# Plan 46 — Enforce invite-only signup server-side (before-user-created hook)

**Status:** shipped (PR #239) · **Owner model:** Opus (security boundary; must verify the
current hook event-payload shape against live Supabase docs (Context7) rather
than trust the draft, and the failure mode of getting it wrong is locking the
couple out or reopening the bypass; includes a manual dashboard step) ·
**Severity: HIGH (H1)** · **Source:** repo audit 2026-07-06 ·
**Req:** 4 of the audit batch ·
Touches a new `supabase/migrations/` file + a Supabase **dashboard** step
(Auth → Hooks). No web/ code change required.

## Finding

The "strangers can't sign up" hardening (plan 16h) works by having the client
call `email_may_sign_in()` and pass the result as `shouldCreateUser` on the
magic-link request (AuthGate.tsx:116–124). But `shouldCreateUser` is a
**client-supplied parameter**, and the Supabase URL + publishable key ship in
the public JS bundle by design. Anyone can call
`signInWithOtp({ email, options: { shouldCreateUser: true } })` from a console
or curl against GoTrue directly — signups are enabled at the project level —
and get a real account. `claim_household()` then provisions them their own
household.

RLS still isolates their data (this is NOT a data breach), but strangers can:
create unlimited accounts, write unlimited rows (database/quota abuse), spam
invites from their own household, and hold an `authenticated` role that
magnifies any future RLS mistake. The gate is UX, not security.

## Fix

A **Before User Created** auth hook runs inside GoTrue on every signup,
regardless of what the client sends. Reject emails without a pending invite:

```sql
create or replace function public.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql
security definer set search_path to ''
as $$
begin
  if exists (
    select 1 from public.household_invites
    where lower(email) = lower(event #>> '{user,email}')
  ) then
    return '{}'::jsonb;  -- invited → allow
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403, 'message', 'Hemma·OS är endast för inbjudna.'));
end;
$$;
grant execute on function public.hook_before_user_created to supabase_auth_admin;
```

Then register it: Dashboard → Authentication → Hooks → "Before User Created" →
Postgres function → `public.hook_before_user_created`. (Verify the exact
event payload shape against current Supabase docs — use Context7 — before
shipping; the `{user,email}` path is the documented shape as of the audit.)

Keep the existing client-side `emailMaySignIn` call purely for a friendly
pre-flight error message — it is no longer load-bearing.

## Important

The existing couple's accounts already exist, so the hook never fires for
them. Test with a throwaway email BOTH ways: uninvited → magic-link request
errors; invited → account creates and `claim_household` joins the household.

## Acceptance criteria

- Direct GoTrue call with `shouldCreateUser: true` and an uninvited email
  fails with 403.
- Invited email still self-onboards end-to-end (magic link → household join).
- Existing users unaffected (sign-in regression check).
- Hook SQL committed as a migration; dashboard registration step documented in
  the migration's header comment (it can't be captured in SQL alone).
