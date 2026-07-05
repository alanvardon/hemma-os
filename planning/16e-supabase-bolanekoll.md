# Plan 16e — Bolånekoll → cloud (Phase C, PR 5)

**Parent:** [Plan 16](16-supabase-migration-auth.md) · **Branch:**
`ui/supabase-bolanekoll` · **Prerequisites:**
[16d](16d-supabase-hushallsbudget.md) merged.

## Goal

Migrate the mortgage tracker: five row arrays + a settings blob today → five
data tables + one `tool_state` row. Biggest table count of any phase, but the
recipe is identical to 16c — no new mechanics.

## The tables (SQL Editor; also commit to `supabase/schema.sql`)

Mirror the five row types in `mortgage.ts`. All ids `text`; all dates `text`
(Decisions 7 & 8 — the app sorts dates lexicographically and legacy rows carry
`''`). Every table below needs the STD columns (`id text pk default
gen_random_uuid()::text`, `household_id … default private.current_household()`,
`created_at`, `updated_at`) **plus** the `hh_all` policy + `set_updated_at`
trigger (as in 16b/16c — per table). Columns beyond STD:

```sql
-- mortgage_loan_parts
  label         text not null default '',
  loan_number   text not null default '',
  start_balance numeric not null default 0,
  start_date    text not null default '',       -- text (Decision 8)
  archived      boolean not null default false

-- mortgage_rate_periods
  loan_part_id text,                             -- text id, null = property-wide
  start_date   text not null default '',
  end_date     text,
  rate         numeric,
  rate_type    text not null default 'rörlig'    -- 'rörlig' | 'bunden'

-- mortgage_payments
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

-- mortgage_valuations
  date        text not null default '',
  value       numeric not null default 0,
  note        text not null default '',
  is_purchase boolean not null default false

-- mortgage_contributions
  owner  text not null default 'joint',          -- 'a' | 'b' | 'joint'
  date   text not null default '',
  amount numeric not null default 0,
  note   text not null default ''
```

## The store swap (`web/src/lib/mortgage-store.ts`)

Keep all exported signatures (`listLoanParts/addLoanPart/…/getSettings/
saveSettings/exportJSON/importJSON`). Five arrays → five tables; `settings` →
`tool_state` (`tool = 'bolanekoll-settings'`, `data` = the whole
`MortgageSettings`, including `import_presets`). **Split the keys** (as in
16b/16c, see the master plan's key-split note): `STORAGE_KEY`
(`bostadskalkyl_mortgage_v1`) becomes a **read-only legacy import source +
backup**; a **new** `bostadskalkyl_mortgage_cache_v1` holds the write-through
cache (mirroring the whole five-array + settings envelope).

- The v<4 `migrateToPeriods` migration keeps running against the **cache/import**
  path only — cloud rows are born v4, so it never fires on cloud data.
- `dayBefore`/`byDateDesc` are pure helpers — unchanged.
- `addPayments`/`removePayments` (bulk) → single `.insert([...])` /
  `.in('id', ids)` delete.

## First-login import

Flag `bostadskalkyl_mortgage_supabase_imported`. Upsert all five arrays by id;
upsert the settings `tool_state` row if absent. Idempotent.

## ⚠ Future: multi-property (do NOT build here — design note only)

The user plans to move house eventually and wants Bolånekoll to gain a
**property selector** (like Bostadskalkyl's scenarios dashboard) plus a **"lock"
a property once moved out** (freeze it as historical). **Decision (2026-07-04):
migrate as single-property now; add properties as its own feature later** — it's
a purely additive change, orthogonal to this migration, and cheap to introduce
post-Supabase (two users / kilobytes of data = a page of SQL run once, no
re-migration; RLS unchanged since everything stays household-scoped and property
is just a sub-filter). Building it now would only bloat the migration and lock
in an under-specified shape.

**The only thing to carry into THIS PR:** treat `MortgageSettings.property_name`
(which lands in the `bolanekoll-settings` `tool_state` blob) as *"the current
property's name"* — don't wire anything to assume it's the only property ever.
When the feature is built later it becomes:

```sql
-- FUTURE, not now:
create table public.properties (
  id text primary key default gen_random_uuid()::text,
  household_id uuid not null references public.households(id) default private.current_household(),
  name text not null, address text, is_locked boolean not null default false,
  created_at timestamptz not null default now()
);
-- each mortgage table gains: property_id text references public.properties(id)
-- backfill: one properties row (from property_name) + stamp all existing rows with its id
-- property_name retires out of the settings blob into properties.name
-- is_locked = the "moved out / locked" flag (same pattern as loan_parts.archived)
```

That later migration also reworks `mortgage-store` queries to scope by the
active property + adds the selector UI — all its own plan (a new number), when
the move is concrete.

## Verification gate / Definition of done

- **RLS acceptance check (before real data)** — see master §Risks. For **all
  five** mortgage tables: signed-in member INSERT→201 + reads back; `+test`
  outsider denied both ways; `supabase/audit-rls.sql` all ✓. (Five new tables =
  five chances to ship a `for select`-only policy — the audit catches any.)

- Bolånekoll renders **identically from cloud data on a second device**: charts,
  the loan-part grouping (`groupLoanParts`), and the Insatser·Contributions
  section (gated behind the `track_contributions` setting — confirm the setting
  round-trips through `tool_state`).
- Offline reload renders from cache.
- Import runs once; re-runs add nothing.
- `build` + `oxlint` + `vitest` green (the pure `mortgage.ts` suite is untouched
  — it never sees storage).

**Next:** [16f](16f-supabase-bostadskalkyl.md) — Bostadskalkyl scenarios.
