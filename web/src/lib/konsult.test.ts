import { describe, it, expect } from 'vitest'
import { computeContracting, defaultInputs } from './konsult'

// Golden values below are hand-derived from the 2026 constants + the formula
// in konsult.ts (revenue -> salary split -> corp tax -> dividend, and
// cashSalary run through swedish-tax's grundavdrag/jobbskatteavdrag), then
// cross-checked with an independent re-implementation run outside the repo.
// A regression here produces confidently wrong kronor, so treat any diff as
// a bug in the code, not the test.
describe('computeContracting: defaults', () => {
  const r = computeContracting()

  it('billable time and revenue', () => {
    // 52 - 6 holiday - 6 sick = 40 billable weeks * 40h * 1000kr
    expect(r.billableWeeks).toBe(40)
    expect(r.billableHours).toBe(1600)
    expect(r.revenue).toBe(1_600_000)
  })

  it('salary split (gross 744,000, lönevaxling 99,996)', () => {
    expect(r.grossSalary).toBe(744_000)
    expect(r.lonevaxling).toBe(99_996)
    expect(r.cashSalary).toBe(644_004)
    expect(r.employerFee).toBeCloseTo(202_346.0568, 4)
    expect(r.sarskildLoneskatt).toBeCloseTo(24_259.0296, 4)
  })

  it('corporate tax and dividend, capped at the 322,400 allowance', () => {
    expect(r.profitBeforeTax).toBeCloseTo(569_394.9136, 4)
    expect(r.corporateTax).toBeCloseTo(117_295.3522016, 6)
    expect(r.profitAfterTax).toBeCloseTo(452_099.5613984, 6)
    expect(r.dividend).toBe(322_400) // profitAfterTax exceeds the allowance
    expect(r.dividendTax).toBe(64_480)
    expect(r.netDividend).toBe(257_920)
    expect(r.retainedProfit).toBeCloseTo(129_699.5613984, 6)
  })

  it('personal income tax on cash salary (644,004 -> flat grundavdrag zone)', () => {
    expect(r.grundavdrag).toBe(17_400) // income > 7.88*PBB -> flat 0.293*PBB
    expect(r.taxableIncome).toBe(626_604)
    expect(r.municipalTax).toBeCloseTo(202_894.3752, 4)
    expect(r.stateTax).toBe(0) // taxableIncome stays under the 643,000 skiktgräns
    expect(r.workTaxCredit).toBeCloseTo(52_390.32192, 4)
    expect(r.netSalary).toBeCloseTo(493_499.94672, 4)
  })

  it('totals', () => {
    expect(r.totalNetIncome).toBeCloseTo(751_419.94672, 4)
    expect(r.totalTax).toBeCloseTo(558_884.4918816, 6)
    expect(r.takeHomeRate).toBeCloseTo(0.4696374667, 8)
    expect(r.effectiveTaxRate).toBeCloseTo(0.349302807426, 8)
  })
})

describe('computeContracting: edge cases', () => {
  it('zero billable hours: no revenue but salary/tax cost still runs', () => {
    const r = computeContracting({ holidayWeeks: 26, sickWeeks: 26 })
    expect(r.billableWeeks).toBe(0)
    expect(r.revenue).toBe(0)
    expect(r.profitBeforeTax).toBeCloseTo(-1_030_605.0864, 4)
    expect(r.corporateTax).toBe(0) // Math.max(0, ...) floors negative profit
    expect(r.dividend).toBe(0)
    expect(r.takeHomeRate).toBe(0) // guarded: revenue is 0
    expect(r.effectiveTaxRate).toBe(0)
  })

  it('dividend above the allowance is capped, excess stays retained', () => {
    const r = computeContracting({ rate: 3000 })
    expect(r.profitAfterTax).toBeCloseTo(2_992_899.5613984, 4)
    expect(r.dividend).toBe(322_400)
    expect(r.retainedProfit).toBeCloseTo(2_670_499.5613984, 4)
  })

  it('dividend below the allowance passes through profitAfterTax uncapped', () => {
    const r = computeContracting({ rate: 700 })
    expect(r.profitAfterTax).toBeCloseTo(70_979.5613984, 3)
    expect(r.dividend).toBeCloseTo(70_979.5613984, 3) // under 322,400 -> not capped
    expect(r.retainedProfit).toBeCloseTo(0, 6)
  })
})

describe('defaultInputs', () => {
  it('encodes the verified 2026 constants', () => {
    const d = defaultInputs()
    expect(d.dividendAllowance).toBe(322_400)
    expect(d.employerFeePct).toBe(31.42)
    expect(d.sarskildLoneskattPct).toBe(24.26)
  })
})
