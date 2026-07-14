begin;

create extension if not exists pgtap with schema extensions;

-- All data is fictional and all changes roll back. Fixture writes happen as
-- postgres; assertions run as fictional user A through the authenticated role
-- and the same auth.uid()/JWT boundary used by PostgREST.
select plan(133);

insert into auth.users (id, email)
values
  ('10000000-0000-0000-0000-000000000001', 'attacker-a@example.invalid'),
  ('10000000-0000-0000-0000-000000000002', 'member-b@example.invalid');

insert into public.households (id, name)
values
  ('20000000-0000-0000-0000-000000000001', 'Fictional household A'),
  ('20000000-0000-0000-0000-000000000002', 'Fictional household B');

insert into public.household_members (household_id, user_id, role)
values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'owner'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'owner');

insert into public.monthend_items (id, household_id)
values
  ('fixture-a-monthend-item', '20000000-0000-0000-0000-000000000001'),
  ('fixture-b-monthend-item', '20000000-0000-0000-0000-000000000002');
insert into public.monthend_payments (id, household_id)
values
  ('fixture-a-monthend-payment', '20000000-0000-0000-0000-000000000001'),
  ('fixture-b-monthend-payment', '20000000-0000-0000-0000-000000000002');
insert into public.salary_submissions (id, household_id, month)
values
  ('fixture-a-salary', '20000000-0000-0000-0000-000000000001', '2026-01'),
  ('fixture-b-salary', '20000000-0000-0000-0000-000000000002', '2026-01');
insert into public.tool_state (household_id, tool, data)
values
  ('20000000-0000-0000-0000-000000000001', 'fixture-a-tool', '{}'::jsonb),
  ('20000000-0000-0000-0000-000000000002', 'fixture-b-tool', '{}'::jsonb);
insert into public.mortgage_loan_parts (id, household_id)
values
  ('fixture-a-loan-part', '20000000-0000-0000-0000-000000000001'),
  ('fixture-b-loan-part', '20000000-0000-0000-0000-000000000002');
insert into public.mortgage_rate_periods (id, household_id)
values
  ('fixture-a-rate-period', '20000000-0000-0000-0000-000000000001'),
  ('fixture-b-rate-period', '20000000-0000-0000-0000-000000000002');
insert into public.mortgage_payments (id, household_id)
values
  ('fixture-a-mortgage-payment', '20000000-0000-0000-0000-000000000001'),
  ('fixture-b-mortgage-payment', '20000000-0000-0000-0000-000000000002');
insert into public.mortgage_valuations (id, household_id)
values
  ('fixture-a-valuation', '20000000-0000-0000-0000-000000000001'),
  ('fixture-b-valuation', '20000000-0000-0000-0000-000000000002');
insert into public.mortgage_contributions (id, household_id)
values
  ('fixture-a-contribution', '20000000-0000-0000-0000-000000000001'),
  ('fixture-b-contribution', '20000000-0000-0000-0000-000000000002');
insert into public.scenarios (id, household_id)
values
  ('fixture-a-scenario', '20000000-0000-0000-0000-000000000001'),
  ('fixture-b-scenario', '20000000-0000-0000-0000-000000000002');
insert into public.house_items (id, household_id)
values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001'),
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002');
insert into public.notification_state (household_id, key, value)
values
  ('20000000-0000-0000-0000-000000000001', 'fixture-a-notification', 'fictional'),
  ('20000000-0000-0000-0000-000000000002', 'fixture-b-notification', 'fictional');
insert into public.household_invites (household_id, email)
values
  ('20000000-0000-0000-0000-000000000001', 'fixture-a-invite@example.invalid'),
  ('20000000-0000-0000-0000-000000000002', 'unrelated-b-invite@example.invalid'),
  ('20000000-0000-0000-0000-000000000002', 'attacker-a@example.invalid');

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated","email":"attacker-a@example.invalid"}',
  true
);

-- The 11 ordinary household stores share one behavioral matrix. Extra column
-- fragments support salary_submissions and tool_state without weakening their
-- valid inserts. Each table emits nine separately named TAP assertions.
create function pg_temp.test_mutable_store(
  p_table text,
  p_key_column text,
  p_own_key text,
  p_foreign_key text,
  p_insert_key text,
  p_foreign_insert_key text,
  p_extra_columns text default '',
  p_extra_values text default ''
) returns setof text
language plpgsql
as $$
declare
  affected bigint;
  own_household constant text := '20000000-0000-0000-0000-000000000001';
  foreign_household constant text := '20000000-0000-0000-0000-000000000002';
  rls_message text := format(
    'new row violates row-level security policy for table "%s"',
    p_table
  );
begin
  if p_table <> 'tool_state' then rls_message := 'household write denied'; end if;
  execute format(
    'select count(*) from public.%I where %I = %L',
    p_table, p_key_column, p_own_key
  ) into affected;
  return next extensions.is(affected, 1::bigint, format('%s: own fixture is visible', p_table));

  execute format(
    'select count(*) from public.%I where %I = %L',
    p_table, p_key_column, p_foreign_key
  ) into affected;
  return next extensions.is(affected, 0::bigint, format('%s: foreign fixture is invisible', p_table));

  execute format(
    'with changed as (
       insert into public.%I (%I, household_id%s)
       values (%L, %L%s) returning 1
     ) select count(*) from changed',
    p_table, p_key_column, p_extra_columns,
    p_insert_key, own_household, p_extra_values
  ) into affected;
  return next extensions.is(affected, 1::bigint, format('%s: own insert succeeds', p_table));

  return next extensions.throws_ok(
    format(
      'insert into public.%I (%I, household_id%s) values (%L, %L%s)',
      p_table, p_key_column, p_extra_columns,
      p_foreign_insert_key, foreign_household, p_extra_values
    ),
    '42501',
    rls_message,
    format('%s: foreign insert is denied by RLS', p_table)
  );

  execute format(
    'with changed as (
       update public.%I set household_id = household_id
       where %I = %L returning 1
     ) select count(*) from changed',
    p_table, p_key_column, p_own_key
  ) into affected;
  return next extensions.is(affected, 1::bigint, format('%s: own update succeeds', p_table));

  return next extensions.throws_ok(
    format(
      'update public.%I set household_id = %L where %I = %L',
      p_table, foreign_household, p_key_column, p_own_key
    ),
    '42501',
    rls_message,
    format('%s: moving an own row to the foreign household is denied', p_table)
  );

  execute format(
    'with changed as (
       update public.%I set household_id = %L
       where %I = %L returning 1
     ) select count(*) from changed',
    p_table, own_household, p_key_column, p_foreign_key
  ) into affected;
  return next extensions.is(affected, 0::bigint, format('%s: foreign update affects no rows', p_table));

  if p_table = 'tool_state' then
    execute format(
      'with changed as (delete from public.%I where %I = %L returning 1) select count(*) from changed',
      p_table, p_key_column, p_foreign_key
    ) into affected;
    return next extensions.is(affected, 0::bigint, format('%s: foreign delete affects no rows', p_table));
    execute format(
      'with changed as (delete from public.%I where %I = %L returning 1) select count(*) from changed',
      p_table, p_key_column, p_insert_key
    ) into affected;
    return next extensions.is(affected, 1::bigint, format('%s: own delete succeeds', p_table));
  else
    return next extensions.throws_ok(
      format('delete from public.%I where %I = %L', p_table, p_key_column, p_foreign_key),
      '42501', format('permission denied for table %s', p_table),
      format('%s: foreign direct delete is revoked', p_table)
    );
    return next extensions.throws_ok(
      format('delete from public.%I where %I = %L', p_table, p_key_column, p_insert_key),
      '42501', format('permission denied for table %s', p_table),
      format('%s: own direct delete must use the durable RPC', p_table)
    );
  end if;
end;
$$;

select assertion
from (
  values
    ('monthend_items', 'id', 'fixture-a-monthend-item', 'fixture-b-monthend-item', 'insert-a-monthend-item', 'insert-b-monthend-item', '', ''),
    ('monthend_payments', 'id', 'fixture-a-monthend-payment', 'fixture-b-monthend-payment', 'insert-a-monthend-payment', 'insert-b-monthend-payment', '', ''),
    ('salary_submissions', 'id', 'fixture-a-salary', 'fixture-b-salary', 'insert-a-salary', 'insert-b-salary', ', month', ', ''2026-02'''),
    ('tool_state', 'tool', 'fixture-a-tool', 'fixture-b-tool', 'insert-a-tool', 'insert-b-tool', ', data', ', ''{}''::jsonb'),
    ('mortgage_loan_parts', 'id', 'fixture-a-loan-part', 'fixture-b-loan-part', 'insert-a-loan-part', 'insert-b-loan-part', '', ''),
    ('mortgage_rate_periods', 'id', 'fixture-a-rate-period', 'fixture-b-rate-period', 'insert-a-rate-period', 'insert-b-rate-period', '', ''),
    ('mortgage_payments', 'id', 'fixture-a-mortgage-payment', 'fixture-b-mortgage-payment', 'insert-a-mortgage-payment', 'insert-b-mortgage-payment', '', ''),
    ('mortgage_valuations', 'id', 'fixture-a-valuation', 'fixture-b-valuation', 'insert-a-valuation', 'insert-b-valuation', '', ''),
    ('mortgage_contributions', 'id', 'fixture-a-contribution', 'fixture-b-contribution', 'insert-a-contribution', 'insert-b-contribution', '', ''),
    ('scenarios', 'id', 'fixture-a-scenario', 'fixture-b-scenario', 'insert-a-scenario', 'insert-b-scenario', '', ''),
    ('house_items', 'id', '30000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000004', '', '')
) as stores(table_name, key_column, own_key, foreign_key, insert_key, foreign_insert_key, extra_columns, extra_values)
cross join lateral pg_temp.test_mutable_store(
  table_name,
  key_column,
  own_key,
  foreign_key,
  insert_key,
  foreign_insert_key,
  extra_columns,
  extra_values
) as assertion;

-- Relationship and service-owned tables expose household-scoped reads but no
-- direct authenticated mutations. This helper checks both own and foreign
-- attempts, with exact RLS errors for inserts and zero affected rows elsewhere.
create function pg_temp.test_read_only_household_table(
  p_table text,
  p_own_predicate text,
  p_foreign_predicate text,
  p_own_insert text,
  p_foreign_insert text,
  p_own_update text,
  p_foreign_update text,
  p_own_delete text,
  p_foreign_delete text
) returns setof text
language plpgsql
as $$
declare
  affected bigint;
  rls_message text := format(
    'new row violates row-level security policy for table "%s"',
    p_table
  );
begin
  execute format('select count(*) from public.%I where %s', p_table, p_own_predicate)
    into affected;
  return next extensions.is(affected, 1::bigint, format('%s: own fixture is visible', p_table));

  execute format('select count(*) from public.%I where %s', p_table, p_foreign_predicate)
    into affected;
  return next extensions.is(affected, 0::bigint, format('%s: foreign fixture is invisible', p_table));

  return next extensions.throws_ok(
    p_own_insert, '42501', rls_message,
    format('%s: direct own insert is denied by RLS', p_table)
  );
  return next extensions.throws_ok(
    p_foreign_insert, '42501', rls_message,
    format('%s: direct foreign insert is denied by RLS', p_table)
  );

  execute format('with changed as (%s returning 1) select count(*) from changed', p_own_update)
    into affected;
  return next extensions.is(affected, 0::bigint, format('%s: direct own update is denied', p_table));

  execute format('with changed as (%s returning 1) select count(*) from changed', p_foreign_update)
    into affected;
  return next extensions.is(affected, 0::bigint, format('%s: direct foreign update is denied', p_table));

  execute format('with changed as (%s returning 1) select count(*) from changed', p_own_delete)
    into affected;
  return next extensions.is(affected, 0::bigint, format('%s: direct own delete is denied', p_table));

  execute format('with changed as (%s returning 1) select count(*) from changed', p_foreign_delete)
    into affected;
  return next extensions.is(affected, 0::bigint, format('%s: direct foreign delete is denied', p_table));
end;
$$;

select * from pg_temp.test_read_only_household_table(
  'household_members',
  $$user_id = '10000000-0000-0000-0000-000000000001'$$,
  $$user_id = '10000000-0000-0000-0000-000000000002'$$,
  $$insert into public.household_members (household_id, user_id, role)
    values ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'member')$$,
  $$insert into public.household_members (household_id, user_id, role)
    values ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'member')$$,
  $$update public.household_members set role = 'member'
    where user_id = '10000000-0000-0000-0000-000000000001'$$,
  $$update public.household_members set role = 'member'
    where user_id = '10000000-0000-0000-0000-000000000002'$$,
  $$delete from public.household_members
    where user_id = '10000000-0000-0000-0000-000000000001'$$,
  $$delete from public.household_members
    where user_id = '10000000-0000-0000-0000-000000000002'$$
);
select is(
  (select count(*) from public.household_roster()),
  1::bigint,
  'household_members: roster RPC returns only the current household member'
);

select * from pg_temp.test_read_only_household_table(
  'notification_state',
  $$key = 'fixture-a-notification'$$,
  $$key = 'fixture-b-notification'$$,
  $$insert into public.notification_state (household_id, key, value)
    values ('20000000-0000-0000-0000-000000000001', 'hostile-a', 'value')$$,
  $$insert into public.notification_state (household_id, key, value)
    values ('20000000-0000-0000-0000-000000000002', 'hostile-b', 'value')$$,
  $$update public.notification_state set value = 'hostile'
    where key = 'fixture-a-notification'$$,
  $$update public.notification_state set value = 'hostile'
    where key = 'fixture-b-notification'$$,
  $$delete from public.notification_state where key = 'fixture-a-notification'$$,
  $$delete from public.notification_state where key = 'fixture-b-notification'$$
);

-- PostgreSQL requires a data-modifying CTE at statement top level. This small
-- helper keeps affected-row assertions valid and consistently reported.
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

-- households is read-only directly; claim_household is its supported lifecycle
-- surface and provides a positive authenticated/RPC control.
select is(
  (select count(*) from public.households where id = '20000000-0000-0000-0000-000000000001'),
  1::bigint,
  'households: current household is visible'
);
select is(
  (select count(*) from public.households where id = '20000000-0000-0000-0000-000000000002'),
  0::bigint,
  'households: foreign household is invisible'
);
select throws_ok(
  $$insert into public.households (id, name)
    values ('20000000-0000-0000-0000-000000000003', 'Hostile household')$$,
  '42501',
  'new row violates row-level security policy for table "households"',
  'households: direct authenticated insert is denied by RLS'
);
select pg_temp.assert_affected(
  $$update public.households set name = 'Hostile own update'
    where id = '20000000-0000-0000-0000-000000000001'$$,
  0::bigint,
  'households: direct current-household update is denied'
);
select pg_temp.assert_affected(
  $$update public.households set name = 'Hostile foreign update'
    where id = '20000000-0000-0000-0000-000000000002'$$,
  0::bigint,
  'households: direct foreign-household update is denied'
);
select pg_temp.assert_affected(
  $$delete from public.households
    where id = '20000000-0000-0000-0000-000000000001'$$,
  0::bigint,
  'households: direct current-household delete is denied'
);
select pg_temp.assert_affected(
  $$delete from public.households
    where id = '20000000-0000-0000-0000-000000000002'$$,
  0::bigint,
  'households: direct foreign-household delete is denied'
);
select is(
  public.claim_household(),
  '20000000-0000-0000-0000-000000000001'::uuid,
  'households: lifecycle RPC resolves the authenticated current household'
);

-- Invites deliberately allow a recipient to read their foreign-household
-- invite. Unrelated foreign rows remain hidden and management stays scoped to
-- the current household.
select is(
  (select count(*) from public.household_invites
    where email = 'fixture-a-invite@example.invalid'),
  1::bigint,
  'household_invites: current-household invite is visible'
);
select is(
  (select count(*) from public.household_invites
    where email = 'unrelated-b-invite@example.invalid'),
  0::bigint,
  'household_invites: unrelated foreign invite is invisible'
);
select is(
  (select count(*) from public.household_invites
    where email = 'attacker-a@example.invalid'
      and household_id = '20000000-0000-0000-0000-000000000002'),
  1::bigint,
  'household_invites: intended recipient may read their foreign invite'
);
select pg_temp.assert_affected(
  $$insert into public.household_invites (household_id, email)
    values ('20000000-0000-0000-0000-000000000001', 'insert-a-invite@example.invalid')$$,
  1::bigint,
  'household_invites: current-household insert succeeds'
);
select throws_ok(
  $$insert into public.household_invites (household_id, email)
    values ('20000000-0000-0000-0000-000000000002', 'insert-b-invite@example.invalid')$$,
  '42501',
  'new row violates row-level security policy for table "household_invites"',
  'household_invites: foreign-household insert is denied by RLS'
);
select pg_temp.assert_affected(
  $$update public.household_invites set email = 'updated-a-invite@example.invalid'
    where email = 'fixture-a-invite@example.invalid'$$,
  0::bigint,
  'household_invites: direct current-household update is denied'
);
select pg_temp.assert_affected(
  $$update public.household_invites set email = 'hostile-b-invite@example.invalid'
    where email = 'unrelated-b-invite@example.invalid'$$,
  0::bigint,
  'household_invites: direct foreign-household update is denied'
);
select pg_temp.assert_affected(
  $$delete from public.household_invites
    where email = 'unrelated-b-invite@example.invalid'$$,
  0::bigint,
  'household_invites: foreign-household delete affects no rows'
);
select pg_temp.assert_affected(
  $$delete from public.household_invites
    where email = 'insert-a-invite@example.invalid'$$,
  1::bigint,
  'household_invites: current-household delete succeeds'
);

select * from finish();

rollback;
