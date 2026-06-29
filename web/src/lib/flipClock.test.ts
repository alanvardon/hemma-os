import { describe, it, expect } from 'vitest'
import { forwardSteps, getDigits } from './flipClock'

describe('forwardSteps', () => {
  it('same value → empty', () => expect(forwardSteps(0, 0)).toEqual([]))
  it('same value non-zero → empty', () => expect(forwardSteps(5, 5)).toEqual([]))
  it('+1 step, no wrap', () => expect(forwardSteps(3, 4)).toEqual([4]))
  it('multi-step, no wrap', () => expect(forwardSteps(3, 7)).toEqual([4, 5, 6, 7]))
  it('9→0 wrap = one step', () => expect(forwardSteps(9, 0)).toEqual([0]))
  it('5→0 wrap = five steps through rollover', () => expect(forwardSteps(5, 0)).toEqual([6, 7, 8, 9, 0]))
  it('0→9 = nine steps', () => expect(forwardSteps(0, 9)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]))
  it('7→2 wraps around', () => expect(forwardSteps(7, 2)).toEqual([8, 9, 0, 1, 2]))
  it('respects custom modulo', () => expect(forwardSteps(2, 0, 3)).toEqual([0]))
  it('custom modulo wrap', () => expect(forwardSteps(1, 0, 3)).toEqual([2, 0]))
})

describe('getDigits', () => {
  it('returns [h1, h2, m1, m2, s1, s2]', () => {
    const d = new Date(2026, 0, 1, 14, 37, 52)
    expect(getDigits(d)).toEqual([1, 4, 3, 7, 5, 2])
  })
  it('midnight → all zeros', () => {
    const d = new Date(2026, 0, 1, 0, 0, 0)
    expect(getDigits(d)).toEqual([0, 0, 0, 0, 0, 0])
  })
  it('23:59:59', () => {
    const d = new Date(2026, 0, 1, 23, 59, 59)
    expect(getDigits(d)).toEqual([2, 3, 5, 9, 5, 9])
  })
  it('single-digit hour/min/sec have leading zero', () => {
    const d = new Date(2026, 0, 1, 9, 4, 7)
    expect(getDigits(d)).toEqual([0, 9, 0, 4, 0, 7])
  })
})
