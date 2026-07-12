// UK Plan 1 (Post-2006, England/Wales) student-loan payoff engine.
//
// Pure + deterministic: no React/Zustand/Supabase/browser imports. The UI layer
// (route `/student-loan`) and the persistence store consume the types and
// functions exported here.
//
// ── Verified statutory constants (record source + effective year next to each) ──
//
// PLAN 1 INTEREST RATE — lower of RPI or (BoE base rate + 1%). For the period
//   1 Sep 2025 – 31 Aug 2026, RPI = 3.2% and base+1% = 5.0%, so the applied
//   Plan 1 rate is 3.2%. Source: GOV.UK "Student Loans interest rates and
//   repayment threshold announcement" + House of Commons Library CBP-10654.
//   https://www.gov.uk/government/news/student-loans-interest-rates-and-repayment-threshold-announcement--6
export const PLAN1_INTEREST_RATE_PCT = 3.2 // effective 2025-26 (1 Sep 2025 – 31 Aug 2026)
//
// REPAYMENT RATE — 9% of income above the applicable threshold. Source: GOV.UK
//   "Repaying your student loan" (Plan 1). Effective for 2025-26.
export const PLAN1_REPAYMENT_RATE = 0.09
//
// WRITE-OFF — Plan 1 loans first advanced on/after 1 Sep 2006 are written off
//   25 years after the April the borrower was first due to repay (the April
//   after the course ends). No age-65 path (that is pre-2006 only). Source:
//   GOV.UK "When your student loan gets written off or cancelled".
//   https://www.gov.uk/repaying-your-student-loan/when-your-student-loan-gets-written-off-or-cancelled
export const PLAN1_WRITEOFF_YEARS = 25
//
// SWEDEN OVERSEAS THRESHOLD — Plan 1 overseas earnings threshold for Sweden is
//   £26,065 for 2025-26 (April 2025 – March 2026). The £404/month figure on the
//   same table is the *fixed instalment* charged only when the borrower does NOT
//   supply income info; the income-assessed path (this model) uses the 9%×excess
//   rule. Source: GOV.UK "Overseas earnings thresholds for Plan 1 student loans".
//   https://www.gov.uk/government/publications/overseas-earnings-thresholds-for-plan-1-student-loans
//   NOTE: this is a sensible DEFAULT — the user must verify the exact figure on
//   their own SLC overseas income-assessment letter, which can differ by year.
export const SWEDEN_OVERSEAS_THRESHOLD_GBP = 26_065 // default 2025-26; verify from SLC letter
//
// Sweden fixed-instalment fallback (£/month) — informational only, not used in
// the projection. See threshold note above. Effective 2025-26.
export const SWEDEN_FIXED_MONTHLY_GBP = 404

// ── Inputs (this interface IS the persisted settings blob; snake_case) ──
export interface StudentLoanInputs {
  balance_gbp: number
  interest_rate: number // annual base rate, % (e.g. 3.2)
  rate_stress: number // added to the base rate, % (stress slider)
  first_due_year: number // the year of the April first due to repay; write-off = +25
  current_year: number // "today" reference — the projection starts here
  income_sek: number // gross annual income as assessed, SEK
  fx_sek_per_gbp: number // SEK per 1 GBP (flat for the projection)
  salary_growth_pct: number // annual salary growth, %
  se_threshold_gbp: number // Sweden overseas threshold, GBP
  hold_threshold_flat: boolean // pessimistic toggle: threshold does NOT grow with salary
  opportunity_rate_pct: number // PV discount rate — what a lump sum earns instead, %
  slc_monthly_gbp?: number // optional: fixed monthly from the SLC letter (sanity check only)
}

export type LoanOutcome = 'cleared' | 'written_off'
export type Recommendation = 'never' | 'pay_now' | 'pay_at'

export interface BalancePoint {
  month_index: number // months from current_year (0 = now)
  year: number // calendar year of this point
  balance_gbp: number
  balance_sek: number
}

export interface StrategyResult {
  nominal_gbp: number
  pv_gbp: number
  nominal_sek: number
  pv_sek: number
  payoff_month_index: number | null // null = no lump (ride it out)
  payoff_year: number | null
}

export interface StudentLoanResult {
  writeoff_year: number
  income_gbp: number
  monthly_repayment_gbp: number // first-year mandated monthly (compare against slc_monthly_gbp)
  slc_monthly_gbp: number | null
  fx_sek_per_gbp: number

  outcome: LoanOutcome // outcome of the ride-it-out path
  cleared_month_index: number | null // month the ride path clears (null if written off)
  balance_series: BalancePoint[] // ride-it-out balance path (yearly snapshots) for the chart

  ride_it_out: StrategyResult
  pay_off_now: StrategyResult
  pay_off_at_optimal: StrategyResult // the best lump-payoff date found by the solver

  recommendation: Recommendation // PV-based verdict (the real one)
  optimal_month_index: number | null // null when recommendation === 'never'
  optimal_year: number | null
  savings_gbp: number // PV saved by following the recommendation vs the headline alternative
  savings_sek: number
  nominal_winner: Recommendation // what a naive nominal comparison would pick (for the PV-vs-nominal insight)
}

export function defaultStudentLoanInputs(): StudentLoanInputs {
  return {
    balance_gbp: 20_000,
    interest_rate: PLAN1_INTEREST_RATE_PCT,
    rate_stress: 0,
    first_due_year: 2015,
    current_year: 2026,
    income_sek: 600_000,
    fx_sek_per_gbp: 13,
    salary_growth_pct: 2,
    se_threshold_gbp: SWEDEN_OVERSEAS_THRESHOLD_GBP,
    hold_threshold_flat: false,
    opportunity_rate_pct: 4,
    slc_monthly_gbp: undefined,
  }
}

export function deriveWriteoffYear(first_due_year: number): number {
  return first_due_year + PLAN1_WRITEOFF_YEARS
}

export function incomeGbp(income_sek: number, fx_sek_per_gbp: number): number {
  return fx_sek_per_gbp > 0 ? income_sek / fx_sek_per_gbp : 0
}

interface SimResult {
  nominal: number
  pv: number
  outcome: LoanOutcome
  cleared_month: number | null
  series: BalancePoint[]
}

/**
 * Simulate one strategy on the loan, month by month.
 * @param lumpMonth  month index at which the whole outstanding balance is paid
 *                   off. `null` = never (ride it out), `0` = pay off now.
 */
export function simulateStrategy(
  input: StudentLoanInputs,
  lumpMonth: number | null,
  collectSeries = false,
): SimResult {
  const d = input
  const writeoffYear = deriveWriteoffYear(d.first_due_year)
  const totalMonths = Math.max(0, (writeoffYear - d.current_year) * 12)
  const fx = d.fx_sek_per_gbp
  const income = incomeGbp(d.income_sek, fx)
  const g = d.salary_growth_pct / 100
  const monthlyRate = (d.interest_rate + d.rate_stress) / 100 / 12
  const oppMonthly = d.opportunity_rate_pct / 100 / 12
  const disc = (k: number) => (oppMonthly === 0 ? 1 : 1 / Math.pow(1 + oppMonthly, k))

  const mandatedMonthly = (year: number): number => {
    const grow = Math.pow(1 + g, year)
    const incomeY = income * grow
    const threshY = d.hold_threshold_flat ? d.se_threshold_gbp : d.se_threshold_gbp * grow
    return (PLAN1_REPAYMENT_RATE * Math.max(0, incomeY - threshY)) / 12
  }

  let balance = Math.max(0, d.balance_gbp)
  let nominal = 0
  let pv = 0
  let outcome: LoanOutcome = 'written_off'
  let clearedMonth: number | null = null
  const series: BalancePoint[] = []

  for (let m = 0; m < totalMonths; m++) {
    const year = Math.floor(m / 12)
    if (collectSeries && m % 12 === 0) {
      series.push({ month_index: m, year: d.current_year + year, balance_gbp: balance, balance_sek: balance * fx })
    }
    if (lumpMonth !== null && m === lumpMonth) {
      nominal += balance
      pv += balance * disc(m)
      clearedMonth = m
      outcome = 'cleared'
      balance = 0
      break
    }
    balance *= 1 + monthlyRate
    const pay = Math.min(mandatedMonthly(year), balance)
    balance -= pay
    nominal += pay
    pv += pay * disc(m + 1)
    if (balance <= 1e-9) {
      balance = 0
      outcome = 'cleared'
      clearedMonth = m
      break
    }
  }

  if (collectSeries) {
    const endMonth = clearedMonth ?? totalMonths
    series.push({
      month_index: endMonth,
      year: d.current_year + Math.floor(endMonth / 12),
      balance_gbp: balance,
      balance_sek: balance * fx,
    })
  }

  return { nominal, pv, outcome, cleared_month: clearedMonth, series }
}

export function computeStudentLoan(input?: Partial<StudentLoanInputs>): StudentLoanResult {
  const d: StudentLoanInputs = { ...defaultStudentLoanInputs(), ...input }
  const fx = d.fx_sek_per_gbp
  const writeoffYear = deriveWriteoffYear(d.first_due_year)
  const totalMonths = Math.max(0, (writeoffYear - d.current_year) * 12)
  const income = incomeGbp(d.income_sek, fx)

  // First-year mandated monthly, for the SLC sanity-check readout.
  const firstThresh = d.se_threshold_gbp
  const monthlyRepayment = (PLAN1_REPAYMENT_RATE * Math.max(0, income - firstThresh)) / 12

  const toStrategy = (sim: SimResult, month: number | null): StrategyResult => ({
    nominal_gbp: sim.nominal,
    pv_gbp: sim.pv,
    nominal_sek: sim.nominal * fx,
    pv_sek: sim.pv * fx,
    payoff_month_index: month,
    payoff_year: month === null ? null : d.current_year + Math.floor(month / 12),
  })

  const ride = simulateStrategy(d, null, true)
  const rideStrategy = toStrategy(ride, null)

  // Solver: scan every candidate lump-payoff month while a balance still exists.
  const maxLumpMonth = ride.cleared_month ?? totalMonths - 1
  let bestLumpMonth: number | null = null
  let bestLumpSim: SimResult | null = null
  let bestNominalMonth: number | null = null
  let bestNominalSim: SimResult | null = null

  for (let m = 0; m <= maxLumpMonth && totalMonths > 0; m++) {
    const sim = simulateStrategy(d, m)
    if (bestLumpSim === null || sim.pv < bestLumpSim.pv - 1e-9) {
      bestLumpSim = sim
      bestLumpMonth = m
    }
    if (bestNominalSim === null || sim.nominal < bestNominalSim.nominal - 1e-9) {
      bestNominalSim = sim
      bestNominalMonth = m
    }
  }

  const payNowSim = totalMonths > 0 ? simulateStrategy(d, 0) : ride
  const payNow = toStrategy(payNowSim, totalMonths > 0 ? 0 : null)
  const payOptimal = bestLumpSim ? toStrategy(bestLumpSim, bestLumpMonth) : rideStrategy

  // PV verdict: ride vs the best lump.
  let recommendation: Recommendation
  let optimalMonth: number | null
  let savings: number
  if (bestLumpSim === null || ride.pv <= bestLumpSim.pv + 1e-9) {
    recommendation = 'never'
    optimalMonth = null
    savings = bestLumpSim ? bestLumpSim.pv - ride.pv : 0 // PV you'd waste by paying off
  } else {
    recommendation = bestLumpMonth === 0 ? 'pay_now' : 'pay_at'
    optimalMonth = bestLumpMonth
    savings = ride.pv - bestLumpSim.pv // PV saved by paying off vs riding
  }

  // Nominal verdict (naive) — for surfacing the PV-vs-nominal disagreement.
  let nominalWinner: Recommendation
  if (bestNominalSim === null || ride.nominal <= bestNominalSim.nominal + 1e-9) {
    nominalWinner = 'never'
  } else {
    nominalWinner = bestNominalMonth === 0 ? 'pay_now' : 'pay_at'
  }

  return {
    writeoff_year: writeoffYear,
    income_gbp: income,
    monthly_repayment_gbp: monthlyRepayment,
    slc_monthly_gbp: d.slc_monthly_gbp ?? null,
    fx_sek_per_gbp: fx,

    outcome: ride.outcome,
    cleared_month_index: ride.cleared_month,
    balance_series: ride.series,

    ride_it_out: rideStrategy,
    pay_off_now: payNow,
    pay_off_at_optimal: payOptimal,

    recommendation,
    optimal_month_index: optimalMonth,
    optimal_year: optimalMonth === null ? null : d.current_year + Math.floor(optimalMonth / 12),
    savings_gbp: Math.max(0, savings),
    savings_sek: Math.max(0, savings) * fx,
    nominal_winner: nominalWinner,
  }
}
