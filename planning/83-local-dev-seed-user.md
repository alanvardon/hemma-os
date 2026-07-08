# Plan 83 — Seed the local dev user so devAuth auto-sign-in survives a `db reset`

**Status:** plan · **Owner model:** Sonnet (small, self-contained SQL seed +
config, but it touches the `auth` schema and the invite-gate security boundary —
the implementer must not weaken the prod hook, and must verify login end-to-end
via a real `db reset`, not by eyeballing) · **Source:** discovered while
verifying plan 57 (2026-07-08 Playwright pass) · **Sequencing:** standalone;
unblocks local Playwright verification for every future web plan, so do it before
the next tool that needs a manual UI pass · **Touches:** new
`supabase/seed.sql` **only** (referenced already by `supabase/config.toml:71`;
no migration, no app code, no prod change).

> Path note: the Supabase project lives at the **repo root** `supabase/` (that's
> where `config.toml` and `migrations/` are), not under `web/`. `config.toml`'s
> `sql_paths = ["./seed.sql"]` resolves to `supabase/seed.sql`.

## Finding

The isolated local dev server (`localhost:5174`, local Supabase + `devAuth`)
**cannot auto-sign-in after a fresh `supabase db reset`.** Every web plan that
needs a Playwright pass hits this wall first.

The failure sequence:

1. `web/src/lib/devAuth.ts:35-47` `maybeDevSignIn()` runs from `AuthGate` on
   localhost. It tries `signInWithPassword({ email: 'dev@local.test', password:
   'local-dev-password' })`.
2. On a freshly-reset DB that user doesn't exist, so the sign-in 400s. The
   `catch` falls through to `supabase.auth.signUp(creds)` (devAuth.ts:45) — the
   comment there still assumes signup "auto-confirms locally", which **was true
   before plan 46**.
3. Plan 46 (`supabase/migrations/20260705210000_signup_hook_invite_gate.sql`)
   added a **Before-User-Created** auth hook, `public.hook_before_user_created`,
   wired locally via `supabase/config.toml:282-284`
   (`[auth.hook.before_user_created] enabled = true`). It rejects any signup
   whose email has no row in `household_invites`:

   ```
   {"code":403,"error_code":"unknown","msg":"Hemma·OS är endast för inbjudna."}
   ```
4. A just-reset DB has **zero households and zero invites** (there is no seed —
   `config.toml:71` points `sql_paths` at `./seed.sql`, which does not exist).
   So there is no invite for `dev@local.test`, the hook 403s the signup, and
   `maybeDevSignIn()` gives up. The app stays on the magic-link screen; no tool
   route renders; Playwright can see nothing.

Observed this session: signup returned 403 with that exact message, and the only
way forward was to mint the user out-of-band via the GoTrue admin API (service-
role key) — not a workflow anyone should have to rediscover.

Why it matters: this is a **verification-blocking** bug, not a product bug. It
silently defeats the project's own rule that all Playwright testing runs against
the isolated local env (see the `dev server` memory). The first symptom is "the
dev server shows a login box and my screenshots are blank," which wastes a full
debugging loop every time the local DB is reset.

### Two things NOT to do

- **Do not weaken the hook or add `dev@local.test` to it.** The hook is the real
  prod security boundary (plan 46). It must keep 403-ing uninvited signups. The
  fix belongs in seed data that only exists locally, never in the migration.
- **Do not solve it by shipping the service-role key in the client.** `devAuth`
  is correctly limited to the anon key + double-gated (`import.meta.env.DEV` +
  `isLocalSupabase()`). Keep it that way.

## Fix

Create `supabase/seed.sql` — the file `config.toml` already expects. Seeds run
automatically at the end of every `supabase db reset`. Seed **three things**: the
dev user directly in the `auth` schema (fully confirmed, password `devAuth`
already uses), **plus its household and owner membership**. Then the very first
`signInWithPassword` succeeds on attempt one (the invite hook only runs on
*creation*, so it never fires), and — critically — `claim_household()` finds the
seeded membership and hits its **"already a member" short-circuit** instead of
its first-time-claim path.

That last part is not optional. `AuthGate` calls `claim_household()` on every
sign-in, and **React StrictMode double-invokes it in dev**. Two concurrent
first-time claims race on the `household_members` `user_id` unique index; the
loser throws 23505 and, timed as StrictMode fires them (same tick), **both
transactions can roll back**, leaving the dev user with *no household at all*
(verified in-browser: 0 households, 0 members after load — cloud tools then
401/return-nothing under RLS). The current `claim_household` (migration
`20260708130000_invite_hygiene.sql`) does a bare `insert into household_members
… values (…, 'owner')` with **no** `on conflict` guard — the race-safe
`on conflict (user_id) do nothing` + re-select-winner logic that
`20260708100000_one_household_per_user.sql` had was dropped. Seeding the
membership sidesteps the whole problem: the initial `select … where user_id =
uid` finds the row and returns before any insert, so the racy path never runs.

```sql
-- supabase/seed.sql  (abridged header — see file for full comments)

-- 1. The dev auth user. Token columns are '' (not NULL): GoTrue's password grant
--    scans confirmation_token / recovery_token / email_change /
--    email_change_token_new into non-nullable Go strings and 500s on login if
--    they are NULL (the admin API sets them to '').
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  confirmation_token, recovery_token, email_change, email_change_token_new,
  created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-0000-0000-0000000d0001',
  'authenticated', 'authenticated', 'dev@local.test',
  crypt('local-dev-password', gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}',
  '{"email_verified":true}',
  '', '', '', '',
  now(), now()
) on conflict (id) do nothing;

-- 2. Matching email identity (GoTrue expects one; identity_data.sub = user id).
insert into auth.identities (
  provider_id, user_id, identity_data, provider, created_at, updated_at
) values (
  '00000000-0000-0000-0000-0000000d0001',
  '00000000-0000-0000-0000-0000000d0001',
  '{"sub":"00000000-0000-0000-0000-0000000d0001","email":"dev@local.test","email_verified":true}',
  'email', now(), now()
) on conflict do nothing;

-- 3. The dev user's household + owner membership, so claim_household() short-
--    circuits on "already a member" and the StrictMode race never happens.
insert into public.households (id, name)
  values ('00000000-0000-0000-0000-0000000d00d0', 'Dev household')
  on conflict (id) do nothing;
insert into public.household_members (household_id, user_id, role)
  values ('00000000-0000-0000-0000-0000000d00d0',
          '00000000-0000-0000-0000-0000000d0001', 'owner')
  on conflict do nothing;
```

Why this exact shape (all verified against a live local DB this session):

- The token columns (`confirmation_token`, `recovery_token`, `email_change`,
  `email_change_token_new`) **must** be `''`. Left NULL, login returns **500**
  (GoTrue scans them into non-nullable Go strings) — observed and fixed this
  session. The other token columns already default to `''` in this Supabase
  version.
- Besides those, the only `auth.users` column NOT NULL without a default is `id`.
  `aud`/`role` = `authenticated`, a non-null `encrypted_password`, and a non-null
  `email_confirmed_at` are what GoTrue needs *functionally* for a confirmed
  password login.
- `encrypted_password = crypt('local-dev-password', gen_salt('bf'))` produces a
  standard bcrypt hash GoTrue accepts — the documented Supabase local-seed
  pattern. `pgcrypto` is already installed locally (verified).
- `auth.identities` NOT-NULL-without-default columns: `provider_id`, `user_id`,
  `identity_data`, `provider` (its `id` defaults). `identity_data.sub` = user id.
- Fixed UUIDs (`…0d0001` user, `…0d00d0` household), not `gen_random_uuid()`, so
  re-runs are deterministic and both ids are greppable.

`devAuth.ts` needs **no change** — its existing `signInWithPassword` path
succeeds first try. The `signUp` fallback (devAuth.ts:41-46) is now effectively
dead for the seeded email but harmless; leave it. Optionally refresh its stale
"auto-confirmed locally" comment to note the hook now gates signup — a one-line
comment, not required for correctness.

## Accepted trade-off

The seed reaches into the `auth` schema with a hand-written insert whose column
set could drift if a future Supabase bump makes a new `auth.users` column
NOT-NULL-without-default (the token columns were exactly this class of surprise —
NULL there 500s login). That's acceptable: it's local-only (a broken seed can
never reach prod), it fails **loudly** at `db reset` time (not silently at
runtime), and the fix would be one added column. Documented in the seed's header.

Two alternatives were rejected: **(a)** seeding an invite row instead of the user
— leaves the dev user a `member` of an owner-less household and still routes
through the racy `claim_household` first-time path; **(b)** relying on
`claim_household` to create the household on sign-in — that IS the racy path this
plan is working around (verified to leave 0 households under StrictMode). Seeding
the membership directly is the only option that is both representative (owner of
its own household) and race-free.

## Acceptance criteria

All verified this session against the live local stack.

- `supabase/seed.sql` exists and is committed (not gitignored — verified).
- `supabase db reset` (from repo root) completes **green** and the log shows
  `Seeding data from supabase/seed.sql...`. ✓
- Immediately after the reset (no manual admin-API step), `signInWithPassword`
  for `dev@local.test` / `local-dev-password` returns **200**, and a **fresh**
  browser context at `http://localhost:5174/#/konsultkalkyl` auto-signs-in and
  renders the tool (not the "Logga in" screen). ✓
- The seed leaves exactly **one household + one `owner` membership** for the dev
  user, and two concurrent `claim_household()` calls both return **200** with the
  seeded household id (no 23505/409, state unchanged) — the StrictMode race is
  neutralised. ✓
- Cloud writes work under RLS: adding a loan part in Bolånekoll persists to
  `public.mortgage_loan_parts` under the seeded household id, with **zero**
  console errors on the write. ✓
- The invite hook is **unchanged** and still rejects an uninvited signup: a
  `signUp` for `stranger@local.test` against local GoTrue still **403s** with
  "Hemma·OS är endast för inbjudna." ✓
- No change to any file under `web/src/` is required; if the devAuth comment is
  refreshed, that is the only app-code edit (not done here).

> Verification note: when testing manually, use a **fresh browser context** — do
> not `localStorage.clear()` on a live tab. Wiping `sb-localhost-auth-token`
> mid-session leaves supabase-js without a token until a reload and makes writes
> 401; that is a test artifact, not a seed bug (hit and diagnosed this session).

## Out of scope

- **Fixing `claim_household`'s StrictMode double-invoke race at the source** —
  the real defect is that `20260708130000_invite_hygiene.sql` dropped the
  `on conflict (user_id) do nothing` + re-select-winner guard that
  `20260708100000_one_household_per_user.sql` had, so a genuine concurrent
  first-time claim (e.g. a real invited partner) can still 409 or, worst case,
  leave no household. This seed sidesteps it for the dev user but does **not**
  fix it for real users. Worth its own plan (restore the race-safe claim, and/or
  make AuthGate not double-fire / retry on 409). Flagged here so it isn't lost.
- Seeding demo data (loan parts, budget rows, scenarios) for the dev household —
  a natural later extension; this plan is strictly about *getting logged in*.
- Any change to the production invite/onboarding path — untouched by design.
- Reworking `devAuth`'s signUp fallback — left as-is; harmless once the seed
  exists.
