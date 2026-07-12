import { describe, it, expect } from 'vitest'
import {
  computeStudentLoan,
  deriveWriteoffYear,
  incomeGbp,
  defaultStudentLoanInputs,
  type StudentLoanInputs,
} from './studentloan'

// Golden values are hand-derived from the model in studentloan.ts:
//   mandated monthly = 0.09 * max(0, income_gbp - threshold) / 12,
//   balance accrues (interest+stress)/12 per month, less repayments,
//   discounted to PV at opportunity_rate/12 per month.
// Cases use round numbers (fx = 1, zero interest where possible) so the
// arithmetic is checkable by hand.

const base: StudentLoanInputs = {
  balance_gbp: 10_000,
  interest_rate: 0,
  rate_stress: 0,
  first_due_year: 2020, // writeoff 2045
  current_year: 2026, // 19 years / 228 months of runway
  income_sek: 40_000,
  fx_sek_per_gbp: 1, // income_gbp = 40_000
  salary_growth_pct: 0,
  se_threshold_gbp: 30_000,
  hold_threshold_flat: true,
  opportunity_rate_pct: 0,
  slc_monthly_gbp: undefined,
}

describe('derivations', () => {
  it('write-off is first-due + 25 years', () => {
    expect(deriveWriteoffYear(2020)).toBe(2045)
    expect(deriveWriteoffYear(2015)).toBe(2040)
  })

  it('income_gbp = income_sek / fx, guarded against fx <= 0', () => {
    expect(incomeGbp(520_000, 13)).toBeCloseTo(40_000, 9)
    expect(incomeGbp(520_000, 0)).toBe(0)
  })

  it('defaults use the verified Plan 1 rate and Sweden threshold', () => {
    const d = defaultStudentLoanInputs()
    expect(d.interest_rate).toBe(3.2)
    expect(d.se_threshold_gbp).toBe(26_065)
  })
})

describe('golden projection — zero-interest clean clear', () => {
  const r = computeStudentLoan(base)

  it('headline derivations', () => {
    expect(r.writeoff_year).toBe(2045)
    expect(r.income_gbp).toBeCloseTo(40_000, 9)
    // 0.09 * (40000 - 30000) / 12 = 900/12 = 75
    expect(r.monthly_repayment_gbp).toBeCloseTo(75, 9)
  })

  it('clears exactly on schedule with no interest', () => {
    // 133 payments of 75 = 9975, month 133 pays the final 25.
    expect(r.outcome).toBe('cleared')
    expect(r.cleared_month_index).toBe(133)
    // no interest -> total repaid equals the original balance
    expect(r.ride_it_out.nominal_gbp).toBeCloseTo(10_000, 6)
    // opportunity_rate = 0 -> PV equals nominal
    expect(r.ride_it_out.pv_gbp).toBeCloseTo(10_000, 6)
  })

  it('pay-off-now is the balance today, at PV', () => {
    expect(r.pay_off_now.nominal_gbp).toBeCloseTo(10_000, 9)
    expect(r.pay_off_now.pv_gbp).toBeCloseTo(10_000, 9)
    expect(r.pay_off_now.payoff_month_index).toBe(0)
  })

  it('ties resolve to "never" (no reason to lump)', () => {
    expect(r.recommendation).toBe('never')
    expect(r.optimal_month_index).toBeNull()
    expect(r.savings_gbp).toBeCloseTo(0, 6)
  })

  it('balance series is yearly and never negative, ending at zero', () => {
    for (const p of r.balance_series) expect(p.balance_gbp).toBeGreaterThanOrEqual(0)
    expect(r.balance_series[0].balance_gbp).toBeCloseTo(10_000, 6)
    expect(r.balance_series.at(-1)!.balance_gbp).toBeCloseTo(0, 6)
  })
})

describe('rounding boundary — clears on an exact month', () => {
  const r = computeStudentLoan({ ...base, balance_gbp: 9_000 })
  it('120 payments of 75 clear 9000 exactly at month 119', () => {
    expect(r.cleared_month_index).toBe(119)
    expect(r.outcome).toBe('cleared')
    expect(r.ride_it_out.nominal_gbp).toBeCloseTo(9_000, 6)
  })
})

describe('edge — never clears, written off', () => {
  it('income below threshold forever => no repayments, forgiven at write-off', () => {
    const r = computeStudentLoan({
      ...base,
      interest_rate: 3.2,
      income_sek: 20_000, // below the 26,065 threshold
      se_threshold_gbp: 26_065,
      opportunity_rate_pct: 0,
    })
    expect(r.outcome).toBe('written_off')
    expect(r.cleared_month_index).toBeNull()
    expect(r.ride_it_out.nominal_gbp).toBeCloseTo(0, 6)
    expect(r.recommendation).toBe('never')
    // with opportunity 0 the cheapest lump is paying the balance now = 10,000,
    // which riding avoids entirely.
    expect(r.savings_gbp).toBeCloseTo(10_000, 4)
  })

  it('extreme stress pushes the rate high enough to never clear', () => {
    const r = computeStudentLoan({
      ...base,
      interest_rate: 3.2,
      rate_stress: 20, // 23.2% effective
      income_sek: 30_000,
      se_threshold_gbp: 26_065,
    })
    expect(r.outcome).toBe('written_off')
    expect(r.recommendation).toBe('never')
  })

  it('zero income => written off', () => {
    const r = computeStudentLoan({ ...base, income_sek: 0, interest_rate: 3.2 })
    expect(r.outcome).toBe('written_off')
    expect(r.recommendation).toBe('never')
  })
})

describe('PV vs nominal disagree — the reason discounting exists', () => {
  // Loan DOES clear (so ride pays principal + interest, nominal > balance), but
  // a high opportunity rate makes the discounted stream cheaper than clearing now.
  const r = computeStudentLoan({
    ...base,
    interest_rate: 3,
    income_sek: 40_000,
    se_threshold_gbp: 26_000,
    opportunity_rate_pct: 15,
  })

  it('clears, so ride nominal exceeds the balance', () => {
    expect(r.outcome).toBe('cleared')
    expect(r.ride_it_out.nominal_gbp).toBeGreaterThan(10_000)
    expect(r.pay_off_now.nominal_gbp).toBeCloseTo(10_000, 6)
  })

  it('nominal picks pay-now, PV picks riding — they disagree', () => {
    expect(r.nominal_winner).toBe('pay_now')
    expect(r.recommendation).not.toBe('pay_now')
    // discounting flips it: riding is cheaper in present value than clearing now
    expect(r.ride_it_out.pv_gbp).toBeLessThan(r.pay_off_now.pv_gbp)
  })
})

describe('dual currency', () => {
  it('SEK figures are GBP * fx', () => {
    const r = computeStudentLoan({ ...base, income_sek: 520_000, fx_sek_per_gbp: 13 })
    expect(r.income_gbp).toBeCloseTo(40_000, 6)
    expect(r.fx_sek_per_gbp).toBe(13)
    expect(r.ride_it_out.nominal_sek).toBeCloseTo(r.ride_it_out.nominal_gbp * 13, 4)
    for (const p of r.balance_series) expect(p.balance_sek).toBeCloseTo(p.balance_gbp * 13, 6)
  })
})
