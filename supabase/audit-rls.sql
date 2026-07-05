-- audit-rls.sql — mechanical guard against RLS drift (plan 16 hardening).
--
-- Paste this whole query into the Supabase SQL Editor and run it after every
-- phase that adds a table. It checks EVERY table in `public` that has a
-- `household_id` column and returns one row per table with a verdict. Any row
-- whose verdict starts with ✗ is a problem — fix it (usually by re-running
-- schema.sql, which re-asserts the correct `for all` policies).
--
-- This catches the exact bug that hid the Månadsavslut breakage: a
-- `for select`-only policy that lets reads through (200) but blocks EVERY
-- insert (403 "violates row-level security policy") — for you and everyone.
--
-- Pass criteria per data table:
--   • RLS enabled (else world-accessible)
--   • a permissive read policy (SELECT or ALL)
--   • a permissive insert policy (INSERT or ALL) whose WITH CHECK scopes to
--     current_household()
-- The read-only infra tables (household_members, household_invites) are exempt
-- from the insert requirement by design.

with hh_tables as (
  select c.relname as tbl, c.relrowsecurity as rls_on
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and exists (
      select 1 from pg_attribute a
      where a.attrelid = c.oid and a.attname = 'household_id' and not a.attisdropped
    )
),
pol as (
  select tablename,
    bool_or(permissive = 'PERMISSIVE' and cmd in ('ALL', 'INSERT')) as has_insert,
    bool_or(permissive = 'PERMISSIVE' and cmd in ('ALL', 'INSERT')
            and with_check ilike '%current_household%') as insert_checked,
    bool_or(permissive = 'PERMISSIVE' and cmd in ('ALL', 'SELECT')) as has_read
  from pg_policies
  where schemaname = 'public'
  group by tablename
)
select
  t.tbl as table_name,
  t.rls_on as rls_enabled,
  coalesce(p.has_read, false) as can_read,
  coalesce(p.has_insert, false) as can_insert,
  coalesce(p.insert_checked, false) as insert_household_scoped,
  case
    when not t.rls_on then '✗ FAIL: RLS disabled (world-accessible)'
    when not coalesce(p.has_read, false) then '✗ FAIL: no read policy'
    when t.tbl in ('household_members', 'household_invites') then '✓ ok (read-only infra)'
    when not coalesce(p.has_insert, false) then '✗ FAIL: no insert policy — inserts blocked for everyone'
    when not coalesce(p.insert_checked, false) then '✗ FAIL: insert policy missing current_household() with_check'
    else '✓ PASS'
  end as verdict
from hh_tables t
left join pol p on p.tablename = t.tbl
order by verdict desc, t.tbl;
