begin;

create extension if not exists pgtap with schema extensions;

-- Plan 111 — household person identity (account-based). All data is fictional
-- and rolls back. Fixture writes happen as postgres; assertions run through the
-- authenticated role and the same auth.uid()/JWT boundary as PostgREST.
select plan(34);

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

-- Household A has a pending invite (no account yet) so a slot can be pre-assigned.
insert into public.household_invites (household_id, email)
values ('20000000-0000-0000-0000-000000000001', 'invitee@example.invalid');

-- ── section A: owner a1 assigns both people and sets their own name ───────────

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated","email":"person-a1@example.invalid"}',
  true
);

-- Assign slot a to the owner and slot b to the pending invite email.
select is(
  jsonb_array_length(
    public.assign_household_people('person-a1@example.invalid', 'invitee@example.invalid')
      -> 'people'),
  2,
  'assign creates exactly two people'
);
select is(
  (select count(*) from public.household_people
    where household_id = '20000000-0000-0000-0000-000000000001'),
  2::bigint,
  'household A has two people rows'
);
select is(
  public.household_identity() ->> 'my_person_id',
  (select id::text from public.household_people
    where household_id = '20000000-0000-0000-0000-000000000001' and slot = 'a'),
  'the caller is "du" for the slot carrying their own email'
);
select is(
  (public.household_identity() -> 'people' -> 0 ->> 'display_name'),
  'person-a1@example.invalid',
  'an un-named account resolves its display name to its email'
);
select is(
  (public.household_identity() -> 'people' -> 1 ->> 'display_name'),
  'invitee@example.invalid',
  'a pending-invite slot shows the invited email until they join'
);

-- Setting a profile name flows into the identity display name.
select lives_ok(
  $$select public.set_my_profile_name('Alan')$$,
  'the caller can set their own profile name'
);
select is(
  (public.household_identity() -> 'people' -> 0 ->> 'display_name'),
  'Alan',
  'the slot display name becomes the account profile name'
);
select is(
  (select display_name from public.household_roster()
    where user_id = '10000000-0000-0000-0000-000000000001'),
  'Alan',
  'household_roster resolves the profile name'
);
select is(
  (select slot from public.household_roster()
    where user_id = '10000000-0000-0000-0000-000000000001'),
  'a',
  'household_roster reports the member''s assigned slot'
);
select is(
  (select slot from public.household_roster()
    where user_id = '10000000-0000-0000-0000-000000000002'),
  null::text,
  'an unassigned member has a null slot'
);

-- A blank profile name clears it back to the email.
select lives_ok(
  $$select public.set_my_profile_name('   ')$$,
  'a blank profile name is accepted (clears the name)'
);
select is(
  (public.household_identity() -> 'people' -> 0 ->> 'display_name'),
  'person-a1@example.invalid',
  'a cleared profile name falls back to the email'
);
select throws_ok(
  $$select public.set_my_profile_name(repeat('x', 61))$$,
  'P0001', 'invalid profile name',
  'an over-long profile name is rejected'
);

-- ── section B: any member assigns; validation; idempotence ───────────────────

select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000002","role":"authenticated","email":"person-a2@example.invalid"}',
  true
);

-- A plain member (not the owner) may reassign — assigning people is shared.
select is(
  public.assign_household_people('person-a1@example.invalid', 'person-a2@example.invalid') ->> 'my_person_id',
  (select id::text from public.household_people
    where household_id = '20000000-0000-0000-0000-000000000001' and slot = 'b'),
  'any member can assign, and a2 becomes "du" for slot b'
);

create temporary table before_retry as
  select id, slot, assigned_email, updated_at from public.household_people
  where household_id = '20000000-0000-0000-0000-000000000001';

select lives_ok(
  $$select public.assign_household_people('person-a1@example.invalid', 'person-a2@example.invalid')$$,
  'retrying the identical assignment succeeds'
);
select is(
  (select count(*) from public.household_people p
    join before_retry b using (id, slot, assigned_email, updated_at)
    where p.household_id = '20000000-0000-0000-0000-000000000001'),
  2::bigint,
  'retry rewrites nothing: same ids, emails and updated_at'
);

select throws_ok(
  $$select public.assign_household_people('person-a1@example.invalid', 'person-a1@example.invalid')$$,
  'P0001', 'duplicate person email',
  'the two slots cannot share an email'
);
select throws_ok(
  $$select public.assign_household_people('person-a1@example.invalid', 'stranger@nope.invalid')$$,
  'P0001', 'unknown person email',
  'an email that is neither a member nor an invite is rejected'
);

-- Clearing a slot: my_person_id disappears for the cleared account.
select is(
  public.assign_household_people('person-a1@example.invalid', null) ->> 'my_person_id',
  null::text,
  'clearing slot b leaves a2 unassigned (null my_person_id)'
);
select is(
  (select assigned_email from public.household_people
    where household_id = '20000000-0000-0000-0000-000000000001' and slot = 'b'),
  null::text,
  'the cleared slot has a null assigned_email'
);

-- ── section C: cross-household isolation (b1) ────────────────────────────────

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
  public.assign_household_people('person-b1@example.invalid', null) ->> 'household_id',
  '20000000-0000-0000-0000-000000000002',
  'assign only ever writes the caller''s own household'
);
select is(
  (select count(*) from public.household_roster()),
  1::bigint,
  'household_roster stays scoped to the caller''s household'
);

-- ── section D: revoked direct writes + unauthenticated boundary ──────────────

select throws_ok(
  $$insert into public.household_people (household_id, slot, assigned_email)
    values ('20000000-0000-0000-0000-000000000002', 'a', 'x@example.invalid')$$,
  '42501', 'permission denied for table household_people',
  'direct people inserts are revoked; use assign_household_people'
);
select throws_ok(
  $$update public.household_people set assigned_email = 'x@example.invalid'$$,
  '42501', 'permission denied for table household_people',
  'direct people updates are revoked'
);
select throws_ok(
  $$insert into public.profiles (user_id, display_name)
    values ('10000000-0000-0000-0000-000000000003', 'Hax')$$,
  '42501', 'permission denied for table profiles',
  'direct profile writes are revoked; use set_my_profile_name'
);

reset role;
select set_config('request.jwt.claims', '', true);
select throws_ok(
  $$select public.assign_household_people('a@example.invalid', 'b@example.invalid')$$,
  'P0001', 'not authenticated',
  'assign requires an authenticated caller'
);
select throws_ok(
  $$select public.set_my_profile_name('Nope')$$,
  'P0001', 'not authenticated',
  'set_my_profile_name requires an authenticated caller'
);

-- ── section E: leave keeps people; accept-invite starts fresh ────────────────

-- Household C assigns its owner, who then moves to household A via an invite.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000004","role":"authenticated","email":"person-c@example.invalid"}',
  true
);
select is(
  jsonb_array_length(
    public.assign_household_people('person-c@example.invalid', 'person-d@example.invalid') -> 'people'),
  2,
  'household C assigns its own two people'
);
select is(
  public.household_identity() ->> 'my_person_id',
  (select id::text from public.household_people
    where household_id = '20000000-0000-0000-0000-000000000003' and slot = 'a'),
  'the mover is "du" in the old household'
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
-- In household A the mover is only "du" if the household assigned their email.
select is(
  public.household_identity() ->> 'my_person_id',
  null::text,
  'the mover starts unassigned in the new household'
);

reset role;
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
  'the old membership is gone'
);

select * from finish();

rollback;
