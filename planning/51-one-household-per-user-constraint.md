# Plan 51 — Enforce one household per user (index + claim race)

**Status:** plan · **Severity: MEDIUM (M5)** · **Source:** repo audit 2026-07-06 ·
**Req:** 9 of the audit batch · **Do before or with plan 50** ·
Touches one new `supabase/migrations/` file. No web/ change.

## Finding

Nothing enforces the design assumption that a user belongs to exactly one
household:

- `household_members` PK is `(household_id, user_id)` — the same user CAN sit
  in two households.
- `claim_household()`'s "create fresh household" branch has no concurrency
  guard: two tabs/devices racing through a first sign-in can BOTH pass the
  "already a member?" check, then each create a household + membership row.
- `current_household()` (baseline migration, lines 61–68) resolves the
  ambiguity with an unordered `limit 1` — so which household a request writes
  to becomes nondeterministic, silently splitting the couple's data.

## Fix

```sql
-- One household per user, enforced at the schema level. If this fails on an
-- existing environment, someone is already in two households — resolve by
-- hand first (keep the row for the shared household, delete the other).
create unique index if not exists household_members_user_uniq
  on public.household_members (user_id);
```

Then make `claim_household` race-safe: replace the final
`insert into household_members … values (hid, uid, 'owner')` with
`… on conflict (user_id) do nothing`, and re-select the membership afterwards
so the loser of the race returns the winner's household id (and clean up the
loser's just-created empty `households` row):

```sql
insert into public.household_members (household_id, user_id, role)
  values (hid, uid, 'owner')
  on conflict (user_id) do nothing;
select household_id into strict hid
  from public.household_members where user_id = uid;
delete from public.households h
  where h.name = 'Mitt hushåll'
    and not exists (select 1 from public.household_members m where m.household_id = h.id)
    and h.id <> hid;
```

(Also gives `current_household()` a deterministic answer for free — exactly
one row can exist.)

**Pre-flight:** run in the SQL editor first:
`select user_id, count(*) from public.household_members group by 1 having count(*) > 1;`
— must return zero rows before applying.

## Acceptance criteria

- Index exists in prod; duplicate-membership query returns zero rows.
- Two rapid parallel `claim_household()` calls for a brand-new user (two
  devtools tabs) end with exactly one household + one membership row.
- audit-rls.sql still passes for all tables.
