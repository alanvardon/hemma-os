-- Plan 96 live metadata audit — STRICTLY READ ONLY.
--
-- Paste this whole file into the linked project's Supabase Dashboard SQL
-- Editor. It returns exactly one result grid and reads only pg_catalog and
-- information_schema metadata. It does not read application/auth rows and
-- contains no DML, DDL, transaction, temp object, or application-function
-- invocation. Do not add household/user queries or copy project identifiers
-- into results.

with public_tables as (
  select
    'public_table_rls'::text as section,
    c.relname::text as object_name,
    pg_catalog.jsonb_build_object(
      'rls_enabled', c.relrowsecurity
    ) as details
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r', 'p')
),
public_policies as (
  select
    'public_policy'::text as section,
    pg_catalog.format('%I.%I', p.tablename, p.policyname)::text as object_name,
    pg_catalog.jsonb_build_object(
      'table_name', p.tablename,
      'policy_name', p.policyname,
      'permissive', p.permissive,
      'command', p.cmd,
      'roles', pg_catalog.to_jsonb(p.roles),
      'has_using', p.qual is not null,
      'has_with_check', p.with_check is not null,
      'using_current_household', coalesce(p.qual, '') ilike '%current_household%',
      'check_current_household', coalesce(p.with_check, '') ilike '%current_household%',
      'using_email_claim', coalesce(p.qual, '') ilike '%auth.jwt%email%'
    ) as details
  from pg_catalog.pg_policies p
  where p.schemaname = 'public'
),
definer_functions as (
  select
    'security_definer_function'::text as section,
    pg_catalog.format(
      '%I.%I(%s)',
      n.nspname,
      p.proname,
      pg_catalog.pg_get_function_identity_arguments(p.oid)
    )::text as object_name,
    pg_catalog.jsonb_build_object(
      'schema_name', n.nspname,
      'function_name', p.proname,
      'identity_arguments', pg_catalog.pg_get_function_identity_arguments(p.oid),
      'owner_name', owner.rolname,
      'empty_search_path', coalesce(p.proconfig, '{}'::text[]) @> array['search_path=""'],
      'public_execute', pg_catalog.has_function_privilege('public', p.oid, 'execute'),
      'anon_execute', pg_catalog.has_function_privilege('anon', p.oid, 'execute'),
      'authenticated_execute', pg_catalog.has_function_privilege('authenticated', p.oid, 'execute'),
      'auth_admin_execute', pg_catalog.has_function_privilege('supabase_auth_admin', p.oid, 'execute')
    ) as details
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  join pg_catalog.pg_roles owner on owner.oid = p.proowner
  where n.nspname in ('public', 'private')
    and p.prosecdef
),
private_schema_usage as (
  select
    'private_schema_usage'::text as section,
    'private'::text as object_name,
    pg_catalog.jsonb_build_object(
      'anon_usage', pg_catalog.has_schema_privilege('anon', 'private', 'usage'),
      'authenticated_usage', pg_catalog.has_schema_privilege('authenticated', 'private', 'usage')
    ) as details
),
private_table_grants as (
  select
    'private_client_table_grants'::text as section,
    'private'::text as object_name,
    pg_catalog.jsonb_build_object(
      'grant_count', count(*),
      'grants', coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'table_name', tp.table_name,
            'grantee', tp.grantee,
            'privilege_type', tp.privilege_type
          )
          order by tp.table_name, tp.grantee, tp.privilege_type
        ) filter (where tp.table_name is not null),
        '[]'::jsonb
      )
    ) as details
  from information_schema.table_privileges tp
  where tp.table_schema = 'private'
    and tp.grantee in ('PUBLIC', 'anon', 'authenticated')
),
revisioned_table_mutation_grants as (
  select
    'revisioned_table_client_mutation_grants'::text as section,
    'public'::text as object_name,
    pg_catalog.jsonb_build_object(
      'grant_count', count(*),
      'grants', coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'table_name', tp.table_name,
            'grantee', tp.grantee,
            'privilege_type', tp.privilege_type
          ) order by tp.table_name, tp.grantee, tp.privilege_type
        ) filter (where tp.table_name is not null),
        '[]'::jsonb
      )
    ) as details
  from information_schema.table_privileges tp
  where tp.table_schema = 'public'
    and tp.table_name = any(array[
      'tool_state', 'scenarios', 'salary_submissions', 'monthend_items',
      'monthend_payments', 'mortgage_loan_parts', 'mortgage_rate_periods',
      'mortgage_payments', 'mortgage_valuations', 'mortgage_contributions',
      'house_items'
    ]::text[])
    and tp.grantee in ('PUBLIC', 'anon', 'authenticated')
    and tp.privilege_type in ('INSERT', 'UPDATE', 'DELETE')
)
select section, object_name, details
from (
  select * from public_tables
  union all
  select * from public_policies
  union all
  select * from definer_functions
  union all
  select * from private_schema_usage
  union all
  select * from private_table_grants
  union all
  select * from revisioned_table_mutation_grants
) audit_rows
order by section, object_name;
