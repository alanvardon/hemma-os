-- Plan 139 Stage 5 proof: the salary-email outbox (public.salary_emails), its
-- AFTER INSERT partner trigger, the redefined private.finalize_salary_month,
-- request_salary_results_email, claim_salary_emails / complete_salary_email and
-- salary_results_email_status. LOCAL DATABASE ONLY. All data is fictional.
--
-- Part 1 runs inside one transaction that is rolled back. Part 2 (the
-- two-session claim race) needs committed rows and real separate sessions, so
-- it uses dblink exactly like test-durable-delete-concurrency.sql and cleans up
-- after itself.
--
-- Run after `supabase db reset`:
--   docker cp supabase/test-salary-emails.sql supabase_db_hemma-os:/tmp/test-salary-emails.sql
--   docker exec supabase_db_hemma-os psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f /tmp/test-salary-emails.sql
-- Success ends with the "plan139 emails ALL PASS" notice.
--
-- Golden values (hand-checked against buildSubmission, web/src/lib/hushallsbudget.ts):
--   Base (plan 139): A = 38 450 + 1 250 = 39 700, B = 31 200; gap 8 500 → 4 250
--     a→b; equal_share 70 900 / 2 = 35 450.
--   Plan 132 golden (test-salary-reminders.sql): A = 42 350 + 1 250 = 43 600,
--     B = 38 900; gap 4 700 → 2 350 a→b; equal_share 82 500 / 2 = 41 250; note
--     'Bonus i mars'. Re-asserted here to prove the finalize redefinition
--     changed nothing but the enqueue.

begin;

-- ── fixtures (as postgres) ────────────────────────────────────────────────────

insert into auth.users (id, email, aud, role) values
  ('13950000-0000-0000-0000-000000000001', 'emails139-a@example.invalid', 'authenticated', 'authenticated'),
  ('13950000-0000-0000-0000-000000000002', 'emails139-b@example.invalid', 'authenticated', 'authenticated'),
  ('13950000-0000-0000-0000-000000000003', 'emails139-other@example.invalid', 'authenticated', 'authenticated');
insert into public.households (id, name) values
  ('13950000-0000-0000-0000-0000000000a1', 'Plan 139 emails household one'),
  ('13950000-0000-0000-0000-0000000000a2', 'Plan 139 emails household two');
insert into public.household_members (household_id, user_id, role) values
  ('13950000-0000-0000-0000-0000000000a1', '13950000-0000-0000-0000-000000000001', 'owner'),
  ('13950000-0000-0000-0000-0000000000a1', '13950000-0000-0000-0000-000000000002', 'member'),
  ('13950000-0000-0000-0000-0000000000a2', '13950000-0000-0000-0000-000000000003', 'owner');
insert into public.household_people (household_id, slot, assigned_email) values
  ('13950000-0000-0000-0000-0000000000a1', 'a', 'emails139-a@example.invalid'),
  ('13950000-0000-0000-0000-0000000000a1', 'b', 'emails139-b@example.invalid');
insert into public.profiles (user_id, display_name) values
  ('13950000-0000-0000-0000-000000000001', 'Anna'),
  ('13950000-0000-0000-0000-000000000002', 'Bo');

create function pg_temp.e139_as(p_user text) returns void language sql as $$
  select set_config('request.jwt.claims',
    pg_catalog.json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
do $$ begin
  execute format('grant usage on schema %I to authenticated, anon, service_role',
    (select nspname from pg_catalog.pg_namespace where oid = pg_catalog.pg_my_temp_schema()));
end $$;
grant execute on function pg_temp.e139_as(text) to authenticated;

create function pg_temp.e139_expect(p_sql text, p_state text, p_label text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate = p_state then return; end if;
    raise exception 'FAIL %: expected %, got % (%)', p_label, p_state, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL %: expected %, statement succeeded', p_label, p_state;
end;
$$;
grant execute on function pg_temp.e139_expect(text, text, text) to authenticated, anon, service_role;

-- Outbox rows for (household one, month[, kind]) — read as postgres.
create function pg_temp.e139_count(p_month text, p_kind text) returns bigint language sql as $$
  select count(*) from public.salary_emails
   where household_id = '13950000-0000-0000-0000-0000000000a1' and month = p_month and kind = p_kind;
$$;

-- ── settings: the two new toggles default to on ───────────────────────────────

insert into public.salary_reminder_settings (household_id) values ('13950000-0000-0000-0000-0000000000a2');
do $$
begin
  if (select notify_partner and email_results from public.salary_reminder_settings
       where household_id = '13950000-0000-0000-0000-0000000000a2') is distinct from true then
    raise exception 'FAIL settings defaults'; end if;
end $$;

-- ── app path: own first half → one partner_submitted row, actor set ──────────

set local role authenticated;
do $$
declare res jsonb;
begin
  perform pg_temp.e139_as('13950000-0000-0000-0000-000000000001');
  res := public.save_salary_half('2026-01', 'a',
    '[{"label":"Lön","amount":38450},{"label":"Barnbidrag","amount":1250}]', null, null);
  if res ->> 'status' <> 'pending' then raise exception 'FAIL app create: %', res; end if;
  -- The member cannot read the outbox directly (no grant), even for their household.
  perform pg_temp.e139_expect($s$select count(*) from public.salary_emails$s$, '42501', 'authenticated selects salary_emails');
end $$;
reset role;

do $$
declare e public.salary_emails%rowtype;
begin
  select * into strict e from public.salary_emails
   where household_id = '13950000-0000-0000-0000-0000000000a1' and month = '2026-01';
  if e.kind <> 'partner_submitted' or e.submitter_slot <> 'a' or e."trigger" <> 'auto'
     or e.actor_user_id is distinct from '13950000-0000-0000-0000-000000000001'::uuid
     or e.submission_id is not null or e.attempts <> 0 or e.sent_at is not null
     or e.skipped_reason is not null or e.claimed_at is not null then
    raise exception 'FAIL app-path partner row: %', row_to_json(e); end if;
end $$;

-- ── re-saving the same half (app edit) enqueues nothing ───────────────────────

set local role authenticated;
do $$
declare res jsonb; seen timestamptz;
begin
  perform pg_temp.e139_as('13950000-0000-0000-0000-000000000001');
  select updated_at into strict seen from public.salary_submission_drafts
   where household_id = '13950000-0000-0000-0000-0000000000a1' and month = '2026-01' and slot = 'a';
  res := public.save_salary_half('2026-01', 'a',
    '[{"label":"Lön","amount":38450},{"label":"Barnbidrag","amount":1250}]', 'Omsparad', seen);
  if res ->> 'status' <> 'pending' then raise exception 'FAIL app re-save: %', res; end if;
  -- And the partner, editing that same half, enqueues nothing either.
  perform pg_temp.e139_as('13950000-0000-0000-0000-000000000002');
  res := public.save_salary_half('2026-01', 'a',
    '[{"label":"Lön","amount":38450},{"label":"Barnbidrag","amount":1250}]', null, (res ->> 'updated_at')::timestamptz);
  if res ->> 'status' <> 'pending' then raise exception 'FAIL partner edit: %', res; end if;
end $$;
reset role;

do $$
begin
  if pg_temp.e139_count('2026-01', 'partner_submitted') <> 1 then
    raise exception 'FAIL re-save enqueued: %', pg_temp.e139_count('2026-01', 'partner_submitted'); end if;
end $$;

-- ── email path (service role, the salary-reminder function's upsert) ─────────
-- First insert → one row with actor null; the same upsert again (conflict →
-- UPDATE triggers, not INSERT) → nothing more.

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.salary_submission_drafts (household_id, month, slot, income_items, note, submitted_via)
  values ('13950000-0000-0000-0000-0000000000a1', '2026-02', 'b', '[{"label":"Lön","amount":31200}]', null, 'email')
  on conflict (household_id, month, slot) do update
    set income_items = excluded.income_items, note = excluded.note, submitted_via = excluded.submitted_via;
insert into public.salary_submission_drafts (household_id, month, slot, income_items, note, submitted_via)
  values ('13950000-0000-0000-0000-0000000000a1', '2026-02', 'b', '[{"label":"Lön","amount":32000}]', 'ny', 'email')
  on conflict (household_id, month, slot) do update
    set income_items = excluded.income_items, note = excluded.note, submitted_via = excluded.submitted_via;
reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare e public.salary_emails%rowtype;
begin
  select * into strict e from public.salary_emails
   where household_id = '13950000-0000-0000-0000-0000000000a1' and month = '2026-02';
  if e.kind <> 'partner_submitted' or e.submitter_slot <> 'b' or e.actor_user_id is not null or e."trigger" <> 'auto' then
    raise exception 'FAIL email-path partner row: %', row_to_json(e); end if;
  if (select income_items from public.salary_submission_drafts
       where household_id = '13950000-0000-0000-0000-0000000000a1' and month = '2026-02' and slot = 'b')
     <> '[{"label":"Lön","amount":32000}]'::jsonb then
    raise exception 'FAIL email-path upsert did not update'; end if;
end $$;

-- ── second half → finalized: exactly one month_results 'auto' row for the new
-- ── submission id, and the Base golden row ────────────────────────────────────

set local role authenticated;
do $$
declare res jsonb;
begin
  perform pg_temp.e139_as('13950000-0000-0000-0000-000000000002');
  res := public.save_salary_half('2026-01', 'b', '[{"label":"Lön","amount":31200}]', null, null);
  if res ->> 'status' <> 'finalized' then raise exception 'FAIL second half: %', res; end if;
end $$;
reset role;

do $$
declare
  r public.salary_submissions%rowtype;
  e public.salary_emails%rowtype;
begin
  select * into strict r from public.salary_submissions
   where household_id = '13950000-0000-0000-0000-0000000000a1' and month = '2026-01';
  if r.income_a <> 39700 or r.income_b <> 31200 or r.transfer_amount::text <> '4250'
     or r.transfer_from <> 'a' or r.transfer_to <> 'b' or r.equal_share::text <> '35450'
     or r.note is not null then  -- B's edit of A's half cleared A's note; B gave none
    raise exception 'FAIL base golden: %', row_to_json(r); end if;

  if pg_temp.e139_count('2026-01', 'month_results') <> 1 then
    raise exception 'FAIL results rows: %', pg_temp.e139_count('2026-01', 'month_results'); end if;
  select * into strict e from public.salary_emails
   where household_id = '13950000-0000-0000-0000-0000000000a1' and month = '2026-01' and kind = 'month_results';
  if e.submission_id is distinct from r.id or e."trigger" <> 'auto' or e.submitter_slot is not null
     or e.actor_user_id is distinct from '13950000-0000-0000-0000-000000000002'::uuid then
    raise exception 'FAIL results row: %', row_to_json(e); end if;
  -- B's own first insert also queued a partner row; the SENDER skips it because
  -- the month is complete by then (salaryEmailDecision 'month_complete').
  if pg_temp.e139_count('2026-01', 'partner_submitted') <> 2 then
    raise exception 'FAIL partner rows after finalize'; end if;
end $$;

-- ── the plan-132 golden finalize (service-role wrapper) still holds ──────────

do $$
declare
  hh uuid := '13950000-0000-0000-0000-0000000000a1';
  outcome text;
  r public.salary_submissions%rowtype;
begin
  insert into public.salary_submission_drafts (household_id, month, slot, income_items, note, submitted_via) values
    (hh, '2026-03', 'a', '[{"label":" Lön ","amount":42350},{"label":"Barnbidrag","amount":1250},{"label":"  ","amount":0}]', ' Bonus i mars ', 'email'),
    (hh, '2026-03', 'b', '[{"label":"Lön","amount":38900}]', '', 'email');
  insert into public.salary_reminder_tokens (household_id, slot, month, token_hash, recipient_email, expires_at)
    values (hh, 'a', '2026-03', encode(extensions.digest('plan139-emails-golden', 'sha256'), 'hex'),
            'emails139-a@example.invalid', now() + interval '30 days');
  set local role service_role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  outcome := public.finalize_salary_month(hh, '2026-03');
  reset role;
  perform set_config('request.jwt.claims', '', true);
  if outcome <> 'finalized' then raise exception 'FAIL golden outcome: %', outcome; end if;

  select * into strict r from public.salary_submissions where household_id = hh and month = '2026-03';
  if r.income_a <> 43600 or r.income_b <> 38900 then
    raise exception 'FAIL golden incomes: % / %', r.income_a, r.income_b; end if;
  if r.transfer_amount::text <> '2350' or r.transfer_from <> 'a' or r.transfer_to <> 'b' then
    raise exception 'FAIL golden transfer: % % → %', r.transfer_amount, r.transfer_from, r.transfer_to; end if;
  if r.equal_share::text <> '41250' then raise exception 'FAIL golden equal_share: %', r.equal_share; end if;
  if r.income_items <> '[{"owner":"a","label":"Lön","amount":42350},
                         {"owner":"a","label":"Barnbidrag","amount":1250},
                         {"owner":"b","label":"Lön","amount":38900}]'::jsonb then
    raise exception 'FAIL golden income_items: %', r.income_items; end if;
  if r.note is distinct from 'Bonus i mars' then raise exception 'FAIL golden note: %', r.note; end if;
  if r.person_a_name <> 'Anna' or r.person_b_name <> 'Bo' then
    raise exception 'FAIL golden names: % / %', r.person_a_name, r.person_b_name; end if;
  if r.revision <> 1 then raise exception 'FAIL golden revision: %', r.revision; end if;
  if exists (select 1 from public.salary_submission_drafts where household_id = hh and month = '2026-03')
     or exists (select 1 from public.salary_reminder_tokens where household_id = hh and month = '2026-03' and revoked_at is null) then
    raise exception 'FAIL golden: drafts/tokens not cleared'; end if;

  -- Service-role path: one auto results row for this id, actor null.
  if (select count(*) from public.salary_emails
       where household_id = hh and month = '2026-03' and kind = 'month_results'
         and submission_id = r.id and "trigger" = 'auto' and actor_user_id is null) <> 1
     or pg_temp.e139_count('2026-03', 'month_results') <> 1 then
    raise exception 'FAIL golden results row'; end if;

  -- Re-finalizing (already_logged) and pending / zero_total outcomes enqueue no results.
  if private.finalize_salary_month(hh, '2026-03') <> 'already_logged' then raise exception 'FAIL re-finalize'; end if;
  if private.finalize_salary_month(hh, '2026-02') <> 'pending' then raise exception 'FAIL pending outcome'; end if;
  insert into public.salary_submission_drafts (household_id, month, slot, income_items, note, submitted_via) values
    (hh, '2026-06', 'a', '[{"label":"Lön","amount":0}]', null, 'email'),
    (hh, '2026-06', 'b', '[]', null, 'email');
  if private.finalize_salary_month(hh, '2026-06') <> 'zero_total' then raise exception 'FAIL zero_total outcome'; end if;
  if pg_temp.e139_count('2026-03', 'month_results') <> 1 or pg_temp.e139_count('2026-02', 'month_results') <> 0
     or pg_temp.e139_count('2026-06', 'month_results') <> 0 then
    raise exception 'FAIL non-finalized outcomes enqueued results'; end if;
end $$;

-- ── JSON import (sync_apply_rows, normal and seed) enqueues NOTHING ───────────

set local role authenticated;
do $$
declare res jsonb;
begin
  perform pg_temp.e139_as('13950000-0000-0000-0000-000000000001');
  res := public.sync_apply_rows('plan139-emails-import', 'salary_submissions',
    '[{"id":"plan139-import-1","month":"2025-06","person_a_name":"Anna","income_a":30000,
       "person_b_name":"Bo","income_b":20000,"transfer_from":"a","transfer_to":"b",
       "transfer_amount":5000,"equal_share":25000,"note":null,
       "income_items":[{"owner":"a","label":"Lön","amount":30000},{"owner":"b","label":"Lön","amount":20000}]}]',
    '{"salary_submissions:plan139-import-1":null}', false);
  if res ->> 'status' <> 'applied' then raise exception 'FAIL import apply: %', res; end if;
  res := public.sync_apply_rows('plan139-emails-seed', 'salary_submissions',
    '[{"id":"plan139-import-2","month":"2025-07","income_a":1,"income_b":1}]',
    '{"salary_submissions:plan139-import-2":null}', true);
  if res ->> 'status' <> 'applied' then raise exception 'FAIL seed apply: %', res; end if;
end $$;
reset role;

do $$
begin
  if not exists (select 1 from public.salary_submissions where id = 'plan139-import-1')
     or not exists (select 1 from public.salary_submissions where id = 'plan139-import-2') then
    raise exception 'FAIL import rows missing'; end if;
  if exists (select 1 from public.salary_emails
              where household_id = '13950000-0000-0000-0000-0000000000a1'
                and (month in ('2025-06', '2025-07') or submission_id like 'plan139-import-%')) then
    raise exception 'FAIL import enqueued an email'; end if;
end $$;

-- ── request_salary_results_email: queued / already_queued / queued; 42501 ────

-- Mark every open fixture row done first, so the throttle state is explicit.
update public.salary_emails set sent_at = now()
 where household_id = '13950000-0000-0000-0000-0000000000a1' and kind = 'month_results';
create temporary table e139_ids (sub_id text not null) on commit drop;
insert into e139_ids select id from public.salary_submissions
 where household_id = '13950000-0000-0000-0000-0000000000a1' and month = '2026-01';
grant select on e139_ids to authenticated, anon, service_role;

set local role authenticated;
do $$
declare sid text := (select sub_id from e139_ids);
begin
  perform pg_temp.e139_as('13950000-0000-0000-0000-000000000001');
  if public.request_salary_results_email(sid) <> 'queued' then raise exception 'FAIL first request'; end if;
  perform pg_temp.e139_as('13950000-0000-0000-0000-000000000002');
  if public.request_salary_results_email(sid) <> 'already_queued' then raise exception 'FAIL second request'; end if;
  -- An imported row may be resent too (only the AUTOMATIC email is import-free).
  if public.request_salary_results_email('plan139-import-1') <> 'queued' then raise exception 'FAIL import-row request'; end if;
  -- Unknown id → 42501.
  perform pg_temp.e139_expect($s$select public.request_salary_results_email('no-such-row')$s$, '42501', 'unknown id');
  perform pg_temp.e139_expect($s$select public.request_salary_results_email(null)$s$, '42501', 'null id');
  -- Another household's member, with household one's id → 42501, nothing written.
  perform pg_temp.e139_as('13950000-0000-0000-0000-000000000003');
  perform pg_temp.e139_expect(format($s$select public.request_salary_results_email(%L)$s$, sid), '42501', 'cross-household id');
end $$;
reset role;

do $$
declare
  sid text := (select sub_id from e139_ids);
  e public.salary_emails%rowtype;
begin
  select * into strict e from public.salary_emails
   where submission_id = sid and "trigger" = 'manual';
  if e.household_id <> '13950000-0000-0000-0000-0000000000a1' or e.month <> '2026-01' or e.kind <> 'month_results'
     or e.actor_user_id is distinct from '13950000-0000-0000-0000-000000000001'::uuid or e.sent_at is not null then
    raise exception 'FAIL manual row: %', row_to_json(e); end if;
  if exists (select 1 from public.salary_emails where household_id = '13950000-0000-0000-0000-0000000000a2') then
    raise exception 'FAIL cross-household request wrote a row'; end if;
end $$;

-- Mark the queued one sent (service role) → a new request queues again.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
declare
  sid text := (select sub_id from e139_ids);
  claimed uuid[];
  target uuid := (select id from public.salary_emails where submission_id = sid and "trigger" = 'manual');
begin
  select array_agg(c.id) into claimed from public.claim_salary_emails(100) c;
  if not (target = any(claimed)) then raise exception 'FAIL manual row not claimed'; end if;
  perform public.complete_salary_email(target, 'sent', null);
  -- Completing an already-completed row is loud.
  perform pg_temp.e139_expect(format($s$select public.complete_salary_email(%L, 'sent', null)$s$, target),
    'P0002', 'double completion');
  perform pg_temp.e139_expect(format($s$select public.complete_salary_email(%L, 'bogus', null)$s$, target),
    '22023', 'bad outcome');
  perform pg_temp.e139_expect($s$select public.claim_salary_emails(0)$s$, '22023', 'claim limit 0');
  perform pg_temp.e139_expect($s$select public.claim_salary_emails(101)$s$, '22023', 'claim limit 101');
  -- Release the other rows this claim leased (the import-row request etc.).
  update public.salary_emails set claimed_at = null where id = any(claimed) and id <> target;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

set local role authenticated;
do $$
declare
  sid text := (select sub_id from e139_ids);
  st record;
begin
  perform pg_temp.e139_as('13950000-0000-0000-0000-000000000002');
  if public.request_salary_results_email(sid) <> 'queued' then raise exception 'FAIL request after sent'; end if;
  -- Status: last sent known, one queued.
  select * into strict st from public.salary_results_email_status() s where s.submission_id = sid;
  if st.last_sent_at is null or st.queued is not true then raise exception 'FAIL status: %', row_to_json(st); end if;
  -- Household two sees nothing of household one.
  perform pg_temp.e139_as('13950000-0000-0000-0000-000000000003');
  if exists (select 1 from public.salary_results_email_status()) then raise exception 'FAIL status cross-household'; end if;
  -- Client roles cannot claim/complete or touch the table.
  perform pg_temp.e139_as('13950000-0000-0000-0000-000000000001');
  perform pg_temp.e139_expect($s$select public.claim_salary_emails(10)$s$, '42501', 'authenticated claim');
  perform pg_temp.e139_expect(
    $s$select public.complete_salary_email('00000000-0000-0000-0000-000000000000', 'sent', null)$s$,
    '42501', 'authenticated complete');
  perform pg_temp.e139_expect(
    $s$insert into public.salary_emails (household_id, month, kind, submission_id, "trigger")
       values ('13950000-0000-0000-0000-0000000000a1', '2026-01', 'month_results', 'x', 'manual')$s$,
    '42501', 'authenticated insert salary_emails');
  perform pg_temp.e139_expect($s$update public.salary_emails set sent_at = now()$s$, '42501', 'authenticated update salary_emails');
end $$;
reset role;

-- ── attempts stop at 5; failures retry; the lease blocks a live re-claim ─────

update public.salary_emails set skipped_reason = 'test_reset'
 where household_id = '13950000-0000-0000-0000-0000000000a1' and sent_at is null and skipped_reason is null;
insert into public.salary_emails (id, household_id, month, kind, submission_id, "trigger")
  values ('13950000-0000-0000-0000-00000000e001', '13950000-0000-0000-0000-0000000000a1', '2026-01',
          'month_results', (select sub_id from e139_ids), 'manual');

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
declare
  target uuid := '13950000-0000-0000-0000-00000000e001';
  expected int;
begin
  foreach expected in array array[1, 2, 3, 4, 5] loop
    if expected = 3 then
      -- Attempt 3: the run holding attempt 2 died mid-send. Its lease is older
      -- than 15 minutes, so the row is claimable again — and that counts.
      update public.salary_emails set claimed_at = now() - interval '16 minutes' where id = target;
    end if;
    if not exists (select 1 from public.claim_salary_emails(100) c where c.id = target and c.attempts = expected) then
      raise exception 'FAIL claim did not return the row with attempts %', expected; end if;
    -- Leased: an immediate second claim (another run) does not get it.
    if exists (select 1 from public.claim_salary_emails(100) c where c.id = target) then
      raise exception 'FAIL leased row re-claimed at attempt %', expected; end if;
    -- Attempt 2 "dies" (no completion); the others fail and release the lease.
    if expected <> 2 then
      perform public.complete_salary_email(target, 'failed', 'Resend 503');
    end if;
  end loop;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare e public.salary_emails%rowtype;
begin
  select * into strict e from public.salary_emails where id = '13950000-0000-0000-0000-00000000e001';
  if e.attempts <> 5 or e.last_error is distinct from 'Resend 503' or e.sent_at is not null or e.skipped_reason is not null then
    raise exception 'FAIL after 5 attempts: %', row_to_json(e); end if;
end $$;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
begin
  if exists (select 1 from public.claim_salary_emails(100) c where c.id = '13950000-0000-0000-0000-00000000e001') then
    raise exception 'FAIL claimed a 6th time'; end if;
  -- The check constraint refuses a 6th attempt even by hand.
  perform pg_temp.e139_expect(
    $s$update public.salary_emails set attempts = 6 where id = '13950000-0000-0000-0000-00000000e001'$s$,
    '23514', 'attempts > 5');
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

-- A dead (5-attempt) row no longer holds the throttle: a fresh request queues.
set local role authenticated;
do $$
declare st record;
begin
  perform pg_temp.e139_as('13950000-0000-0000-0000-000000000001');
  select * into strict st from public.salary_results_email_status() s where s.submission_id = (select sub_id from e139_ids);
  if st.queued then raise exception 'FAIL dead row counted as queued'; end if;
  if public.request_salary_results_email((select sub_id from e139_ids)) <> 'queued' then
    raise exception 'FAIL request after a dead row'; end if;
end $$;
reset role;

-- ── anon: nothing ─────────────────────────────────────────────────────────────

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
do $$
begin
  perform pg_temp.e139_expect($s$select count(*) from public.salary_emails$s$, '42501', 'anon select salary_emails');
  perform pg_temp.e139_expect($s$select public.claim_salary_emails(10)$s$, '42501', 'anon claim');
  perform pg_temp.e139_expect(
    $s$select public.complete_salary_email('00000000-0000-0000-0000-000000000000', 'sent', null)$s$, '42501', 'anon complete');
  perform pg_temp.e139_expect($s$select public.request_salary_results_email('x')$s$, '42501', 'anon request');
  perform pg_temp.e139_expect($s$select * from public.salary_results_email_status()$s$, '42501', 'anon status');
end $$;
reset role;

-- Grants as catalogued (belt and braces).
do $$
begin
  if has_table_privilege('authenticated', 'public.salary_emails', 'select')
     or has_table_privilege('anon', 'public.salary_emails', 'select')
     or has_table_privilege('authenticated', 'public.salary_emails', 'insert')
     or not has_table_privilege('service_role', 'public.salary_emails', 'select')
     or has_function_privilege('authenticated', 'public.claim_salary_emails(integer)', 'execute')
     or has_function_privilege('authenticated', 'public.complete_salary_email(uuid, text, text)', 'execute')
     or not has_function_privilege('service_role', 'public.claim_salary_emails(integer)', 'execute')
     or not has_function_privilege('service_role', 'public.complete_salary_email(uuid, text, text)', 'execute')
     or has_function_privilege('anon', 'public.request_salary_results_email(text)', 'execute')
     or not has_function_privilege('authenticated', 'public.request_salary_results_email(text)', 'execute')
     or has_function_privilege('anon', 'public.salary_results_email_status()', 'execute')
     or not has_function_privilege('authenticated', 'public.salary_results_email_status()', 'execute')
     or has_function_privilege('authenticated', 'private.enqueue_salary_partner_email()', 'execute')
     or has_function_privilege('authenticated', 'private.finalize_salary_month(uuid, text)', 'execute')
     or not has_function_privilege('service_role', 'private.finalize_salary_month(uuid, text)', 'execute')
     or exists (select 1 from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'salary_emails') then
    raise exception 'FAIL grants';
  end if;
end $$;

rollback;

-- ── Part 2: two concurrent sessions never claim the same row ─────────────────
-- Session A claims 2 and HOLDS its transaction (row locks) for 0.75 s; session
-- B claims 2 meanwhile and must SKIP the locked rows. Then, after both commit,
-- a third claim gets none of them (the lease).

create extension if not exists dblink with schema extensions;

drop function if exists public.plan139_claim_hold(integer);
drop role if exists plan139_dblink;
delete from public.salary_emails where household_id = '13950000-0000-0000-0000-0000000000c1';
delete from public.households where id = '13950000-0000-0000-0000-0000000000c1';

do $$
begin
  if exists (select 1 from public.salary_emails where sent_at is null and skipped_reason is null and attempts < 5) then
    raise exception 'FAIL precondition: open salary_emails rows exist outside this test; run after supabase db reset';
  end if;
end $$;

insert into public.households (id, name) values ('13950000-0000-0000-0000-0000000000c1', 'Plan 139 claim race');
insert into public.salary_emails (id, household_id, month, kind, submission_id, "trigger", created_at) values
  ('13950000-0000-0000-0000-00000000c001', '13950000-0000-0000-0000-0000000000c1', '2026-01', 'month_results', 'race-1', 'manual', now() - interval '4 minutes'),
  ('13950000-0000-0000-0000-00000000c002', '13950000-0000-0000-0000-0000000000c1', '2026-02', 'month_results', 'race-2', 'manual', now() - interval '3 minutes'),
  ('13950000-0000-0000-0000-00000000c003', '13950000-0000-0000-0000-0000000000c1', '2026-03', 'month_results', 'race-3', 'manual', now() - interval '2 minutes'),
  ('13950000-0000-0000-0000-00000000c004', '13950000-0000-0000-0000-0000000000c1', '2026-04', 'month_results', 'race-4', 'manual', now() - interval '1 minute');

create function public.plan139_claim_hold(p_hold integer) returns text
language plpgsql security definer set search_path to '' as $$
declare ids text;
begin
  select coalesce(string_agg(c.id::text, ',' order by c.id), '') into ids from public.claim_salary_emails(2) c;
  if p_hold > 0 then perform pg_catalog.pg_sleep(p_hold / 1000.0); end if;
  return ids;
end; $$;

create role plan139_dblink login password 'plan139-local-concurrency-only';
grant execute on function public.plan139_claim_hold(integer) to plan139_dblink;

select extensions.dblink_connect('plan139_a','dbname=postgres user=plan139_dblink password=plan139-local-concurrency-only host=supabase_db_hemma-os port=5432');
select extensions.dblink_connect('plan139_b','dbname=postgres user=plan139_dblink password=plan139-local-concurrency-only host=supabase_db_hemma-os port=5432');

select extensions.dblink_send_query('plan139_a', $$select public.plan139_claim_hold(750)$$);
select pg_sleep(0.1);
select extensions.dblink_send_query('plan139_b', $$select public.plan139_claim_hold(0)$$);
create temp table plan139_results(label text, result text);
insert into plan139_results select 'a', result from extensions.dblink_get_result('plan139_a') as t(result text);
insert into plan139_results select 'b', result from extensions.dblink_get_result('plan139_b') as t(result text);
insert into plan139_results select 'c', public.plan139_claim_hold(0);

do $$
declare
  a text[] := string_to_array((select result from plan139_results where label = 'a'), ',');
  b text[] := string_to_array((select result from plan139_results where label = 'b'), ',');
  c text := (select result from plan139_results where label = 'c');
begin
  if cardinality(a) <> 2 or cardinality(b) <> 2 then
    raise exception 'FAIL race claim sizes: a=% b=%', a, b; end if;
  if a && b then raise exception 'FAIL the same row was claimed twice: a=% b=%', a, b; end if;
  if (select count(distinct x) from unnest(a || b) x) <> 4 then raise exception 'FAIL race did not cover all rows'; end if;
  if c <> '' then raise exception 'FAIL a leased row was re-claimed after commit: %', c; end if;
  if exists (select 1 from public.salary_emails
              where household_id = '13950000-0000-0000-0000-0000000000c1' and attempts <> 1) then
    raise exception 'FAIL race attempts'; end if;
end $$;

select extensions.dblink_disconnect('plan139_a');
select extensions.dblink_disconnect('plan139_b');
drop function public.plan139_claim_hold(integer);
drop role plan139_dblink;
delete from public.salary_emails where household_id = '13950000-0000-0000-0000-0000000000c1';
delete from public.households where id = '13950000-0000-0000-0000-0000000000c1';
drop extension dblink;

do $$ begin raise notice 'plan139 emails ALL PASS'; end $$;
