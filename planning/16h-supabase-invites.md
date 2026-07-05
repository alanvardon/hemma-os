# Plan 16h — Invite UI + auto-join + hardening (Phase D, PR 8)

**Parent:** [Plan 16](16-supabase-migration-auth.md) · **Branch:**
`ui/supabase-invites` · **Prerequisites:**
[16g](16g-supabase-konsult-lonevaxling.md) merged (every tool is cloud-backed).

## Goal

Replace the manual SQL household seed with a real, self-service join flow:
enter your partner's email → they auto-join on their first magic-link sign-in.
Plus the final security hardening. This is the "product-complete" phase; the app
already works for the two of you via the 16a seed, so this is polish + a fresh
account onboarding path.

## Auto-join on first sign-in

Today (16a) a new sign-in has no household. Add the join logic, run once per new
user right after `onAuthStateChange` fires a session for a user with no
`household_members` row:

1. Look for a `household_invites` row matching the user's email.
2. If found → insert a `household_members` row for `(household_id, auth.uid())`
   and delete the invite.
3. If none → create a household + add them as owner (their own private space).

Implement as a **Postgres function** (`security definer`, called via
`supabase.rpc('claim_household')`) rather than client inserts — it needs to
write `household_members`/`households`, which the client otherwise can't (their
policies are read-only). This keeps the trust boundary in the DB.

## Invite RLS policies (as a Supabase migration: `migration new` → `db push`)

The client now needs limited write/read on invites + membership. Add:

```sql
-- a user may see invites addressed to their own email
create policy inv_read_own on public.household_invites for select to authenticated
  using (email = (select auth.jwt() ->> 'email'));

-- a household member may create invites for their household
create policy inv_write on public.household_invites for insert to authenticated
  with check (household_id = (select private.current_household()));
```

Membership inserts stay inside the `security definer` `claim_household` function
(not a client policy), so the "create membership" power isn't exposed directly.

## Invite UI

A small settings surface (in the household/settings area — new or existing):
- Show current household members (from `household_members` + names).
- "Invite by email" input → inserts a `household_invites` row for the current
  household. Show pending invites with a remove option.

## Hardening

- **`shouldCreateUser: false`** on `signInWithOtp` now that both of you (and any
  invited partner) can be onboarded via invites — stops strangers creating
  accounts at all. (Was deliberately deferred from 16a because the seed needed
  accounts to pre-exist.)
- Retire the SQL seed from the docs' "how to onboard" path (keep it in the
  migration history / this plan as reference).

## Optional stretch (same PR or a follow-up)

- **Realtime** on `monthend_items`/`monthend_payments` + the budget
  `tool_state` row (`supabase.channel(...).on('postgres_changes', …)`) so a
  partner's edit appears live. Nice-to-have; the couple tools benefit most.

## Verification gate / Definition of done

- **RLS acceptance check** — the new **write** policies on
  `household_invites` are the surface here: a member can insert an invite for
  their household and read invites addressed to their email; a non-member can do
  neither. `supabase/audit-rls.sql` still all ✓ (data tables unchanged; the
  invite table stays read-mostly with the scoped write policy).

- A **fresh account with a pending invite** self-joins on first sign-in and sees
  the household's data.
- A **fresh account without an invite** lands in its own empty private
  household (and cannot see yours — RLS).
- `shouldCreateUser: false` verified: an unknown email gets no magic link.
- Inviting from the UI creates a pending invite; removing it works.
- `build` + `oxlint` + `vitest` green.

**Done:** the Supabase migration is complete. Cross-tool insights (idea #8) is
now unblocked — all household data lives in one queryable place (real tables +
`tool_state` blobs).
