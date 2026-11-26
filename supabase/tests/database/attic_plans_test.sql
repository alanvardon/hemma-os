begin;

create extension if not exists pgtap with schema extensions;
-- Plan 140: attic_plans is a household-owned, revisioned sync resource whose
-- `plan` jsonb document round-trips through sync_apply_rows; plan 149 adds
-- durable variant deletes through sync_delete_rows. All data is
-- fictional and everything rolls back.
select plan(35);

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
-- Plan 149: variants are separate rows that the household can delete through
-- the durable, tombstone-writing sync_delete_rows RPC (as house_items).
select is((public.sync_apply_rows(
  'attic-create-variant', 'attic_plans',
  '[{"id":"63000000-0000-0000-0000-00000000000c","name":"Plan B","schema_version":2,"plan":{"v":2,"items":[]}}]',
  '{"attic_plans:63000000-0000-0000-0000-00000000000c":null}', false
)->>'status'), 'applied', 'a second plan variant row can be created');
select is((select count(*) from public.attic_plans), 2::bigint,
  'household A now holds two plan variants');
select throws_ok(
  $$select public.sync_delete_rows(
    'attic-delete-bad-id', 'attic_plans', array['not-a-uuid'],
    '{"attic_plans:not-a-uuid":null}'
  )$$,
  '22023', 'invalid attic plan id', 'a non-uuid attic plan id is rejected before any tombstone'
);
select is((public.sync_delete_rows(
  'attic-delete-stale', 'attic_plans', array['63000000-0000-0000-0000-00000000000a'],
  '{"attic_plans:63000000-0000-0000-0000-00000000000a":1}'
)->>'status'), 'conflict', 'a delete from a stale revision is a conflict');
select is((select count(*) from public.attic_plans where id = '63000000-0000-0000-0000-00000000000a'), 1::bigint,
  'a conflicting delete leaves the plan in place');
select is((public.sync_delete_rows(
  'attic-delete-own', 'attic_plans', array['63000000-0000-0000-0000-00000000000a'],
  '{"attic_plans:63000000-0000-0000-0000-00000000000a":2}'
)), '{"status":"applied","revisions":{"attic_plans:63000000-0000-0000-0000-00000000000a":null}}'::jsonb,
  'the household deletes its own plan variant at the current revision');
select is((select count(*) from public.attic_plans where id = '63000000-0000-0000-0000-00000000000a'), 0::bigint,
  'the deleted plan is absent');
select ok((select (data #> '{resources,attic_plans}') ? '63000000-0000-0000-0000-00000000000a'
  from public.tool_state where tool = 'sync-tombstones-v1'), 'the attic plan tombstone is recorded');
select is((public.sync_delete_rows(
  'attic-delete-own', 'attic_plans', array['63000000-0000-0000-0000-00000000000a'],
  '{"attic_plans:63000000-0000-0000-0000-00000000000a":2}'
)->>'status'), 'applied', 'repeating an acknowledged delete is idempotent');
select is((public.sync_apply_rows(
  'attic-resurrect', 'attic_plans',
  '[{"id":"63000000-0000-0000-0000-00000000000a","plan":{"v":2,"items":[]}}]',
  '{"attic_plans:63000000-0000-0000-0000-00000000000a":null}', false
)->>'status'), 'conflict', 'stale replay cannot recreate a deleted plan id');
select is((public.sync_delete_rows(
  'attic-delete-missing', 'attic_plans', array['63000000-0000-0000-0000-0000000000ff'],
  '{"attic_plans:63000000-0000-0000-0000-0000000000ff":null}'
)->>'status'), 'applied', 'deleting a never-existing id is a no-op success, as for house_items');
select is((public.sync_delete_rows(
  'attic-delete-foreign', 'attic_plans', array['63000000-0000-0000-0000-00000000000b'],
  '{"attic_plans:63000000-0000-0000-0000-00000000000b":null}'
)->>'status'), 'applied', 'a foreign plan id does not disclose whether a row exists');
select is((public.sync_delete_rows(
  'attic-delete-foreign-rev', 'attic_plans', array['63000000-0000-0000-0000-00000000000b'],
  '{"attic_plans:63000000-0000-0000-0000-00000000000b":1}'
)), '{"status":"conflict","revisions":{"attic_plans:63000000-0000-0000-0000-00000000000b":null}}'::jsonb,
  'guessing a foreign plan''s revision is a conflict that reveals nothing');
select throws_ok(
  $$delete from public.attic_plans where id = '63000000-0000-0000-0000-00000000000c'$$,
  '42501', 'permission denied for table attic_plans', 'direct client deletes cannot bypass tombstones'
);
select is((public.sync_delete_rows(
  'attic-delete-last', 'attic_plans', array['63000000-0000-0000-0000-00000000000c'],
  '{"attic_plans:63000000-0000-0000-0000-00000000000c":1}'
)->>'status'), 'applied', 'the household''s last plan can be deleted at DB level (the UI prevents it)');
select is((select count(*) from public.attic_plans), 0::bigint,
  'household A holds no plans after deleting the last one');
select is((public.sync_apply_rows(
  'attic-create-fresh', 'attic_plans',
  '[{"id":"63000000-0000-0000-0000-00000000000d","plan":{"v":2,"items":[]}}]',
  '{"attic_plans:63000000-0000-0000-0000-00000000000d":null}', false
)->>'status'), 'applied', 'a fresh plan id remains writable after deletes');

reset role;
select is(
  (select plan from public.attic_plans where id = '63000000-0000-0000-0000-00000000000b'),
  '{"v":2,"items":[{"id":"secret","type":"bed"}]}'::jsonb,
  'household B''s plan is unchanged'
);
select is((select count(*) from public.attic_plans where household_id = '62000000-0000-0000-0000-000000000002'), 1::bigint,
  'household A''s deletes never removed household B''s row');
select ok(
  not has_function_privilege('authenticated', 'public.delete_household_rows(text,text[])', 'execute'),
  'the retired delete_household_rows stays revoked from clients'
);
select ok(
  exists (select 1 from pg_catalog.pg_trigger t
    join pg_catalog.pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'public.attic_plans'::regclass and not t.tgisinternal
      and t.tgname = 'reject_deleted_attic_plans' and p.proname = 'reject_tombstoned_row'
      and encode(t.tgargs, 'escape') like 'attic_plans%'),
  'attic_plans carries the tombstone guard trigger'
);

select * from finish();
rollback;
