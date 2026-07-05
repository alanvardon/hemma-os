# #2 — Bostadskalkyl editable constants (settings)

## Decisions locked

- **Expose the full set + amort rules:** fastighetsavgift cap · min
  down-payment % (max LTV) · lagfart rate · pantbrev rate · ränteavdrag (two-tier
  rate + threshold) · amortisation-rule rates (>70% LTV, 50–70% LTV, +1% if loan
  > 4.5× gross income).
- **Per-scenario override.** Global defaults seed new scenarios; each scenario
  can freeze/override its own constants.
- **Amort rate auto-fills, but stays overridable.** Add a **household gross
  annual income** input so the 4.5×-income surcharge can apply; the calc computes
  the statutory required amort rate and pre-fills the field with a "Statutory
  min: X%" note, but you can still type your own.

## Current state (everything hardcoded)

[`calc.ts`](../web/src/lib/calc.ts):

- `FASTIGHETSAVGIFT_CAP = 9725` ([:5](../web/src/lib/calc.ts#L5))
- `RANTEAVDRAG_THRESHOLD = 100_000` ([:6](../web/src/lib/calc.ts#L6))
- `lagfart`: `price * 0.015` ([:9](../web/src/lib/calc.ts#L9))
- `pantbrevCost`: `… * 0.02` ([:13](../web/src/lib/calc.ts#L13))
- `ranteavdrag`: 30% up to threshold, 21% above ([:17](../web/src/lib/calc.ts#L17))
- `amortRate` is a **manual input** ([:79](../web/src/lib/calc.ts#L79)); there is
  **no gross-income field** and no statutory-rate derivation.
- `15% min` is a **hardcoded label** in [SummaryColumn.tsx:145](../web/src/components/SummaryColumn.tsx#L145).
- `chartData.ts` and `stressAt()` re-derive figures and must use the same constants.

## Target design

### A `Constants` model

```ts
export interface Constants {
  fastighetsavgiftCap: number     // kr/yr, småhus cap
  minDownPaymentPct: number       // 15  -> max LTV 85
  lagfartRate: number             // 0.015
  pantbrevRate: number            // 0.02
  ranteavdrag: { threshold: number; lowRate: number; highRate: number } // 100_000, 0.30, 0.21
  amort: { highLtvRate: number; midLtvRate: number; incomeSurcharge: number;
           highLtvThreshold: number; midLtvThreshold: number; incomeMultiple: number }
           // 0.02, 0.01, 0.01, 70, 50, 4.5
}

export const DEFAULT_CONSTANTS: Constants = { /* verify 2026 values — see below */ }
```

### `calc.ts` refactor (signature change)

Thread `constants` through the pure functions and `derive()`:

- `lagfart(price, rate)`, `pantbrevCost(loan, existing, rate)`,
  `ranteavdrag(annual, { threshold, lowRate, highRate })`,
  `fastighetsavgiftCap(tax, cap)`.
- `derive(inputs, constants)` and `stressAt(inputs, rate, constants)`.
- New `requiredAmortRate(ltv, loanAmount, grossAnnualIncome, constants)` →
  base (2% / 1% / 0% by LTV band) + `incomeSurcharge` if
  `loanAmount > incomeMultiple * grossAnnualIncome`. Returns a %.
- Update **every caller**: [chartData.ts](../web/src/components/charts/chartData.ts),
  [`Bostadskalkyl.tsx`](../web/src/routes/Bostadskalkyl.tsx) `useMemo(() => derive(inputs))`,
  charts that call `stressAt`. (This refactor is the bulk of the work — a
  mechanical but wide sweep; the golden test will catch regressions.)

### Inputs model change

- Add `grossAnnualIncome: number` to `Inputs` (+ `DEFAULT_INPUTS`).
- `InputsColumn` amort field: pre-fill from `requiredAmortRate(...)`, overridable;
  render the "Statutory min: X%" hint. Add the gross-income field near the
  affordability section.
- `15% min` label → driven by `constants.minDownPaymentPct`.

### Data model (rides on #3)

- Add **optional** `constants?: Constants` to `Scenario`. Absent ⇒ fall back to
  the global defaults (back-compat for old scenarios — no destructive migration).
- New localStorage key `bostadskalkyl_constants_v1` for the **global defaults**
  (one object, with the same async Promise API as the rest of `storage.ts`).
- `derive()` for a scenario uses `scenario.constants ?? globalDefaults`.

### UI

- A **"Calculation settings" modal** (`AnimatedDialog`, matching the existing
  modals) with grouped, labelled fields and a **Reset to defaults** button.
- **Global defaults:** opened from the scenarios dashboard (#3) via a gear icon —
  edits seed new scenarios.
- **Per-scenario:** opened from the calculator header (gear) — pre-seeded from the
  scenario's constants (or global default). Show a small **"modified"** chip on
  values that differ from the global default.
- Same component, parameterised by source (global vs scenario) + save target.

## Edge cases

- **Old scenarios** (no `constants`) → use global defaults; nothing to migrate.
- **Validation:** rates 0–100%, caps ≥ 0; block NaN. Affordability divide-by-zero
  already guarded ([calc.ts:177](../web/src/lib/calc.ts#L177)).
- **4.5× rule with no income** (blank/0): skip the +1% surcharge and note that the
  income-based step isn't applied.
- Keep `derive()` **pure** — constants in, figures out; no module-level state.

## ⚠️ Verify 2026 statutory values during implementation

Per your global Context7 rule, confirm current figures before hardcoding the
defaults (these drift yearly / by reform):

- **Fastighetsavgift** småhus cap (the 9 725 kr is income year 2025).
- **Lagfart** 1.5% and **pantbrev** 2% (stable, but confirm).
- **Ränteavdrag** 30% / 21% over 100 000 kr.
- **Amorteringskrav** bands (2% > 70% LTV, 1% 50–70%, +1% > 4.5× gross income).

## Testing

- `calc.test.ts`: `derive` with custom constants; `requiredAmortRate` across LTV
  bands + the income surcharge boundary; two-tier ränteavdrag with a custom
  threshold; fastighetsavgift cap. Update the golden `DEFAULT_INPUTS` test to pass
  `DEFAULT_CONSTANTS`.

## Effort

**Medium** — the `calc.ts` signature refactor fans out to charts + tests; new
modal; new income input. Mechanical but wide.

## Sequencing

Build **after #3** (constants live inside the `Scenario` record). Could ship
global-only first with a TODO for per-scenario, but cleanest once #3 lands.
