import { describe, it, expect } from 'vitest'
import {
  lagfart,
  pantbrevCost,
  ranteavdrag,
  fastighetsavgiftCap,
  equityPct,
  requiredAmortRate,
  derive,
  DEFAULT_INPUTS,
  DEFAULT_CONSTANTS,
  mortgageComparisonDeltas,
  mortgageComparisonLeg,
} from './calc'

// ── Ported from the vanilla calc.test.js ────────────────────────────
describe('pure functions', () => {
  it('lagfart: 2 000 000 kr property', () => expect(lagfart(2_000_000)).toBe(30_000))
  it('lagfart: zero property price', () => expect(lagfart(0)).toBe(0))
  it('pantbrevCost: loan exceeds existing pantbrev', () =>
    expect(pantbrevCost(1_500_000, 1_000_000)).toBe(10_000))
  it('pantbrevCost: loan within existing pantbrev', () =>
    expect(pantbrevCost(800_000, 1_000_000)).toBe(0))
  it('ranteavdrag: below threshold (80 000)', () => expect(ranteavdrag(80_000)).toBe(24_000))
  it('ranteavdrag: at threshold (100 000)', () => expect(ranteavdrag(100_000)).toBe(30_000))
  it('ranteavdrag: above threshold (150 000)', () => expect(ranteavdrag(150_000)).toBe(40_500))
  it('equityPct: standard case', () => expect(equityPct(1_500_000, 2_000_000)).toBe(75))
  it('equityPct: zero price returns 0', () => expect(equityPct(0, 0)).toBe(0))
  it('fastighetsavgiftCap: above cap (10 425, income year 2026)', () => expect(fastighetsavgiftCap(12_000)).toBe(10_425))
  it('fastighetsavgiftCap: below cap', () => expect(fastighetsavgiftCap(6_000)).toBe(6_000))
})

describe('mortgage-only comparison contract', () => {
  it('GOLDEN: all legs share monthly interest, gross, relief and effective definitions', () => {
    const current = mortgageComparisonLeg(2_400_000, 3.75, 4_000)
    const bankA = mortgageComparisonLeg(3_000_000, 3.5, 5_000)
    const bankB = mortgageComparisonLeg(3_000_000, 3.9, 5_000)

    expect(current).toEqual({ balance: 2_400_000, rate: 3.75, interest: 7_500, amortization: 4_000, gross: 11_500, relief: 2_250, effective: 9_250 })
    expect(bankA).toEqual({ balance: 3_000_000, rate: 3.5, interest: 8_750, amortization: 5_000, gross: 13_750, relief: 2_587.5, effective: 11_162.5 })
    expect(bankB).toEqual({ balance: 3_000_000, rate: 3.9, interest: 9_750, amortization: 5_000, gross: 14_750, relief: 2_797.5, effective: 11_952.5 })

    expect(mortgageComparisonDeltas(current, bankA, bankB)).toEqual({
      currentVsA: { amount: -2_250, cheaper: 'current' },
      currentVsB: { amount: -3_250, cheaper: 'current' },
      aVsB: { amount: -1_000, cheaper: 'a' },
    })
  })

  it('uses the configured annual relief brackets and keeps rounding boundaries deterministic', () => {
    const cfg = { thresholdKr: 1_000, lowPct: 30, highPct: 20 }
    const leg = mortgageComparisonLeg(100_005, 3.333, 123.456, cfg)
    expect(leg).toMatchObject({ balance: 100_005, rate: 3.333, amortization: 123.456 })
    expect(leg.interest).toBeCloseTo(277.7638875, 8)
    expect(leg.gross).toBeCloseTo(401.2198875, 8)
    expect(leg.relief).toBeCloseTo(63.88611083, 8)
    expect(leg.effective).toBeCloseTo(337.33377667, 8)
    // Formatting rounds only at the display boundary; domain precision remains.
    expect(Math.round(leg.interest)).toBe(278)
    expect(Math.round(leg.effective)).toBe(337)
  })

  it('proposed property tax and drift affect full totals but never mortgage-only figures', () => {
    const base = derive({ ...DEFAULT_INPUTS, propertyTax: 0, driftkostnad: 0 })
    const withPropertyCosts = derive({ ...DEFAULT_INPUTS, propertyTax: 12_000, driftkostnad: 4_000 })

    expect(withPropertyCosts.bankA.mortgage).toEqual(base.bankA.mortgage)
    expect(withPropertyCosts.bankB.mortgage).toEqual(base.bankB.mortgage)
    expect(withPropertyCosts.bankA.total - base.bankA.total).toBe(5_000)
    expect(withPropertyCosts.bankB.total - base.bankB.total).toBe(5_000)
  })
})

// ── requiredAmortRate (amorteringskrav) ─────────────────────────────
describe('requiredAmortRate', () => {
  it('above 70% LTV → 2%', () => expect(requiredAmortRate(85, 5_000_000, 0)).toBe(2))
  it('50–70% LTV → 1%', () => expect(requiredAmortRate(60, 5_000_000, 0)).toBe(1))
  it('below 50% LTV → 0%', () => expect(requiredAmortRate(40, 5_000_000, 0)).toBe(0))
  it('+1% surcharge when loan exceeds 4.5× gross income', () =>
    expect(requiredAmortRate(85, 5_000_000, 1_000_000)).toBe(3))
  it('no surcharge when income is unknown (0)', () =>
    expect(requiredAmortRate(85, 5_000_000, 0)).toBe(2))
})

// ── derive() honours custom constants ───────────────────────────────
describe('derive with custom constants', () => {
  it('lagfart + pantbrev scale with the rates', () => {
    const f = derive(DEFAULT_INPUTS, { ...DEFAULT_CONSTANTS, lagfartPct: 2, pantbrevPct: 3 })
    expect(Math.round(f.lagfart)).toBe(Math.round(DEFAULT_INPUTS.newPrice * 0.02))
    expect(Math.round(f.pantbrevCost)).toBe(Math.round(Math.max(0, f.loanAmount - DEFAULT_INPUTS.existingPantbrev) * 0.03))
  })
  it('exposes the statutory required amort rate', () => {
    // default LTV is 5.85M/6.5M = 90% (>70%) with no income → 2%
    expect(derive(DEFAULT_INPUTS).requiredAmortRate).toBe(2)
  })
})

// ── derive() — replaces the old summarize() tests ───────────────────
describe('derive', () => {
  it('standard scenario core figures', () => {
    const f = derive(DEFAULT_INPUTS)
    expect(f.loanAmount).toBe(5_850_000)
    expect(f.totalTakeaway).toBe(2_500_000)
    expect(f.netProceeds).toBe(2_360_000)
    expect(f.totalUpfront).toBe(650_000 + 97_500 + 77_000)
    expect(f.cashBalance).toBe(2_360_000 - 824_500)
    const expectedMonthly =
      (5_850_000 * 0.035) / 12 + (5_850_000 * 0.02) / 12 + 9_725 / 12 + 3_000
    expect(f.bankA.total).toBeCloseTo(expectedMonthly, 6)
  })

  it('all-zero money inputs yield zeros', () => {
    const f = derive({
      ...DEFAULT_INPUTS,
      salePrice: 0,
      currentMortgage: 0,
      agentCost: 0,
      movingCost: 0,
      newPrice: 0,
      deposit: 0,
      existingPantbrev: 0,
      propertyTax: 0,
      driftkostnad: 0,
      interestRateA: 0,
      interestRateB: 0,
    })
    expect(f.loanAmount).toBe(0)
    expect(f.totalMonthly).toBe(0)
    expect(f.cashBalance).toBe(0)
  })

  it('ränteavdrag toggle only changes the affordability figure', () => {
    const off = derive({ ...DEFAULT_INPUTS, ranteavdrag: false })
    const on = derive({ ...DEFAULT_INPUTS, ranteavdrag: true })
    expect(on.totalMonthly).toBe(off.totalMonthly) // monthly cost unchanged
    expect(on.reqSalaryMonthly).toBeLessThan(off.reqSalaryMonthly) // relief lowers it
  })
})

// ── GOLDEN regression ───────────────────────────────────────────────
// Exact figures shown for the default inputs, captured from the live vanilla
// app on 2026-06-23. If derive() ever drifts from the legacy recalc() math,
// these fail — the numerical half of the "pixel-match today" guarantee.
describe('golden figures — default inputs match the live vanilla app', () => {
  const f = derive(DEFAULT_INPUTS)
  const r = (n: number) => Math.round(n)

  it('net from sale 2 360 000', () => expect(r(f.netProceeds)).toBe(2_360_000))
  it('loan amount 5 850 000', () => expect(r(f.loanAmount)).toBe(5_850_000))
  it('lagfart 97 500', () => expect(r(f.lagfart)).toBe(97_500))
  it('new pantbrev cost 77 000', () => expect(r(f.pantbrevCost)).toBe(77_000))
  it('total upfront 824 500', () => expect(r(f.totalUpfront)).toBe(824_500))
  it('cash surplus +1 535 500', () => expect(r(f.cashBalance)).toBe(1_535_500))
  it('bank A monthly 30 623', () => expect(r(f.bankA.total)).toBe(30_623))
  it('bank B monthly 32 573', () => expect(r(f.bankB.total)).toBe(32_573))
  it('bank A cheaper by 1 950/mo', () => expect(r(Math.abs(f.bankDiff))).toBe(1_950))
  it('ränteavdrag 4 333/mo', () => expect(r(f.relief / 12)).toBe(4_333))
  it('back from Skatteverket 51 998/yr', () => expect(r(f.relief)).toBe(51_998))
  it('effective monthly 26 290', () => expect(r(f.effectiveMonthly)).toBe(26_290))
  it('required gross salary 102 076/mo', () => expect(r(f.reqSalaryMonthly)).toBe(102_076))
  it('equity at 5y 1 235 000', () => expect(r(f.equity.y5)).toBe(1_235_000))
  it('equity at 10y 1 820 000', () => expect(r(f.equity.y10)).toBe(1_820_000))
  it('equity at 20y 2 990 000', () => expect(r(f.equity.y20)).toBe(2_990_000))
})
