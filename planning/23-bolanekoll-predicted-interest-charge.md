# Plan 23 — Bolånekoll predicted interest / "expected next charge" (forecast + reconcile + confirm-to-log)

**Status:** plan — reviewed against code and decisions locked 2026-07-08 (user Q&A; supersedes the pre-grill draft) ·
**Owner model:** split — **Opus for the supersede semantics + the golden math values**
(a wrong tolerance or a bad replace deletes/duplicates real ledger rows, and wrong
expected values certify a bug); **Sonnet can build the Prognos card + badges** once
the pure helpers and first tests exist. ·
**Source:** chat request, reviewed 2026-07-08 — *"reduce the amount of manual
entering and uploading of CSVs"*. ·
**Touches:** `web/src/lib/mortgage.ts` (new pure fns), `web/src/lib/mortgage-forecast.test.ts`
(new), `web/src/routes/Bolanekoll.tsx` (Prognos block, import supersede, triage badge),
`web/src/styles/mortgage.css`. **No store/schema change** — reuses the existing
`Payment.source` string (`'predicted'`) and existing store APIs.

## Goal

Each month the household imports a bank CSV of `Ränta` + `Amortering` rows. For a
flat interest-only loan that entry is nearly identical every month. This plan makes
the steady months **zero-typing**: Bolånekoll computes the upcoming charge, one
click logs it as a `predicted` row, and the next real CSV import silently replaces
the prediction when it matches (prompts only on drift). The bank stays ground truth
— ränteavdrag/Skatteverket figures always end up based on *real* interest paid.

This is **arithmetic, not forecasting**: `interest = balance × rate × days/365`,
and the app already stores every input. The only uncertainty is a future rörlig
rate move; a bunden part is exact until its villkorsändringsdag. The first 2–3
months of a part's life still need real imports — that history is what calibrates
the rate, cadence, and charge day.

## The math — pure helpers in `lib/mortgage.ts`, calibrated against history

All new functions live in `mortgage.ts` so they can use the module-private helpers
[`partBalanceAsOf`](../web/src/lib/mortgage.ts#L461),
[`effectiveRate`](../web/src/lib/mortgage.ts#L560),
[`daysBetween`](../web/src/lib/mortgage.ts#L453), and
[`monthKey`](../web/src/lib/mortgage.ts#L369) without exporting them.

```ts
// lib/mortgage.ts — pure, no DOM. asOf defaults to the part's last interest date.
export interface ExpectedCharge {
  loan_part_id: string
  next_date: string           // day-of-month pattern from history, NOT last+median-gap
  days: number                // daysBetween(last interest date, next_date)
  balance: number             // partBalanceAsOf(part, payments, lastDate)
  rate: number | null         // the rate the prediction actually uses (%)
  rate_source: 'derived' | 'listed' | null
  rate_type: 'rörlig' | 'bunden' | null
  interest: number            // balance × rate/100 × days/365
  amortization: number        // monthlyAmortizationRate-derived (0 for interest-only)
  gross: number               // interest + amortization
  confidence: 'exact' | 'assumed' | 'unknown'
  calibration_gap: number | null  // listed rate − derivedRate (pp); diagnostic only
}

export function expectedCharge(part, periods, payments): ExpectedCharge | null
export function expectedCharges(parts, periods, payments):
  { rows: ExpectedCharge[]; total_interest: number; total_gross: number }
```

### Rate selection — **calibrated, not listed** (decision 3)

Predict with **[`derivedRate`](../web/src/lib/mortgage.ts#L639)** (trailing-3
day-weighted rate reverse-engineered from real charges) whenever it returns
non-null — it encodes what the bank *actually* bills, including its day-count
convention. Fall back to the **listed rate**
([`effectiveRate`](../web/src/lib/mortgage.ts#L560) at `next_date`) when history
is too thin (`derivedRate` needs ≥ 2 interest rows with a positive balance).
`rate_source` records which one was used.

**Why derived first:** if the bank computes interest on a 360-day basis, the
listed 3.50 % behaves like ~3.55 % under our 365-day formula. Predicting with the
listed rate would run every charge ~1.4 % hot — outside the 1 % reconcile
tolerance — and flag drift *every single month*, training the user to ignore the
one flag that matters. `derivedRate` absorbs the convention automatically.

`calibration_gap = listed − derived` stays as a **diagnostic** (amber note when
|gap| > 0.1 pp): a stable small gap means day-count convention (fine); a sudden
gap means an unlogged rate change (fix the rate period).

### Confidence

- **`exact`** — `bindingStatus(part, periods, next_date).bound && !expired`
  ([mortgage.ts:564](../web/src/lib/mortgage.ts#L564)): bunden inside its binding.
- **`assumed`** — rörlig (or bunden past villkorsändringsdag), rate held flat.
- **`unknown`** — `rate_source` is `listed` with no derived history to calibrate
  it, or no rate at all. `expectedCharge` returns **null** only when the part has
  neither an interest row nor a rate period (nothing to compute from).

### Cadence and `next_date` — day-of-month pattern, not median gap (decision 4)

Banks charge on a fixed day-of-month, so raw gaps alternate 28/30/31 days; adding
a median gap to the last date drifts off the real charge day and corrupts `days`.
Instead:

1. **Period length**: median gap between the part's interest rows, snapped to
   whole months (`1` if median ≤ 45 days, else `3` — covers monthly and
   kvartalsvis). Cold start (< 2 interest rows): assume monthly.
2. **Charge day**: the mode of day-of-month across the part's interest rows
   (ties → most recent wins). Cold start: the last row's day; no rows → today's day.
3. `next_date` = last interest date + period months, at the charge day, clamped
   to month end (day 31 in a 30-day month → 30).
4. `days = daysBetween(lastDate, next_date)` — actual days, so February prices
   correctly.

### Worked example

Part balance 1 000 000 kr, listed rörlig 3.50 %, bank bills monthly on the 27th
using a 360-day basis → real charges imply `derivedRate` ≈ 3.55 %.
`expectedCharge`: `rate: 3.55, rate_source: 'derived', confidence: 'assumed'`,
`next_date` = the 27th next month, `days: 31`,
`interest = 1 000 000 × 0.0355 × 31/365 = 3 015 kr` — matching the bank to the
öre, where the listed rate would predict 2 973 kr and flag ⚠ 42 kr drift forever.
`calibration_gap = −0.05 pp`, shown as a muted diagnostic, not an error.

### Forward annual view (feeds ränteavdrag planning)

```ts
export function forecastInterest(parts, periods, payments, months = 12):
  { interest: number; deduction: number; net: number; assumed: boolean }
```

Rolls `expectedCharge` forward `months`, holding **balance and rate flat**, and
runs the total through [`ranteavdrag`](../web/src/lib/mortgage.ts#L287).
`assumed: true` if any part is rörlig. Mirrors the *backward*
[`monthlyCost`](../web/src/lib/mortgage.ts#L531). **Caveat (documented in a code
comment):** flat balance slightly overstates interest for an amortizing part;
acceptable because the household's parts are interest-only and the figure is
labelled an estimate.

### Reconcile (expected vs actual)

```ts
export function reconcileCharge(expected: ExpectedCharge, actualInterest: number):
  { expected: number; actual: number; drift: number; ok: boolean }
// ok = |drift| ≤ max(50 kr, 1% of expected)

export function matchPredictedRows(payments: Payment[], drafts: Array<Partial<Payment>>):
  Array<{ draftIndex: number; predicted: Payment; recon: ReturnType<typeof reconcileCharge> }>
// pairs each incoming kind:'interest' draft with an existing source:'predicted'
// row on the SAME loan_part_id + SAME monthKey(date)
```

**Do not reuse [`flagDuplicates`](../web/src/lib/mortgage.ts#L202) for this
matching.** Its fingerprint includes the date, but the import triage feeds it
candidates with `date: ''` ([Bolanekoll.tsx:226](../web/src/routes/Bolanekoll.tsx#L226))
while existing rows carry real dates — the fingerprints can never collide, so that
dedupe path is currently dead code. Match on `loan_part_id + monthKey` instead.
(Fixing `flagDuplicates`' date asymmetry is a separate small plan — see Out of scope.)

## UI

1. **Prognos card** — extend the existing Projection card
   ([Bolanekoll.tsx:577-602](../web/src/routes/Bolanekoll.tsx#L577-L602)) with an
   **"Expected next charge"** block above the payoff chips:
   - Total chip: `Nästa avi ~3 015 kr` with sub-line `interest 3 015 · amort 0`.
   - Per-part rows: `Del 2 · 3.55 % · 27 aug · ~3 015 kr` with an **`≈ exact`** /
     **`≈ est.`** badge from `confidence`, and the amber calibration note when
     |`calibration_gap`| > 0.1 pp (`listed 3.50 % vs charged 3.55 % — day-count or
     unlogged rate change`).
   - Muted forward line from `forecastInterest`:
     `~36 200 kr interest over 12 mo · ~25 300 kr after avdrag` tagged
     *(assumes rates hold)* when `assumed`.
2. **One-click confirm-to-log** (decision 5 — **committed, this is the point of
   the plan**): a `Logga förväntad avi` button on each per-part row (and a
   log-all on the total chip) that calls
   [`makePayment`](../web/src/lib/mortgage.ts#L183) with the predicted `interest`
   amount, `date: next_date`, carried-forward `balance_after`, and
   **`source: 'predicted'`**, then
   [`Store.addPayment`](../web/src/lib/mortgage-store.ts#L308). The row renders
   in the payment list with a distinct *predicted* tag (style in `mortgage.css`).
   **Guard:** the button disables when any interest row (predicted or real)
   already exists for that part + `monthKey(next_date)` — no double-logging.
3. **Import supersede** (decision 6 — auto-replace within tolerance, prompt on
   drift): in [`confirmImport`](../web/src/routes/Bolanekoll.tsx#L254-L272),
   before `Store.addPayments(drafts)`:
   - Run `matchPredictedRows(payments, drafts)`.
   - **Within tolerance** → collect the matched predicted ids and call
     [`Store.removePayments(ids)`](../web/src/lib/mortgage-store.ts#L340) in the
     same flow, then add the actual rows as normal. Toast:
     `Added 2 rows · replaced 1 predicted row`. Silent otherwise — zero extra
     clicks in a steady month.
   - **Drift outside tolerance** → the triage summary
     ([Bolanekoll.tsx:273-287](../web/src/routes/Bolanekoll.tsx#L273-L287)) gains
     a per-part **⚠ drift X kr (predicted 3 015 → actual 3 175)** chip, and the
     confirm dialog requires an explicit go-ahead; on confirm the predicted row is
     still removed and the actual kept (actuals always win — decision 1). The
     drift itself is the alarm: a rate reset, fee, or extra amortering happened.
   - Never edits the imported amount; the actual row keeps its
     `source: 'import:<file>'`.
4. **Reconcile badge without Phase C** — even when nothing was pre-logged, run
   `reconcileCharge(expectedCharge(part…), actualRow.amount)` on incoming interest
   rows and show **✓ matched / ⚠ drift X kr** in the triage summary. Same tolerance,
   read-only.

## Decisions locked (chat + review Q&A 2026-07-08)

1. **Predict-then-reconcile**, never predict-instead-of — bank `Saldo` stays
   ground truth; actuals always supersede predictions.
2. **Arithmetic, not ML** — `balance × rate × days/365` from stored data; no rate
   forecasting.
3. **Prediction rate = `derivedRate` when available, listed rate as fallback**
   (`rate_source` explicit) — the derived rate matches what the bank actually
   bills and absorbs day-count conventions; `calibration_gap` is diagnostic only.
4. **`next_date` from the day-of-month pattern** (mode of charge days + months-
   snapped period), never last-date-plus-median-gap.
5. **Confirm-to-log is committed, not optional** — it is the "stop typing"
   deliverable the plan exists for. One click per steady month, `source:
   'predicted'`, double-log guard.
6. **Supersede = auto-replace within tolerance, prompt on drift** — remove the
   matched `predicted` row and keep the actual; within `max(50 kr, 1 %)` this is
   silent, outside it the triage requires explicit confirmation.
7. **Confidence is explicit** — `exact` (bunden in binding) / `assumed` (rörlig
   held flat) / `unknown` (uncalibrated or no rate); the UI never hides the
   assumption.
8. **Cold start is defined** — < 2 interest rows ⇒ monthly cadence + listed rate
   + `confidence: 'unknown'`; no interest rows *and* no rate period ⇒ `null` (no
   block rendered). The first 2–3 real imports are the calibration set.
9. **No schema change** — `Payment.source = 'predicted'` on the existing string
   field; matching by `loan_part_id + monthKey`, not `flagDuplicates`.

## Build order

- **Phase A — forecast (read-only):** `expectedCharge`/`expectedCharges`/
  `forecastInterest` + the Prognos block. Zero write risk; ships the numbers.
- **Phase B — reconcile badge:** `reconcileCharge` + read-only ✓/⚠ triage chips.
- **Phase C — confirm-to-log + supersede:** the `predicted` row button,
  double-log guard, and the `matchPredictedRows` replace path in `confirmImport`.
  Last because it is the only phase that writes, but **committed** — A/B alone do
  not reduce manual entry.

## Acceptance criteria

- **Unit — new `web/src/lib/mortgage-forecast.test.ts`** (mirrors
  `mortgage-copy.test.ts` style; golden values hand-verified in comments):
  - `expectedCharge`: monthly vs kvartalsvis period detection; charge-day mode
    (incl. month-end clamp: 31st → 30 Apr, 28/29 Feb); `interest = balance ×
    rate/100 × days/365` to the öre; `rate_source: 'derived'` when ≥ 2 clean
    intervals exist and the derived figure is used; listed-rate fallback with
    `confidence: 'unknown'` on thin history; bunden ⇒ `exact`, rörlig ⇒
    `assumed`; null when no interest rows and no rate period; `calibration_gap`
    ≈ 0 on a clean synthetic history and ≈ +0.05 pp on a 360-day-basis history.
  - `forecastInterest`: 12-mo flat case = 12 × one monthly charge; `deduction`
    = `ranteavdrag(total)` including the 100 000 kr / 30→21 % knee; `assumed`
    true iff any rörlig part.
  - `reconcileCharge`: |drift| at exactly 50 kr / exactly 1 % ⇒ `ok`; just past
    either ⇒ flagged.
  - `matchPredictedRows`: pairs on part + month; ignores non-interest drafts and
    non-`predicted` existing rows; a predicted row in a *different* month does
    not match.
  - Round-trip: log the predicted amount ⇒ `partBalanceAsOf` unchanged for an
    interest-only part; subsequent `expectedCharge` is unchanged.
- **UI (against the isolated dev env, [[project_dev_server]]):** seeded parts +
  rate periods + ≥ 3 months of interest history ⇒ Prognos shows per-part figures,
  badges, forward line; confirm-to-log inserts exactly one `predicted`-tagged row
  and the button then disables; importing a matching CSV replaces it silently
  (toast mentions the replacement, payment list shows only the actual); importing
  a drifted CSV (> tolerance) shows the ⚠ chip and requires confirm; import with
  nothing pre-logged still shows ✓/⚠ reconcile chips.
- `npm run build` (the real typecheck), `npm test`, `npm run lint` all green.

## Out of scope

- **Predicting future *rate* moves** (Riksbank path) — rörlig is held flat and
  labelled `assumed`.
- **Auto-log on visit** — considered and rejected in the 2026-07-08 Q&A; rows
  enter the ledger only on an explicit click (or a real import).
- **Auto-importing from the bank** (Open Banking / scraping) — the CSV stays the
  bank connection; this removes only the re-typing.
- **Fixing `flagDuplicates`' dead date-asymmetry**
  ([Bolanekoll.tsx:226](../web/src/routes/Bolanekoll.tsx#L226) blanks candidate
  dates so import dedupe never fires) — real adjacent bug, deserves its own
  small plan; this plan merely routes around it.
- Amortising-schedule modelling beyond the existing trailing-average — interest-
  only is the real case; the flat-balance caveat in `forecastInterest` is
  documented in code.
