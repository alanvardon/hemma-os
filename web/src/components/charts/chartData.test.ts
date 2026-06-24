import { describe, it, expect } from 'vitest'
import { DEFAULT_INPUTS } from '../../lib/calc'
import { amortSeries, equitySeries, stressSeries } from './chartData'

describe('amortSeries', () => {
  const s = amortSeries(DEFAULT_INPUTS)

  it('starts at each mortgage balance in year 0', () => {
    expect(s.years[0]).toBe(0)
    expect(s.current[0]).toBe(2_000_000)
    expect(s.next[0]).toBe(5_850_000) // newPrice − deposit
  })

  it('computes payoff years and a covering x-axis', () => {
    expect(s.nextPayoff).toBe(50) // 5.85M at 2%/yr → 50 years
    expect(s.currentPayoff).toBe(48) // never reaches 0 within term → term cap
    expect(s.maxYear).toBe(50)
    expect(s.years).toHaveLength(51)
  })

  it('has no null gaps across the axis (paid-off years read 0)', () => {
    expect(s.current.every((v) => v !== null)).toBe(true)
    expect(s.next.every((v) => v !== null)).toBe(true)
    expect(s.next.at(-1)).toBe(0)
  })
})

describe('equitySeries', () => {
  it('starts at the deposit and grows monotonically', () => {
    const pts = equitySeries(DEFAULT_INPUTS)
    expect(pts[0].equity).toBe(650_000)
    expect(pts.at(-1)!.year).toBe(30) // horizon, since default never fully amortises in 30y
    expect(pts.at(-1)!.equity).toBe(650_000 + 117_000 * 30)
    for (let n = 1; n < pts.length; n++) expect(pts[n].equity).toBeGreaterThanOrEqual(pts[n - 1].equity)
  })

  it('caps equity at the purchase price', () => {
    const pts = equitySeries({ ...DEFAULT_INPUTS, amortRate: 20 })
    expect(pts.at(-1)!.equity).toBe(6_500_000) // capped at newPrice
  })
})

describe('stressSeries', () => {
  const pts = stressSeries(DEFAULT_INPUTS)

  it('spans the slider range', () => {
    expect(pts[0].rate).toBe(0.5)
    expect(pts.at(-1)!.rate).toBe(12)
    expect(pts).toHaveLength(47)
  })

  it('monthly cost rises strictly with the rate', () => {
    for (let n = 1; n < pts.length; n++) expect(pts[n].total).toBeGreaterThan(pts[n - 1].total)
  })
})
