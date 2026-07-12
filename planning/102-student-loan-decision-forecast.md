# Plan 102 — Make the Student Loan payoff forecast decision-grade

**Status:** proposed · **Priority:** High · **Effort:** L · **Owner:** Codex ·
**Source:** user review and modelling decisions, 2026-07-12 · **Touches:**
`web/src/lib/studentloan.ts`, `web/src/lib/studentloan.test.ts`,
`web/src/routes/StudentLoan.tsx`, `web/src/components/charts/StudentLoanChart.tsx`,
`web/src/lib/studentloan-store.ts`

## Goal

Answer the user's real question with the lowest expected financial cost as the
objective:

> Under what future income, threshold, interest-rate and GBP/SEK conditions does
> voluntarily repaying this UK Plan 1 loan become better than continuing the
> mandatory payments and preserving the possibility of write-off?

The result must show both understandable scenarios and a probability-based
forecast. It must not present one distant payoff year as certain.

## Decisions locked

- The loan is **UK Plan 1, England/Wales, first advanced on or after 1 September
  2006**, and is eligible for write-off 25 years after the April it first became
  due. It contains no other repayment plan.
- The user lives and earns in Sweden. Income is expected to rise steadily; no
  career break, parental leave, reduced hours or other discontinuity is expected.
- The objective is **lowest expected financial cost**, not the emotional benefit
  of becoming debt-free.
- Payoff money would otherwise remain in **cash savings and investments**. Model
  their expected **after-tax SEK returns** separately, then derive an allocation-
  weighted central return. Do not use an unexplained headline investment return.
- Build **both** deterministic scenarios and a seeded probabilistic simulation.
  Scenarios explain the result; probability analysis describes uncertainty.
- No personal SLC assessment letter or confirmed statutory repayment-due date is
  available. Expose these as unverified assumptions and do not invent precision.
- Model compliant income-assessed overseas repayment. The fixed instalment for
  failing to supply income information is informational only.
- This changes calculation meaning. Before implementation, verify statutory
  constants and mechanics against authoritative GOV.UK/SLC sources, record URLs
  and effective dates beside constants, and obtain owner confirmation of the
  formulas and forecast defaults.

## Problems in the current model

1. Defaults are for 2025–26. From 6 April 2026 Sweden's published Plan 1 figures
   are a £26,900 threshold, 0.076765 GBP per SEK SLC conversion rate and £428
   fixed instalment. Constants need effective dates and history.
2. Salary and threshold grow at the same percentage, largely freezing assessed
   repayments and understating the main uncertainty controlling clearance.
3. One FX value does two jobs: SLC's annual assessment conversion and the user's
   market conversion cost.
4. GBP cash flows are discounted using a Swedish savings/investment return and
   translated at today's flat FX. This currency mismatch can select the wrong
   strategy.
5. Future rates, FX, thresholds and income are treated as known. Waiting has
   option value because the user can pay after uncertainty resolves; paying now
   is irreversible.
6. Whole calendar years are used even though assessment years change on 6 April
   and write-off is tied to a particular April.
7. The `never` verdict calls the difference versus the best future lump payoff
   the amount paying **now** would waste. These are different comparisons.
8. Copy sometimes says the ride strategy reaches write-off when it clears first.
9. Repayment rounding and interest timing are unlabelled approximations, and
   invalid numerical inputs can produce meaningless projections.

## Model contract

### Dates and statutory regime

- Use exact `as_of_date` and `statutory_repayment_due_date`; derive write-off by
  adding 25 years.
- If only the first-due year is known, assume 6 April but label the date as
  unconfirmed from SLC. Do not imply day-level certainty.
- Step monthly, splitting periods when an annual threshold/SLC FX change or the
  exact write-off date falls inside a month.
- Guard the locked post-2006 Plan 1 scope. Do not calculate other plans silently.

### Effective-dated official inputs

- Store effective-dated defaults for Plan 1 interest, Sweden's threshold, SLC's
  GBP-per-SEK rate and the fixed fallback instalment.
- Preserve assessed figures as user overrides and show effective period/source.
- Add a maintenance test that fails once the latest known threshold period has
  expired, making stale defaults visible.
- Apply verified SLC repayment rounding and document remaining approximations.

### Separate economic inputs

Use independent paths for gross SEK income and salary growth; threshold and
threshold growth; annual SLC assessment FX; market GBP/SEK and conversion cost;
Plan 1 interest; and after-tax SEK opportunity return.

For cash and investments, accept allocation and low/central/high after-tax
expected returns. Derive the weighted central return but preserve the component
assumptions for scenarios and uncertainty analysis.

### Currency-consistent cash flows

For each period:

1. Convert gross SEK income to assessed GBP using that assessment year's
   official SLC GBP-per-SEK rate.
2. Derive the mandatory GBP repayment from assessed income and threshold.
3. Convert that payment to expected SEK cost using market FX plus optional
   conversion fee/spread.
4. Discount SEK cash flows using the after-tax SEK opportunity return.

Rank strategies by expected SEK present value. Retain GBP nominal figures for
reconciliation and explanation, not as the primary decision metric.

### Strategies and option value

Compare mandatory payments only; pay in full now; pay at a chosen date; and an
adaptive **wait and reassess** strategy. The adaptive strategy reassesses at
least annually and pays only when updated expected continuation cost exceeds the
settlement balance by a configurable safety margin.

The recommendation should be a trigger, not merely a year. Example: “Continue
mandatory payments; reassess annually. Payoff becomes favourable if expected
remaining repayments exceed settlement by SEK X and write-off probability falls
below Y%.”

Report pay-now versus ride, best fixed-date payoff versus ride, and adaptive
wait/reassess versus both. Never reuse one comparison's savings for another.

## Forecasts

### Deterministic scenarios

Provide three editable scenarios:

| Scenario | Salary | Threshold | Interest | GBP/SEK | Opportunity return |
|---|---|---|---|---|---|
| Lower repayment | lower growth | faster growth | lower | favourable | low case |
| Central | expected steady growth | central | central | central | weighted central |
| Higher repayment | higher growth | slower growth | higher | adverse | high case |

For each show outcome, clearance/write-off date, amount written off, nominal
payments, SEK present-value cost and winning strategy. Show break-even salary
growth, income, interest and GBP/SEK where practical.

### Probability simulation

- Implement a pure deterministic simulation with an injected seeded PRNG.
- Use documented editable distributions/ranges for salary growth, threshold
  growth, interest, market FX and opportunity return. Correlate variables only
  with a documented justification; otherwise label independence an approximation.
- Return probability of natural clearance and write-off, expected amount written
  off, expected SEK PV by strategy, probability each strategy wins, regret from
  paying now, and percentile bands for balance and cumulative payments.
- Use enough seeded trials for stable displayed results, test convergence
  tolerance, and keep recalculation off the render path if profiling requires it.

## UI and wording

- Replace the absolute hero instruction with recommendation, expected SEK
  advantage, probability it wins, and the next reassessment trigger/date.
- Distinguish “known”, “user assumption” and “forecast”. Put the unconfirmed SLC
  date warning next to the verdict.
- Add scenario comparison and probability-range charts. Do not present a range
  as a guaranteed balance path.
- Explain opportunity cost in SEK and model cash/investment allocation without
  suggesting investment returns are risk-free.
- Distinguish “clears naturally” from “written off” and show expected write-off.
- Retain SLC-letter reconciliation for future use, with assessment-period and
  rounding tolerance explanations.
- State that voluntary repayments generally cannot be undone and that compliant
  overseas income reporting is assumed.

## Validation and persistence

- Reject or visibly flag impossible dates, non-positive FX, negative balances,
  non-finite values, growth at or below −100%, implausible rates/returns and
  inconsistent low/central/high ranges. Do not silently clamp financial input.
- Version and defensively migrate the existing persisted blob. Map old FX to the
  market central case only; seed SLC FX from the effective-dated table. Preserve
  balance, income, rate, dates and opportunity rate, marking migrated assumptions
  for review.
- Test malformed, partial and legacy shapes. Saving remains write-through and
  failures remain visible.

## Test plan

Develop model changes test-first. Add:

- Golden 2026–27 Sweden assessment examples, whole-pound rounding and correct
  SLC conversion direction.
- Exact 6 April, rate-effective-date, final-payment, clearance and write-off
  boundaries.
- Currency consistency with changing SLC and market FX.
- Separate salary/threshold growth cases that flip clearance to write-off.
- Savings-only, investments-only and mixed after-tax opportunity-cost cases.
- Proof every displayed saving uses its named comparator.
- A case where adaptive waiting beats pay-now and a fixed future payoff.
- Seed reproducibility, percentile ordering and Monte Carlo convergence.
- Invalid/extreme inputs and persisted-shape migrations.
- Component tests for uncertainty labels, unconfirmed assumptions and
  outcome-dependent verdicts.
- Playwright verification at 390×844 and desktop in light/dark themes using
  fictional data, including scenario editing and probability interpretation.

Before PR, run `npm run lint`, `npm run test` and `npm run build`, then interactive
Playwright verification against the local development server. Leave it running
for owner review.

## Delivery sequence

1. Correct constants, dates, repayment mechanics, comparisons and tests.
2. Separate salary/threshold/SLC-FX/market-FX/opportunity paths and migrate data.
3. Add deterministic scenarios and break-even outputs.
4. Add seeded probability simulation and adaptive wait/reassess strategy.
5. Rework verdict, charts and explanations; complete browser verification.

Do not ship a new recommendation between stages 1–2 without clearly labelling
it transitional; those stages change financial meaning together.

## Acceptance criteria

- Official inputs are effective-dated, sourced and not silently stale.
- Primary ranking is currency-consistent expected SEK present value.
- Salary and threshold have independent paths; SLC and market FX are separate.
- Exact-date write-off is used and unconfirmed personal dates are labelled.
- Every savings statement uses its named comparator.
- The tool shows three scenarios, break-even information and reproducible
  probabilities, including write-off probability and strategy regret.
- The recommendation quantifies the option value of waiting/reassessment.
- Financial, boundary, uncertainty, persistence and visible-wording tests pass,
  along with lint and build.
- Mobile/desktop and light/dark verification is completed locally, with remaining
  modelling limitations reported.

## Deferred

- Other UK plans or mixed-plan allocation rules.
- Automatic personal SLC data import.
- Account-specific tax modelling; the user supplies after-tax expected returns.
- Advice based on debt-free preference; lowest expected cost remains the goal.
