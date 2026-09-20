# Plan 128 — Fit the bank profile from the ledger and persist it as truth

**Status:** complete · **Owner model:** Opus for the fitter/persistence stages;
Sonnet for the dialog stage · **Severity:** MEDIUM · **Source:** owner decision
2026-08-01 (the profile should be worked out automatically once there is enough
evidence, written to the database, and reused for any future mortgage with that
bank) · **Req:** 3 of 3 (build order 126 → 127 → 128) · **Touches:** a new
`supabase/migrations/*_bank_charge_basis.sql`, `web/src/lib/mortgage.ts`,
`web/src/lib/mortgage-store.ts`, `web/src/lib/persistence-schema.ts`,
`web/src/routes/bolanekoll/BankProfileDialog.tsx`,
`web/src/routes/bolanekoll/useMortgageWorkspace.ts`,
`web/src/routes/Bolanekoll.tsx`, and focused domain/store/route tests.

## Finding

The bank profile is meant to record how a bank calculates. In practice almost
nothing is ever recorded.

**Only a declared value is written.** `useMortgageWorkspace.ts:178` writes
`year_basis_source: input.year_basis == null ? null : 'declared'`. Nothing else
in the codebase writes a source. The owner has declared nothing, so every bank
row holds `null`.

**Everything else is re-derived at read time.** `effectiveBankProfile`
(`mortgage.ts:1493-1514`) walks declared → detected → catalog → default on every
call, running `suggestBankProfile` each time (`mortgage.ts:1374`). The result
looks identical in the UI but is stored nowhere, so the same figure can change
because an import moved a detector across its threshold.

**`charge_basis` cannot be stored at all.** There is no column. It is inferred
from the ledger by `chargeBasis` (`mortgage.ts:1690-1703`) on every forecast,
and it moves the number more than 360-vs-365 does — it decides whether interest
scales with the day count or is a flat month.

**Three detectors, three heuristics.** `learnYearBasis` (`mortgage.ts:1306`),
`isMonthEndBilling` and `chargeBasis` each answer one question with their own
thresholds. None of them proves that the resulting profile actually reproduces
what the bank charged.

## Settled decisions

1. Once evidence is sufficient, the profile is **written to the database
   automatically** — no confirm click.
2. A stored profile is **write-once**. New contradicting evidence raises a
   visible drift prompt; only the owner changes a stored value. A profile that
   silently re-fits is persistence without determinism.
3. Auto-persist never overwrites a `'declared'` value. Precedence stays
   `declared > detected > catalog > default`.
4. Sufficiency is proven by **replay**, not by a statistical threshold: the
   fitted profile must reproduce the bank's own charges.
5. The profile is household-scoped and belongs to the bank, not the mortgage, so
   a future mortgage with the same bank inherits it. This is already true
   structurally — `mortgage_banks` carries `household_id` and is separate from
   `mortgages`.
6. **The profile may never produce a historical figure** (Plan 126 settled
   meaning 8). This is what makes profile versioning unnecessary: nothing
   recomputes history, so a profile change cannot reach backwards.
7. Learned values stay household-scoped. Nothing is written back to the shared
   `CatalogBank` catalogue.

## Why fitting needs so little

Only one convention is blocked by missing rate history, and it is worth stating
because it bounds the whole plan:

| Convention | Fittable without a known rate? | From |
|---|---|---|
| billing, charge day, cadence | yes | the date pattern alone |
| `charge_basis` | yes | do charges scale with day count? `chargeBasis` reads only days and amounts |
| `year_basis` | **no** | degenerate with the rate |

A charge is `balance × rate × days / basis`. The charge, balance and days are
observed, leaving two unknowns in one equation: 3,93 % on /360 and 3,98 % on
/365 produce an identical charge. The existing learner already encodes this by
skipping any pair whose period carries no listed rate
(`mortgage.ts:1321-1322`).

So the only unfittable corner is a **days-basis bank, not catalogued, with no
declared basis and no rate period covering any historical charge**. Even there
the forecast runs on the 365 default with a `'assumed'` confidence, exposure
≤ 1,4 %, resolved by a single entered historical rate. `year_basis` does not
appear in the flat-monthly branch at all.

## Fix

### 1. One replay fitter

Replace the three detectors with a single pure function that proves its answer:

```ts
export interface ProfileFit {
  year_basis: 360 | 365
  charge_basis: 'days' | 'monthly'
  billing: 'month-end' | 'fixed'
  /** Charges replayed — only intervals with both a charge and a covering rate. */
  covered: number
  /** Total absolute kronor error across the replayed charges. */
  residual: number
  /** Residual of the next-best amount candidate; the margin proves uniqueness. */
  runner_up_residual: number
  proven: boolean
}

export function fitBankProfile(
  parts: LoanPart[], periods: RatePeriod[], payments: Payment[],
): ProfileFit | null
```

Conventions split by what they affect:

- **Amount conventions** — `year_basis × charge_basis`, four candidates. For
  each, replay every historical interest charge from the balance at interval
  start, the listed rate covering that interval, and the observed dates. Sum the
  absolute kronor residual. The winner is the lowest.
- **Date conventions** — `billing`, charge day and cadence never change a
  replayed amount, only the prediction of the *next* date. Fit them from the
  date pattern, as `isMonthEndBilling` does today.

`proven` requires all of: `covered >= 4`; `residual <= max(5 kr, 0.5 %` of the
replayed interest`)`; and `runner_up_residual >= 4 × residual`, so an ambiguous
fit is never persisted. Pool evidence across the bank's parts, as
`sameBankParts` already does (`mortgage.ts:1345-1352`). Skip any interval
straddling a rate boundary — the same rule `learnYearBasis` uses today.

Return `null` when no interval has both a charge and a covering rate.

`learnYearBasis`, `isMonthEndBilling` and `chargeBasis` are replaced as
*decision* functions. Keep `chargeBasis` only if a bank has no stored
`charge_basis` yet, as Plan 126's interim source.

### 2. `charge_basis` on the bank

New migration — never edit an applied one. Add `charge_basis text` and
`charge_basis_source text` to `mortgage_banks`, matching the existing two
conventions exactly in shape and RLS.

Thread the fields through: the sync column list (`mortgage-store.ts:74`), the
dirty-field set (`mortgage-store.ts:195`), the envelope defaults
(`mortgage-store.ts:378`) and the parser (`persistence-schema.ts:510-517`),
whose source enum is already `['detected', 'suggested', 'declared']`. Extend
`Bank` (`mortgage.ts:38-52`), `CatalogBank` (`mortgage.ts:1436`) and
`effectiveBankProfile` with a third `EffectiveConvention`.

### 3. Auto-persist, write-once

On Bolånekoll load, for each bank with at least one active part: if any
convention has no stored value and `fitBankProfile` returns `proven`, write the
missing fields once with source `'detected'` — already a legal persisted value,
so **no migration is needed for `year_basis` or `billing`**.

Rules:

- never write a field whose source is already `'declared'` or `'detected'`
- write all proven fields in one bank update, not one per field
- the write is idempotent and safe to lose: a failure just means the next load
  retries. Do not block the page, and do not report success on failure
- surface what happened once, non-modally:
  > Bankprofil för Danske Bank fastställd: bankår 360, ränta per dag. Återskapar
  > bankens 7 senaste debiteringar inom 2 kr.

Because it is write-once, the forecast reads a stable stored value and the same
inputs always yield the same Nästa avisering.

### 4. Drift instead of silent re-fit

Extend `bankProfileDrift` (`mortgage.ts:1394`) beyond `year_basis` to every
stored convention, and to `'detected'` values as well as `'declared'` ones. When
a fresh `proven` fit disagrees with a stored value, show the existing
drift banner and offer the correction as an explicit owner action.

`ConventionDriftWarning` (`mortgage.ts:1448-1458`) already carries
`field / against / held / observed / effective`; add `'detected'` to `against`.

Never auto-correct. A stored profile changes only when the owner accepts.

### 5. Surface all three in Bankprofil

Add the third control beside Bankår and Avisering, reusing the existing
`SOURCE_LABELS` provenance chip (`BankProfileDialog.tsx:122`, `:145`) so each
field states where its value came from. Swedish copy:

- `Räntemodell` — `Ränta per dag` / `Fast månadsränta (30/360)` / `Automatiskt`
- provenance chips for `angivet` / `fastställt` / `katalog` / `standard`
- the replay evidence line beneath, when a fit exists

Setting a control to a value writes `'declared'` and pins it, exactly as the two
existing fields behave.

## Execution

- [x] **Stage 1 · [Opus]** — `fitBankProfile` with replay goldens: a known-360
  days bank, a known-365 days bank, a flat-monthly bank, an ambiguous history
  that must not prove, a history with no covering rate that returns `null`, and
  a boundary-straddling interval that is skipped. Gate: focused domain tests
  pass.
- [x] **Stage 2 · [Opus]** — migration, sync/parser/type threading, and
  `effectiveBankProfile`'s third field. Gate: store tests plus a local migration
  apply; persisted legacy rows without the columns still parse.
- [x] **Stage 3 · [Opus]** — auto-persist on load. Gate: store test with
  `createSupabaseMock()` proves write-once (a second load writes nothing), that
  a `declared` field is never overwritten, and that a failed write neither
  blocks the page nor reports success.
- [x] **Stage 4 · [Opus]** — drift across all three conventions with no
  auto-correction. Gate: domain and component tests.
- [x] **Stage 5 · [Sonnet]** — Bankprofil third control, provenance chips,
  evidence line, Swedish copy. Gate: route tests and build pass.
- [x] **Stage 6 · [Sonnet]** — Playwright verification at 390×844 and desktop,
  both themes. Gate: screenshots attached to the PR.

## Acceptance criteria

- A bank with enough evidence gets its profile written automatically on load,
  with source `'detected'`, and the owner is told once what was determined and
  on what evidence.
- A second load writes nothing. A `'declared'` field is never overwritten.
- An ambiguous history — two candidates within the margin — persists nothing and
  leaves the forecast on `'assumed'` confidence.
- A history with no covering rate period returns `null` rather than guessing a
  year basis.
- The fitted profile reproduces the bank's replayed charges within the stated
  tolerance, and the residual is visible in the dialog.
- `charge_basis` is stored, editable and provenance-labelled alongside the other
  two; Plan 126's forecast reads the stored value in preference to `chargeBasis`
  detection.
- Fresh contradicting evidence raises a drift prompt and changes nothing until
  the owner accepts.
- No historical figure anywhere is derived from the profile.
- No godkänd prognos row or real Betalningar row changes when a profile is
  written or corrected.
- A new mortgage created against an existing bank inherits the stored profile
  with no refitting.
- Legacy bank rows saved before the migration still parse and sync.
- `npm run lint`, `npm run test`, and `npm run build` pass from `web/`.

## Out of scope

- Writing learned conventions back to the shared `CatalogBank` catalogue.
  Household-scoped only.
- Effective-dating or versioning the profile. Unnecessary under settled decision
  6 — nothing recomputes history.
- Reconstructing missing historical rate periods from charges by inverting
  `rate = charge × basis / (balance × days)`. Attractive but a separate feature;
  it writes contractual data inferred from a model.
- Production migration/deployment; work stays local until the owner merges.
