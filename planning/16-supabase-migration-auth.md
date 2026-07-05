# Plan 16 — Supabase migration + auth (Hemma·OS `web/`)

> **📎 This is the MASTER reference. The actionable work is split into eight
> per-PR phase plans, `16a`–`16h`, meant to be executed in letter order:**
>
> | # | file | phase | goal |
> |---|------|-------|------|
> | 16a | `16a-supabase-auth-gate.md` | A | project + auth + login gate (no data yet) |
> | 16b | `16b-supabase-salary-pilot.md` | A | salary-store pilot (prove the whole loop) |
> | 16c | `16c-supabase-manadsavslut.md` | B | Månadsavslut → cloud |
> | 16d | `16d-supabase-hushallsbudget.md` | B | Hushållsbudget (sync→async refactor + blob) |
> | 16e | `16e-supabase-bolanekoll.md` | C | Bolånekoll (5 mortgage tables) |
> | 16f | `16f-supabase-bostadskalkyl.md` | C | Bostadskalkyl scenarios + prefs |
> | 16g | `16g-supabase-konsult-lonevaxling.md` | C | Konsult + Löneväxling blobs |
> | 16h | `16h-supabase-invites.md` | D | invite UI + auto-join + hardening |
>
> Each phase file is self-contained for its own mechanics (its SQL, its store
> swap, its gate). **This master doc holds the shared concepts** the phase files
> reference and don't repeat: the *Supabase in five minutes* primer, the ten
> locked *Decisions*, the *RLS one-policy-shape* explanation, the *STD column
> shorthand*, and the *Risks / watch-list*. Read this once end-to-end before
> starting 16a; keep it open as you go.

**Status:** BUILD-READY (fully planned 2026-07-04; supersedes the earlier
architecture-sketch version; split into 16a–16h same day) · **Owner model:**
Opus for the schema/RLS/sync design + the first pilot; Sonnet for the mechanical
per-tool store swaps once the pattern is proven. · **Relationship:**
foundational — unlocks idea #8 (cross-tool insights). Builds on the existing
Promise-API stores. Big; **phased — 8 PRs.**

## What this is (plain answer to "how would this work + do we need a password?")

Hemma·OS becomes a **login-gated, cloud-backed** app for a household of two. You
each **sign in with a magic link** (type your email, click the link Supabase
emails you) — **no password to create or remember.** Once in, every tool's data
lives in Supabase, scoped to your shared household, synced across all your
devices, and backed up. It still works offline: localStorage stays as a cache.

## Supabase in five minutes (read this first)

Never used Supabase? Here's the mental model:

- **Supabase = a hosted Postgres database + a login system + an auto-generated
  API**, run for you in the cloud. You create a "project" on
  [supabase.com](https://supabase.com) (free tier is plenty for two people) and
  get a **dashboard** — a website where you create tables, run SQL, manage
  users, and read logs. No server of ours anywhere: the React app in the
  browser talks straight to Supabase over HTTPS via their JS library,
  `@supabase/supabase-js`.
- **How the browser is allowed to talk to a database directly:** every request
  carries the signed-in user's identity, and Postgres itself enforces who may
  see which rows via **Row Level Security (RLS)** — per-table rules ("policies")
  like *"you may only read rows whose `household_id` is your household"*. RLS
  **is** the security model; there is no backend code to hide behind.
- **Two kinds of keys** (found under *Project Settings → API Keys*):
  - the **publishable key** (`sb_publishable_…`; older docs call it the "anon
    key") — ships in the browser bundle **by design**. It only identifies the
    project; RLS decides what any holder of it can actually do.
  - the **secret key** (`sb_secret_…`; older docs: "service role key") —
    bypasses RLS entirely. **Never put this in the app, the repo, or a GitHub
    secret used by the Pages build.** We don't need it at all for this plan.
- **Magic link** = passwordless email login. User types their email, Supabase
  emails a one-time sign-in link (expires after a short period, single use),
  clicking it lands them back on the app already signed in. The session then
  persists in the browser, so it's roughly once-per-device friction.
- **Words you'll meet:** *SQL Editor* = a page in the dashboard where you paste
  and run SQL (this is how we'll create every table — no local tooling needed
  for v1). *Table Editor* = spreadsheet-style view of your data. *Policy* = one
  RLS rule. *`auth.users`* = the built-in table Supabase keeps of everyone who
  has signed in. *upsert* = insert-or-update-by-id in one call. *jsonb* = a
  column type that stores an arbitrary JSON blob.

## Decisions locked (source of truth)

1. **Driver = all three** (sharing **primary**, sync + backup along for free).
   → we build a household/two-user layer + row-level security.
2. **Auth = Supabase Auth magic link** (passwordless). No username/password.
   Google OAuth can be added later if the email step annoys.
3. **Scoping = everything household-shared.** One `household`, both are members,
   **every** row carries `household_id`, **one** RLS policy app-wide. Both see all
   tools' data. (Can carve a tool back to personal later.)
4. **Sync = cloud source-of-truth + local cache**, conflicts **last-write-wins**
   by `updated_at`. Hydrate stores from Supabase on login; writes go to Supabase
   optimistically + update the localStorage cache (offline fallback). Realtime
   ("see partner's edit live") deferred to a later phase.
5. **Login-gated.** Visiting requires sign-in; RLS scopes each signer to their own
   household; you two share one. Finances never shown to an anonymous visitor.
6. **Household join = email pre-authorization.** In settings, enter partner's
   email → pending membership; they auto-join on first magic-link sign-in with
   that email. (Acceptable v1 shortcut: SQL-seed one household + both memberships
   to get the pilot live before building the invite UI.)

Locked in the 2026-07-04 full-planning pass (each justified inline below):

7. **All data-table primary keys are `text`, not `uuid`.** The stores'
   client-generated ids are *mostly* UUIDs but not always: every store has a
   non-UUID fallback (`'sub-…'`, `'rate-…'`), and Bostadskalkyl scenario ids are
   `Date.now().toString(36)` + a counter (`useStore.ts` `newId()`) — never
   UUIDs. A `uuid` column would reject those rows at import. `text` accepts
   everything; uniqueness still enforced by the primary key.
8. **Dates stay `text` (ISO strings), not `date` columns.** The app already
   treats every date as a string and sorts lexicographically
   (`byDateDesc`/`localeCompare`), and legacy rows can carry `''` — which a
   `date` column would reject. Matching the app is safer than being fancy.
9. **Blob-shaped state goes in ONE generic `tool_state` table** (one jsonb row
   per household per tool) instead of a table per tool: Hushållsbudget's whole
   `BudgetState`, Konsultkalkyl inputs, Löneväxling inputs, Månadsavslut
   settings, Bolånekoll settings, Bostadskalkyl prefs (global constants + drift
   & savings items). Rationale: these are load-all/save-all shapes today; a
   blob is the 1:1 port, one table = one policy = less beginner surface. The
   cost — SQL can't query *inside* a blob — only matters for cross-tool
   insights (idea #8), and the hub stats already compute in JS from loaded
   rows, so nothing breaks. Any blob can be promoted to real tables later with
   a page of SQL.
10. **What stays localStorage forever (device state, never synced):** theme,
    hub "last opened" card ordering, Bostadskalkyl session/draft/draft-constants
    (scratch buffers), the drift monthly/yearly view toggle, and the one-time
    import-done flags. Rule of thumb: *data* syncs, *device state* doesn't.

## Architecture

### Auth

- One Supabase project. Email sign-in (which includes magic links) is **enabled
  by default** on a new project — nothing to switch on, and no separate "magic
  link" toggle to hunt for. (Password sign-in technically also exists under the
  Email provider, but it's inert: the app only ever calls `signInWithOtp`, and
  no one ever sets a password.) Supabase's built-in email sender
  is fine for two users (it's rate-limited to a handful of emails per hour and
  meant for low volume — enough here since sign-in is rare; configure custom
  SMTP later only if links stop arriving).
- **URL configuration (easy to miss, breaks silently):** under *Authentication
  → URL Configuration*, set **Site URL** to
  `https://alanvardon.github.io/hemma-os/` and add
  `http://localhost:5173/**` (Vite dev) to the **Redirect URLs** allow-list.
  Magic links only ever redirect to URLs on this list — if it's wrong, links
  appear to work but dump you on the wrong page, signed out.
- Client: `npm install @supabase/supabase-js` in `web/`, then one shared module:

  ```ts
  // web/src/lib/supabase.ts
  import { createClient } from '@supabase/supabase-js'

  export const supabase = createClient(
    import.meta.env.VITE_SUPABASE_URL,
    import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  )
  ```

  The two `VITE_`-prefixed env vars come from `.env.local` in dev and GitHub
  Actions secrets in the Pages build (see *Env / deploy*). The publishable key
  is public by design — safe because RLS guards every table.
- A top-level `<AuthGate>` in `App.tsx`, wrapping `<RouterProvider>` (inside
  the ThemeContext provider, so the login screen is themed): while the session
  is loading → nothing/splash; no session → a magic-link screen (email input +
  "Skicka länk" + a "check your inbox" state); session → render the app.
  Session state is the standard two-call pattern:

  ```ts
  // read the persisted session once on mount, then subscribe to changes
  supabase.auth.getSession().then(({ data }) => setSession(data.session))
  const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
  // send the link:
  await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin + window.location.pathname },
  })
  ```

  Supabase stores the session in localStorage and auto-refreshes it, so each
  device asks for a link roughly once. (Later hardening, once both of you have
  signed in at least once: pass `shouldCreateUser: false` in the `options` so
  strangers can no longer create accounts at all — harmless today thanks to
  RLS, but tidy. Don't set it before your partner's first sign-in or their
  account can't be created.)
- **⚠ Hash-router collision (our app-specific gotcha):** the app routes via
  `createHashRouter` (`/#/manadsavslut`), and a clicked magic link *also* comes
  back with the tokens in the URL hash (`…/#access_token=…`). supabase-js
  (default `detectSessionInUrl: true`) consumes and cleans that hash on load,
  but React Router boots at the same time and will briefly "route" to
  `#access_token…` — and **the router currently has NO catch-all route**
  (`App.tsx` `createHashRouter` config), so that lands on React Router's default
  error page. Part of PR 1: add `{ path: '*', element: <Navigate to="/" replace /> }`
  (a good hygiene fix regardless), and point `emailRedirectTo` at the bare app
  root. Test the full click-the-email-link flow on localhost **and** on Pages
  before calling Phase A done.

### Household + membership (the whole multi-user model)

Three tiny tables (run in the dashboard's SQL Editor). These are OURS (not
imported), so they get proper `uuid` keys:

```sql
create table public.households (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

create table public.household_members (
  household_id uuid not null references public.households(id),
  user_id      uuid not null references auth.users(id),
  role         text not null default 'member',
  primary key (household_id, user_id)
);

create table public.household_invites (   -- email pre-auth (Phase D UI)
  household_id uuid not null references public.households(id),
  email        text not null,
  created_at   timestamptz not null default now(),
  primary key (household_id, email)
);
```

- On first sign-in: if the user's email matches a `household_invites` row →
  insert a `household_members` row, delete the invite. Else → create a household
  + add them as owner (their own private space). **v1 shortcut (Decision 6):
  skip this logic entirely and SQL-seed** — see the Phase A walkthrough.
- A SQL helper `current_household()` returns the caller's household id, used by
  every RLS policy. **It must be `security definer`** (runs with the function
  owner's rights): the policy on `household_members` itself would otherwise
  need to query `household_members`, which is infinite recursion — a documented
  Supabase footgun. Keep it in a `private` schema so it isn't exposed over the
  API:

```sql
create schema if not exists private;

create or replace function private.current_household()
returns uuid
language sql
security definer
set search_path = ''
as $$
  select household_id from public.household_members
  where user_id = (select auth.uid())   -- auth.uid() = the signed-in user's id
  limit 1;
$$;

-- Without this, every query by a signed-in user fails with
-- "permission denied for schema private": creating a schema does NOT
-- automatically let other roles use it, and RLS policies run as the
-- querying user's role (`authenticated`).
grant usage on schema private to authenticated;
```

The household tables get read-only policies (v1 never inserts from the client;
the seed runs in the SQL Editor, which bypasses RLS):

```sql
alter table public.households        enable row level security;
alter table public.household_members enable row level security;
alter table public.household_invites enable row level security;

create policy hh_read on public.households for select to authenticated
  using (id = (select private.current_household()));
create policy hm_read on public.household_members for select to authenticated
  using (household_id = (select private.current_household()));
-- invites: no client policy needed until Phase D
```

### RLS — one policy shape, every table

Every data table gets a `household_id uuid not null` column and:

```sql
alter table public.<t> enable row level security;

create policy hh_all on public.<t> for all to authenticated
  using      (household_id = (select private.current_household()))
  with check (household_id = (select private.current_household()));
```

`using` filters what you can **read/update/delete**; `with check` blocks
**writing** a row into someone else's household. Together: a user touches only
rows of the household they belong to. That single shape covers all tools
(Decision 3).

Two conveniences on every data table so the client code stays dumb:

```sql
-- 1. household_id fills itself in on insert — stores never need to know it:
--    household_id uuid not null default private.current_household()
-- 2. updated_at maintains itself (needed for last-write-wins):
create extension if not exists moddatetime schema extensions;
create trigger set_updated_at before update on public.<t>
  for each row execute procedure moddatetime (updated_at);
```

## Complete data model (locked — every table, all phases)

Shared column shorthand used below (spell it out per table when running):

```sql
-- STD =
--   id           text primary key default gen_random_uuid()::text,  -- text: see Decision 7
--   household_id uuid not null references public.households(id)
--                default private.current_household(),
--   created_at   timestamptz not null default now(),
--   updated_at   timestamptz not null default now()
-- + the hh_all policy + the set_updated_at trigger, per table.
```

### Phase A — `salary_submissions` (pilot; mirrors `SalarySubmission` in `hushallsbudget.ts`)

```sql
create table public.salary_submissions (
  -- STD columns…
  month           text not null,      -- 'YYYY-MM'
  person_a_name   text,
  income_a        numeric,
  person_b_name   text,
  income_b        numeric,
  transfer_from   text,               -- 'a' | 'b'
  transfer_to     text,
  transfer_amount numeric,
  equal_share     numeric,            -- a number in the TS type (share amount), NOT a boolean
  note            text,
  income_items    jsonb               -- [{owner,label,amount}] — never queried, blob is fine
);
```

### Phase B — Månadsavslut (mirrors `Item`/`Payment` in `manadsavslut.ts`)

```sql
create table public.monthend_items (
  -- STD columns…
  date_purchased text not null default '',
  description    text not null default '',
  enter_amount   numeric not null default 0,
  split          boolean not null default true,
  amount         numeric not null default 0,
  fronted_by     text not null default 'a',    -- 'a' | 'b'
  owed_by        text not null default 'a',
  paid           boolean not null default false,
  pending        boolean not null default false,
  payment_id     text,                          -- text id of the settling payment
  note           text not null default '',
  personal_items jsonb not null default '[]',   -- [{person,amount,note}]
  personal_a     numeric not null default 0,    -- derived sums, cached (store re-derives)
  personal_b     numeric not null default 0
);

create table public.monthend_payments (
  -- STD columns…
  item_ids     jsonb not null default '[]',     -- ["<item id>", …]
  from_person  text,                            -- 'a' | 'b' | null
  to_person    text,
  amount       numeric not null default 0,
  period_label text not null default '',
  note         text not null default ''
);
-- MonthEndSettings → tool_state (tool = 'manadsavslut'), see below.
```

### Phase B — `tool_state` (all blob-shaped state, Decision 9)

```sql
create table public.tool_state (
  household_id uuid not null references public.households(id)
               default private.current_household(),
  tool         text not null,          -- which blob this row is (see list below)
  data         jsonb not null,
  updated_at   timestamptz not null default now(),
  primary key (household_id, tool)
);
-- same hh_all policy + set_updated_at trigger as everything else.
```

One row per household per `tool` key:

| `tool` key            | blob                                            | phase |
|-----------------------|--------------------------------------------------|-------|
| `hushallsbudget`      | the whole `BudgetState`                          | B     |
| `manadsavslut-settings` | `MonthEndSettings`                             | B     |
| `bolanekoll-settings` | `MortgageSettings` (incl. `import_presets`)      | C     |
| `bostadskalkyl-prefs` | `{ globalConstants, driftItems, savingsItems }`  | C     |
| `konsultkalkyl`       | the Konsult inputs object                        | C     |
| `lonevaxling`         | the Löneväxling inputs object                    | C     |

The JSON inside keeps whatever casing the TS types already have (camelCase is
fine inside jsonb — only real *columns* are snake_case).

### Phase C — Bolånekoll (mirrors the five row types in `mortgage.ts`)

```sql
create table public.mortgage_loan_parts (
  -- STD columns…
  label         text not null default '',
  loan_number   text not null default '',
  start_balance numeric not null default 0,
  start_date    text not null default '',   -- text: see Decision 8
  archived      boolean not null default false
);

create table public.mortgage_rate_periods (
  -- STD columns…
  loan_part_id text,                        -- text id, null = property-wide
  start_date   text not null default '',
  end_date     text,
  rate         numeric,
  rate_type    text not null default 'rörlig'   -- 'rörlig' | 'bunden'
);

create table public.mortgage_payments (
  -- STD columns…
  loan_part_id  text,
  date          text not null default '',
  kind          text not null default 'payment', -- interest|amortization|payment|loan|fee|other
  description   text not null default '',
  amount        numeric not null default 0,
  balance_after numeric,
  paid_by       text not null default 'joint',   -- 'a' | 'b' | 'joint'
  source        text not null default '',
  is_insats     boolean not null default false,
  paid_split    jsonb                             -- {a,b} | null
);

create table public.mortgage_valuations (
  -- STD columns…
  date        text not null default '',
  value       numeric not null default 0,
  note        text not null default '',
  is_purchase boolean not null default false
);

create table public.mortgage_contributions (
  -- STD columns…
  owner  text not null default 'joint',
  date   text not null default '',
  amount numeric not null default 0,
  note   text not null default ''
);
-- MortgageSettings → tool_state (tool = 'bolanekoll-settings').
```

### Phase C — Bostadskalkyl scenarios (mirrors `Scenario` in `storage.ts`)

```sql
create table public.scenarios (
  -- STD columns… (ids here are DEFINITELY not UUIDs — Decision 7)
  name      text not null,
  saved_at  text not null,   -- the TS field is camelCase `savedAt` (ISO string) —
                             -- storage.ts maps savedAt ↔ saved_at at the query edge
  inputs    jsonb not null,
  constants jsonb            -- optional per-scenario statutory constants
);
```

⚠ `Scenario` is the one row type that is NOT snake_case-ready (`savedAt`,
plus camelCase keys inside `inputs`/`constants` — those stay camelCase inside
the jsonb, only `savedAt` becomes a real column). The mapping lives in
`storage.ts` only.

## Store-swap pattern (the migration mechanics)

The async Promise-API stores (**salary**, **manadsavslut**, **mortgage**) are
"swap one file": replace `_read`/`_write` localStorage calls with Supabase
queries; keep the exported `list/add/remove/update` signatures so **call sites
don't change**.

**⚠ Split the localStorage keys (data-safety — learned building 16b, applies to
every store).** The old `STORAGE_KEY` stays as a **read-only legacy import
source + permanent backup** — never written after the swap — and a **separate
new cache key** (`…_cache_v1`) holds the write-through offline cache. Do NOT
reuse one key for both: the cache write (`_writeCache` on the first `list()`
after deploy) would overwrite the user's real history with cloud data *before*
the first-login import can read it → silent data loss. With the split, the
import always reads the untouched original.

Shape of the swap, using salary as the example:

```ts
export async function list(): Promise<SalarySubmission[]> {
  const { data, error } = await supabase
    .from('salary_submissions')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) return _readCache()   // offline / Supabase down → serve the cache
  _writeCache(data)
  return data
}

export async function add(record: SalarySubmission): Promise<SalarySubmission> {
  const saved = { ...record, id: record.id || _id(), created_at: record.created_at || new Date().toISOString() }
  const { error } = await supabase.from('salary_submissions').insert(saved)
  _appendCache(saved)              // optimistic — cache updates either way
  if (error) throw error           // NB: today's store NEVER rejects on write —
  return saved                     // verify each call site copes with a rejection
}
```

Notes for the swap: every supabase-js call returns `{ data, error }` — it
**doesn't throw**, you check `error` yourself. No `household_id` or
`updated_at` in client code — the column default and trigger handle both.
Offline stance, stated honestly: **reads** fall back to the cache; **writes**
fail visibly when offline (no write queue in v1 — a queued-sync layer is a
possible later phase, not silently promised now).

Per-store specifics (verified against the code 2026-07-04):

- **salary-store.ts** — cleanest 1:1; Phase A pilot.
- **manadsavslut-store.ts** — three data kinds in one envelope today → items +
  payments tables + a `tool_state` settings row. `normalizeItem` keeps running
  on rows loaded from Supabase (it's idempotent). `settle()` writes a payment
  AND flips items' `paid`/`payment_id` — two Supabase writes; do the payment
  insert first so a mid-failure leaves items unsettled (retryable) rather than
  settled-but-unpaid.
- **mortgage-store.ts** — five row arrays + settings, same recipe. The
  v<4 `migrateToPeriods` migration keeps running against the *cache/import*
  path only (cloud rows are born v4).
- **storage.ts (Bostadskalkyl)** — GOOD NEWS, simpler than first planned:
  `useStore` already hydrates through this facade with an async `hydrate()`
  (`useStore.ts`), so there is **no Zustand middleware rework** — swap
  `loadScenarios`/`saveScenarios` (+ scenario `savedAt` mapping) and the
  prefs (`loadGlobalConstants`/`saveGlobalConstants`, drift/savings items) to
  Supabase; leave `loadSession`/`loadDraft`/`loadTheme`/`loadDriftYearly`
  on localStorage (Decision 10). Note `saveScenarios` writes the WHOLE list —
  simplest correct port is delete-then-upsert by id diff, or just upsert all
  rows + delete the missing ids; keep it inside the facade.
- **Konsultkalkyl.tsx / Lonevaxling.tsx** — persistence is currently INLINE in
  the route files (`localStorage.getItem(STORAGE_KEY)` at
  `Konsultkalkyl.tsx:37`, `Lonevaxling.tsx:21`; keys `bostadskalkyl_konsult_v1`
  / `bostadskalkyl_lonevaxling_v1`). First extract each into a tiny
  `lib/<tool>-store.ts` with the same load/save Promise shape, THEN it's the
  standard `tool_state` swap. (Two commits in one PR: extract, then swap.)
- **hushallsbudget-store.ts** — the only sync→async refactor:
  `loadBudget()/saveBudget()` become Promise-returning, call sites in
  `Hushallsbudget.tsx` await them, then the body swaps to the `tool_state`
  blob row.
- **Home.tsx (hub bento)** — needs NO changes: it loads rows via the store
  APIs and hands them to pure `hub-stats.ts` functions, so it follows each
  store to the cloud automatically. Its "last opened" ordering keys stay
  local (Decision 10).

## First-login data migration (per store, one-time)

On the first authenticated load *after the household exists*, each migrated
store checks its own flag key (e.g. `bostadskalkyl_salary_supabase_imported`);
if unset, it reads the legacy localStorage rows (the original `STORAGE_KEY`,
kept read-only by the key-split above — never the cache key) and **upserts** them
(`.upsert(rows)` — insert-or-update keyed on `id`; idempotent, so running twice
adds nothing) then sets the flag. Blob tools upsert their single `tool_state`
row only if no cloud row exists yet (first household member to log in wins;
fine for v1). **Remember localStorage is per-origin:** the real history lives
on the live Pages origin, so the import matters on each device you've actually
used, not on localhost — and both of your devices import into the SAME
household, deduped by row id.

## Build plan — 8 PRs, in order (one at a time, base=main)

Branch names `ui/supabase-<slug>`. Every PR: `npm run build` + `npx oxlint` +
`npx vitest run` green in `web/`, plus the listed gate. SQL for each phase is
run in the dashboard first, and **every statement is also committed to
`supabase/schema.sql`** in the same PR (the repo's paper trail — see Risks).

1. **PR 1 `ui/supabase-auth-gate` — project + auth + gate.** Manual: create
   project, auth URLs, household tables + function + grant + policies (schema
   §Household). Code: `lib/supabase.ts`, `.env*` gitignore fix, `<AuthGate>` +
   login screen, `*` catch-all route, deploy.yml secrets. NO data tables yet —
   the app works exactly as before behind the gate (still localStorage).
   *Gate:* magic-link round trip on localhost AND live Pages; seeded household
   visible (walkthrough steps 1–8); unknown hash routes to hub.
2. **PR 2 `ui/supabase-salary-pilot` — salary pilot (Phase A).** SQL:
   `salary_submissions`. Code: salary-store swap + cache + import flag.
   *Gate:* RLS verified with a third `+alias` account (read AND write
   direction) BEFORE real data; salary log syncs between two devices; offline
   reload still renders history (DevTools → Network → Offline).
3. **PR 3 `ui/supabase-manadsavslut` — the couple flagship, part 1 (Phase B).**
   SQL: `monthend_items`, `monthend_payments`, `tool_state`. Code:
   manadsavslut-store swap (settings → tool_state) + import.
   *Gate:* full month-end flow (CSV import → triage → settle) against cloud;
   partner's device sees the settle; `settle()` two-write order as specced.
4. **PR 4 `ui/supabase-hushallsbudget` — flagship part 2 (Phase B).** Code:
   sync→async refactor of hushallsbudget-store (commit 1, still localStorage —
   the risky change in isolation), then blob swap to `tool_state` + import
   (commit 2). *Gate:* budget edits sync; salary submissions still land (the
   budget page uses both stores).
5. **PR 5 `ui/supabase-bolanekoll` (Phase C).** SQL: the five mortgage tables.
   Code: mortgage-store swap (settings → tool_state) + import.
   *Gate:* Bolånekoll renders identically from cloud data on a second device
   (charts, groups, contributions gating).
6. **PR 6 `ui/supabase-bostadskalkyl` (Phase C).** SQL: `scenarios`. Code:
   storage.ts partial swap (scenarios + `bostadskalkyl-prefs` blob; session/
   draft/theme stay local) + `savedAt` mapping + import.
   *Gate:* scenarios list syncs; draft/session behave unchanged per device;
   the 51-test suite still green (storage facade signatures unchanged).
7. **PR 7 `ui/supabase-konsult-lonevaxling` (Phase C).** Code: extract the two
   inline persistence blobs into tiny stores (commit 1), swap to `tool_state`
   (commit 2) + imports. *Gate:* inputs persist across devices.
8. **PR 8 `ui/supabase-invites` (Phase D).** Invite UI (enter partner email →
   `household_invites` row) + first-sign-in auto-join + the invite RLS
   policies (user may read invites matching `auth.jwt()->>'email'`, insert
   their own membership when invited, else create their own household);
   `shouldCreateUser: false` hardening; retire the SQL seed. Optional:
   Realtime on monthend/budget. *Gate:* a fresh account with a pending invite
   self-joins and sees household data; a fresh account without one gets an
   empty private household.

Testing note for the swaps: the pure calc/analytics libs keep their existing
vitest suites untouched (they never see storage). For store files, mock the
`lib/supabase` module (`vi.mock`) with an in-memory table double — enough to
test cache-fallback, import idempotency, and the `savedAt` mapping without a
network.

## Phase A step-by-step (the beginner walkthrough)

Everything up to the code changes happens in the browser, in the Supabase
dashboard:

1. **Create the project.** supabase.com → sign up (GitHub login is easiest) →
   *New project*, org + name `hemma-os`, region **Stockholm (eu-north-1)**,
   free plan. It'll ask for a *database password* — that's for direct Postgres
   access, not for the app; generate one and store it in your password manager.
   Wait ~2 min for provisioning.
2. **Copy the two values the app needs**, both under *Project Settings*: the
   **Project URL** (`https://<ref>.supabase.co`, under *Data API*) and the
   **publishable key** (under *API Keys*).
3. **Configure auth URLs** as described under *Auth* above (Site URL = the
   Pages URL, allow-list localhost).
4. **Create the schema.** *SQL Editor → New query*: paste + run, in order, the
   household tables, the `private.current_household()` function **plus its
   `grant usage` line**, the household RLS policies, the `salary_submissions`
   table, its `hh_all` policy, and the `moddatetime` trigger (all verbatim from
   the schema sections). Green "Success" per statement; the tables appear in
   the Table Editor.
5. **Wire the client.** `npm install @supabase/supabase-js` in `web/`, add
   `web/src/lib/supabase.ts`, then — **first** add `.env*` to the root
   `.gitignore` (today it only lists `.env`, which does *not* match
   `.env.local`) — create `web/.env.local` with
   `VITE_SUPABASE_URL=…` and `VITE_SUPABASE_PUBLISHABLE_KEY=…`.
6. **Build the `<AuthGate>`** + magic-link screen; verify the full email round
   trip on `npm run dev` (localhost redirect must be on the allow-list).
7. **Both of you sign in once.** This is what creates your two rows in
   `auth.users` — the seed needs them to exist. Expect empty tools; you have no
   household yet.
8. **Seed the household** (SQL Editor — it runs as the table owner, bypassing
   RLS):

   ```sql
   insert into public.households (name) values ('Vardon') returning id; -- copy the id
   insert into public.household_members (household_id, user_id, role)
   select '<the-id-you-copied>', id, 'owner'
   from auth.users
   where email in ('alan.vardon@proton.me', '<partner-email>');
   -- verify: should return 2 rows
   select * from public.household_members;
   ```

9. **Swap `salary-store.ts`** per the pattern above + the first-login import.
10. **Verify the Definition of done for A** (below) — especially the RLS check:
    sign in with a **third** email (an alias like `alan.vardon+test@proton.me`
    counts as a separate user) that's in no household, and confirm it sees zero
    salary rows. Do this **before** real data goes in.
11. **Deploy:** add the two values as GitHub Actions secrets, thread them into
    `deploy.yml` (below), push, and repeat the email-link + sync test on the
    live Pages site.

## Env / deploy

- Dev: `web/.env.local`. **Not covered by `.gitignore` today** — the root file
  only lists `.env`, which doesn't match `.env.local`; add `.env*` to it
  *before* creating the file. Vite exposes only `VITE_`-prefixed vars to the
  bundle, read via `import.meta.env.VITE_…`.
- CI: repo *Settings → Secrets and variables → Actions* → add
  `SUPABASE_URL` + `SUPABASE_PUBLISHABLE_KEY`, then in `deploy.yml`'s build step:

  ```yaml
      - name: Build the React app
        env:
          VITE_SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          VITE_SUPABASE_PUBLISHABLE_KEY: ${{ secrets.SUPABASE_PUBLISHABLE_KEY }}
        run: |
          npm --prefix web ci
          npm --prefix web run build
  ```

  (Committing the URL + publishable key instead would also be *safe* — it's a
  public key — but secrets keep the repo clean.) No server needed; the SPA
  talks to Supabase directly. Pages hosting unchanged.

## Risks / watch-list

- **RLS correctness is the whole security model — and you must test the POSITIVE
  path, not just the negative.** The **RLS acceptance check** for every new
  table, run *before* real data goes in:
  1. **Member insert round-trips:** signed in as a household member, an INSERT
     returns **201** *and* the row reads back.
  2. **Outsider is denied both ways:** signed in as the `+test` account (no/other
     household), SELECT returns `[]` **and** INSERT is rejected (403).
  3. **`supabase/audit-rls.sql` is all ✓** (paste it into the SQL Editor).

  Why step 1 is non-negotiable: the Månadsavslut bug was a `for select`-only
  policy. It passed the outsider test (inserts *were* rejected) — but it also
  silently blocked **you**: reads returned 200, every insert 403. Testing only
  that "an outsider can't write" gives a false pass. Always confirm a real member
  *can* write. Failure modes to know: RLS *enabled but no insert-capable policy*
  → nobody can write (this bug); RLS *disabled* → world-readable to anyone with
  the publishable key (the dashboard shows a red "RLS disabled" badge — check it
  per table). `audit-rls.sql` mechanically catches both.
- **Publishable key in a public bundle** is expected; never ship the **secret
  key** (`sb_secret_…` / legacy "service role").
- **Free-tier project pausing:** Supabase **pauses free projects after ~1 week
  with no API activity**. The app then errors until you press *Restore* in the
  dashboard (data is kept). Regular household use resets the clock, but expect
  this after a long holiday — the offline cache means the tools still render.
- **Magic-link email deliverability** on the built-in sender: low hourly rate
  limit, a cooldown between requests to the same address, links expire and are
  single-use. Fine for two people who stay signed in; custom SMTP is the
  upgrade path if it bites.
- **Hash router × magic-link tokens** (see Auth) — must be verified on
  localhost *and* Pages, it's environment-dependent.
- **Last-write-wins** can lose a field if both edit the same row offline — fine
  for two people; documented, not solved. Blob rows (`tool_state`) lose at
  WHOLE-BLOB granularity (both edit the budget offline → one budget wins) —
  acceptable, but it's the strongest argument for eventually normalizing the
  budget if simultaneous editing becomes a habit.
- **No offline write queue in v1** — offline reads work (cache), offline
  writes fail visibly. Don't let the UI pretend otherwise.
- Synchronous-store refactor (hushallsbudget) is the riskiest code change —
  it's isolated as its own commit inside PR 4, still on localStorage, so the
  refactor and the cloud swap can't blame each other.
- **`supabase/schema.sql` is the idempotent source of truth — apply it
  VERBATIM.** Every statement is `… if not exists` / `create or replace` /
  `drop policy if exists` + recreate, so pasting the *whole file* into the SQL
  Editor either sets up or **repairs** the database (re-asserting the correct
  `for all` policies). **Never hand-edit an object in the dashboard and copy the
  change back** — that lossy round-trip is exactly how the `for select`-only
  policy drifted in. New phases append their tables here using the same
  idempotent shape (`create table if not exists`, `drop policy if exists hh_all
  … create policy hh_all … for all … with check …`, `create or replace
  trigger`). Graduating to the Supabase CLI's migration files is the real fix
  when you want it; the idempotent single file is the v1 stand-in.

## Definition of done (per phase)

Every phase that adds a table passes the **RLS acceptance check** (see Risks:
member insert→201 + read-back; outsider denied both ways; `audit-rls.sql` all ✓)
before real data.

- **A (PRs 1–2):** sign in via magic link on two devices; salary log syncs
  between them; **RLS acceptance check passes** (member can write + read back; a
  third `+test` user can neither read nor write); existing local salary history
  imported once (re-running the import adds nothing); offline still renders from
  cache; magic-link round trip works on localhost **and** the live Pages site.
- **B (PRs 3–4) / C (PRs 5–7):** each migrated tool reads/writes Supabase,
  syncs across devices, shares across the two of you; **RLS acceptance check
  passes for every new table** (`audit-rls.sql` all ✓); `build`/`oxlint`/`vitest`
  green; offline fallback works; per-PR gates above.
- **D (PR 8):** partner self-joins via email pre-auth; strangers can't create
  accounts (`shouldCreateUser: false`); (optional) realtime updates.
