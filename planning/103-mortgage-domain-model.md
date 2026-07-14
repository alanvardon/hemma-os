# Plan 105 — Mortgage domain model: Bank → Mortgage → Lånedel

**Status:** proposed · **Priority:** High (foundational — 104 and the profile
work build on it) · **Effort:** L · **Owner:** Claude · **Source:** owner design
discussion, 2026-07-14 · **Approvals:** owner approved the relational entity
model, "model many mortgages / build UI for one", and "change bank = new
mortgage" on 2026-07-14 · **Touches:** `supabase/migrations/` (new, additive),
RLS/`config.toml`, `web/src/lib/mortgage.ts` (types + resolvers),
`web/src/lib/mortgage-store.ts`, `web/src/lib/mortgage-store.test.ts`,
`web/src/lib/mortgage-*.test.ts`, `web/src/routes/Bolanekoll.tsx`,
`web/src/routes/bolanekoll/`

## Goal

Restructure the currently flat mortgage model (household → loan parts) into the
real Swedish bolån hierarchy, so bank-level conventions, the loan agreement, and
per-part rates each live at the correct level:

```
Bank        (household may use several over time — carries the billing-convention profile)
  Mortgage  (one bolån agreement, linked to exactly one bank)
    Lånedel × N   (each keeps its own RatePeriods: rate + rörlig/bunden + villkorsändringsdag)
```

This is the **foundation** for [plan 104](104-declared-calc-overrides.md) (bank
profiles + learning, which hang off the Bank) and is compatible with
[plan 103](103-declared-amortering-plan.md) (amortering, which stays per part).

## Decisions locked (owner, 2026-07-14)

- **Three levels, one bank per mortgage.** A `Bank` has many `Mortgage`s; a
  `Mortgage` links to exactly **one** bank and has many `Lånedel` (loan parts).
  No mortgage spans two banks.
- **Conventions are bank-level; rates are part-level.** The billing-convention
  profile (day-count year, billing cadence — detailed in plan 104) lives on the
  **Bank**, because it is how that bank bills across all its mortgages/parts.
  **Each Lånedel keeps its own `RatePeriod`s** (rate, `rate_type`
  rörlig/bunden, villkorsändringsdag). The Mortgage/Bank layer must **not**
  flatten, blend, or override per-part rates. `groupLoanParts` (parts grouped by
  villkorsändringsdag, mixed types supported) stays valid *within* a mortgage.
- **Model many, build for one.** The schema supports multiple mortgages; the UI
  surfaces the single active mortgage for now. No multi-mortgage management
  screens yet.
- **Change bank = new mortgage.** A bank change creates a new `Mortgage` linked
  to the new bank; the old mortgage and its bank (with any learned/locked
  profile) are retained as history. A refinance is genuinely a new agreement.
- **Relational, additive, reversible-safe migration.** Create the new tables +
  the nullable `mortgage_id` on parts; seed + backfill for the existing
  household; **never edit an applied migration — new migration only.** Legacy
  rows lacking `mortgage_id` fall back gracefully (never crash).
- **Schema/RLS change** — gated on approval per the repo rules; owner approved
  the route on 2026-07-14. Add store + migration tests.

## Data model

- **New `mortgage_banks`** — `id`, `household_id`, `created_at`, `label`.
  (Plan 104 adds the profile columns — `year_basis`, `billing`, provenance — in
  its own additive migration, so each plan's migration stays focused and neither
  re-edits the other's.) RLS household-scoped, mirroring the sibling tables.
- **New `mortgages`** — `id`, `household_id`, `bank_id` (references
  `mortgage_banks`), `created_at`, `label`, `start_date` (nullable),
  `archived`. RLS household-scoped.
- **`mortgage_loan_parts.mortgage_id`** — `uuid null references mortgages(id)`.
  Parts reach their bank via `mortgage → bank`.
- **Migration** (additive): create both tables + the column; seed one bank
  ("Danske") and one mortgage for the existing household; backfill every existing
  part's `mortgage_id` to that mortgage. Idempotent; safe to re-run.
- **Valuations stay household-level for now** (they are today). Re-parenting a
  valuation under a specific mortgage/property is a deliberate future extension,
  noted, not done here.

## Store & resolvers

- Extend `mortgage-store.ts`: CRUD for `mortgage_banks` and `mortgages`; patch
  `mortgage_id` on parts; the load snapshot gains `banks` and `mortgages`.
  Follow the existing `{data,error}` checking (supabase-js never throws).
- Add pure resolvers in `mortgage.ts`: `mortgageForPart(part, mortgages)`,
  `bankForPart(part, mortgages, banks)` — so plan 104's profile lookup and the
  forecast can reach a part's bank without threading ids through every call.
- **Forecast math is unchanged**: `expectedCharge`/`pendingCharge` still run per
  part on its own `RatePeriod`s and ledger. The only new capability is reaching
  the part's bank (for plan 104's profile). Per-part mixed rörlig/bunden
  forecasting is preserved verbatim.

## UI

- Bolånekoll shows the **active mortgage**; the Lånedelar list is presented under
  it (bank → mortgage → parts). Adding a part associates it with the current
  mortgage. Multi-mortgage switching is deferred (model-only).
- The section-heading rename ("Lånedelar" → e.g. "Banker / Lån") remains a
  separate cosmetic PR; this plan introduces the grouped structure, not the
  wording.

## Tests (test-first where logic changes)

- **Migration** — idempotent; seeds one bank + one mortgage; backfills all
  existing parts' `mortgage_id`; re-run is a no-op.
- **Legacy fallback** — a part with null `mortgage_id`/no bank resolves to
  "unknown bank" and the forecast falls back to detection without crashing.
- **Store CRUD** — save/load/merge of banks + mortgages and the `mortgage_id`
  patch, with a mocked Supabase client asserting success **and** failure paths
  (per the AGENTS.md writes-and-failures rule).
- **Forecast regression** — every existing #305 golden passes byte-for-byte with
  parts now parented under a mortgage (structure changes, math does not).
- **Per-part mixed binding preserved** — one mortgage holding a bunden part and a
  rörlig part forecasts each on its own rate/type; `groupLoanParts` still groups
  by villkorsändringsdag within the mortgage.
- **Resolvers** — `bankForPart` returns the right bank through the mortgage link;
  change-bank creates a second mortgage, and its parts resolve to the new bank
  while the old mortgage's parts still resolve to the old bank.

## Sequence

**105 first (foundation) → 104 (bank profiles + learning on the Bank) → 103
(amortering, independent, any time).** Each its own branch + PR off `main`.

## Out of scope

- Multi-mortgage management UI (model supports it; UI shows the active one).
- Bank-level profile columns + the learner (plan 104).
- Declared amortering (plan 103).
- Re-parenting valuations/property under a mortgage (future).
- The Lånedelar rename (separate cosmetic PR).

## Verify gates

`npm run lint`, `npm run test`, `npm run build` from `web/`, plus local
migration/RLS checks. Store-layer test with a mocked Supabase client for the new
CRUD (success + failure), per the AGENTS.md writes-and-failures rule.
