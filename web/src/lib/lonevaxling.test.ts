import { describe, it, expect } from 'vitest'
import {
  computeLonevaxling,
  defaultInputs,
  PENSION_CEILING_YR,
  SGI_CEILING_YR,
  DEFAULT_UPLIFT,
} from './lonevaxling'

// Golden values are hand-derived from the 2026 IBB/PBB constants + the
// formula in lonevaxling.ts (gross/after-sacrifice net via swedish-tax's
// grundavdrag/jobbskatteavdrag), cross-checked with an independent
// re-implementation run outside the repo.
describe('constants', () => {
  it('pension and SGI ceilings, default uplift', () => {
    expect(PENSION_CEILING_YR).toBeCloseTo(673_038, 6) // 8.07 * 83,400 IBB
    expect(SGI_CEILING_YR).toBeCloseTo(592_000, 6) // 10 * 59,200 PBB
    expect(DEFAULT_UPLIFT).toBeCloseTo(5.762111701271544, 10)
  })
})

describe('computeLonevaxling: defaults (eligible, above pension ceiling)', () => {
  const r = computeLonevaxling()

  it('sacrifice and cash-after', () => {
    expect(r.grossSalary).toBe(780_000)
    expect(r.sacrifice).toBe(60_000)
    expect(r.cashAfter).toBe(720_000)
  })

  it('tax saved now, marginal rate', () => {
    expect(r.netGivenUp).toBeCloseTo(28_572, 2)
    expect(r.taxSavedNow).toBeCloseTo(31_428, 2)
    expect(r.marginalRateNow).toBeCloseTo(0.5238, 4)
  })

  it('pension side: uplift, withdrawal tax, leverage', () => {
    expect(r.premiumToPension).toBeCloseTo(63_456, 2)
    expect(r.upliftAmount).toBeCloseTo(3_456, 2)
    expect(r.netPensionValue).toBeCloseTo(43_150.08, 2)
    expect(r.netBenefit).toBeCloseTo(14_578.08, 2)
    expect(r.leverage).toBeCloseTo(1.510222595548089, 8)
  })

  it('eligibility flags: all clear', () => {
    expect(r.eligible).toBe(true)
    expect(r.ceilingMonthly).toBeCloseTo(56_086.5, 4)
    expect(r.sgiCeilingMonthly).toBeCloseTo(49_333.333333, 4)
    expect(r.maxSafeSacrifice).toBeCloseTo(8_913.5, 4)
    expect(r.flags).toEqual({
      notEligible: false,
      overSacrificed: false,
      belowSgi: false,
      belowBrytpunkt: false,
      withdrawalNotBelowMarginal: false,
    })
  })
})

describe('computeLonevaxling: edge cases', () => {
  it('gross below the pension ceiling -> not eligible, sacrifice not recommended', () => {
    const r = computeLonevaxling({ grossSalaryMonthly: 40_000, sacrificeMonthly: 3_000 })
    expect(r.eligible).toBe(false)
    expect(r.maxSafeSacrifice).toBe(0)
    expect(r.suggestedSacrifice).toBe(0)
    expect(r.flags.notEligible).toBe(true)
    expect(r.flags.belowSgi).toBe(true)
    expect(r.flags.belowBrytpunkt).toBe(true)
    expect(r.netBenefit).toBeCloseTo(-1_242.661991333538, 6) // sacrificing here is a net loss
  })

  it('zero sacrifice: everything collapses to zero, no divide-by-zero', () => {
    const r = computeLonevaxling({ sacrificeMonthly: 0 })
    expect(r.sacrifice).toBe(0)
    expect(r.netGivenUp).toBe(0)
    expect(r.marginalRateNow).toBe(0)
    expect(r.leverage).toBe(0)
    expect(r.netBenefit).toBe(0)
    expect(r.flags.overSacrificed).toBe(false)
    expect(r.flags.belowSgi).toBe(false)
  })

  it('over-sacrificing past the pension ceiling trips overSacrificed', () => {
    const r = computeLonevaxling({ grossSalaryMonthly: 60_000, sacrificeMonthly: 10_000 })
    expect(r.cashAfter).toBe(600_000) // 600,000/12 = 50,000/mo < 56,086.5 ceiling
    expect(r.flags.overSacrificed).toBe(true)
    expect(r.flags.belowBrytpunkt).toBe(true)
    expect(r.maxSafeSacrifice).toBeCloseTo(3_913.5, 4)
  })
})

describe('defaultInputs', () => {
  it('encodes the verified 2026 defaults', () => {
    const d = defaultInputs()
    expect(d.upliftPct).toBe(5.76)
    expect(d.withdrawalTaxPct).toBe(32)
  })
})
