-- Plan 132 Stage 1 proof: salary reminder tables, RLS, finalize_salary_month and
-- discard_salary_drafts. LOCAL DATABASE ONLY. All data is fictional and the whole
-- file runs inside one transaction that is rolled back.
--
-- Run after `supabase db reset`:
--   docker cp supabase/test-salary-reminders.sql supabase_db_hemma-os:/tmp/test-salary-reminders.sql
--   docker exec supabase_db_hemma-os psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f /tmp/test-salary-reminders.sql
-- Success ends with the "plan132 ALL PASS" notice.
--
-- Golden finalise values are hand-checked against buildSubmission
-- (web/src/lib/hushallsbudget.ts): income = item totals, transfer = |a − b| / 2
-- from 'a' when a − b >= 0, equal_share = (a + b) / 2, income_items = A items
-- (owner 'a') then B items (owner 'b'), blank-and-zero items dropped.

begin;

-- ── fixtures (as postgres) ────────────────────────────────────────────────────

insert into auth.users (id, email, aud, role) values
  ('13200000-0000-0000-0000-000000000001', 'salary-a@example.invalid', 'authenticated', 'authenticated'),
  ('13200000-0000-0000-0000-000000000002', 'salary-b@example.invalid', 'authenticated', 'authenticated'),
  ('13200000-0000-0000-0000-000000000003', 'salary-other@example.invalid', 'authenticated', 'authenticated');
insert into public.households (id, name) values
  ('13200000-0000-0000-0000-0000000000a1', 'Plan 132 household one'),
  ('13200000-0000-0000-0000-0000000000a2', 'Plan 132 household two');
insert into public.household_members (household_id, user_id, role) values
  ('13200000-0000-0000-0000-0000000000a1', '13200000-0000-0000-0000-000000000001', 'owner'),
  ('13200000-0000-0000-0000-0000000000a1', '13200000-0000-0000-0000-000000000002', 'member'),
  ('13200000-0000-0000-0000-0000000000a2', '13200000-0000-0000-0000-000000000003', 'owner');
-- Household one: slot a has a profile name, slot b falls back to the email.
-- Household two: no people configured → "Person A"/"Person B".
insert into public.household_people (household_id, slot, assigned_email) values
  ('13200000-0000-0000-0000-0000000000a1', 'a', 'salary-a@example.invalid'),
  ('13200000-0000-0000-0000-0000000000a1', 'b', 'salary-b@example.invalid');
insert into public.profiles (user_id, display_name) values
  ('13200000-0000-0000-0000-000000000001', 'Alva');

create temporary table plan132_ids (
  hh1 uuid not null, hh2 uuid not null
) on commit drop;
insert into plan132_ids values
  ('13200000-0000-0000-0000-0000000000a1', '13200000-0000-0000-0000-0000000000a2');
grant select on plan132_ids to authenticated, anon;

-- Two drafts + two live tokens for (household, month).
create function pg_temp.plan132_seed(
  p_household uuid, p_month text,
  p_items_a jsonb, p_note_a text, p_items_b jsonb, p_note_b text
) returns void language sql as $$
  insert into public.salary_submission_drafts
    (household_id, month, slot, income_items, note, submitted_via)
  select p_household, p_month, d.slot, d.items, d.note, 'email'
  from (values ('a', p_items_a, p_note_a), ('b', p_items_b, p_note_b)) d(slot, items, note)
  where d.items is not null;
  insert into public.salary_reminder_tokens
    (household_id, slot, month, token_hash, recipient_email, expires_at)
  select p_household, s.slot, p_month,
         encode(extensions.digest(p_household::text || p_month || s.slot || 'plan132', 'sha256'), 'hex'),
         'salary-' || s.slot || '@example.invalid', now() + interval '30 days'
  from (values ('a'), ('b')) s(slot);
$$;

create function pg_temp.plan132_live_tokens(p_household uuid, p_month text) returns bigint
language sql as $$
  select count(*) from public.salary_reminder_tokens
  where household_id = p_household and month = p_month and revoked_at is null;
$$;
create function pg_temp.plan132_drafts(p_household uuid, p_month text) returns bigint
language sql as $$
  select count(*) from public.salary_submission_drafts
  where household_id = p_household and month = p_month;
$$;

-- ── finalize: golden case A=[Lön 42350, Barnbidrag 1250], B=[Lön 38900] ───────

do $$
declare
  hh uuid := '13200000-0000-0000-0000-0000000000a1';
  outcome text;
  r public.salary_submissions%rowtype;
begin
  perform pg_temp.plan132_seed(hh, '2026-01',
    '[{"label":" Lön ","amount":42350},{"label":"Barnbidrag","amount":1250},{"label":"  ","amount":0}]',
    ' Bonus i mars ',
    '[{"label":"Lön","amount":38900}]', '');
  outcome := private.finalize_salary_month(hh, '2026-01');
  if outcome <> 'finalized' then raise exception 'FAIL golden outcome: %', outcome; end if;

  select * into strict r from public.salary_submissions where household_id = hh and month = '2026-01';
  if r.income_a <> 43600 or r.income_b <> 38900 then
    raise exception 'FAIL golden incomes: % / %', r.income_a, r.income_b; end if;
  if r.transfer_amount <> 2350 or r.transfer_amount::text <> '2350'
     or r.transfer_from <> 'a' or r.transfer_to <> 'b' then
    raise exception 'FAIL golden transfer: % % → %', r.transfer_amount, r.transfer_from, r.transfer_to; end if;
  if r.equal_share <> 41250 or r.equal_share::text <> '41250' then
    raise exception 'FAIL golden equal_share: %', r.equal_share; end if;
  if r.income_items <> '[{"owner":"a","label":"Lön","amount":42350},
                         {"owner":"a","label":"Barnbidrag","amount":1250},
                         {"owner":"b","label":"Lön","amount":38900}]'::jsonb then
    raise exception 'FAIL golden income_items: %', r.income_items; end if;
  if r.note is distinct from 'Bonus i mars' then raise exception 'FAIL golden note: %', r.note; end if;
  if r.person_a_name <> 'Alva' or r.person_b_name <> 'salary-b@example.invalid' then
    raise exception 'FAIL golden names: % / %', r.person_a_name, r.person_b_name; end if;
  if r.revision <> 1 or r.id is null or r.id = '' then
    raise exception 'FAIL golden revision/id: % %', r.revision, r.id; end if;
  if pg_temp.plan132_drafts(hh, '2026-01') <> 0 or pg_temp.plan132_live_tokens(hh, '2026-01') <> 0 then
    raise exception 'FAIL golden: drafts/tokens not cleared'; end if;

  -- Finalizing again is already_logged and writes nothing more.
  if private.finalize_salary_month(hh, '2026-01') <> 'already_logged'
     or (select count(*) from public.salary_submissions where household_id = hh and month = '2026-01') <> 1 then
    raise exception 'FAIL golden re-finalize'; end if;
end $$;

-- ── finalize: equal halves → transfer 0 from 'a'; both notes joined A first ───

do $$
declare
  hh uuid := '13200000-0000-0000-0000-0000000000a1';
  r public.salary_submissions%rowtype;
begin
  perform pg_temp.plan132_seed(hh, '2026-02',
    '[{"label":"Lön","amount":40000}]', 'Semester',
    '[{"label":"Lön","amount":40000}]', ' Föräldraledig ');
  if private.finalize_salary_month(hh, '2026-02') <> 'finalized' then raise exception 'FAIL equal outcome'; end if;
  select * into strict r from public.salary_submissions where household_id = hh and month = '2026-02';
  if r.transfer_amount <> 0 or r.transfer_from <> 'a' or r.transfer_to <> 'b' or r.equal_share <> 40000 then
    raise exception 'FAIL equal transfer: % % → % eq %', r.transfer_amount, r.transfer_from, r.transfer_to, r.equal_share; end if;
  if r.note is distinct from 'Semester · Föräldraledig' then raise exception 'FAIL equal note: %', r.note; end if;
end $$;

-- ── finalize: B > A → transfer from 'b'; no notes → null ──────────────────────

do $$
declare
  hh uuid := '13200000-0000-0000-0000-0000000000a1';
  r public.salary_submissions%rowtype;
begin
  perform pg_temp.plan132_seed(hh, '2026-03',
    '[{"label":"Lön","amount":30000}]', null,
    '[{"label":"Lön","amount":36000}]', '   ');
  if private.finalize_salary_month(hh, '2026-03') <> 'finalized' then raise exception 'FAIL b>a outcome'; end if;
  select * into strict r from public.salary_submissions where household_id = hh and month = '2026-03';
  if r.transfer_amount <> 3000 or r.transfer_from <> 'b' or r.transfer_to <> 'a' or r.equal_share <> 33000 then
    raise exception 'FAIL b>a transfer: % % → % eq %', r.transfer_amount, r.transfer_from, r.transfer_to, r.equal_share; end if;
  if r.note is not null then raise exception 'FAIL b>a note should be null: %', r.note; end if;
end $$;

-- ── finalize: decimal A 30000.50 / B 30000 → 0.25, unrounded ──────────────────

do $$
declare
  hh uuid := '13200000-0000-0000-0000-0000000000a1';
  r public.salary_submissions%rowtype;
begin
  perform pg_temp.plan132_seed(hh, '2026-04',
    '[{"label":"Lön","amount":30000.50}]', null,
    '[{"label":"Lön","amount":30000}]', null);
  if private.finalize_salary_month(hh, '2026-04') <> 'finalized' then raise exception 'FAIL decimal outcome'; end if;
  select * into strict r from public.salary_submissions where household_id = hh and month = '2026-04';
  if r.income_a <> 30000.5 or r.transfer_amount <> 0.25 or r.transfer_amount::text <> '0.25'
     or r.transfer_from <> 'a' or r.equal_share <> 30000.25 then
    raise exception 'FAIL decimal: a % transfer % from % eq %', r.income_a, r.transfer_amount, r.transfer_from, r.equal_share; end if;
end $$;

-- ── finalize: one draft → pending; nothing written, nothing revoked ───────────

do $$
declare hh uuid := '13200000-0000-0000-0000-0000000000a1';
begin
  perform pg_temp.plan132_seed(hh, '2026-05', '[{"label":"Lön","amount":41000}]', null, null, null);
  if private.finalize_salary_month(hh, '2026-05') <> 'pending' then raise exception 'FAIL pending outcome'; end if;
  if exists (select 1 from public.salary_submissions where household_id = hh and month = '2026-05')
     or pg_temp.plan132_drafts(hh, '2026-05') <> 1 or pg_temp.plan132_live_tokens(hh, '2026-05') <> 2 then
    raise exception 'FAIL pending side effects'; end if;
end $$;

-- ── finalize: zero (and negative) total → zero_total; drafts left alone ───────

do $$
declare hh uuid := '13200000-0000-0000-0000-0000000000a1';
begin
  perform pg_temp.plan132_seed(hh, '2026-06',
    '[{"label":"Lön","amount":0}]', null, '[{"label":"","amount":0}]', null);
  if private.finalize_salary_month(hh, '2026-06') <> 'zero_total' then raise exception 'FAIL zero_total outcome'; end if;
  if exists (select 1 from public.salary_submissions where household_id = hh and month = '2026-06')
     or pg_temp.plan132_drafts(hh, '2026-06') <> 2 or pg_temp.plan132_live_tokens(hh, '2026-06') <> 2 then
    raise exception 'FAIL zero_total side effects'; end if;

  -- The modal's guard is income_a + income_b <= 0, so a negative total is too.
  perform pg_temp.plan132_seed(hh, '2026-10',
    '[{"label":"Korrigering","amount":-100}]', null, '[{"label":"Lön","amount":50}]', null);
  if private.finalize_salary_month(hh, '2026-10') <> 'zero_total' then raise exception 'FAIL negative total outcome'; end if;
  if pg_temp.plan132_drafts(hh, '2026-10') <> 2 then raise exception 'FAIL negative total drafts'; end if;
end $$;

-- ── finalize: month already logged → drafts deleted, tokens revoked ───────────

do $$
declare hh uuid := '13200000-0000-0000-0000-0000000000a1';
begin
  insert into public.salary_submissions (id, household_id, month, income_a, income_b)
    values ('plan132-existing', hh, '2026-07', 1, 1);
  perform pg_temp.plan132_seed(hh, '2026-07',
    '[{"label":"Lön","amount":41000}]', null, '[{"label":"Lön","amount":39000}]', null);
  if private.finalize_salary_month(hh, '2026-07') <> 'already_logged' then raise exception 'FAIL already_logged outcome'; end if;
  if (select count(*) from public.salary_submissions where household_id = hh and month = '2026-07') <> 1
     or pg_temp.plan132_drafts(hh, '2026-07') <> 0 or pg_temp.plan132_live_tokens(hh, '2026-07') <> 0 then
    raise exception 'FAIL already_logged side effects'; end if;
end $$;

-- ── finalize: input validation raises instead of guessing ─────────────────────

do $$
declare hh uuid := '13200000-0000-0000-0000-0000000000a1';
begin
  begin
    perform private.finalize_salary_month(hh, '2026-13');
    raise exception 'FAIL bad month accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform private.finalize_salary_month(null, '2026-08');
    raise exception 'FAIL null household accepted';
  exception when invalid_parameter_value then null;
  end;
  perform pg_temp.plan132_seed(hh, '2026-11',
    '[{"label":"Lön","amount":"41000"}]', null, '[{"label":"Lön","amount":39000}]', null);
  begin
    perform private.finalize_salary_month(hh, '2026-11');
    raise exception 'FAIL string amount accepted';
  exception when invalid_parameter_value then null;
  end;
  if exists (select 1 from public.salary_submissions where household_id = hh and month = '2026-11') then
    raise exception 'FAIL malformed draft wrote a row'; end if;
end $$;

-- ── finalize: household two has no people → "Person A"/"Person B" ─────────────

do $$
declare
  hh uuid := '13200000-0000-0000-0000-0000000000a2';
  r public.salary_submissions%rowtype;
begin
  perform pg_temp.plan132_seed(hh, '2026-01',
    '[{"label":"Lön","amount":30000}]', null, '[{"label":"Lön","amount":32000}]', null);
  if private.finalize_salary_month(hh, '2026-01') <> 'finalized' then raise exception 'FAIL hh2 outcome'; end if;
  select * into strict r from public.salary_submissions where household_id = hh and month = '2026-01';
  if r.person_a_name <> 'Person A' or r.person_b_name <> 'Person B' then
    raise exception 'FAIL fallback names: % / %', r.person_a_name, r.person_b_name; end if;
end $$;

-- Fixtures for the client-boundary checks below.
select pg_temp.plan132_seed('13200000-0000-0000-0000-0000000000a1', '2026-09',
  '[{"label":"Lön","amount":41000}]', null, null, null);
select pg_temp.plan132_seed('13200000-0000-0000-0000-0000000000a2', '2026-09',
  '[{"label":"Lön","amount":30000}]', null, null, null);
insert into public.salary_reminder_settings (household_id, enabled, send_day)
  values ('13200000-0000-0000-0000-0000000000a2', false, 3);

-- ── authenticated client (household one) ──────────────────────────────────────

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"13200000-0000-0000-0000-000000000001","role":"authenticated","email":"salary-a@example.invalid"}', true);

do $$
declare
  hh1 uuid := (select hh1 from plan132_ids);
  hh2 uuid := (select hh2 from plan132_ids);
begin
  -- Drafts: own household readable, other household invisible.
  if (select count(*) from public.salary_submission_drafts where household_id = hh1 and month = '2026-09') <> 1 then
    raise exception 'FAIL member cannot read own drafts'; end if;
  if exists (select 1 from public.salary_submission_drafts where household_id = hh2) then
    raise exception 'FAIL member reads another household''s drafts'; end if;

  -- Drafts: no client writes of any kind.
  begin
    insert into public.salary_submission_drafts (household_id, month, slot, income_items, submitted_via)
      values (hh1, '2026-09', 'b', '[]', 'email');
    raise exception 'FAIL client draft insert allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.salary_submission_drafts set note = 'x' where household_id = hh1;
    raise exception 'FAIL client draft update allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.salary_submission_drafts where household_id = hh1;
    raise exception 'FAIL client draft delete allowed';
  exception when insufficient_privilege then null;
  end;

  -- Tokens: no client access at all.
  begin
    perform 1 from public.salary_reminder_tokens;
    raise exception 'FAIL client token select allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.salary_reminder_tokens (household_id, slot, month, token_hash, recipient_email, expires_at)
      values (hh1, 'a', '2026-09', repeat('a', 64), 'x@example.invalid', now() + interval '1 day');
    raise exception 'FAIL client token insert allowed';
  exception when insufficient_privilege then null;
  end;

  -- Settings: own household insert/update/select; other household denied; no delete.
  insert into public.salary_reminder_settings (household_id, send_day) values (hh1, 12);
  update public.salary_reminder_settings set enabled = false, send_day = 28 where household_id = hh1;
  if (select enabled::text || send_day from public.salary_reminder_settings where household_id = hh1) <> 'false28' then
    raise exception 'FAIL member settings upsert'; end if;
  if exists (select 1 from public.salary_reminder_settings where household_id = hh2) then
    raise exception 'FAIL member reads another household''s settings'; end if;
  begin
    insert into public.salary_reminder_settings (household_id) values (hh2);
    raise exception 'FAIL member inserts another household''s settings';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.salary_reminder_settings set household_id = hh2 where household_id = hh1;
    raise exception 'FAIL member moves settings to another household';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.salary_reminder_settings where household_id = hh1;
    raise exception 'FAIL member settings delete allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.salary_reminder_settings set send_day = 29 where household_id = hh1;
    raise exception 'FAIL send_day 29 accepted';
  exception when check_violation then null;
  end;

  -- finalize is service-only.
  begin
    perform private.finalize_salary_month(hh1, '2026-09');
    raise exception 'FAIL client executed finalize_salary_month';
  exception when insufficient_privilege then null;
  end;

  -- discard: validates the month, then clears only the caller's household.
  begin
    perform public.discard_salary_drafts('2026-9');
    raise exception 'FAIL discard accepted a bad month';
  exception when invalid_parameter_value then null;
  end;
  perform public.discard_salary_drafts('2026-09');
end $$;

reset role;

do $$
begin
  if pg_temp.plan132_drafts('13200000-0000-0000-0000-0000000000a1', '2026-09') <> 0
     or pg_temp.plan132_live_tokens('13200000-0000-0000-0000-0000000000a1', '2026-09') <> 0 then
    raise exception 'FAIL discard did not clear own household'; end if;
  if pg_temp.plan132_drafts('13200000-0000-0000-0000-0000000000a2', '2026-09') <> 1
     or pg_temp.plan132_live_tokens('13200000-0000-0000-0000-0000000000a2', '2026-09') <> 2 then
    raise exception 'FAIL discard touched another household'; end if;
  if (select send_day from public.salary_reminder_settings
        where household_id = '13200000-0000-0000-0000-0000000000a2') <> 3 then
    raise exception 'FAIL other household settings changed'; end if;
end $$;

-- ── authenticated client without a household ──────────────────────────────────

insert into auth.users (id, email, aud, role) values
  ('13200000-0000-0000-0000-000000000009', 'salary-loner@example.invalid', 'authenticated', 'authenticated');
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"13200000-0000-0000-0000-000000000009","role":"authenticated","email":"salary-loner@example.invalid"}', true);
do $$
begin
  if exists (select 1 from public.salary_submission_drafts)
     or exists (select 1 from public.salary_reminder_settings) then
    raise exception 'FAIL household-less user sees salary reminder rows'; end if;
  begin
    perform public.discard_salary_drafts('2026-09');
    raise exception 'FAIL household-less discard allowed';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ── anon: nothing ─────────────────────────────────────────────────────────────

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
do $$
begin
  begin
    perform 1 from public.salary_submission_drafts;
    raise exception 'FAIL anon reads drafts';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.salary_reminder_settings;
    raise exception 'FAIL anon reads settings';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.salary_reminder_tokens;
    raise exception 'FAIL anon reads tokens';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.discard_salary_drafts('2026-09');
    raise exception 'FAIL anon executed discard_salary_drafts';
  exception when insufficient_privilege then null;
  end;
  begin
    perform private.finalize_salary_month('13200000-0000-0000-0000-0000000000a2', '2026-09');
    raise exception 'FAIL anon executed finalize_salary_month';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

do $$ begin raise notice 'plan132 ALL PASS'; end $$;

rollback;
