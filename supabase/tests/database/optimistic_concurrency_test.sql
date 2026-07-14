begin;

create extension if not exists pgtap with schema extensions;
select plan(65);

insert into auth.users(id, email) values
  ('51000000-0000-0000-0000-000000000001', 'revision-a1@example.invalid'),
  ('51000000-0000-0000-0000-000000000002', 'revision-a2@example.invalid'),
  ('51000000-0000-0000-0000-000000000003', 'revision-b@example.invalid');
insert into public.households(id, name) values
  ('52000000-0000-0000-0000-000000000001', 'Revision fixture A'),
  ('52000000-0000-0000-0000-000000000002', 'Revision fixture B');
insert into public.household_members(household_id, user_id, role) values
  ('52000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000001', 'owner'),
  ('52000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000002', 'member'),
  ('52000000-0000-0000-0000-000000000002', '51000000-0000-0000-0000-000000000003', 'owner');

insert into public.scenarios(id, household_id, name) values
  ('atomic-a', '52000000-0000-0000-0000-000000000001', 'Atomic A'),
  ('atomic-b', '52000000-0000-0000-0000-000000000001', 'Atomic B'),
  ('seed-existing', '52000000-0000-0000-0000-000000000001', 'Cloud wins'),
  ('foreign-row', '52000000-0000-0000-0000-000000000002', 'Foreign secret');
insert into public.monthend_items(id, household_id, description)
  values ('settle-item', '52000000-0000-0000-0000-000000000001', 'Fictional item');
insert into public.mortgage_loan_parts(id, household_id, label)
  values
    ('cascade-parent', '52000000-0000-0000-0000-000000000001', 'Fictional part'),
    ('foreign-parent', '52000000-0000-0000-0000-000000000002', 'Foreign part');
insert into public.mortgage_payments(id, household_id, loan_part_id)
  values ('cascade-payment', '52000000-0000-0000-0000-000000000001', 'cascade-parent');
insert into public.mortgage_rate_periods(id, household_id, loan_part_id)
  values ('cascade-period', '52000000-0000-0000-0000-000000000001', 'cascade-parent');

insert into public.tool_state(household_id, tool, data) values (
  '52000000-0000-0000-0000-000000000001', 'bostadskalkyl-prefs',
  '{"globalConstants":{"tax":1},"driftItems":[{"id":"d"}],"savingsItems":[{"id":"s"}]}'
);
select private.migrate_bostadskalkyl_preferences();

select ok(
  not exists (
    select 1 from (values
      ('tool_state'), ('scenarios'), ('salary_submissions'), ('monthend_items'),
      ('monthend_payments'), ('mortgage_loan_parts'), ('mortgage_rate_periods'),
      ('mortgage_payments'), ('mortgage_valuations'), ('mortgage_contributions'),
      ('house_items')
    ) expected(table_name)
    left join pg_catalog.pg_class c on c.relname = expected.table_name
    left join pg_catalog.pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    left join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attname = 'revision'
      and a.attnum > 0 and not a.attisdropped and a.attnotnull
    where a.attrelid is null
  ),
  'all eleven mutable stores have a required server revision'
);
select is(
  (select count(*) from pg_catalog.pg_trigger t
    join pg_catalog.pg_proc p on p.oid = t.tgfoid
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where not t.tgisinternal and n.nspname = 'private'
      and p.proname = 'set_sync_revision'),
  11::bigint, 'all revisioned stores use the server revision trigger'
);
select ok(
  not has_table_privilege('public', 'private.sync_operation_receipts', 'select')
  and not has_table_privilege('anon', 'private.sync_operation_receipts', 'select')
  and not has_table_privilege('authenticated', 'private.sync_operation_receipts', 'select'),
  'durable operation receipts are inaccessible to client roles'
);
select ok(
  (select data = '{"tax":1}'::jsonb from public.tool_state
    where household_id = '52000000-0000-0000-0000-000000000001'
      and tool = 'bostadskalkyl-global-constants')
  and (select data = '[{"id":"d"}]'::jsonb from public.tool_state
    where household_id = '52000000-0000-0000-0000-000000000001'
      and tool = 'bostadskalkyl-drift-items')
  and (select data = '[{"id":"s"}]'::jsonb from public.tool_state
    where household_id = '52000000-0000-0000-0000-000000000001'
      and tool = 'bostadskalkyl-savings-items'),
  'the combined Bostadskalkyl row migrates into three direct slice values'
);
update public.tool_state set data = '[{"id":"edited"}]'
  where household_id = '52000000-0000-0000-0000-000000000001'
    and tool = 'bostadskalkyl-drift-items';
select private.migrate_bostadskalkyl_preferences();
select is(
  (select data from public.tool_state
    where household_id = '52000000-0000-0000-0000-000000000001'
      and tool = 'bostadskalkyl-drift-items'),
  '[{"id":"edited"}]'::jsonb,
  'rerunning the preference migration never overwrites an edited slice'
);

set local role authenticated;
select throws_ok(
  $$select public.sync_apply_rows(
    'unauthenticated-op', 'scenarios', '[{"id":"x"}]',
    '{"scenarios:x":null}', false
  )$$,
  '42501', 'authentication required', 'an authenticated role without auth.uid is rejected'
);
select set_config('request.jwt.claims',
  '{"sub":"51000000-0000-0000-0000-000000000001","role":"authenticated","email":"revision-a1@example.invalid"}', true);

select is((public.sync_apply_rows(
  'row-create', 'scenarios', '[{"id":"row","name":"A"}]',
  '{"scenarios:row":null}', false
)->'revisions'->>'scenarios:row'), '1', 'a new row receives revision one');
select ok((select name = 'A' and revision = 1 from public.scenarios where id = 'row'),
  'the revision-one row is persisted in the caller household');
select is((public.sync_apply_rows(
  'row-update', 'scenarios', '[{"id":"row","name":"B"}]',
  '{"scenarios:row":1}', false
)->'revisions'->>'scenarios:row'), '2', 'a matching update receives the next revision');
select is((public.sync_apply_rows(
  'row-stale', 'scenarios', '[{"id":"row","name":"stale"}]',
  '{"scenarios:row":1}', false
)->>'status'), 'conflict', 'a second client writing from the stale base is rejected');
select is((select name from public.scenarios where id = 'row'), 'B',
  'a stale conflict does not change the winning value');

select is((public.sync_apply_rows(
  'lost-response', 'scenarios', '[{"id":"receipt-row","name":"first"}]',
  '{"scenarios:receipt-row":null}', false
)->'revisions'->>'scenarios:receipt-row'), '1', 'the first receipt-backed write commits');
select is((public.sync_apply_rows(
  'intervening-write', 'scenarios', '[{"id":"receipt-row","name":"second"}]',
  '{"scenarios:receipt-row":1}', false
)->'revisions'->>'scenarios:receipt-row'), '2', 'an intervening partner write advances the row');
select is((public.sync_apply_rows(
  'lost-response', 'scenarios', '[{"id":"receipt-row","name":"first"}]',
  '{"scenarios:receipt-row":null}', false
)->'revisions'->>'scenarios:receipt-row'), '1', 'a lost-response retry returns the original acknowledgement');
select ok((select name = 'second' and revision = 2 from public.scenarios where id = 'receipt-row'),
  'a receipt retry never replays over an intervening write');
select throws_ok(
  $$select public.sync_apply_rows(
    'lost-response', 'scenarios', '[{"id":"different","name":"reuse"}]',
    '{"scenarios:different":null}', false
  )$$,
  '22023', 'sync operation id was reused', 'an operation id cannot be reused for a different request'
);

select throws_ok(
  $$select public.sync_apply_rows(
    'protected-field', 'scenarios', '[{"id":"bad","household_id":"52000000-0000-0000-0000-000000000002"}]',
    '{"scenarios:bad":null}', false
  )$$,
  '22023', 'invalid row payload', 'caller-supplied household and protected fields are rejected'
);
select throws_ok(
  $$select public.sync_apply_rows('unsupported-row', 'pg_class', '[{"id":"x"}]', '{"pg_class:x":null}', false)$$,
  '22023', 'unsupported sync resource', 'row RPC resources are strictly allowlisted'
);
select throws_ok(
  $$select public.sync_apply_rows(
    'duplicate-row', 'scenarios', '[{"id":"dup"},{"id":"dup"}]',
    '{"scenarios:dup":null}', false
  )$$,
  '22023', 'duplicate row id', 'duplicate row ids are rejected'
);
select throws_ok(
  $$select public.sync_apply_rows(
    'negative-revision', 'scenarios', '[{"id":"row","name":"bad"}]',
    '{"scenarios:row":-1}', false
  )$$,
  '22023', 'invalid expected revision', 'negative expected revisions are rejected'
);
select throws_ok(
  $$select public.sync_apply_rows(
    'invalid-house-id', 'house_items', '[{"id":"not-a-uuid"}]',
    '{"house_items:not-a-uuid":null}', false
  )$$,
  '22023', 'invalid house item id', 'house item ids must be valid UUIDs'
);
select throws_ok(
  $$select public.sync_apply_rows(
    'foreign-payment-parent', 'mortgage_payments',
    '[{"id":"foreign-parent-payment","loan_part_id":"foreign-parent"}]',
    '{"mortgage_payments:foreign-parent-payment":null}', false
  )$$,
  '22023', 'mortgage parent is not in caller household',
  'a mortgage payment cannot link to another household parent'
);
select throws_ok(
  $$select public.sync_apply_rows(
    'foreign-period-parent', 'mortgage_rate_periods',
    '[{"id":"foreign-parent-period","loan_part_id":"foreign-parent"}]',
    '{"mortgage_rate_periods:foreign-parent-period":null}', false
  )$$,
  '22023', 'mortgage parent is not in caller household',
  'a mortgage rate period cannot link to another household parent'
);

select is((public.sync_apply_rows(
  'foreign-update', 'scenarios', '[{"id":"foreign-row","name":"stolen"}]',
  '{"scenarios:foreign-row":1}', false
)->>'status'), 'conflict', 'a foreign opaque id cannot be updated through the definer RPC');
reset role;
select ok((select name = 'Foreign secret' and revision = 1 from public.scenarios where id = 'foreign-row'),
  'the foreign household row remains unchanged');
set local role authenticated;

select is((public.sync_apply_rows(
  'atomic-batch', 'scenarios',
  '[{"id":"atomic-a","name":"changed"},{"id":"atomic-b","name":"changed"}]',
  '{"scenarios:atomic-a":1,"scenarios:atomic-b":999}', false
)->>'status'), 'conflict', 'one stale entity rejects the whole multi-row transaction');
select ok((select bool_and(name in ('Atomic A','Atomic B') and revision = 1)
  from public.scenarios where id in ('atomic-a','atomic-b')),
  'a rejected multi-row transaction leaves every row unchanged');
select is((public.sync_apply_rows(
  'seed-existing-op', 'scenarios', '[{"id":"seed-existing","name":"Device seed"}]',
  '{"scenarios:seed-existing":null}', true
)->>'status'), 'applied', 'an explicit import seed is an acknowledged no-op when the id exists');
select is((select name from public.scenarios where id = 'seed-existing'), 'Cloud wins',
  'an import seed never overwrites a partner cloud row');

select is((public.sync_apply_rows(
  'seed-delete-create', 'scenarios', '[{"id":"seed-deleted","name":"temporary"}]',
  '{"scenarios:seed-deleted":null}', false
)->>'status'), 'applied', 'the tombstone seed fixture is created through the RPC');
select is((public.sync_delete_rows(
  'seed-delete', 'scenarios', array['seed-deleted'],
  '{"scenarios:seed-deleted":1}'
)->>'status'), 'applied', 'the fixture is durably deleted');
select is((public.sync_apply_rows(
  'seed-after-delete', 'scenarios', '[{"id":"seed-deleted","name":"stale seed"}]',
  '{"scenarios:seed-deleted":null}', true
)->>'status'), 'applied', 'a stale import seed treats a tombstone as an acknowledged no-op');
select is((select count(*) from public.scenarios where id = 'seed-deleted'), 0::bigint,
  'Plan 97 tombstones remain authoritative over seed imports');

select is((public.sync_apply_tool_state(
  'tool-create', 'konsultkalkyl', '{"value":1}', null, false
)->'revisions'->>'tool_state:konsultkalkyl'), '1', 'a tool blob starts at revision one');
select is((public.sync_apply_tool_state(
  'tool-update', 'konsultkalkyl', '{"value":2}', 1, false
)->'revisions'->>'tool_state:konsultkalkyl'), '2', 'a tool blob advances on a matching revision');
select is((public.sync_apply_tool_state(
  'tool-stale', 'konsultkalkyl', '{"value":0}', 1, false
)->>'status'), 'conflict', 'a stale whole-tool write is rejected');
select is((select data from public.tool_state where tool = 'konsultkalkyl'), '{"value":2}'::jsonb,
  'the winning tool blob survives a stale write');
select is((public.sync_apply_tool_state(
  'tool-create', 'konsultkalkyl', '{"value":1}', null, false
)->'revisions'->>'tool_state:konsultkalkyl'), '1', 'tool-state receipts survive later writes');
select throws_ok(
  $$select public.sync_apply_tool_state('bad-tool', 'sync-tombstones-v1', '{}', null, false)$$,
  '22023', 'invalid tool state mutation', 'server-managed and unknown tool rows are not writable'
);

select is((public.sync_apply_tool_state(
  'drift-create', 'bostadskalkyl-drift-items', '[{"id":"new-drift"}]', 2, false
)->>'status'), 'applied', 'one migrated preference slice can be edited independently');
select is((public.sync_apply_tool_state(
  'savings-update', 'bostadskalkyl-savings-items', '[{"id":"new-saving"}]', 1, false
)->>'status'), 'applied', 'a sibling preference slice has its own revision chain');
select is((public.sync_apply_tool_state(
  'drift-update', 'bostadskalkyl-drift-items', '[{"id":"final-drift"}]', 3, false
)->>'status'), 'applied', 'the first preference slice advances again');
select is((select data from public.tool_state where tool = 'bostadskalkyl-savings-items'),
  '[{"id":"new-saving"}]'::jsonb, 'editing one preference slice does not overwrite its sibling');

select throws_ok(
  $$select public.sync_settle_items(
    'invalid-settlement-items', '{"id":"invalid-settlement","item_ids":[1]}',
    '{"monthend_payments:invalid-settlement":null,"monthend_items:1":1}'
  )$$,
  '22023', 'invalid settlement payload', 'settlement item ids must be JSON strings'
);
select throws_ok(
  $$select public.sync_apply_rows(
    'bypass-settlement', 'monthend_payments',
    '[{"id":"bypass-payment","item_ids":["settle-item"]}]',
    '{"monthend_payments:bypass-payment":null}', false
  )$$,
  '22023', 'settlement payments require the settlement RPC',
  'generic row writes cannot bypass atomic settlement semantics'
);
select throws_ok(
  $$select public.sync_apply_rows(
    'bypass-paid-link', 'monthend_items',
    '[{"id":"settle-item","paid":true,"payment_id":"invented"}]',
    '{"monthend_items:settle-item":1}', false
  )$$,
  '22023', 'settlement fields are server managed',
  'generic item edits cannot forge payment links'
);
select throws_ok(
  $$select public.sync_apply_tool_state(
    'invalid-slice-shape', 'bostadskalkyl-drift-items', '{"not":"an array"}', 3, false
  )$$,
  '22023', 'invalid tool state data', 'preference slice JSON shapes are validated'
);
select is((public.sync_settle_items(
  'settle-op',
  '{"id":"settlement","item_ids":["settle-item"],"amount":125,"period_label":"2026-07"}',
  '{"monthend_payments:settlement":null,"monthend_items:settle-item":1}'
)->>'status'), 'applied', 'settlement atomically creates payment and advances each item');
select ok(
  (select revision = 1 from public.monthend_payments where id = 'settlement')
  and (select paid and payment_id = 'settlement' and revision = 2
       from public.monthend_items where id = 'settle-item'),
  'settlement revisions and financial links commit together'
);
select is((public.sync_settle_items(
  'stale-settle',
  '{"id":"stale-settlement","item_ids":["settle-item"],"amount":1}',
  '{"monthend_payments:stale-settlement":null,"monthend_items:settle-item":1}'
)->>'status'), 'conflict', 'a settlement from a stale item revision is rejected');
select is((select count(*) from public.monthend_payments where id = 'stale-settlement'), 0::bigint,
  'a stale settlement leaves no partial payment');
select is((public.sync_settle_items(
  'settle-op',
  '{"id":"settlement","item_ids":["settle-item"],"amount":125,"period_label":"2026-07"}',
  '{"monthend_payments:settlement":null,"monthend_items:settle-item":1}'
)->'revisions'->>'monthend_items:settle-item'), '2', 'settlement retry returns its original receipt');

select is((public.sync_unsettle_payment(
  'stale-unsettle', 'settlement',
  '{"monthend_payments:settlement":1,"monthend_items:settle-item":1}'
)->>'status'), 'conflict', 'unsettlement validates the linked item revision');
select is((select count(*) from public.monthend_payments where id = 'settlement'), 1::bigint,
  'a stale unsettlement keeps the payment and links intact');
select is((public.sync_unsettle_payment(
  'unsettle-op', 'settlement',
  '{"monthend_payments:settlement":1,"monthend_items:settle-item":2}'
)->>'status'), 'applied', 'matching unsettlement commits atomically');
select ok(
  (select not paid and payment_id is null and revision = 3
     from public.monthend_items where id = 'settle-item')
  and not exists (select 1 from public.monthend_payments where id = 'settlement'),
  'unsettlement advances items, deletes payment, and clears links together'
);
select is((public.sync_unsettle_payment(
  'unsettle-op', 'settlement',
  '{"monthend_payments:settlement":1,"monthend_items:settle-item":2}'
)->>'status'), 'applied', 'unsettlement retry is acknowledged from its receipt');

select is((public.sync_delete_mortgage_loan_part(
  'incomplete-cascade', 'cascade-parent',
  '{"mortgage_loan_parts:cascade-parent":1}'
)->>'status'), 'conflict', 'mortgage cascade detects a changed or omitted child set');
select is((select count(*) from public.mortgage_loan_parts where id = 'cascade-parent'), 1::bigint,
  'a cascade conflict leaves parent and children intact');
select is((public.sync_delete_mortgage_loan_part(
  'cascade-op', 'cascade-parent',
  '{"mortgage_loan_parts:cascade-parent":1,"mortgage_payments:cascade-payment":1,"mortgage_rate_periods:cascade-period":1}'
)->>'status'), 'applied', 'a complete matching mortgage cascade is applied');
select ok(
  not exists (select 1 from public.mortgage_loan_parts where id = 'cascade-parent')
  and not exists (select 1 from public.mortgage_payments where id = 'cascade-payment')
  and not exists (select 1 from public.mortgage_rate_periods where id = 'cascade-period')
  and (select (data #> '{resources,mortgage_loan_parts}') ? 'cascade-parent'
    and (data #> '{resources,mortgage_payments}') ? 'cascade-payment'
    and (data #> '{resources,mortgage_rate_periods}') ? 'cascade-period'
    from public.tool_state where tool = 'sync-tombstones-v1'),
  'mortgage cascade rows and Plan 97 tombstones commit together'
);
select is((public.sync_delete_mortgage_loan_part(
  'cascade-op', 'cascade-parent',
  '{"mortgage_loan_parts:cascade-parent":1,"mortgage_payments:cascade-payment":1,"mortgage_rate_periods:cascade-period":1}'
)->>'status'), 'applied', 'mortgage cascade retry is acknowledged from its receipt');

select throws_ok(
  $$select public.sync_delete_rows(
    'extra-expected-key', 'scenarios', array['row'],
    '{"scenarios:row":2,"scenarios:other":1}'
  )$$,
  '22023', 'invalid expected revision set', 'unexpected revision keys are rejected'
);
select throws_ok(
  $$select public.sync_delete_rows(
    'oversized-id', 'scenarios', array[repeat('x', 513)],
    jsonb_build_object('scenarios:' || repeat('x', 513), null)
  )$$,
  '22023', 'invalid delete ids', 'oversized entity ids are rejected'
);

select set_config('request.jwt.claims',
  '{"sub":"51000000-0000-0000-0000-000000000002","role":"authenticated","email":"revision-a2@example.invalid"}', true);
select throws_ok(
  $$select public.sync_apply_rows(
    'lost-response', 'scenarios', '[{"id":"receipt-row","name":"first"}]',
    '{"scenarios:receipt-row":null}', false
  )$$,
  '22023', 'sync operation id was reused', 'a partner cannot claim another user receipt in the same household'
);

select * from finish();
rollback;
