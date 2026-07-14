-- Plan 96 post-migration function-grant verification — STRICTLY READ ONLY.
--
-- Paste this SELECT into the linked project's Supabase Dashboard SQL Editor.
-- It reads only pg_catalog function metadata and does not invoke application
-- functions or read application/auth rows.
--
-- Expected matrix:
--   email_may_sign_in(text): public=false, anon=false, authenticated=false
--   household_roster(): public=false, anon=false, authenticated=true
--   legacy settle_items/unsettle_payment/delete_*: all client execute=false
--   sync_apply_rows/sync_apply_tool_state/sync_delete_rows: authenticated=true only
--   sync_settle_items/sync_unsettle_payment/sync_delete_mortgage_loan_part:
--     authenticated=true only

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
  'public.unsettle_payment(text)'::pg_catalog.regprocedure,
  'public.delete_household_rows(text,text[])'::pg_catalog.regprocedure,
  'public.delete_mortgage_loan_part(text)'::pg_catalog.regprocedure,
  'public.sync_apply_rows(text,text,jsonb,jsonb,boolean)'::pg_catalog.regprocedure,
  'public.sync_apply_tool_state(text,text,jsonb,bigint,boolean)'::pg_catalog.regprocedure,
  'public.sync_delete_rows(text,text,text[],jsonb)'::pg_catalog.regprocedure,
  'public.sync_settle_items(text,jsonb,jsonb)'::pg_catalog.regprocedure,
  'public.sync_unsettle_payment(text,text,jsonb)'::pg_catalog.regprocedure,
  'public.sync_delete_mortgage_loan_part(text,text,jsonb)'::pg_catalog.regprocedure
)
order by p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid);
