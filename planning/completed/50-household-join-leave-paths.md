# Plan 50 — Household lifecycle: join-when-already-provisioned + leave

**Status:** plan · **Owner model:** Opus (two new security-definer RPCs that
move memberships — the most consequential auth-layer change in the batch; also
carries an unresolved product decision that must be settled with the user
before any code) ·
**Severity: MEDIUM (M4)** · **Source:** repo audit 2026-07-06 ·
**Req:** 8 of the audit batch · **Depends on:** plan 51 (unique membership
index) simplifies this — do 51 first or together ·
Touches new `supabase/migrations/` + `web/src/lib/household.ts` +
`web/src/components/HouseholdMenu.tsx`.

## Finding

`claim_household()` consumes an invite ONLY when the caller has no membership
yet (migration 20260705180000, lines 33–38 early-return). So:

- Someone who signs in BEFORE being invited (or who slipped past the client
  gate — audit H1) gets their own single-member household **forever**; an
  invite to their email sits pending eternally and is never matched again.
- There is no leave-household, no remove-member, no merge —
  `household_members` has a SELECT-only policy and no other write path exists
  outside `claim_household`.

At N=2 this is survivable with manual SQL, but it's the first thing that hurts
with a third person or one onboarding mistake.

## Scope decision (keep it small)

Do NOT build merge/transfer machinery. Two RPCs cover the real cases:

1. **`accept_invite()`** — security definer. If a pending invite exists for
   the caller's (lowercased) email: delete their membership row(s); if their
   old household is now empty, delete its invites, tool_state and data rows
   are ORPHANED not deleted (decide: simplest = leave the empty household in
   place, harmless); insert membership into the inviting household as
   'member'; consume the invite. Effect: "sign-in-before-invite" is repaired
   by the invitee themselves clicking a button.
2. **`leave_household()`** — security definer. Delete the caller's membership
   UNLESS they are the last member (raise instead — last member leaving would
   strand the data; they can just stop using it). On next sign-in
   `claim_household` provisions them a fresh household.

Both must re-check everything inside the function (definer bypasses RLS) and
pin on `auth.uid()`.

**UI (HouseholdMenu):** when `inv_read_own` shows a pending invite addressed
to ME while I already have a household → banner "Du är inbjuden till ett annat
hushåll" with an accept button (calls `accept_invite`, then full reload so
every store re-reads under the new household). Add "Lämna hushåll" behind a
confirm in the panel footer.

## Open question for the user (before implementing)

What happens to the old household's data on accept/leave — abandon in place
(recommended: recoverable by re-joining via SQL, zero deletion risk) or purge?
Plan assumes abandon.

## Acceptance criteria

- Repro the stranding: create user with own household, then invite their
  email → banner appears → accept → member of inviting household, invite
  consumed, old household empty but intact.
- Leave: non-last member can leave; last member gets a friendly error.
- RPCs unit-tested at the SQL level (supabase SQL editor script committed
  alongside, like audit-rls.sql) since the client mock can't prove definer
  pinning.
