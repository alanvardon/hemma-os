import { describe, it, expect } from 'vitest'
import { grundavdrag, jobbskatteavdrag, PBB_2026, STATE_TAX_SKIKTGRANS, STATE_TAX_RATE } from './swedish-tax'

// Values captured from konsult.ts's grundavdragFn/jobbskatteavdragFn and
// lonevaxling.ts's grundavdrag/jobbskatteavdrag BEFORE they were consolidated
// into this shared module — a regression here means the extraction changed
// behavior for either Konsultkalkyl or Löneväxling.
describe('grundavdrag', () => {
  it.each([
    [0, 25100],
    [50000, 25100],
    [150000, 43400],
    [300000, 34000],
    [500000, 17400],
    [643000, 17400],
    [1000000, 17400],
  ])('income %d -> %d', (income, expected) => {
    expect(grundavdrag(income, PBB_2026)).toBeCloseTo(expected, 5)
  })
})

describe('jobbskatteavdrag', () => {
  it.each([
    [0, 25100, 0.3238, 0],
    [300000, 34000, 0.3238, 32526.948181228432],
    [643000, 17400, 0.3238, 52390.321919999995],
    [1000000, 17400, 0.3238, 50462.753472],
  ])('income %d, ga %d, rate %d -> %d', (income, ga, rate, expected) => {
    expect(jobbskatteavdrag(income, ga, rate, PBB_2026)).toBeCloseTo(expected, 4)
  })
})

describe('shared constants', () => {
  it('match the pre-extraction values', () => {
    expect(PBB_2026).toBe(59200)
    expect(STATE_TAX_SKIKTGRANS).toBe(643000)
    expect(STATE_TAX_RATE).toBe(0.2)
  })
})
