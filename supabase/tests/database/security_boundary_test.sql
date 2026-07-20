begin;

create extension if not exists pgtap with schema extensions;

select plan(18);

select is(
  (
    select count(*)
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
  ),
  20::bigint,
  'the audited public-table inventory is complete'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and not c.relrowsecurity
  ),
  'every public table has row-level security enabled'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_attribute a
      on a.attrelid = c.oid
     and a.attname = 'household_id'
     and a.attnum > 0
     and not a.attisdropped
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and c.relname not in (
        'household_invites',
        'household_members',
        'household_people',
        'household_tool_person_bindings',
        'notification_state'
      )
      and not exists (
        select 1
        from pg_catalog.pg_policies p
        where p.schemaname = 'public'
          and p.tablename = c.relname
          and p.permissive = 'PERMISSIVE'
          and p.cmd = 'ALL'
          and 'authenticated' = any (p.roles)
          and p.qual ilike '%current_household%'
          and p.with_check ilike '%current_household%'
      )
  ),
  'every mutable household table has an authenticated ALL policy with USING and WITH CHECK isolation'
);

select ok(
  exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'households'
      and cmd = 'SELECT' and qual ilike '%current_household%'
  )
  and exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'household_members'
      and cmd = 'SELECT' and qual ilike '%current_household%'
  ),
  'households and household_members expose household-scoped reads only'
);

select ok(
  exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'notification_state'
      and cmd = 'SELECT' and qual ilike '%current_household%'
  )
  and not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'notification_state'
      and cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE')
      and 'authenticated' = any (roles)
  ),
  'notification_state is household-readable and client read-only'
);

select ok(
  not exists (
    select 1 from (values
      ('household_people'),
      ('household_tool_person_bindings')
    ) identity_tables(table_name)
    where not exists (
        select 1 from pg_catalog.pg_policies p
        where p.schemaname = 'public' and p.tablename = identity_tables.table_name
          and p.cmd = 'SELECT' and p.qual ilike '%current_household%'
      )
      or exists (
        select 1 from pg_catalog.pg_policies p
        where p.schemaname = 'public' and p.tablename = identity_tables.table_name
          and p.cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE')
          and 'authenticated' = any (p.roles)
      )
  ),
  'identity tables are household-readable and client read-only'
);

select ok(
  not exists (
    select 1 from information_schema.table_privileges
    where table_schema = 'public'
      and table_name in ('household_people', 'household_tool_person_bindings')
      and grantee in ('PUBLIC', 'anon', 'authenticated')
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
  ),
  'client roles cannot bypass the identity RPCs with direct table writes'
);

select ok(
  not exists (
    select 1 from (values
      ('public.household_identity()'),
      ('public.configure_household_people(text,text,text,text,text,text,text)'),
      ('public.claim_my_household_person_by_email()'),
      ('public.set_my_household_person(uuid)')
    ) identity_rpcs(signature)
    where has_function_privilege('public', signature, 'execute')
       or has_function_privilege('anon', signature, 'execute')
       or not has_function_privilege('authenticated', signature, 'execute')
  ),
  'only authenticated can execute the household identity RPCs'
);

select ok(
  exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'household_invites'
      and cmd = 'INSERT' and with_check ilike '%current_household%'
  )
  and exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'household_invites'
      and cmd = 'DELETE' and qual ilike '%current_household%'
  )
  and exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'household_invites'
      and cmd = 'SELECT' and qual ilike '%current_household%'
  )
  and exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'household_invites'
      and cmd = 'SELECT' and qual ilike '%auth.jwt%email%'
  ),
  'household_invites has scoped manage and recipient-read policies'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.prosecdef
      and not coalesce(p.proconfig, '{}'::text[]) @> array['search_path=""']
  ),
  'every application SECURITY DEFINER function pins an empty search_path'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    join pg_catalog.pg_roles owner on owner.oid = p.proowner
    where n.nspname in ('public', 'private')
      and p.prosecdef
      and owner.rolname <> 'postgres'
  ),
  'every application SECURITY DEFINER function is owned by postgres'
);

select ok(
  not has_function_privilege('public', 'public.hook_before_user_created(jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.hook_before_user_created(jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.hook_before_user_created(jsonb)', 'execute')
  and has_function_privilege('supabase_auth_admin', 'public.hook_before_user_created(jsonb)', 'execute'),
  'the signup hook is executable only by the Auth administrator'
);

select ok(
  not has_function_privilege('public', 'public.email_may_sign_in(text)', 'execute')
  and not has_function_privilege('anon', 'public.email_may_sign_in(text)', 'execute')
  and not has_function_privilege('authenticated', 'public.email_may_sign_in(text)', 'execute'),
  'the retired email_may_sign_in function is not client-executable'
);

select ok(
  not has_function_privilege('public', 'public.household_roster()', 'execute')
  and not has_function_privilege('anon', 'public.household_roster()', 'execute')
  and has_function_privilege('authenticated', 'public.household_roster()', 'execute')
  and not has_function_privilege(
    'public',
    'public.settle_items(text,jsonb,text,text,numeric,text,text,timestamp with time zone)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'public.settle_items(text,jsonb,text,text,numeric,text,text,timestamp with time zone)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'public.settle_items(text,jsonb,text,text,numeric,text,text,timestamp with time zone)',
    'execute'
  )
  and not has_function_privilege('public', 'public.unsettle_payment(text)', 'execute')
  and not has_function_privilege('anon', 'public.unsettle_payment(text)', 'execute')
  and not has_function_privilege('authenticated', 'public.unsettle_payment(text)', 'execute')
  and not has_function_privilege('public', 'public.delete_household_rows(text,text[])', 'execute')
  and not has_function_privilege('anon', 'public.delete_household_rows(text,text[])', 'execute')
  and not has_function_privilege('authenticated', 'public.delete_household_rows(text,text[])', 'execute')
  and not has_function_privilege('authenticated', 'public.delete_mortgage_loan_part(text)', 'execute')
  and not exists (
    select 1 from (values
      ('public.sync_apply_rows(text,text,jsonb,jsonb,boolean)'),
      ('public.sync_apply_tool_state(text,text,jsonb,bigint,boolean)'),
      ('public.sync_delete_rows(text,text,text[],jsonb)'),
      ('public.sync_settle_items(text,jsonb,jsonb)'),
      ('public.sync_unsettle_payment(text,text,jsonb)'),
      ('public.sync_delete_mortgage_loan_part(text,text,jsonb)')
    ) functions(signature)
    where has_function_privilege('public', signature, 'execute')
       or has_function_privilege('anon', signature, 'execute')
       or not has_function_privilege('authenticated', signature, 'execute')
  ),
  'only authenticated can execute the receipt-backed mutation RPCs; legacy mutation RPCs are retired'
);

select ok(
  not exists (
    select 1 from information_schema.table_privileges
    where table_schema = 'public'
      and table_name = any(array[
        'tool_state', 'scenarios', 'salary_submissions', 'monthend_items',
        'monthend_payments', 'mortgage_loan_parts', 'mortgage_rate_periods',
        'mortgage_payments', 'mortgage_valuations', 'mortgage_contributions',
        'mortgage_banks', 'mortgages', 'house_items'
      ]::text[])
      and grantee in ('anon', 'authenticated')
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
  ),
  'client roles cannot bypass optimistic concurrency with direct table writes'
);

select ok(
  not exists (
    select 1
    from information_schema.table_privileges
    where table_schema = 'private'
      and grantee in ('PUBLIC', 'anon', 'authenticated')
  ),
  'private schema contains no client table grants'
);

select ok(
  not has_function_privilege('public', 'private.household_has_persisted_data(uuid)', 'execute')
  and not has_function_privilege('anon', 'private.household_has_persisted_data(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.household_has_persisted_data(uuid)', 'execute'),
  'the private persisted-data predicate is not client-executable'
);

select ok(
  not has_schema_privilege('anon', 'private', 'usage')
  and has_schema_privilege('authenticated', 'private', 'usage')
  and has_function_privilege('authenticated', 'private.current_household()', 'execute')
  and has_function_privilege('authenticated', 'private.invite_cap_ok(uuid)', 'execute'),
  'private helper access matches policy evaluation requirements'
);

select * from finish();

rollback;
