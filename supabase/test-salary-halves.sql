-- Plan 139 Stage 1 proof: public.save_salary_half (in-app salary halves),
-- private.salary_validated_items and private.caller_may_create_salary_half.
-- LOCAL DATABASE ONLY. All data is fictional and the whole file runs inside one
-- transaction that is rolled back.
--
-- Run after `supabase db reset`:
--   docker cp supabase/test-salary-halves.sql supabase_db_hemma-os:/tmp/test-salary-halves.sql
--   docker exec supabase_db_hemma-os psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f /tmp/test-salary-halves.sql
-- Success ends with the "plan139 ALL PASS" notice.
--
-- Base golden row (plan 139), hand-checked against buildSubmission
-- (web/src/lib/hushallsbudget.ts):
--   A = Lön 38 450 + Barnbidrag 1 250 = 39 700; B = Lön 31 200 = 31 200;
--   gap = 39 700 − 31 200 = 8 500 ≥ 0 → transfer 8 500 / 2 = 4 250 from a to b;
--   equal_share = (39 700 + 31 200) / 2 = 70 900 / 2 = 35 450.
--
-- Note: now() is constant inside one transaction, so the set_updated_at trigger
-- re-stamps an edited draft with the same updated_at it already had. A "stale"
-- version is therefore simulated as updated_at − 1 second.

begin;

-- ── fixtures (as postgres) ────────────────────────────────────────────────────
-- Household one: both slots assigned to members (B's login email is stored in
--   mixed case to prove the lower() resolution).
-- Household two: slot a assigned to its only member, slot b row with a NULL
--   assigned_email (D3: unassigned).
-- Household three: no slot a row at all (unassigned), slot b assigned to an
--   email that has not signed up (still strictly own-only).

insert into auth.users (id, email, aud, role) values
  ('13900000-0000-0000-0000-000000000001', 'salary139-a@example.invalid', 'authenticated', 'authenticated'),
  ('13900000-0000-0000-0000-000000000002', 'Salary139-B@Example.invalid', 'authenticated', 'authenticated'),
  ('13900000-0000-0000-0000-000000000003', 'salary139-c@example.invalid', 'authenticated', 'authenticated'),
  ('13900000-0000-0000-0000-000000000004', 'salary139-d@example.invalid', 'authenticated', 'authenticated'),
  ('13900000-0000-0000-0000-000000000009', 'salary139-loner@example.invalid', 'authenticated', 'authenticated');
insert into public.households (id, name) values
  ('13900000-0000-0000-0000-0000000000a1', 'Plan 139 household one'),
  ('13900000-0000-0000-0000-0000000000a2', 'Plan 139 household two'),
  ('13900000-0000-0000-0000-0000000000a3', 'Plan 139 household three');
insert into public.household_members (household_id, user_id, role) values
  ('13900000-0000-0000-0000-0000000000a1', '13900000-0000-0000-0000-000000000001', 'owner'),
  ('13900000-0000-0000-0000-0000000000a1', '13900000-0000-0000-0000-000000000002', 'member'),
  ('13900000-0000-0000-0000-0000000000a2', '13900000-0000-0000-0000-000000000003', 'owner'),
  ('13900000-0000-0000-0000-0000000000a3', '13900000-0000-0000-0000-000000000004', 'owner');
insert into public.household_people (household_id, slot, assigned_email) values
  ('13900000-0000-0000-0000-0000000000a1', 'a', 'salary139-a@example.invalid'),
  ('13900000-0000-0000-0000-0000000000a1', 'b', 'salary139-b@example.invalid'),
  ('13900000-0000-0000-0000-0000000000a2', 'a', 'salary139-c@example.invalid'),
  ('13900000-0000-0000-0000-0000000000a2', 'b', null),
  ('13900000-0000-0000-0000-0000000000a3', 'b', 'pending139@example.invalid');
insert into public.profiles (user_id, display_name) values
  ('13900000-0000-0000-0000-000000000001', 'Anna'),
  ('13900000-0000-0000-0000-000000000002', 'Bo');

-- Simulate an authenticated caller (same claims shape as the other test files).
create function pg_temp.plan139_as(p_user text) returns void language sql as $$
  select set_config('request.jwt.claims',
    pg_catalog.json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
-- The session's temp schema must be usable by the simulated client roles.
do $$ begin
  execute format('grant usage on schema %I to authenticated, anon',
    (select nspname from pg_catalog.pg_namespace where oid = pg_catalog.pg_my_temp_schema()));
end $$;
grant execute on function pg_temp.plan139_as(text) to authenticated;

-- Expect a SQLSTATE from one dynamic statement.
create function pg_temp.plan139_expect(p_sql text, p_state text, p_label text) returns void
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
grant execute on function pg_temp.plan139_expect(text, text, text) to authenticated, anon;

-- ── own create → pending; other's assigned slot → 42501 ───────────────────────

set local role authenticated;

do $$
declare
  hh1 uuid := '13900000-0000-0000-0000-0000000000a1';
  res jsonb;
  d public.salary_submission_drafts%rowtype;
begin
  perform pg_temp.plan139_as('13900000-0000-0000-0000-000000000001');

  res := public.save_salary_half('2026-01', 'a',
    '[{"label":" Lön ","amount":38450},{"label":"Barnbidrag","amount":1250},{"label":"  ","amount":0}]',
    ' Bonus ', null);
  if res ->> 'status' <> 'pending' or res ->> 'updated_at' is null then
    raise exception 'FAIL own create: %', res; end if;
  select * into strict d from public.salary_submission_drafts
   where household_id = hh1 and month = '2026-01' and slot = 'a';
  if d.income_items <> '[{"label":"Lön","amount":38450},{"label":"Barnbidrag","amount":1250}]'::jsonb
     or d.note is distinct from 'Bonus' or d.submitted_via <> 'app'
     or (res ->> 'updated_at')::timestamptz <> d.updated_at then
    raise exception 'FAIL own create draft: % % % %', d.income_items, d.note, d.submitted_via, d.updated_at; end if;

  -- A creating B's assigned half: refused, nothing written.
  perform pg_temp.plan139_expect(
    $s$select public.save_salary_half('2026-01', 'b', '[{"label":"Lön","amount":31200}]', null, null)$s$,
    '42501', 'other''s assigned slot');
  if exists (select 1 from public.salary_submission_drafts
              where household_id = hh1 and month = '2026-01' and slot = 'b') then
    raise exception 'FAIL forbidden create wrote a draft'; end if;
end $$;

-- ── second half (B, mixed-case login email) → finalized with the base golden ──

do $$
declare
  hh1 uuid := '13900000-0000-0000-0000-0000000000a1';
  res jsonb;
  r public.salary_submissions%rowtype;
begin
  perform pg_temp.plan139_as('13900000-0000-0000-0000-000000000002');
  res := public.save_salary_half('2026-01', 'b', '[{"label":"Lön","amount":31200}]', '', null);
  if res ->> 'status' <> 'finalized' or not (res ? 'updated_at')
     or res -> 'updated_at' <> 'null'::jsonb then
    raise exception 'FAIL second half: %', res; end if;

  select * into strict r from public.salary_submissions where household_id = hh1 and month = '2026-01';
  if r.income_a <> 39700 or r.income_b <> 31200 then
    raise exception 'FAIL base incomes: % / %', r.income_a, r.income_b; end if;
  if r.transfer_amount <> 4250 or r.transfer_amount::text <> '4250'
     or r.transfer_from <> 'a' or r.transfer_to <> 'b' then
    raise exception 'FAIL base transfer: % % → %', r.transfer_amount, r.transfer_from, r.transfer_to; end if;
  if r.equal_share <> 35450 or r.equal_share::text <> '35450' then
    raise exception 'FAIL base equal_share: %', r.equal_share; end if;
  if r.income_items <> '[{"owner":"a","label":"Lön","amount":38450},
                         {"owner":"a","label":"Barnbidrag","amount":1250},
                         {"owner":"b","label":"Lön","amount":31200}]'::jsonb then
    raise exception 'FAIL base income_items: %', r.income_items; end if;
  if r.note is distinct from 'Bonus' then raise exception 'FAIL base note: %', r.note; end if;
  if r.person_a_name <> 'Anna' or r.person_b_name <> 'Bo' then
    raise exception 'FAIL base names: % / %', r.person_a_name, r.person_b_name; end if;
  if r.revision <> 1 then raise exception 'FAIL base revision: %', r.revision; end if;
  if exists (select 1 from public.salary_submission_drafts where household_id = hh1 and month = '2026-01') then
    raise exception 'FAIL base: drafts not cleared'; end if;
end $$;

-- ── save on a completed month → already_logged, nothing written ───────────────

do $$
declare
  hh1 uuid := '13900000-0000-0000-0000-0000000000a1';
  res jsonb;
begin
  perform pg_temp.plan139_as('13900000-0000-0000-0000-000000000001');
  res := public.save_salary_half('2026-01', 'a', '[{"label":"Lön","amount":99999}]', null, null);
  if res <> '{"status":"already_logged"}'::jsonb then raise exception 'FAIL already_logged: %', res; end if;
  -- Even an edit-shaped call (non-null expected) is already_logged, not a conflict.
  res := public.save_salary_half('2026-01', 'b', '[{"label":"Lön","amount":1}]', null, now());
  if res ->> 'status' <> 'already_logged' then raise exception 'FAIL already_logged edit-shaped: %', res; end if;
  if exists (select 1 from public.salary_submission_drafts where household_id = hh1 and month = '2026-01') then
    raise exception 'FAIL already_logged wrote a draft'; end if;
  if (select count(*) from public.salary_submissions where household_id = hh1 and month = '2026-01') <> 1
     or (select income_a from public.salary_submissions where household_id = hh1 and month = '2026-01') <> 39700 then
    raise exception 'FAIL already_logged changed the month row'; end if;
end $$;

-- ── edit: any member, matching updated_at ok; stale / null → 40001 ────────────

do $$
declare
  hh1 uuid := '13900000-0000-0000-0000-0000000000a1';
  res jsonb;
  seen timestamptz;
  d public.salary_submission_drafts%rowtype;
begin
  perform pg_temp.plan139_as('13900000-0000-0000-0000-000000000001');
  res := public.save_salary_half('2026-02', 'a', '[{"label":"Lön","amount":38450}]', 'Första', null);
  if res ->> 'status' <> 'pending' then raise exception 'FAIL edit setup: %', res; end if;
  seen := (res ->> 'updated_at')::timestamptz;

  -- B edits A's existing half (D2: editing is anyone) against the version seen.
  perform pg_temp.plan139_as('13900000-0000-0000-0000-000000000002');
  perform pg_temp.plan139_expect(
    format($s$select public.save_salary_half('2026-02', 'a', '[{"label":"Lön","amount":1}]', null, %L)$s$,
           seen - interval '1 second'),
    '40001', 'stale updated_at');
  perform pg_temp.plan139_expect(
    $s$select public.save_salary_half('2026-02', 'a', '[{"label":"Lön","amount":1}]', null, null)$s$,
    '40001', 'null updated_at on an existing half');
  select * into strict d from public.salary_submission_drafts
   where household_id = hh1 and month = '2026-02' and slot = 'a';
  if d.income_items <> '[{"label":"Lön","amount":38450}]'::jsonb or d.note <> 'Första' then
    raise exception 'FAIL conflict changed the draft: % %', d.income_items, d.note; end if;

  res := public.save_salary_half('2026-02', 'a',
    '[{"label":"Lön","amount":39000},{"label":"Återbetalning","amount":-1500}]', null, seen);
  if res ->> 'status' <> 'pending' or res ->> 'updated_at' is null then
    raise exception 'FAIL matching edit: %', res; end if;
  select * into strict d from public.salary_submission_drafts
   where household_id = hh1 and month = '2026-02' and slot = 'a';
  if d.income_items <> '[{"label":"Lön","amount":39000},{"label":"Återbetalning","amount":-1500}]'::jsonb
     or d.note is not null or d.submitted_via <> 'app' then
    raise exception 'FAIL matching edit draft: % % %', d.income_items, d.note, d.submitted_via; end if;

  -- A half that does not exist but is "edited" (it vanished) → conflict, not create.
  perform pg_temp.plan139_expect(
    format($s$select public.save_salary_half('2026-02', 'b', '[{"label":"Lön","amount":1}]', null, %L)$s$, seen),
    '40001', 'edit of a missing half');
  if exists (select 1 from public.salary_submission_drafts
              where household_id = hh1 and month = '2026-02' and slot = 'b') then
    raise exception 'FAIL edit of missing half wrote a draft'; end if;
end $$;

-- ── edit of an emailed half: submitted_via becomes 'app' (channel of latest save) ──

reset role;
insert into public.salary_submission_drafts (household_id, month, slot, income_items, note, submitted_via)
  values ('13900000-0000-0000-0000-0000000000a1', '2026-04', 'b', '[{"label":"Lön","amount":31200}]', 'via mejl', 'email');
set local role authenticated;

do $$
declare
  hh1 uuid := '13900000-0000-0000-0000-0000000000a1';
  res jsonb;
  seen timestamptz;
begin
  perform pg_temp.plan139_as('13900000-0000-0000-0000-000000000001');
  select updated_at into strict seen from public.salary_submission_drafts
   where household_id = hh1 and month = '2026-04' and slot = 'b';
  res := public.save_salary_half('2026-04', 'b', '[{"label":"Lön","amount":32000}]', 'via mejl', seen);
  if res ->> 'status' <> 'pending' then raise exception 'FAIL emailed edit: %', res; end if;
  if (select submitted_via from public.salary_submission_drafts
       where household_id = hh1 and month = '2026-04' and slot = 'b') <> 'app' then
    raise exception 'FAIL emailed edit submitted_via'; end if;
end $$;

-- ── zero total → zero_total, both halves kept with their updated_at ──────────

do $$
declare
  hh1 uuid := '13900000-0000-0000-0000-0000000000a1';
  res jsonb;
begin
  perform pg_temp.plan139_as('13900000-0000-0000-0000-000000000001');
  res := public.save_salary_half('2026-03', 'a', '[{"label":"Lön","amount":0}]', null, null);
  if res ->> 'status' <> 'pending' then raise exception 'FAIL zero setup: %', res; end if;
  perform pg_temp.plan139_as('13900000-0000-0000-0000-000000000002');
  res := public.save_salary_half('2026-03', 'b', '[]', null, null);
  if res ->> 'status' <> 'zero_total' or res ->> 'updated_at' is null then
    raise exception 'FAIL zero_total: %', res; end if;
  if (select count(*) from public.salary_submission_drafts where household_id = hh1 and month = '2026-03') <> 2
     or exists (select 1 from public.salary_submissions where household_id = hh1 and month = '2026-03') then
    raise exception 'FAIL zero_total side effects'; end if;
end $$;

-- ── validator limits and argument checks → 22023, nothing written ─────────────

do $$
declare
  hh1 uuid := '13900000-0000-0000-0000-0000000000a1';
  res jsonb;
  twenty_one jsonb := (select jsonb_agg(jsonb_build_object('label', '', 'amount', 0))
                         from generate_series(1, 21));
  twenty jsonb := (select jsonb_agg(jsonb_build_object('label', 'Rad ' || g, 'amount', g))
                     from generate_series(1, 20) g);
  sql text := $s$select public.save_salary_half(%L, %L, %L::jsonb, %L, null)$s$;
begin
  perform pg_temp.plan139_as('13900000-0000-0000-0000-000000000001');

  -- 21 raw items (even all blank+zero: counted before dropping) → reject.
  perform pg_temp.plan139_expect(format(sql, '2026-05', 'a', twenty_one, null), '22023', '21 items');
  -- 81-character label after trim → reject.
  perform pg_temp.plan139_expect(format(sql, '2026-05', 'a',
    jsonb_build_array(jsonb_build_object('label', repeat('x', 81), 'amount', 1)), null), '22023', '81-char label');
  -- |amount| 10 000 001 either way → reject.
  perform pg_temp.plan139_expect(format(sql, '2026-05', 'a',
    '[{"label":"Lön","amount":10000001}]', null), '22023', 'amount 10000001');
  perform pg_temp.plan139_expect(format(sql, '2026-05', 'a',
    '[{"label":"Lön","amount":-10000001}]', null), '22023', 'amount -10000001');
  perform pg_temp.plan139_expect(format(sql, '2026-05', 'a',
    '[{"label":"Lön","amount":10000000.01}]', null), '22023', 'amount 10000000.01');
  -- 201-character note after trim → reject.
  perform pg_temp.plan139_expect(format(sql, '2026-05', 'a',
    '[{"label":"Lön","amount":1}]', repeat('n', 201)), '22023', '201-char note');
  -- Shape errors: string amount, missing label, non-object item, non-array.
  perform pg_temp.plan139_expect(format(sql, '2026-05', 'a',
    '[{"label":"Lön","amount":"41000"}]', null), '22023', 'string amount');
  perform pg_temp.plan139_expect(format(sql, '2026-05', 'a',
    '[{"amount":41000}]', null), '22023', 'missing label');
  perform pg_temp.plan139_expect(format(sql, '2026-05', 'a', '[41000]', null), '22023', 'non-object item');
  perform pg_temp.plan139_expect(format(sql, '2026-05', 'a', '{"label":"Lön"}', null), '22023', 'non-array items');
  perform pg_temp.plan139_expect(
    $s$select public.save_salary_half('2026-05', 'a', null, null, null)$s$, '22023', 'null items');
  -- Bad slot / month.
  perform pg_temp.plan139_expect(format(sql, '2026-05', 'c', '[]', null), '22023', 'bad slot');
  perform pg_temp.plan139_expect(format(sql, '2026-5', 'a', '[]', null), '22023', 'bad month');
  perform pg_temp.plan139_expect(format(sql, null, 'a', '[]', null), '22023', 'null month');
  if exists (select 1 from public.salary_submission_drafts where household_id = hh1 and month = '2026-05') then
    raise exception 'FAIL rejected input wrote a draft'; end if;

  -- Boundaries are accepted: 20 items, 80-char label (padded), ±10 000 000,
  -- 200-char note (padded with whitespace that is trimmed away).
  res := public.save_salary_half('2026-05', 'a', twenty, null, null);
  if res ->> 'status' <> 'pending'
     or (select jsonb_array_length(income_items) from public.salary_submission_drafts
          where household_id = hh1 and month = '2026-05' and slot = 'a') <> 20 then
    raise exception 'FAIL 20 items boundary: %', res; end if;
  res := public.save_salary_half('2026-05', 'a',
    jsonb_build_array(
      jsonb_build_object('label', '  ' || repeat('x', 80) || '  ', 'amount', 10000000),
      jsonb_build_object('label', 'Skatt', 'amount', -10000000)),
    E'  ' || repeat('n', 200) || E'\n',
    (res ->> 'updated_at')::timestamptz);
  if res ->> 'status' <> 'pending' then raise exception 'FAIL boundary edit: %', res; end if;
  if (select income_items -> 0 ->> 'label' from public.salary_submission_drafts
       where household_id = hh1 and month = '2026-05' and slot = 'a') <> repeat('x', 80)
     or (select length(note) from public.salary_submission_drafts
          where household_id = hh1 and month = '2026-05' and slot = 'a') <> 200 then
    raise exception 'FAIL boundary values not trimmed/kept'; end if;
end $$;

-- ── D3: unassigned slot (NULL email, or no household_people row) → allowed ────
-- ── an assigned slot whose person has not signed up stays own-only ───────────

do $$
declare
  hh2 uuid := '13900000-0000-0000-0000-0000000000a2';
  hh3 uuid := '13900000-0000-0000-0000-0000000000a3';
  res jsonb;
begin
  perform pg_temp.plan139_as('13900000-0000-0000-0000-000000000003');
  res := public.save_salary_half('2026-02', 'b', '[{"label":"Lön","amount":30000}]', null, null);
  if res ->> 'status' <> 'pending' then raise exception 'FAIL D3 null-email slot: %', res; end if;
  res := public.save_salary_half('2026-02', 'a', '[{"label":"Lön","amount":32000}]', null, null);
  if res ->> 'status' <> 'finalized' then raise exception 'FAIL D3 own half finalize: %', res; end if;
  if (select transfer_amount::text || transfer_from || transfer_to || equal_share::text
        from public.salary_submissions where household_id = hh2 and month = '2026-02') <> '1000ab31000' then
    raise exception 'FAIL D3 finalized row'; end if;

  perform pg_temp.plan139_as('13900000-0000-0000-0000-000000000004');
  res := public.save_salary_half('2026-02', 'a', '[{"label":"Lön","amount":30000}]', null, null);
  if res ->> 'status' <> 'pending' then raise exception 'FAIL D3 missing-row slot: %', res; end if;
  perform pg_temp.plan139_expect(
    $s$select public.save_salary_half('2026-02', 'b', '[{"label":"Lön","amount":1}]', null, null)$s$,
    '42501', 'assigned-but-not-signed-up slot');
  if exists (select 1 from public.salary_submission_drafts where household_id = hh3 and slot = 'b') then
    raise exception 'FAIL not-signed-up slot got a draft'; end if;
end $$;

-- ── cross-household: a caller only ever touches their own household ──────────

do $$
declare
  res jsonb;
begin
  -- Household two's member saves 2026-04 slot b — household one also has a
  -- pending 2026-04 slot b draft (from the emailed-edit case above).
  perform pg_temp.plan139_as('13900000-0000-0000-0000-000000000003');
  if exists (select 1 from public.salary_submission_drafts
              where household_id = '13900000-0000-0000-0000-0000000000a1') then
    raise exception 'FAIL cross-household drafts visible'; end if;
  -- Household one's half version is no use here: it is not an edit of anything
  -- in household two, so a non-null expected updated_at is a conflict.
  perform pg_temp.plan139_expect(
    $s$select public.save_salary_half('2026-04', 'b', '[{"label":"Lön","amount":5}]', null, now())$s$,
    '40001', 'cross-household edit-shaped call');
  res := public.save_salary_half('2026-04', 'b', '[{"label":"Lön","amount":5}]', null, null);
  if res ->> 'status' <> 'pending' then raise exception 'FAIL cross-household own save: %', res; end if;
end $$;

reset role;

do $$
begin
  if (select income_items::text || note from public.salary_submission_drafts
       where household_id = '13900000-0000-0000-0000-0000000000a1' and month = '2026-04' and slot = 'b')
     <> '[{"label": "Lön", "amount": 32000}]via mejl' then
    raise exception 'FAIL cross-household save changed household one'; end if;
  if (select income_items from public.salary_submission_drafts
       where household_id = '13900000-0000-0000-0000-0000000000a2' and month = '2026-04' and slot = 'b')
     <> '[{"label":"Lön","amount":5}]'::jsonb then
    raise exception 'FAIL cross-household save not in own household'; end if;
  if (select count(*) from public.salary_submissions
       where household_id = '13900000-0000-0000-0000-0000000000a1') <> 1 then
    raise exception 'FAIL household one month rows changed'; end if;
end $$;

-- ── household-less authenticated caller → 42501 ───────────────────────────────

set local role authenticated;
do $$
begin
  perform pg_temp.plan139_as('13900000-0000-0000-0000-000000000009');
  perform pg_temp.plan139_expect(
    $s$select public.save_salary_half('2026-02', 'a', '[{"label":"Lön","amount":1}]', null, null)$s$,
    '42501', 'household-less caller');

  -- The private helpers are not client-executable.
  perform pg_temp.plan139_as('13900000-0000-0000-0000-000000000001');
  perform pg_temp.plan139_expect(
    $s$select private.salary_validated_items('[]')$s$, '42501', 'client executes salary_validated_items');
  perform pg_temp.plan139_expect(
    $s$select private.caller_may_create_salary_half('13900000-0000-0000-0000-0000000000a1', 'b')$s$,
    '42501', 'client executes caller_may_create_salary_half');
  -- And direct draft writes are still refused (plan 132 grants unchanged).
  perform pg_temp.plan139_expect(
    $s$insert into public.salary_submission_drafts (household_id, month, slot, income_items, submitted_via)
       values ('13900000-0000-0000-0000-0000000000a1', '2026-09', 'a', '[]', 'app')$s$,
    '42501', 'client direct draft insert');
end $$;
reset role;

-- ── anon: cannot execute ──────────────────────────────────────────────────────

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
do $$
begin
  perform pg_temp.plan139_expect(
    $s$select public.save_salary_half('2026-02', 'a', '[{"label":"Lön","amount":1}]', null, null)$s$,
    '42501', 'anon executes save_salary_half');
end $$;
reset role;

-- Grants as catalogued (belt and braces for the role checks above).
do $$
begin
  if has_function_privilege('anon', 'public.save_salary_half(text, text, jsonb, text, timestamptz)', 'execute')
     or not has_function_privilege('authenticated', 'public.save_salary_half(text, text, jsonb, text, timestamptz)', 'execute')
     or has_function_privilege('authenticated', 'private.salary_validated_items(jsonb)', 'execute')
     or has_function_privilege('authenticated', 'private.caller_may_create_salary_half(uuid, text)', 'execute')
     or has_function_privilege('anon', 'private.caller_may_create_salary_half(uuid, text)', 'execute') then
    raise exception 'FAIL function grants';
  end if;
end $$;

do $$ begin raise notice 'plan139 ALL PASS'; end $$;

rollback;
