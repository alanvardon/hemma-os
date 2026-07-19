begin;

create extension if not exists pgtap with schema extensions;

-- Plan 111 Stage 1 — household person identity. All data is fictional and all
-- changes roll back. Fixture writes happen as postgres; assertions run through
-- the authenticated role and the same auth.uid()/JWT boundary as PostgREST.
select plan(41);

insert into auth.users (id, email)
values
  ('10000000-0000-0000-0000-000000000001', 'person-a1@example.invalid'),
  ('10000000-0000-0000-0000-000000000002', 'person-a2@example.invalid'),
  ('10000000-0000-0000-0000-000000000003', 'person-b1@example.invalid'),
  ('10000000-0000-0000-0000-000000000004', 'person-c@example.invalid'),
  ('10000000-0000-0000-0000-000000000005', 'person-d@example.invalid');

insert into public.households (id, name)
values
  ('20000000-0000-0000-0000-000000000001', 'Fictional household A'),
  ('20000000-0000-0000-0000-000000000002', 'Fictional household B'),
  ('20000000-0000-0000-0000-000000000003', 'Fictional household C');

insert into public.household_members (household_id, user_id, role)
values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'owner'),
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'member'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000003', 'owner'),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000004', 'owner'),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000005', 'member');

-- ── section A: configure + read as user a1 (household A owner) ───────────────

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated","email":"person-a1@example.invalid"}',
  true
);

select is(
  jsonb_array_length(
    public.configure_household_people('Alex', 'Sam', 'bolanekoll', 'a', 'b')
      -> 'people'),
  2,
  'configure creates exactly two canonical people'
);
select is(
  (select count(*) from public.household_people
    where household_id = '20000000-0000-0000-0000-000000000001'),
  2::bigint,
  'household A has two people rows'
);
select is(
  public.household_identity() -> 'bindings' -> 'bolanekoll' ->> 'a',
  (select id::text from public.household_people
    where household_id = '20000000-0000-0000-0000-000000000001' and slot = 'a'),
  'bolanekoll tool slot a is bound to canonical person a'
);
select is(
  public.household_identity() ->> 'my_person_id',
  null::text,
  'a fresh configuration leaves the caller unmapped'
);

create temporary table before_retry as
  select id, slot, display_name, updated_at from public.household_people
  where household_id = '20000000-0000-0000-0000-000000000001';

select is(
  jsonb_array_length(
    public.configure_household_people('Alex', 'Sam', 'bolanekoll', 'a', 'b')
      -> 'people'),
  2,
  'retrying the identical configure call succeeds'
);
select is(
  (select count(*) from public.household_people p
    join before_retry b using (id, slot, display_name, updated_at)
    where p.household_id = '20000000-0000-0000-0000-000000000001'),
  2::bigint,
  'retry rewrites nothing: same person ids, names and updated_at'
);
select is(
  (select count(*) from public.household_tool_person_bindings
    where household_id = '20000000-0000-0000-0000-000000000001'),
  2::bigint,
  'retry does not duplicate bindings'
);

select throws_ok(
  $$select public.configure_household_people('Alex', 'Sam', 'bolanekoll', 'a', null)$$,
  'P0001', 'incomplete tool binding',
  'a binding missing one tool slot is rejected'
);
select throws_ok(
  $$select public.configure_household_people('Alex', 'Sam', 'bolanekoll', 'a', 'a')$$,
  'P0001', 'duplicate tool binding',
  'binding both tool slots to the same person is rejected'
);
select throws_ok(
  $$select public.configure_household_people('Alex', 'Sam', 'okand-verktyg', 'a', 'b')$$,
  'P0001', 'invalid tool',
  'an unknown tool is rejected'
);
select throws_ok(
  $$select public.configure_household_people('   ', 'Sam')$$,
  'P0001', 'invalid person name',
  'a blank person name is rejected'
);

-- A tool may bind canonical person b to its legacy slot a (swap) and back.
select is(
  public.configure_household_people('Alex', 'Sam', 'bolanekoll', 'b', 'a')
    -> 'bindings' -> 'bolanekoll' ->> 'a',
  (select id::text from public.household_people
    where household_id = '20000000-0000-0000-0000-000000000001' and slot = 'b'),
  'a swapped binding maps tool slot a to canonical person b'
);
select is(
  public.configure_household_people('Alex', 'Sam', 'bolanekoll', 'a', 'b')
    -> 'bindings' -> 'bolanekoll' ->> 'a',
  (select id::text from public.household_people
    where household_id = '20000000-0000-0000-0000-000000000001' and slot = 'a'),
  'the binding can be swapped back without constraint conflicts'
);

select lives_ok(
  $$select public.set_my_household_person(
      (select id from public.household_people
        where household_id = '20000000-0000-0000-0000-000000000001' and slot = 'a'))$$,
  'the caller can claim a person of their household'
);
select is(
  public.household_identity() ->> 'my_person_id',
  (select id::text from public.household_people
    where household_id = '20000000-0000-0000-0000-000000000001' and slot = 'a'),
  'household_identity reports the caller mapping'
);
select lives_ok(
  $$select public.set_my_household_person(
      (select id from public.household_people
        where household_id = '20000000-0000-0000-0000-000000000001' and slot = 'a'))$$,
  'retrying the same mapping is an idempotent no-op'
);
select is(
  (select person_display_name from public.household_roster()
    where user_id = '10000000-0000-0000-0000-000000000001'),
  'Alex',
  'household_roster exposes the mapped display name'
);
select is(
  (select count(*) from public.household_roster() where person_id is null),
  1::bigint,
  'household_roster shows the unmapped member with a null person'
);

-- ── section B: second account a2 — duplicate claim and caller-only writes ────

select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000002","role":"authenticated","email":"person-a2@example.invalid"}',
  true
);

select throws_ok(
  $$select public.set_my_household_person(
      (select id from public.household_people
        where household_id = '20000000-0000-0000-0000-000000000001' and slot = 'a'))$$,
  'P0001', 'person already claimed',
  'two accounts cannot claim the same person'
);
select lives_ok(
  $$select public.set_my_household_person(
      (select id from public.household_people
        where household_id = '20000000-0000-0000-0000-000000000001' and slot = 'b'))$$,
  'the second account claims the remaining person'
);
-- PostgreSQL requires a data-modifying CTE at statement top level; this helper
-- keeps the affected-row assertion valid (same as household_isolation_test).
create function pg_temp.assert_affected(
  p_statement text,
  p_expected bigint,
  p_description text
) returns text
language plpgsql
as $$
declare
  affected bigint;
begin
  execute format(
    'with changed as (%s returning 1) select count(*) from changed',
    p_statement
  ) into affected;
  return extensions.is(affected, p_expected, p_description);
end;
$$;

select pg_temp.assert_affected(
  $$update public.household_members set person_id = null
    where user_id = '10000000-0000-0000-0000-000000000001'$$,
  0::bigint,
  'a member cannot rewrite another account''s mapping directly'
);
select throws_ok(
  $$insert into public.household_people (household_id, slot, display_name)
    values ('20000000-0000-0000-0000-000000000001', 'a', 'Intrang')$$,
  '42501', 'permission denied for table household_people',
  'direct people inserts are revoked; use configure_household_people'
);
select throws_ok(
  $$update public.household_people set display_name = 'Intrang'$$,
  '42501', 'permission denied for table household_people',
  'direct people updates are revoked'
);
select throws_ok(
  $$insert into public.household_tool_person_bindings
      (household_id, tool, tool_slot, person_id)
    select '20000000-0000-0000-0000-000000000001', 'manadsavslut', 'a', id
      from public.household_people
      where household_id = '20000000-0000-0000-0000-000000000001' and slot = 'a'$$,
  '42501', 'permission denied for table household_tool_person_bindings',
  'direct binding inserts are revoked'
);
select throws_ok(
  $$delete from public.household_tool_person_bindings$$,
  '42501', 'permission denied for table household_tool_person_bindings',
  'direct binding deletes are revoked'
);

-- ── section C: cross-household isolation as user b1 (household B) ────────────

select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000003","role":"authenticated","email":"person-b1@example.invalid"}',
  true
);

select is(
  (select count(*) from public.household_people
    where household_id = '20000000-0000-0000-0000-000000000001'),
  0::bigint,
  'a foreign household''s people are invisible'
);
select is(
  (select count(*) from public.household_tool_person_bindings
    where household_id = '20000000-0000-0000-0000-000000000001'),
  0::bigint,
  'a foreign household''s bindings are invisible'
);
select is(
  public.configure_household_people('Berit', 'Bosse') ->> 'household_id',
  '20000000-0000-0000-0000-000000000002',
  'configure only ever writes the caller''s own household'
);
-- household A's raw person id survives in the pg_temp snapshot, so this claim
-- attempt is a real foreign uuid even though RLS hides the row from b1.
select throws_ok(
  $$select public.set_my_household_person(
      (select id from before_retry where slot = 'a'))$$,
  'P0001', 'person not in household',
  'claiming a person of a foreign household is rejected'
);
select is(
  (select count(*) from public.household_roster()),
  1::bigint,
  'household_roster stays scoped to the caller''s household'
);

-- request.jwt.claims is transaction-scoped, so clear it explicitly to test the
-- unauthenticated boundary.
reset role;
select set_config('request.jwt.claims', '', true);
select throws_ok(
  $$select public.set_my_household_person(
      (select id from before_retry where slot = 'a'))$$,
  'P0001', 'not authenticated',
  'the mapping RPC requires an authenticated caller'
);

-- ── section D: leaving removes the mapping but keeps the people ──────────────

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000002","role":"authenticated","email":"person-a2@example.invalid"}',
  true
);
select lives_ok(
  $$select public.leave_household()$$,
  'the mapped second member can leave the household'
);

reset role;
select is(
  (select count(*) from public.household_members
    where user_id = '10000000-0000-0000-0000-000000000002'),
  0::bigint,
  'leaving removes the membership row and with it the mapping'
);
select is(
  (select count(*) from public.household_people
    where household_id = '20000000-0000-0000-0000-000000000001'),
  2::bigint,
  'leaving never deletes household_people rows'
);
select is(
  (select count(*) from public.household_members m
    join public.household_people p
      on p.household_id = m.household_id and p.id = m.person_id
    where p.household_id = '20000000-0000-0000-0000-000000000001'
      and p.slot = 'b'),
  0::bigint,
  'the departed member''s person is unclaimed and reusable'
);

-- ── section E: accepting an invite starts unmapped ───────────────────────────

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000004","role":"authenticated","email":"person-c@example.invalid"}',
  true
);
select is(
  jsonb_array_length(
    public.configure_household_people('Cesar', 'Doris') -> 'people'),
  2,
  'household C configures its own people before the move'
);
select lives_ok(
  $$select public.set_my_household_person(
      (select id from public.household_people
        where household_id = '20000000-0000-0000-0000-000000000003' and slot = 'a'))$$,
  'the mover is mapped in the old household'
);

reset role;
insert into public.household_invites (household_id, email)
values ('20000000-0000-0000-0000-000000000001', 'person-c@example.invalid');

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000004","role":"authenticated","email":"person-c@example.invalid"}',
  true
);
select is(
  public.accept_invite(),
  '20000000-0000-0000-0000-000000000001'::uuid,
  'the invite moves the account into household A'
);

reset role;
select is(
  (select person_id from public.household_members
    where user_id = '10000000-0000-0000-0000-000000000004'),
  null::uuid,
  'the new membership starts unmapped — identity never crosses households'
);
select is(
  (select count(*) from public.household_people
    where household_id = '20000000-0000-0000-0000-000000000003'),
  2::bigint,
  'the abandoned household keeps its people rows'
);
select is(
  (select count(*) from public.household_members
    where user_id = '10000000-0000-0000-0000-000000000004'
      and household_id = '20000000-0000-0000-0000-000000000003'),
  0::bigint,
  'the old membership (and its mapping) is gone'
);

select * from finish();

rollback;
