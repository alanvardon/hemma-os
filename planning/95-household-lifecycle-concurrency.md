# Plan 95 — Serialize household leave and invite acceptance

**Status:** proposed · **Priority:** Medium · **Effort:** S–M · **Owner model:**
GPT-5.6 Sol — owns database locking, SECURITY DEFINER review, concurrency tests,
and multi-invite decision handling · **Requires approval:** migration changes

## Goal

Close household lifecycle races and make multi-invite behavior deterministic
without broadening any caller's authority.

## Confirmed race

`leave_household()` in
`supabase/migrations/20260708110000_household_join_leave.sql:99-111` counts
members and then deletes. If the final two members leave concurrently, both can
observe a count of two and both delete themselves, stranding the household and
its data.

## Secondary ambiguity

`accept_invite()` selects one matching invite with `limit 1` and consumes every
invite for that email. If two households invite the same address, the selected
household is unspecified and the other invitation disappears.

## Decisions locked

1. A household containing persisted data may never reach zero members through a
   client-callable lifecycle RPC.
2. Serialize leave operations by locking a stable household row (or an equally
   strong documented mechanism) before recounting and deleting.
3. SECURITY DEFINER functions continue deriving identity from `auth.uid()`/JWT,
   with pinned empty search paths and authenticated-only execution.
4. Do not choose multi-invite product behavior silently. Before implementation,
   confirm whether the UI should let the user choose, enforce one active invite
   per email globally, or reject ambiguous acceptance.

## Implementation

- Add a new migration replacing function bodies; do not edit old migrations.
- Lock, re-read membership, and mutate inside one transaction.
- Make invitation selection deterministic according to the confirmed decision.
- Consume only the invitation(s) the decision says were acted on.

## Tests

- Two database sessions attempt to leave a two-member household concurrently;
  exactly one succeeds and one membership remains.
- Concurrent claim/accept calls preserve one membership per user.
- No-invite, expired-invite, same-household, and multiple-invite cases.
- Hostile callers cannot choose another user or household.

## Acceptance criteria

- The concurrent final-member test fails against the old function and passes
  against the new migration.
- No lifecycle RPC can strand household data.
- Multi-invite behavior is explicit in UI, SQL, and tests.
- `supabase/test-household-lifecycle.sql` is extended or replaced with a test
  capable of exercising concurrency.
