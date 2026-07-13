-- Plan 96 — restore least-privilege execution grants for public functions.
--
-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default. Earlier
-- migrations revoked named client roles without always revoking PUBLIC, so
-- those roles retained effective access through their PUBLIC membership.

-- Retired client preflight: the Before User Created Auth hook is the signup
-- boundary, so no client role should call this invite-enumeration function.
revoke execute on function public.email_may_sign_in(text)
  from public, anon, authenticated;

-- Active RPCs remain available to signed-in users only. Revoke inherited and
-- anonymous access before restoring the intended explicit grant.
revoke execute on function public.household_roster() from public, anon;
grant execute on function public.household_roster() to authenticated;

revoke execute on function public.settle_items(
  text, jsonb, text, text, numeric, text, text, timestamp with time zone
) from public, anon;
grant execute on function public.settle_items(
  text, jsonb, text, text, numeric, text, text, timestamp with time zone
) to authenticated;

revoke execute on function public.unsettle_payment(text) from public, anon;
grant execute on function public.unsettle_payment(text) to authenticated;
