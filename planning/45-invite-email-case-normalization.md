# Plan 45 — Case-insensitive invite email matching

**Status:** plan · **Severity: HIGH (H3)** · **Source:** repo audit 2026-07-06 ·
**Req:** 3 of the audit batch ·
Touches a new `supabase/migrations/` file + `web/src/lib/household.ts`.

## Finding

Invites are stored lowercased (household.ts:61 `.toLowerCase()`), but both SQL
functions compare **case-sensitively**:

- `email_may_sign_in(addr)` — `where email = addr`
  (migration 20260705180000_invites_claim_join.sql:75), and the client passes
  the raw typed address (`AuthGate.tsx:116` only `.trim()`s it).
- `claim_household()` — `where email = mail` (same migration, line 43), where
  `mail` is the JWT email (GoTrue normalizes it lowercase).

Failure: an invited partner types `Sam@Gmail.com` on the login screen →
`email_may_sign_in` returns false → `shouldCreateUser: false` → GoTrue refuses
to create the account → the ONE onboarding path fails, with an error that
never hints "retype it in lowercase". A mixed-case invite row (the `inv_write`
RLS policy accepts any string via direct API insert) would additionally never
be matched or consumed by `claim_household`.

## Fix

Normalize on both sides.

**New migration** (`lower()` both comparisons — idempotent `create or replace`):

```sql
create or replace function public.email_may_sign_in(addr text)
returns boolean language sql security definer set search_path to '' as $$
  select exists (select 1 from public.household_invites
                 where lower(email) = lower(addr));
$$;
```

…and re-declare `claim_household()` with the invite lookup changed to
`where lower(email) = lower(mail)` (copy the full body from
20260705180000_invites_claim_join.sql — `create or replace` replaces whole
functions, no partial edit).

**Client belt-and-braces** — household.ts:34:

```ts
const { data, error } = await supabase.rpc('email_may_sign_in', { addr: addr.trim().toLowerCase() })
```

`createInvite` already lowercases; leave it.

## Notes

- If plan 46 (before-user-created hook) lands first, apply the same `lower()`
  comparison there — its draft SQL already includes it.
- Optional hardening (not required): make `household_invites.email` `citext`,
  or add a `check (email = lower(email))` constraint. Skip unless trivial —
  the `lower()` comparisons alone close the bug.

## Acceptance criteria

- In SQL editor: seed an invite for `sam@gmail.com`, then
  `select email_may_sign_in('Sam@Gmail.COM')` → true.
- Migration applied via `supabase db push` (or dashboard) and committed.
- Sign-in flow still works for the existing couple (regression check).
