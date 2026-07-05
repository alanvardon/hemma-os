# Plan 16c — Månadsavslut → cloud (Phase B, PR 3)

**Parent:** [Plan 16](16-supabase-migration-auth.md) · **Branch:**
`ui/supabase-manadsavslut` · **Prerequisites:**
[16b](16b-supabase-salary-pilot.md) merged (the store-swap pattern is proven).

## Goal

Migrate the couple's most-shared tool. Three data kinds live in one localStorage
envelope today (items, payments, settings) → two data tables + one
`tool_state` blob row. This PR also **introduces the generic `tool_state`
table** that every later blob (budget, konsult, settings…) reuses.

## The tables (now captured in the baseline migration)

`tool_state` — one jsonb row per household per tool (Decision 9). Created here,
reused by 16d/16e/16f/16g:

```sql
create table public.tool_state (
  household_id uuid not null references public.households(id)
               default private.current_household(),
  tool         text not null,          -- 'manadsavslut-settings', 'hushallsbudget', …
  data         jsonb not null,
  updated_at   timestamptz not null default now(),
  primary key (household_id, tool)
);
alter table public.tool_state enable row level security;
create policy hh_all on public.tool_state for all to authenticated
  using      (household_id = (select private.current_household()))
  with check (household_id = (select private.current_household()));
create trigger set_updated_at before update on public.tool_state
  for each row execute procedure moddatetime (updated_at);
```

Items + payments (mirror `Item`/`Payment` in `manadsavslut.ts`). STD columns =
`id text pk default gen_random_uuid()::text`, `household_id … default
private.current_household()`, `created_at`, `updated_at` (as in 16b):

```sql
create table public.monthend_items (
  id text primary key default gen_random_uuid()::text,
  household_id uuid not null references public.households(id) default private.current_household(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
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
  personal_a     numeric not null default 0,    -- derived sums, store re-derives
  personal_b     numeric not null default 0
);

create table public.monthend_payments (
  id text primary key default gen_random_uuid()::text,
  household_id uuid not null references public.households(id) default private.current_household(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  item_ids     jsonb not null default '[]',     -- ["<item id>", …]
  from_person  text,                            -- 'a' | 'b' | null
  to_person    text,
  amount       numeric not null default 0,
  period_label text not null default '',
  note         text not null default ''
);
```

Add the `hh_all` policy + `set_updated_at` trigger to **both** tables (same two
statements as 16b, per table).

## The store swap (`web/src/lib/manadsavslut-store.ts`)

Keep all exported signatures. Items → `monthend_items`, payments →
`monthend_payments`, settings → `tool_state` (`tool = 'manadsavslut-settings'`,
`data` = the whole `MonthEndSettings`). **Split the keys** (as in 16b, see the
master plan's key-split note): `STORAGE_KEY` (`bostadskalkyl_monthend_v1`)
becomes a **read-only legacy import source + backup**; a **new**
`bostadskalkyl_monthend_cache_v1` holds the write-through cache. The cache
mirrors the whole `{ items, payments, settings }` envelope.

- **`normalizeItem` keeps running** on rows loaded from Supabase — it's
  idempotent, so it harmlessly re-derives `personal_a/b`.
- **`settle()` ordering matters.** It writes a payment AND flips items'
  `paid`/`payment_id`. Do the **payment insert first**, then the item updates,
  so a mid-failure leaves items *unsettled* (retryable) rather than
  settled-but-unpaid. Two round trips; check `error` after each.
- `addItems` (bulk CSV import) → one `.insert([...])` call.

## First-login import (one-time, idempotent)

On the first authenticated load after the household exists, if
`localStorage['bostadskalkyl_monthend_supabase_imported']` is unset: read the
legacy `bostadskalkyl_monthend_v1` envelope (the **read-only** key from the
split, never the cache) and upsert **items → `monthend_items`** + **payments →
`monthend_payments`** keyed on `id` (so re-running adds nothing), plus the
**settings → `tool_state`** row **only if no cloud row exists yet** (so a
partner's already-saved settings aren't clobbered); then set the flag.

Unlike salary (one `list()`), Månadsavslut has three read entry points — gate
the import at the start of **all three** (`listItems`/`listPayments`/
`getSettings`) so it fires regardless of which loads first; dedupe concurrent
calls with a shared in-memory promise; on any error leave the flag unset to
retry. Per-origin/per-device: the real history lives on the live Pages origin,
not localhost.

## Verification gate / Definition of done

- **RLS acceptance check (before real data)** — see master §Risks. For **both**
  `monthend_items` and `monthend_payments`: signed-in member INSERT→201 + reads
  back; `+test` outsider denied both ways; `supabase/audit-rls.sql` all ✓. (This
  is the check that was missing — the tables shipped with a `for select`-only
  policy, so reads worked but every insert 403'd until the policy was fixed to
  `for all`.)

- Full month-end flow against cloud: CSV import → per-row triage → settle,
  reflected on your partner's device.
- `settle()` two-write order behaves as specced (interrupt-safe).
- Offline reload renders the last state from cache.
- Import runs once; re-runs add nothing.
- `build` + `oxlint` + `vitest` green.

**Next:** [16d](16d-supabase-hushallsbudget.md) — Hushållsbudget (the
sync→async refactor).
