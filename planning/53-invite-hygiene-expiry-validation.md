# Plan 53 — Invite hygiene: expiry, cap, server-side validation

**Status:** plan · **Severity: LOW (L2)** · **Source:** repo audit 2026-07-06 ·
**Req:** 11 of the audit batch · Natural companion to plans 45/46/52 — batch
the SQL into one migration PR if convenient ·
Touches one new `supabase/migrations/` file (+ optional tiny copy change in
`HouseholdMenu.tsx`).

## Finding

`household_invites` rows are forever and free-form:

- **No expiry** — a pending invite is a standing account-creation grant for
  that email (it drives both `email_may_sign_in` and, after plan 46, the
  signup hook). Forgotten invites keep working years later.
- **No cap** — the `inv_write` RLS policy lets any member insert unlimited
  invites for their household.
- **No server-side email validation** — the policy accepts any string; the
  `EMAIL_RE` check lives only in HouseholdMenu.tsx:20. A junk row can't be
  signed in with, but it pollutes the gate table.

## Fix (one migration)

```sql
-- Expiry: consider invites older than 30 days dead everywhere they're read.
-- (Column default now() already exists as created_at — no new column needed.)
-- Update the three consumers to add:  and created_at > now() - interval '30 days'
--   • email_may_sign_in()           (plans 45/52 already touch it)
--   • claim_household() invite lookup
--   • hook_before_user_created()    (plan 46)
-- Optionally a scheduled cleanup:  delete from household_invites
--   where created_at < now() - interval '90 days';  (pg_cron, or skip — the
--   read-side filter is what matters)

-- Server-side shape check + normalization:
alter table public.household_invites
  add constraint household_invites_email_shape
  check (email = lower(email) and email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$');

-- Cap: at most 5 pending invites per household.
create or replace function private.invite_cap_ok(hid uuid) returns boolean
language sql security definer set search_path to '' as $$
  select count(*) < 5 from public.household_invites where household_id = hid;
$$;
-- and extend inv_write's with_check:
--   with check (household_id = (select private.current_household())
--               and (select private.invite_cap_ok(household_id)))
```

Pre-flight: `select * from household_invites where email <> lower(email) or
email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$';` — clean up before adding the
constraint.

UI: surface the constraint errors as the existing `createInvite` error string
already does (it returns `error.message`); optionally show invite age in the
pending list.

## Acceptance criteria

- Insert of `'not-an-email'` or mixed-case via direct PostgREST call → 4xx.
- 6th pending invite rejected with a policy error.
- An invite backdated >30 days no longer passes `email_may_sign_in` /
  `claim_household` / the hook.
