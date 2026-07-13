-- Plan 96 post-migration function-grant verification — STRICTLY READ ONLY.
--
-- Paste this SELECT into the linked project's Supabase Dashboard SQL Editor.
-- It reads only pg_catalog function metadata and does not invoke application
-- functions or read application/auth rows.
--
-- Expected matrix:
--   email_may_sign_in(text): public=false, anon=false, authenticated=false
--   household_roster(): public=false, anon=false, authenticated=true
--   settle_items(...): public=false, anon=false, authenticated=true
--   unsettle_payment(text): public=false, anon=false, authenticated=true

select
  n.nspname as schema_name,
  p.proname as function_name,
  pg_catalog.pg_get_function_identity_arguments(p.oid) as identity_arguments,
  pg_catalog.has_function_privilege('public', p.oid, 'execute') as public_execute,
  pg_catalog.has_function_privilege('anon', p.oid, 'execute') as anon_execute,
  pg_catalog.has_function_privilege('authenticated', p.oid, 'execute') as authenticated_execute
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where p.oid in (
  'public.email_may_sign_in(text)'::pg_catalog.regprocedure,
  'public.household_roster()'::pg_catalog.regprocedure,
  'public.settle_items(text,jsonb,text,text,numeric,text,text,timestamp with time zone)'::pg_catalog.regprocedure,
  'public.unsettle_payment(text)'::pg_catalog.regprocedure
)
order by p.proname;
