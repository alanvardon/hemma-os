begin;

create extension if not exists pgtap with schema extensions;
select plan(29);

insert into auth.users (id, email) values
  ('41000000-0000-0000-0000-000000000001', 'tombstone-a@example.invalid'),
  ('41000000-0000-0000-0000-000000000002', 'tombstone-b@example.invalid');
insert into public.households (id, name) values
  ('42000000-0000-0000-0000-000000000001', 'Tombstone fixture A'),
  ('42000000-0000-0000-0000-000000000002', 'Tombstone fixture B');
insert into public.household_members (household_id, user_id, role) values
  ('42000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-000000000001', 'owner'),
  ('42000000-0000-0000-0000-000000000002', '41000000-0000-0000-0000-000000000002', 'owner');

insert into public.scenarios (id, household_id) values
  ('deleted-scenario', '42000000-0000-0000-0000-000000000001'),
  ('foreign-scenario', '42000000-0000-0000-0000-000000000002');
insert into public.mortgage_loan_parts (id, household_id) values
  ('deleted-part', '42000000-0000-0000-0000-000000000001');
insert into public.mortgage_payments (id, household_id, loan_part_id) values
  ('deleted-child-payment', '42000000-0000-0000-0000-000000000001', 'deleted-part');
insert into public.mortgage_rate_periods (id, household_id, loan_part_id) values
  ('deleted-child-period', '42000000-0000-0000-0000-000000000001', 'deleted-part');
insert into public.monthend_payments (id, household_id, item_ids) values
  ('deleted-settlement', '42000000-0000-0000-0000-000000000001', '["settled-item"]');
insert into public.monthend_items (id, household_id, paid, payment_id) values
  ('settled-item', '42000000-0000-0000-0000-000000000001', true, 'deleted-settlement');
insert into public.house_items (id, household_id, title) values
  ('43000000-0000-0000-0000-000000000001', '42000000-0000-0000-0000-000000000001', 'Fictional house item');
insert into public.mortgage_loan_parts (id, household_id) values
  ('rollback-part', '42000000-0000-0000-0000-000000000001');
insert into public.mortgage_payments (id, household_id, loan_part_id) values
  ('rollback-child-payment', '42000000-0000-0000-0000-000000000001', 'rollback-part');
insert into public.mortgage_rate_periods (id, household_id, loan_part_id) values
  ('rollback-child-period', '42000000-0000-0000-0000-000000000001', 'rollback-part');

create function pg_temp.fail_selected_child_delete() returns trigger language plpgsql as $$
begin
  if old.id = 'rollback-child-payment' then raise exception 'forced child delete failure'; end if;
  return old;
end;
$$;
create trigger fail_selected_child_delete before delete on public.mortgage_payments
for each row execute function pg_temp.fail_selected_child_delete();

select ok(
  (select count(*) from pg_catalog.pg_trigger t
    join pg_catalog.pg_proc p on p.oid = t.tgfoid
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where not t.tgisinternal and n.nspname = 'private' and p.proname = 'reject_tombstoned_row') = 10
  and not exists (
    select 1 from (values
      ('scenarios','scenarios'), ('salary_submissions','salary_submissions'),
      ('monthend_items','monthend_items'), ('monthend_payments','monthend_payments'),
      ('mortgage_loan_parts','mortgage_loan_parts'), ('mortgage_rate_periods','mortgage_rate_periods'),
      ('mortgage_payments','mortgage_payments'), ('mortgage_valuations','mortgage_valuations'),
      ('mortgage_contributions','mortgage_contributions'), ('house_items','house_items')
    ) expected(table_name, resource)
    left join pg_catalog.pg_class c on c.relname = expected.table_name
    left join pg_catalog.pg_namespace cn on cn.oid = c.relnamespace and cn.nspname = 'public'
    left join pg_catalog.pg_trigger t on t.tgrelid = c.oid and not t.tgisinternal
      and encode(t.tgargs, 'escape') like expected.resource || '%'
    left join pg_catalog.pg_proc p on p.oid = t.tgfoid and p.proname = 'reject_tombstoned_row'
    where p.oid is null
  ), 'all ten row stores map to the correct tombstone resource');
select ok(
  not has_table_privilege('authenticated', 'public.tool_state', 'TRUNCATE')
  and not has_table_privilege('authenticated', 'public.scenarios', 'TRUNCATE')
  and not has_table_privilege('anon', 'public.tool_state', 'TRUNCATE'),
  'client roles cannot bypass row security and ledger protection with TRUNCATE');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"41000000-0000-0000-0000-000000000001","role":"authenticated","email":"tombstone-a@example.invalid"}', true);

select lives_ok(
  $$select public.sync_delete_rows(
    'tombstone-delete-scenario', 'scenarios', array['deleted-scenario'],
    '{"scenarios:deleted-scenario":1}'::jsonb
  )$$,
  'an authenticated household can durably delete its scenario'
);
select is((select count(*) from public.scenarios where id = 'deleted-scenario'), 0::bigint,
  'the deleted scenario is absent');
select ok((select (data #> '{resources,scenarios}') ? 'deleted-scenario'
  from public.tool_state where tool = 'sync-tombstones-v1'), 'the scenario tombstone is recorded');
select lives_ok(
  $$select public.sync_delete_rows(
    'tombstone-delete-scenario', 'scenarios', array['deleted-scenario'],
    '{"scenarios:deleted-scenario":1}'::jsonb
  )$$,
  'repeating an acknowledged delete is idempotent'
);
select is(
  (public.sync_apply_rows(
    'tombstone-recreate-scenario', 'scenarios', '[{"id":"deleted-scenario"}]',
    '{"scenarios:deleted-scenario":null}', false
  )->>'status'), 'conflict', 'stale replay cannot recreate a deleted id'
);
select is(
  (public.sync_apply_rows(
    'tombstone-fresh-scenario', 'scenarios', '[{"id":"fresh-scenario"}]',
    '{"scenarios:fresh-scenario":null}', false
  )->>'status'), 'applied', 'a fresh scenario id remains writable');
select throws_ok(
  $$delete from public.scenarios where id = 'fresh-scenario'$$,
  '42501', 'permission denied for table scenarios', 'direct client deletes cannot bypass tombstones'
);
select throws_ok($$update public.scenarios set id = 'renamed-scenario' where id = 'fresh-scenario'$$,
  '42501', 'permission denied for table scenarios', 'client updates cannot bypass deletion by renaming an id');
select lives_ok(
  $$select public.sync_delete_rows(
    'tombstone-delete-house-item', 'house_items',
    array['43000000-0000-0000-0000-000000000001'],
    '{"house_items:43000000-0000-0000-0000-000000000001":1}'::jsonb
  )$$,
  'the corrected house_items allowlist mapping deletes through the RPC'
);
select is((select count(*) from public.house_items where id = '43000000-0000-0000-0000-000000000001'), 0::bigint,
  'the house item is absent after its durable delete');

select lives_ok(
  $$select public.sync_delete_rows(
    'tombstone-opaque-foreign', 'scenarios', array['foreign-scenario'],
    '{"scenarios:foreign-scenario":null}'::jsonb
  )$$,
  'a foreign opaque id does not disclose whether a row exists'
);
reset role;
select is((select count(*) from public.scenarios where id = 'foreign-scenario'), 1::bigint,
  'the other household row is unchanged');

set local role authenticated;
select lives_ok($$select public.sync_delete_mortgage_loan_part(
  'tombstone-cascade', 'deleted-part',
  '{"mortgage_loan_parts:deleted-part":1,"mortgage_payments:deleted-child-payment":1,"mortgage_rate_periods:deleted-child-period":1}'::jsonb
)$$,
  'mortgage cascade deletion succeeds');
select is((select count(*) from public.mortgage_loan_parts where id = 'deleted-part'), 0::bigint,
  'the mortgage parent is removed');
select ok((select
    (data #> '{resources,mortgage_loan_parts}') ? 'deleted-part'
    and (data #> '{resources,mortgage_payments}') ? 'deleted-child-payment'
    and (data #> '{resources,mortgage_rate_periods}') ? 'deleted-child-period'
  from public.tool_state where tool = 'sync-tombstones-v1'),
  'mortgage parent and child tombstones are recorded atomically');
select lives_ok($$select public.sync_delete_mortgage_loan_part(
  'tombstone-cascade', 'deleted-part',
  '{"mortgage_loan_parts:deleted-part":1,"mortgage_payments:deleted-child-payment":1,"mortgage_rate_periods:deleted-child-period":1}'::jsonb
)$$,
  'mortgage cascade retry is idempotent');
select is((public.sync_apply_rows(
  'tombstone-recreate-parent', 'mortgage_loan_parts', '[{"id":"deleted-part"}]',
  '{"mortgage_loan_parts:deleted-part":null}', false
)->>'status'), 'conflict', 'a deleted mortgage parent id cannot be recreated');
select throws_ok($$select public.sync_apply_rows(
  'tombstone-recreate-payment', 'mortgage_payments',
  '[{"id":"deleted-child-payment","loan_part_id":"deleted-part"}]',
  '{"mortgage_payments:deleted-child-payment":null}', false
)$$, '23503', 'deleted mortgage loan part cannot receive children',
  'a payment cannot be recreated under a deleted parent');
select throws_ok($$select public.sync_apply_rows(
  'tombstone-recreate-period', 'mortgage_rate_periods',
  '[{"id":"deleted-child-period","loan_part_id":"deleted-part"}]',
  '{"mortgage_rate_periods:deleted-child-period":null}', false
)$$, '23503', 'deleted mortgage loan part cannot receive children',
  'a rate period cannot be recreated under a deleted parent');

select throws_ok($$select public.sync_delete_mortgage_loan_part(
  'tombstone-rollback-cascade', 'rollback-part',
  '{"mortgage_loan_parts:rollback-part":1,"mortgage_payments:rollback-child-payment":1,"mortgage_rate_periods:rollback-child-period":1}'::jsonb
)$$,
  'P0001', 'forced child delete failure', 'a child failure aborts the mortgage cascade');
reset role;
select ok(
  (select count(*) from public.mortgage_loan_parts where id = 'rollback-part') = 1
  and (select count(*) from public.mortgage_payments where id = 'rollback-child-payment') = 1
  and (select count(*) from public.mortgage_rate_periods where id = 'rollback-child-period') = 1
  and not coalesce((select (data #> '{resources,mortgage_loan_parts}') ? 'rollback-part'
    from public.tool_state where household_id = '42000000-0000-0000-0000-000000000001' and tool = 'sync-tombstones-v1'), false)
  and not coalesce((select (data #> '{resources,mortgage_payments}') ? 'rollback-child-payment'
    from public.tool_state where household_id = '42000000-0000-0000-0000-000000000001' and tool = 'sync-tombstones-v1'), false)
  and not coalesce((select (data #> '{resources,mortgage_rate_periods}') ? 'rollback-child-period'
    from public.tool_state where household_id = '42000000-0000-0000-0000-000000000001' and tool = 'sync-tombstones-v1'), false),
  'a failed cascade rolls back parent, children, and tombstones');
set local role authenticated;

select lives_ok($$select public.sync_unsettle_payment(
  'tombstone-unsettle', 'deleted-settlement',
  '{"monthend_payments:deleted-settlement":1,"monthend_items:settled-item":1}'::jsonb
)$$,
  'unsettling records a durable payment deletion');
select ok((select not paid and payment_id is null from public.monthend_items where id = 'settled-item'),
  'unsettling restores the linked item');
select is((public.sync_settle_items(
  'tombstone-recreate-settlement',
  '{"id":"deleted-settlement","item_ids":["settled-item"]}',
  '{"monthend_payments:deleted-settlement":null,"monthend_items:settled-item":2}'
)->>'status'), 'conflict', 'an unsettled payment id cannot be recreated');
select throws_ok(
  $$insert into public.tool_state(household_id, tool, data) values
    ('42000000-0000-0000-0000-000000000001', 'sync-tombstones-v1', '{}')
    on conflict (household_id, tool) do update set data = excluded.data$$,
  '42501', 'permission denied for table tool_state', 'clients cannot mutate the tombstone ledger'
);
select throws_ok(
  $$update public.tool_state set tool = 'renamed-ledger' where tool = 'sync-tombstones-v1'$$,
  '42501', 'permission denied for table tool_state', 'clients cannot rename the tombstone ledger'
);
select throws_ok(
  $$select public.sync_delete_rows(
    'tombstone-invalid-resource', 'not-allowlisted', array['x'],
    '{"not-allowlisted:x":null}'::jsonb
  )$$,
  '22023', 'unsupported generic delete resource', 'the generic delete RPC has a strict allowlist'
);

select * from finish();
rollback;
