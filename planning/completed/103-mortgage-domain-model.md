# Plan 103 — Mortgage domain model: Bank → Mortgage → Lånedel

**Status:** proposed · **Priority:** High (foundational) · **Depends on:** none —
this is the base of the batch · **Blocks:** [plan 104](104-declared-calc-overrides.md)
(bank profiles build on the Bank entity) · **Effort:** L · **Owner:** Claude
Opus 4.8 · **Source:** owner design discussion, 2026-07-14 · **Approvals:** owner
approved the relational entity model, "model many mortgages / build UI for one",
and "change bank = new mortgage" on 2026-07-14 · **Touches:**
`supabase/migrations/` (new, additive),
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
[plan 105](105-declared-amortering-plan.md) (amortering, which stays per part).

The same restructuring also **retires the overloaded per-part `start_balance` /
"As of date" (`start_date`) pair**, which today does three incompatible jobs at
once — pre-ledger balance bootstrap, origination anchor for "Total amortised",
and the reconcile-check baseline. That overloading is what makes the
*"Start-balance check … off by 192 000 kr"* banner a false alarm on any loan
older than its imported ledger window. See
**[Lånedel: split origination from the "As of date" snapshot](#lånedel-split-origination-from-the-as-of-date-snapshot)**
below.

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
- **Split the overloaded `start_balance` / "As of date".** Introduce an explicit
  per-part `original_balance` (the origination anchor); retire the *snapshot*
  meaning of `start_date`; rebuild `reconcileBalance` so **pre-import
  amortisation is never flagged**. Additive columns, backfilled from the current
  fields — see the dedicated section below. Owner surfaced this on 2026-07-14
  from the false-alarm banner and chose to fold it into this domain-model plan.
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
- **`mortgage_loan_parts.original_balance` + `original_date`** — `numeric null` /
  `date null`. The part's amount at origination, split out of the overloaded
  `start_balance` / `start_date` (see the dedicated section below). Both go into
  `COLS.parts` in `mortgage-store.ts`
  ([:44](../web/src/lib/mortgage-store.ts#L44)) and the `makeLoanPart`
  normaliser (default `null`, clamp `original_balance ≥ 0`).
- **Migration** (additive): create both tables + the columns; seed one bank
  ("Danske") and one mortgage for the existing household; backfill every existing
  part's `mortgage_id` to that mortgage **and** `original_balance := start_balance`,
  `original_date := start_date` (today's `start_balance` values already *are*
  origination amounts). Idempotent; safe to re-run.
- **Valuations stay household-level for now** (they are today). Re-parenting a
  valuation under a specific mortgage/property is a deliberate future extension,
  noted, not done here.

## Lånedel: split origination from the "As of date" snapshot

### The overloaded field today

`LoanPart.start_balance` + `start_date` (labelled **"As of date"** in the part
editor, [PartDialog.tsx:40-41](../web/src/routes/bolanekoll/PartDialog.tsx#L40-L41))
serve three incompatible roles at once:

1. **Pre-ledger balance bootstrap** —
   [`partBalance`](../web/src/lib/mortgage.ts#L243-L257) uses the *latest imported
   Saldo* whenever any `balance_after` exists, and only falls back to
   `start_balance − Σ amortisation after start_date` when the ledger carries no
   Saldo at all. Once a real ledger is imported this role is dead for the
   household — `start_balance`/`start_date` no longer touch today's balance.
2. **Origination anchor for "Total amortised"** —
   [`partOriginal`](../web/src/lib/mortgage.ts#L259-L272) returns `start_balance`
   when `> 0`, and `partAmortized = partOriginal − partBalance`
   ([:274-276](../web/src/lib/mortgage.ts#L274-L276)) drives the hero's *Total
   amortised* chip ([Bolanekoll.tsx:840](../web/src/routes/Bolanekoll.tsx#L840)).
   Here `start_balance` means *the loan's original amount* and its date is
   *origination*.
3. **Reconcile baseline** —
   [`reconcileBalance`](../web/src/lib/mortgage.ts#L1231-L1247) compares
   `start_balance` against the ledger's **earliest** Saldo (scoped to rows dated
   ≥ `start_date`); the banner renders at
   [Bolanekoll.tsx:857-862](../web/src/routes/Bolanekoll.tsx#L857-L862), gated by
   `|drift| ≥ max(start_balance·1%, 5000)`
   ([:374-377](../web/src/routes/Bolanekoll.tsx#L374-L377)).

**Roles 2 and 3 fight.** Role 2 wants `start_balance` = the *origination* amount
(higher, older). Role 3 assumes `start_balance` = the ledger's *opening* Saldo
(wherever the import happens to begin). For any loan older than its imported
statement window these legitimately differ by the pre-import amortisation —
Danske Bank 1 shows origination `1 200 000` vs ledger-opening `1 008 000`, i.e.
`192 000` amortised before the import — so the banner fires as a false *"off by
192 000 kr"* alarm even though `partBalance` tracks today's Saldo correctly. The
banner's own copy admits this ("today's balance still tracks the Saldo
correctly"), which is the tell that the check is comparing the wrong two numbers.

### The fix (folded into this restructuring)

- **`original_balance` (+ optional `original_date`) is the single, unambiguous
  origination anchor** — the part's amount when the agreement was signed.
  `partOriginal` reads it first; the origination *date* is the mortgage's
  `start_date` (this plan's `mortgages.start_date`), with `original_date` an
  optional per-part override for staggered draws.

  ```ts
  function partOriginal(part: LoanPart, payments: Payment[]): number {
    // Origination anchor — the part's amount when the agreement was signed.
    if (Number(part?.original_balance) > 0) return r2(Number(part.original_balance))
    if (Number(part?.start_balance) > 0) return r2(Number(part.start_balance)) // legacy fallback
    // …existing loan-row / earliest-Saldo derivation unchanged…
  }
  ```

- **Retire the *snapshot* meaning of `start_date`.** The pre-ledger bootstrap
  (role 1) is served by `original_balance − Σ amortisation` when no Saldo ledger
  exists — no separate "as of" snapshot field is needed. `start_balance` /
  `start_date` survive only as a defensive legacy fallback (old rows must never
  crash); they are no longer the origination source once backfilled.

- **Rebuild `reconcileBalance` on the clean anchor.** It must **stop** comparing
  origination against the ledger's opening Saldo. Fire only on genuine evidence
  of a partial import or a stale figure:
  - origination sits *within/after* the imported ledger window (so the two
    *should* coincide) and they still disagree, **or**
  - the earliest Saldo cannot be reconciled forward from `original_balance` by
    the amortisation actually logged between them.

  When origination **predates** the ledger's earliest row, the gap is expected
  pre-import amortisation → **no banner**. This is exactly the 192 000 case, now
  silenced by construction.

- **UI.** The part editor's "As of date" field is relabelled to its real job —
  *Ursprungligt lånebelopp* (vid origination) — in a follow-up cosmetic PR
  (bundled with the "Lånedelar → Banker / Lån" rename); this plan does the
  model + math + reconcile rebuild, not the wording.

**Interaction with plan 105.** Plan 105 (declared amortering) also adds an
optional `LoanPart` field (`planned_amortization`). Different field, no overlap;
building **103 first** means 105 lands on the clean origination anchor rather
than the overloaded one.

## Store & resolvers

- Extend `mortgage-store.ts`: CRUD for `mortgage_banks` and `mortgages`; patch
  `mortgage_id` on parts; add `original_balance`/`original_date` to `COLS.parts`
  ([:44](../web/src/lib/mortgage-store.ts#L44)) and the `makeLoanPart`
  normaliser; the load snapshot gains `banks` and `mortgages`. Follow the
  existing `{data,error}` checking (supabase-js never throws).
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
- **Origination split** — `partOriginal`/`totalAmortized` read `original_balance`:
  a part with `original_balance = 1 200 000` and a ledger opening at `1 008 000`
  reports *Total amortised* from origination (`1 200 000 − current`), not from
  the ledger window. With `original_balance` null it falls back to `start_balance`,
  then to the loan-row/earliest-Saldo derivation (existing goldens unchanged).
- **Reconcile no longer false-alarms** — origination (`original_date`) predating
  the ledger's earliest Saldo yields **no** banner (the 192 000 pre-import case);
  a genuine partial import (origination *within* the window, numbers disagree)
  still fires; malformed/negative drift never crashes.
- **Migration backfill** — existing rows get `original_balance := start_balance`
  and `original_date := start_date`; idempotent; a row lacking the new columns
  falls back without crashing.
- **Malformed anchor** — negative/NaN `original_balance` is clamped/ignored at the
  normaliser (falls back to `start_balance`, then derivation).

## Sequence

**103 first (this — foundation) → [104](104-declared-calc-overrides.md) (bank
profiles + learning on the Bank) → [105](105-declared-amortering-plan.md)
(amortering, independent, any time).** Each its own branch + PR off `main`.

## Out of scope

- Multi-mortgage management UI (model supports it; UI shows the active one).
- Bank-level profile columns + the learner ([plan 104](104-declared-calc-overrides.md)).
- Declared amortering ([plan 105](105-declared-amortering-plan.md)).
- Re-parenting valuations/property under a mortgage (future).
- The Lånedelar rename **and** the "As of date" → *Ursprungligt lånebelopp*
  field relabel (bundled into that separate cosmetic PR). This plan does the
  origination-anchor model, math, and reconcile rebuild — not the copy.

## Verify gates

`npm run lint`, `npm run test`, `npm run build` from `web/`, plus local
migration/RLS checks. Store-layer test with a mocked Supabase client for the new
CRUD (success + failure), per the AGENTS.md writes-and-failures rule.
