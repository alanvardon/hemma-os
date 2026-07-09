# Plan 84 — Restore `claim_household`'s first-sign-in race guard (regressed by plan 53)

**Status:** plan · **Owner model:** Opus (one small migration, but it must merge
two prior migrations' semantics — plan 52's race guard AND plan 53's invite
expiry — inside a security-definer function; a wrong merge silently reintroduces
either the race or the multi-household bug, and nothing in CI would catch it) ·
**Severity: HIGH** (prod-reachable 409 on first sign-in; guaranteed failure in
dev under StrictMode) · **Source:** discovered 2026-07-09 while working on plan
83; reproduced live against local Supabase (parallel RPCs → 200 + 409) ·
**Sequencing:** standalone; own branch off `main` (plan 83's PR #255 is open —
do NOT stack) · **Touches:** new
`supabase/migrations/20260709090000_restore_claim_household_race_guard.sql`
**only** (no app code — `AuthGate.tsx` / `household.ts` need no change).

## Finding

Plan 53 (`supabase/migrations/20260708130000_invite_hygiene.sql`) re-created
`public.claim_household()` to add the 30-day invite expiry — but its body was
**written from a stale copy of the function**, predating plan 52
(`20260708100000_one_household_per_user.sql`). Plan 52's entire race-handling
tail was silently reverted. Since migrations apply in timestamp order, the live
function (verified via `\sf public.claim_household`) is the regressed one.

What plan 52 added and plan 53 dropped — the fresh-household branch now reads
(invite_hygiene.sql, function tail):

```sql
-- Otherwise: a fresh private household with this user as its owner.
insert into public.households (name) values ('Mitt hushåll') returning id into hid;
insert into public.household_members (household_id, user_id, role)
  values (hid, uid, 'owner');          -- ← bare insert: no on-conflict,
return hid;                            --   no re-select, no orphan cleanup
```

The failure sequence (reproduced live this session):

1. `web/src/main.tsx:23` wraps the app in `<StrictMode>`. In dev, React
   mounts → unmounts → remounts, so AuthGate's session effect
   (`web/src/components/AuthGate.tsx:41-61`) runs twice. The dedupe ref
   `claimedFor.current` is only set **after** the first RPC resolves
   (AuthGate.tsx:56), so both effect runs fire `claimHousehold()` before either
   returns → two **concurrent** `claim_household()` RPCs on every first
   sign-in of a fresh user in dev.
2. Both calls pass the "already a member" check (no membership exists yet),
   both insert a `households` row, both attempt the owner-membership insert.
3. The unique index `household_members_user_uniq (user_id)` (from plan 52) lets
   exactly one through; the loser raises `23505 unique_violation`. plpgsql
   doesn't catch it, so the losing call's transaction **aborts and rolls back**
   (its household row disappears with it — no orphan) and PostgREST returns
   **HTTP 409** to the client. Observed: `call 1 → 200, call 2 → 409`.
4. `claimHousehold()` maps the error to `null` (`web/src/lib/household.ts:25`);
   AuthGate still renders the app but leaves the claim uncached, so it re-fires
   on the next auth event.

Why it matters: **prod is exposed, not just dev.** StrictMode makes the race
deterministic locally, but any two concurrent first-sign-in claims reproduce it
in production — two tabs opened from the same magic link, a token refresh
racing the initial claim. Plan 52 closed exactly this window; plan 53 reopened
it without anyone deciding to. No data is lost (the rollback is clean), but a
first-run user gets a failed claim + console noise, and a shipped invariant
regressed invisibly — the same "functional change hidden in a rewrite" landmine
already on record for the orchestrator repo.

Checked and clean: `accept_invite` was also re-created by plan 53, but a diff
against its plan-50 original (`20260708110000_household_join_leave.sql`) shows
the only change is the intended expiry filter — its `on conflict (user_id) do
nothing` survived. The regression is isolated to `claim_household`.

## Fix

One new migration that re-creates `claim_household` as the **union of both
parents**: plan 53's 30-day invite expiry in the invite lookup, plan 52's
race-safe tail in the fresh-household branch. Nothing else changes — the
already-a-member fast path and the invite-join branch are byte-identical to the
live version.

```sql
-- supabase/migrations/20260709090000_restore_claim_household_race_guard.sql
--
-- Plan 84 — restore the first-sign-in race guard that plan 52
-- (20260708100000_one_household_per_user.sql) added and plan 53
-- (20260708130000_invite_hygiene.sql) accidentally reverted by rewriting
-- claim_household from a stale copy. Two concurrent first-time claims (React
-- StrictMode double-fires AuthGate's effect in dev; two tabs in prod) both
-- reached the bare owner-insert; the unique index on user_id made the loser
-- 409 back to the client. This body is the union of both parents: plan 53's
-- 30-day invite expiry + plan 52's on-conflict / re-select / orphan-cleanup
-- tail. If you rewrite this function again, START FROM THIS TEXT.

create or replace function "public"."claim_household"()
    returns "uuid"
    language "plpgsql"
    security definer
    set "search_path" to ''
    as $$
declare
  uid uuid := (select auth.uid());
  mail text := (select auth.jwt() ->> 'email');
  hid uuid;
  new_hid uuid;
begin
  if uid is null then
    return null;
  end if;

  -- Already a member — nothing to do (this runs on every sign-in / refresh).
  select household_id into hid
    from public.household_members where user_id = uid limit 1;
  if hid is not null then
    return hid;
  end if;

  -- A pending, non-expired invite to this email — join that household.
  if mail is not null then
    select household_id into hid
      from public.household_invites
      where lower(email) = lower(mail) and created_at > now() - interval '30 days'
      limit 1;
    if hid is not null then
      insert into public.household_members (household_id, user_id, role)
        values (hid, uid, 'member') on conflict do nothing;
      delete from public.household_invites where lower(email) = lower(mail);
      return hid;
    end if;
  end if;

  -- Otherwise: a fresh private household with this user as its owner. Two racing
  -- first-time claims both land here; the unique index on user_id lets exactly
  -- one membership survive.
  insert into public.households (name) values ('Mitt hushåll') returning id into new_hid;
  insert into public.household_members (household_id, user_id, role)
    values (new_hid, uid, 'owner')
    on conflict (user_id) do nothing;

  -- Re-select the surviving membership so the race loser returns the winner's
  -- household id rather than its own orphaned one.
  select household_id into strict hid
    from public.household_members where user_id = uid;

  -- If we lost the race, drop the empty household THIS call just created (it has
  -- no members and no data — brand new). Scoped to new_hid only: never touches
  -- abandoned-but-populated households left behind by plan 50's leave/accept,
  -- whose data rows would otherwise trip the (non-cascading) household_id FKs.
  if new_hid is distinct from hid then
    delete from public.households where id = new_hid;
  end if;

  return hid;
end;
$$;

alter function "public"."claim_household"() owner to "postgres";
grant execute on function "public"."claim_household"() to "authenticated";
```

Wait — plan 52's guard used `on conflict (user_id) do nothing`, which turns the
loser's violation into a no-op *within the same still-alive transaction*; both
calls then re-select the winner's membership and both return the same household
id, and the loser deletes its own empty household. That is the semantics being
restored, verbatim. **Do not** "simplify" the tail to an exception handler or
drop the `strict` — the re-select must fail loudly if no membership exists at
all (that would mean the index or the insert semantics changed underneath us).

Client side needs **no change**: `claimHousehold()` is documented idempotent and
AuthGate's post-resolve caching is correct once the RPC stops failing. The
StrictMode double-call remains (two RPCs, both now succeed and agree) — that's
harmless by design.

## Acceptance criteria

- New migration applies cleanly to the running local stack (`supabase migration
  up` from the repo root) — no reset required.
- **Race test (the one that failed before):** create a fresh confirmed user via
  the local GoTrue admin API, sign in for a JWT, fire two *parallel*
  `POST /rest/v1/rpc/claim_household` calls. Both must return **HTTP 200 with
  the same household id** (before the fix: one 200, one 409 — reproduced
  2026-07-09).
- After the race: exactly **one** `household_members` row for that user
  (`role = 'owner'`) and **no empty orphan household** (every `households` row
  has ≥ 1 member or pre-existing data).
- Idempotence unchanged: a third, sequential call returns the same id (fast
  path).
- Invite expiry preserved: the deployed function text still contains
  `created_at > now() - interval '30 days'` in the invite lookup
  (`\sf public.claim_household`) — proving plan 53's feature survived the merge.
- `npm run build` green in `web/` (nothing should have changed, but it's the
  gate).
- Clean up the throwaway race-test users/households from the local DB afterwards.

## Out of scope

- Client-side in-flight dedupe of `claimHousehold()` (module-level shared
  promise). Considered and rejected: the server fix is the real boundary (it
  protects the two-tab prod case a client dedupe can't), the double RPC is
  harmless once idempotent, and the dedupe would complicate
  `household.test.ts`'s mock semantics for zero correctness gain.
- Any pgTAP / DB-level test harness for migrations — there is none in the repo;
  adding one is a separate infrastructure decision.
- Auditing other functions for the same stale-copy pattern beyond
  `accept_invite` (checked, clean) — `leave_household` and the roster RPCs were
  not rewritten by plan 53.
