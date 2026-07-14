# Plan 103 — Declared amortering plan (override the derived amortering)

**Status:** proposed · **Priority:** Medium · **Effort:** S–M · **Owner:** Claude ·
**Source:** owner question after the #305 forecast fix, 2026-07-14 ·
**Touches:** `web/src/lib/mortgage.ts`, `web/src/lib/mortgage.test.ts`,
`web/src/lib/mortgage-forecast.test.ts`, `web/src/lib/mortgage-store.ts`,
`web/src/routes/bolanekoll/PartDialog.tsx`, `web/src/routes/Bolanekoll.tsx`,
optionally a Supabase migration (see Decisions locked · storage)

## Goal

Let the owner **declare** that a fixed amortering (e.g. 8 000 kr/mån rak) sits on
a specific loan part, and have `expectedCharge` trust that declaration over the
value derived from ledger history — so the forecast is correct **immediately**
when the arrangement is new or changes, instead of lagging ~3 months while the
trailing-median detector catches up.

This does **not** replace detection. Detection stays the default and the
fallback; the declaration is an optional, higher-priority source.

## Why this, and why now

Today amortering is inferred, in priority order
([mortgage.ts:937-967](../web/src/lib/mortgage.ts#L937-L967)):

1. explicit `kind:'amortization'` rows (manual ledgers) — median of trailing 3,
2. paired `betalning − ränta` within a month — median of trailing 3,
3. the balance-timeline drop (last resort).

For the household's steady state this is correct to the öre (part 1 = 8 000, the
three flat parts = 0), so **nothing is broken today**. The gap is at the moments
detection *cannot* see, because they have no history yet:

- **Changing which part amortises** — moving amortering from DB1 to DB2 leaves
  the median predicting the old split for ~3 months, and mixes both during the
  switch.
- **A new or changed amortering amount** — a rak step-up/step-down, or starting
  extra amortering, is not reflected until ~3 paired months exist.
- **The villkorsändring at the end of July 2026** — balances, rate, and possibly
  the amortering arrangement all move at once; detection is least reliable
  exactly then.

## Decisions locked

- **Rak (fixed kr/mån) only, per part.** The household loan is rak amortering,
  not annuitet. Scope the declaration to a fixed monthly krona amount on a named
  part. Annuitet is explicitly out of scope (see below).
- **Declaration wins over detection, but never over real rows.** Priority
  becomes: explicit `amortization` rows → **declared plan** → paired
  `betalning − ränta` → balance-timeline drop. Real, imported amortering rows
  still outrank the declaration (the bank remains ground truth); the declaration
  only supersedes the *estimated* sources (paired diff, timeline).
  - Rationale: an explicit manual `amortization` row is real recorded history; a
    declared plan is intent. Real history must not be overwritten by intent.
    (If this ordering proves surprising in review, the alternative — declaration
    above everything — is a one-line change; flag at implementation.)
- **Effective-dated.** The plan carries an optional `start_date` (and optional
  `end_date`) so a change of arrangement is dated, not retroactive. A plan with
  no dates applies to the current and future forecast only, never rewriting past
  months. `expectedCharge`/`rollChargeOnce` consult the plan effective at each
  rolled `next_date`, mirroring how `effectiveRatePeriod` is already consulted
  per rolled date.
- **Zero is a valid declaration.** Declaring 0 kr/mån on a part explicitly pins
  it interest-only, overriding a noisy paired-diff that would otherwise invent a
  few kronor of amortering. This matters for the three flat parts during the
  villkorsändring churn.
- **Amortering stays rate-independent.** The declared amount feeds only the
  `amortization`/`gross`/`betalning` legs and the balance step-down in
  `rollChargeOnce`; it never touches the ränta arithmetic. No interaction with
  the rolling-3-month rate work in [plan 104](104-declared-calc-overrides.md).
- **Storage — reuse, do not add a table if avoidable.** Prefer an optional
  field on the loan part (`planned_amortization: number | null`, plus optional
  `planned_amortization_start`/`_end`) persisted in the existing mortgage
  tool-state JSON, so **no migration and no schema/RLS change** are required
  (household-owned already, like the rest of the mortgage state). Only if a part
  needs *multiple* dated amortering steps do we introduce an
  `AmorteringPlan[]` collection parallel to `RatePeriod[]`; decide at
  implementation, defaulting to the single-field form. Validate the shape
  defensively on load (non-negative number or null), consistent with the
  existing `make*` normalisers.

## Design

1. **Types.** Add optional `planned_amortization` (+ optional dates) to
   `LoanPart` and its `makeLoanPart` normaliser, defaulting to `null`. Clamp to
   `>= 0`; `null`/empty means "not declared → detect".
2. **`expectedCharge` amortering selection** — insert the declared plan as the
   second priority (after explicit rows, before paired diff). Resolve the
   amount effective at `next_date`. When present (incl. `0`), it is
   authoritative and the paired/timeline branches are skipped.
3. **`rollChargeOnce`** already steps `balance` down by `out.amortization`; since
   the declared amount rides in `out.amortization`, rolling works unchanged. Add
   handling only if dated plans change the amount across a roll boundary (re-resolve
   the effective plan per rolled `next_date`, same pattern as the binding check).
4. **`betalning`** — when a declared amortering is present on a part that has
   betalning history, `betalning = interest + declared_amortering`, so the
   Nästa avisering total row stays the bank's total-debit shape.
5. **UI (PartDialog / Lånedelar).** Add an optional "Planerad amortering
   (kr/mån)" field to the part editor with an optional "Gäller från" date.
   Concise Swedish copy. Empty = "beräknas från historik" (detected). Show the
   effective source in the forecast detail so the owner can see whether a figure
   is declared or detected (reuse the existing observed/estimated labelling
   convention — declared amortering is a *declared* value, not an estimate).

## Tests (test-first, pure calc layer)

Add to `mortgage-forecast.test.ts` / `mortgage.test.ts`, using realistic
fictional golden values:

- **Declared amount wins over a stale paired diff** — a part whose trailing
  paired diffs say ~6 000 but declared 8 000 → `amortization` 8 000,
  `betalning = interest + 8 000`, and the rolled balance steps by 8 000.
- **Declared 0 pins interest-only** — a flat part with one noisy paired month →
  declared 0 → `amortization` 0, `betalning = interest`.
- **Real amortization rows still win** — an explicit trailing `amortization`
  row overrides a conflicting declaration (ground-truth precedence).
- **Effective-dating** — a plan with `start_date` next month does not alter the
  current pending charge but applies to the rolled series past that date; a
  dated *change* (8 000 → 5 000) is reflected only from its start.
- **Detection unchanged when undeclared** — parts with `planned_amortization`
  null reproduce the existing #305 goldens exactly (regression guard).
- **Balance step-down / payoff** — declared amortering drives
  `projectBalance`/series step-downs and stops at 0 without going negative.
- **Malformed input** — negative/NaN declaration is clamped/ignored (falls back
  to detection), asserted at the normaliser.

## Out of scope

- **Annuitet** (declining amortering as interest falls) — the household loan is
  rak; annuitet is a separate model if ever needed.
- **Planned lump-sum insatser** (one-off extra amorteringar on a future date) —
  a natural extension, but the existing `is_insats` real-row path already covers
  logged ones; forecasting *future* lump sums is a follow-up, not this plan.
- **Amorteringskrav auto-derivation** — deriving the *required* amortering from
  LTV/DTI already exists in `amorteringskravStatus`; this plan is about the
  *actual* declared amortering, not the statutory minimum.

## Verify gates

`npm run lint`, `npm run test`, `npm run build` from `web/`. Add the store-layer
test if the declaration touches `mortgage-store.ts` persistence
(save/load/merge of the new field) per the AGENTS.md writes-and-failures rule.
