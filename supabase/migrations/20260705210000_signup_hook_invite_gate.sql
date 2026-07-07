-- Plan 46 — enforce invite-only signup server-side (Before User Created hook).
--
-- Plan 16h's "strangers can't sign up" hardening relies on the CLIENT passing
-- shouldCreateUser: false to signInWithOtp when email_may_sign_in() says no
-- (AuthGate.tsx). But shouldCreateUser is a client-supplied parameter, and the
-- Supabase URL + publishable key ship in the public JS bundle by design —
-- anyone can call signInWithOtp({ email, options: { shouldCreateUser: true } })
-- directly against GoTrue and get a real account. RLS still isolates their
-- data (not a data breach), but they can create unlimited accounts, write
-- unlimited rows, and hold an authenticated role. The client-side gate is UX,
-- not security.
--
-- A "Before User Created" auth hook runs inside GoTrue on every signup
-- attempt, server-side, regardless of what the client sends — this is the
-- actual security boundary. household_invites has no auth.uid()/current_
-- household() context to authorize against at this point (there's no session
-- yet), so the check needs security definer to read the table past RLS —
-- same reasoning as claim_household()/email_may_sign_in() in
-- 20260705180000_invites_claim_join.sql. Payload shape (event->'user'->>
-- 'email') verified against the current Supabase Auth Hooks docs.
--
-- Grant to supabase_auth_admin only (the role GoTrue calls hooks as); revoke
-- from authenticated/anon/public so no other caller can invoke it directly
-- (matches the Supabase-documented pattern for these hooks).
--
-- MANUAL STEP (cannot be captured in SQL): after this migration is applied,
-- register the hook in the dashboard — Authentication → Hooks → "Before User
-- Created" → Postgres function → public.hook_before_user_created. The hook
-- has no effect until this is done.
--
-- Existing users are unaffected — the hook only fires on new-user creation,
-- and the seeded couple's accounts already exist.

create or replace function public.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
begin
  if exists (
    select 1 from public.household_invites
    where lower(email) = lower(event #>> '{user,email}')
  ) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403, 'message', 'Hemma·OS är endast för inbjudna.'));
end;
$$;

grant execute on function public.hook_before_user_created to supabase_auth_admin;
revoke execute on function public.hook_before_user_created from authenticated, anon, public;
