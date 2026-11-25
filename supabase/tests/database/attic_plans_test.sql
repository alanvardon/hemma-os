begin;

create extension if not exists pgtap with schema extensions;
-- Plan 140: attic_plans is a household-owned, revisioned sync resource whose
-- `plan` jsonb document round-trips through sync_apply_rows. All data is
-- fictional and everything rolls back.
select plan(17);

insert into auth.users(id, email) values
  ('61000000-0000-0000-0000-000000000001', 'attic-a@example.invalid'),
  ('61000000-0000-0000-0000-000000000002', 'attic-b@example.invalid');
insert into public.households(id, name) values
  ('62000000-0000-0000-0000-000000000001', 'Attic fixture A'),
  ('62000000-0000-0000-0000-000000000002', 'Attic fixture B');
insert into public.household_members(household_id, user_id, role) values
  ('62000000-0000-0000-0000-000000000001', '61000000-0000-0000-0000-000000000001', 'owner'),
  ('62000000-0000-0000-0000-000000000002', '61000000-0000-0000-0000-000000000002', 'owner');
insert into public.attic_plans(id, household_id, plan) values
  ('63000000-0000-0000-0000-00000000000b', '62000000-0000-0000-0000-000000000002',
   '{"v":2,"items":[{"id":"secret","type":"bed"}]}');

select is(
  (select array[private.sync_table_for_resource('attic_plans')]
     || private.sync_allowed_row_keys('attic_plans')),
  array['attic_plans','id','created_at','name','schema_version','plan'],
  'attic_plans maps to its table with exactly the client-owned keys'
);
select ok(private.sync_resource_allowed('attic_plans'), 'attic_plans is an allowed sync resource');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"61000000-0000-0000-0000-000000000001","role":"authenticated","email":"attic-a@example.invalid"}', true);

select is((select count(*) from public.attic_plans), 0::bigint,
  'household A cannot see household B''s plan');
select throws_ok(
  $$insert into public.attic_plans(id, household_id, plan)
    values ('63000000-0000-0000-0000-0000000000a1', '62000000-0000-0000-0000-000000000002', '{}')$$,
  '42501', 'permission denied for table attic_plans',
  'a direct insert with household B''s id is rejected'
);
select throws_ok(
  $$insert into public.attic_plans(id, plan) values ('63000000-0000-0000-0000-0000000000a2', '{}')$$,
  '42501', 'permission denied for table attic_plans',
  'a direct own insert is rejected; writes go through sync_apply_rows'
);

select is((public.sync_apply_rows(
  'attic-create', 'attic_plans',
  '[{"id":"63000000-0000-0000-0000-00000000000a","created_at":"2026-11-25T10:00:00Z","name":"Vindsplanen","schema_version":2,"plan":{"v":2,"items":[{"id":"i1","type":"bed","x":1.25,"z":-0.5}],"options":{"knee":{"N":[4,5,6],"S":[]}}}}]',
  '{"attic_plans:63000000-0000-0000-0000-00000000000a":null}', false
)->'revisions'->>'attic_plans:63000000-0000-0000-0000-00000000000a'), '1',
  'a new plan row receives revision one');
select is(
  (select plan from public.attic_plans where id = '63000000-0000-0000-0000-00000000000a'),
  '{"v":2,"items":[{"id":"i1","type":"bed","x":1.25,"z":-0.5}],"options":{"knee":{"N":[4,5,6],"S":[]}}}'::jsonb,
  'the plan jsonb document round-trips as a nested value'
);
select ok(
  (select household_id = '62000000-0000-0000-0000-000000000001' and revision = 1
     and name = 'Vindsplanen' and schema_version = 2
   from public.attic_plans where id = '63000000-0000-0000-0000-00000000000a'),
  'the row is owned by the caller household'
);
select is((public.sync_apply_rows(
  'attic-update', 'attic_plans',
  '[{"id":"63000000-0000-0000-0000-00000000000a","plan":{"v":2,"items":[]}}]',
  '{"attic_plans:63000000-0000-0000-0000-00000000000a":1}', false
)->'revisions'->>'attic_plans:63000000-0000-0000-0000-00000000000a'), '2',
  'a matching update advances the revision');
select is((public.sync_apply_rows(
  'attic-stale', 'attic_plans',
  '[{"id":"63000000-0000-0000-0000-00000000000a","plan":{"v":2,"items":[{"id":"stale"}]}}]',
  '{"attic_plans:63000000-0000-0000-0000-00000000000a":1}', false
)->>'status'), 'conflict', 'a save from a stale revision is a conflict');
select is(
  (select plan from public.attic_plans where id = '63000000-0000-0000-0000-00000000000a'),
  '{"v":2,"items":[]}'::jsonb, 'a conflict leaves the winning plan untouched'
);
select throws_ok(
  $$select public.sync_apply_rows(
    'attic-protected', 'attic_plans',
    '[{"id":"63000000-0000-0000-0000-0000000000a3","plan":{},"household_id":"62000000-0000-0000-0000-000000000002"}]',
    '{"attic_plans:63000000-0000-0000-0000-0000000000a3":null}', false
  )$$,
  '22023', 'invalid row payload', 'a caller-supplied household_id is rejected'
);
select throws_ok(
  $$select public.sync_apply_rows(
    'attic-not-object', 'attic_plans',
    '[{"id":"63000000-0000-0000-0000-0000000000a4","plan":[1,2]}]',
    '{"attic_plans:63000000-0000-0000-0000-0000000000a4":null}', false
  )$$,
  '23514', null, 'a non-object plan violates the table check'
);
select is((public.sync_apply_rows(
  'attic-foreign', 'attic_plans',
  '[{"id":"63000000-0000-0000-0000-00000000000b","plan":{"v":2,"items":[]}}]',
  '{"attic_plans:63000000-0000-0000-0000-00000000000b":null}', false
)->>'status'), 'conflict', 'household B''s row id cannot be written from household A');
select throws_ok(
  $$select public.sync_delete_rows(
    'attic-delete', 'attic_plans', array['63000000-0000-0000-0000-00000000000a'],
    '{"attic_plans:63000000-0000-0000-0000-00000000000a":2}'
  )$$,
  '22023', 'unsupported generic delete resource', 'attic plans have no client delete path'
);

reset role;
select is(
  (select plan from public.attic_plans where id = '63000000-0000-0000-0000-00000000000b'),
  '{"v":2,"items":[{"id":"secret","type":"bed"}]}'::jsonb,
  'household B''s plan is unchanged'
);
select is((select count(*) from public.attic_plans where id = '63000000-0000-0000-0000-00000000000a'), 1::bigint,
  'the rejected delete left household A''s plan in place');

select * from finish();
rollback;
