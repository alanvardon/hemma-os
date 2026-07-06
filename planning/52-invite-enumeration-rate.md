# Plan 52 — Blunt invite-email enumeration via `email_may_sign_in`

**Status:** plan · **Severity: LOW (L1)** · **Source:** repo audit 2026-07-06 ·
**Req:** 10 of the audit batch · **Depends on:** plan 46 — if the
before-user-created hook lands, this function stops being load-bearing, which
is what makes this cheap ·
Touches one new `supabase/migrations/` file + optionally
`web/src/components/AuthGate.tsx`.

## Finding

`email_may_sign_in(addr)` is `security definer` and granted to `anon`
(migration 20260705180000, line 79). Anyone with the publishable key — i.e.
anyone who views the site source — can probe arbitrary email addresses and
learn which ones have a pending household invite. Privacy leak (reveals who is
being onboarded and confirms the address is "known" to the app), unthrottled
beyond Supabase's platform defaults.

## Fix (choose after plan 46 lands)

Preferred, and only valid AFTER plan 46: the server-side hook now enforces the
signup gate, so the anon RPC exists purely to pre-render a nicer error in
AuthGate. Two options:

- **A (recommended): remove the anon grant entirely** —
  `revoke execute on function public.email_may_sign_in(text) from anon;`
  AuthGate then always sends the OTP request with `shouldCreateUser: true` and
  maps the hook's 403 to the friendly "invite only" message. Deletes the
  enumeration surface AND the H3 client half. `emailMaySignIn` in
  household.ts is then dead code — remove it.
- **B (if the pre-flight UX must stay): keep the RPC but make it constant-ish**
  — always return true unless rate-limited; i.e. accept that the check moves
  entirely to the hook. (Functionally identical to A with extra steps — prefer
  A.)

## Acceptance criteria

- `select email_may_sign_in('x@y.z')` as `anon` → permission denied (option A).
- Uninvited email on the login screen still gets a clear Swedish error
  message sourced from the hook's 403.
- `emailMaySignIn` removed from household.ts + AuthGate (option A).
