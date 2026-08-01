import { describe, it, expect } from 'vitest'
import { proposeRatePeriodTransition } from './mortgage'
import type { RatePeriod, RatePeriodTransitionResult } from './mortgage'

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Realistic fictional Swedish mortgage terms: three-month `rörlig` periods on
// one loan part, rates in the 3–5 % band.
function period(p: Partial<RatePeriod>): RatePeriod {
  return {
    id: 'rp-1', created_at: '2026-01-01T00:00:00Z', loan_part_id: 'part-1',
    start_date: '2026-05-01', end_date: null, rate: 3.93, rate_type: 'rörlig', ...p,
  }
}

type Draft = Pick<RatePeriod, 'start_date' | 'end_date' | 'rate' | 'rate_type'>
function draft(d: Partial<Draft> = {}): Draft {
  return { start_date: '2026-08-01', end_date: null, rate: 4.29, rate_type: 'rörlig', ...d }
}

function valid(result: RatePeriodTransitionResult) {
  expect(result.status).toBe('valid')
  if (result.status !== 'valid') throw new Error('expected a valid transition')
  return result.transition
}

function reasonOf(result: RatePeriodTransitionResult) {
  return result.status === 'invalid' ? result.reason : 'valid:' + JSON.stringify(result.transition)
}

// ── Validation ───────────────────────────────────────────────────────────────
describe('proposeRatePeriodTransition — draft validation', () => {
  it('rejects a start date that is not a real ISO date', () => {
    expect(reasonOf(proposeRatePeriodTransition('part-1', [], draft({ start_date: '' })))).toBe('invalid-date')
    expect(reasonOf(proposeRatePeriodTransition('part-1', [], draft({ start_date: '2026-08' })))).toBe('invalid-date')
    expect(reasonOf(proposeRatePeriodTransition('part-1', [], draft({ start_date: '01/08/2026' })))).toBe('invalid-date')
    expect(reasonOf(proposeRatePeriodTransition('part-1', [], draft({ start_date: '2026-02-30' })))).toBe('invalid-date')
    expect(reasonOf(proposeRatePeriodTransition('part-1', [], draft({ start_date: null as unknown as string })))).toBe('invalid-date')
  })

  it('rejects an explicit end date that is not a real ISO date', () => {
    expect(reasonOf(proposeRatePeriodTransition('part-1', [], draft({ end_date: '2026-10-32' })))).toBe('invalid-date')
    expect(reasonOf(proposeRatePeriodTransition('part-1', [], draft({ end_date: 'okänt' })))).toBe('invalid-date')
  })

  it('treats a null or blank end date as open-ended, not as an invalid date', () => {
    expect(valid(proposeRatePeriodTransition('part-1', [], draft({ end_date: null }))).successor.end_date).toBeNull()
    expect(valid(proposeRatePeriodTransition('part-1', [], draft({ end_date: '' }))).successor.end_date).toBeNull()
  })

  it('rejects a rate that is missing, negative or non-finite', () => {
    expect(reasonOf(proposeRatePeriodTransition('part-1', [], draft({ rate: null })))).toBe('invalid-rate')
    expect(reasonOf(proposeRatePeriodTransition('part-1', [], draft({ rate: -0.5 })))).toBe('invalid-rate')
    expect(reasonOf(proposeRatePeriodTransition('part-1', [], draft({ rate: Number.NaN })))).toBe('invalid-rate')
    expect(reasonOf(proposeRatePeriodTransition('part-1', [], draft({ rate: Number.POSITIVE_INFINITY })))).toBe('invalid-rate')
    expect(reasonOf(proposeRatePeriodTransition('part-1', [], draft({ rate: '4,29' as unknown as number })))).toBe('invalid-rate')
  })

  it('accepts a 0 % rate and does not impose a maximum', () => {
    expect(valid(proposeRatePeriodTransition('part-1', [], draft({ rate: 0 }))).successor.rate).toBe(0)
    expect(valid(proposeRatePeriodTransition('part-1', [], draft({ rate: 19.5 }))).successor.rate).toBe(19.5)
  })

  it('rejects an end date before the start date', () => {
    const r = proposeRatePeriodTransition('part-1', [], draft({ start_date: '2026-08-01', end_date: '2026-07-31' }))
    expect(reasonOf(r)).toBe('start-after-end')
  })

  it('accepts a single-day period ending on its own start date', () => {
    const t = valid(proposeRatePeriodTransition('part-1', [], draft({ start_date: '2026-08-01', end_date: '2026-08-01' })))
    expect(t.successor.end_date).toBe('2026-08-01')
  })

  it('rejects a start date that duplicates an existing period on the part', () => {
    const periods = [period({ id: 'rp-a', start_date: '2026-08-01', end_date: '2026-10-31', rate: 3.93 })]
    expect(reasonOf(proposeRatePeriodTransition('part-1', periods, draft({ start_date: '2026-08-01' })))).toBe('duplicate-start')
  })
})

// ── Neighbour resolution ─────────────────────────────────────────────────────
describe('proposeRatePeriodTransition — predecessor', () => {
  it('closes an open-ended predecessor on the day before the draft start', () => {
    const periods = [period({ id: 'rp-a', start_date: '2026-05-01', end_date: null, rate: 3.93 })]
    const t = valid(proposeRatePeriodTransition('part-1', periods, draft({ start_date: '2026-08-01', rate: 4.29 })))
    expect(t.close).toEqual({ id: 'rp-a', end_date: '2026-07-31' })
    expect(t.successor).toEqual({
      loan_part_id: 'part-1', start_date: '2026-08-01', end_date: null, rate: 4.29, rate_type: 'rörlig',
    })
  })

  it('closes a predecessor whose period overlaps into the draft', () => {
    const periods = [period({ id: 'rp-a', start_date: '2026-05-01', end_date: '2026-10-31', rate: 3.93 })]
    const t = valid(proposeRatePeriodTransition('part-1', periods, draft({ start_date: '2026-08-01' })))
    expect(t.close).toEqual({ id: 'rp-a', end_date: '2026-07-31' })
  })

  it('closes a predecessor that ends exactly on the draft start date', () => {
    const periods = [period({ id: 'rp-a', start_date: '2026-05-01', end_date: '2026-08-01', rate: 3.93 })]
    const t = valid(proposeRatePeriodTransition('part-1', periods, draft({ start_date: '2026-08-01' })))
    expect(t.close).toEqual({ id: 'rp-a', end_date: '2026-07-31' })
  })

  it('proposes no write when the predecessor already ends the day before', () => {
    const periods = [period({ id: 'rp-a', start_date: '2026-05-01', end_date: '2026-07-31', rate: 3.93 })]
    const t = valid(proposeRatePeriodTransition('part-1', periods, draft({ start_date: '2026-08-01' })))
    expect(t.close).toBeNull()
    expect(t.successor.start_date).toBe('2026-08-01')
  })

  it('rejects a draft that leaves a gap after the predecessor', () => {
    const periods = [period({ id: 'rp-a', start_date: '2026-05-01', end_date: '2026-07-31', rate: 3.93 })]
    expect(reasonOf(proposeRatePeriodTransition('part-1', periods, draft({ start_date: '2026-08-02' })))).toBe('gap-before')
    expect(reasonOf(proposeRatePeriodTransition('part-1', periods, draft({ start_date: '2026-11-01' })))).toBe('gap-before')
  })

  it('treats the latest earlier period as the predecessor, ignoring older ones', () => {
    const periods = [
      period({ id: 'rp-a', start_date: '2025-11-01', end_date: '2026-04-30', rate: 4.61 }),
      period({ id: 'rp-b', start_date: '2026-05-01', end_date: null, rate: 3.93 }),
    ]
    const t = valid(proposeRatePeriodTransition('part-1', periods, draft({ start_date: '2026-08-01' })))
    expect(t.close).toEqual({ id: 'rp-b', end_date: '2026-07-31' })
  })

  it('proposes no close for the first-ever period on a part', () => {
    const t = valid(proposeRatePeriodTransition('part-1', [], draft({ start_date: '2026-08-01', rate: 4.29 })))
    expect(t.close).toBeNull()
    expect(t.successor.start_date).toBe('2026-08-01')
  })

  it('proposes no close when every existing period starts later', () => {
    const periods = [period({ id: 'rp-a', start_date: '2026-11-01', end_date: null, rate: 3.93 })]
    const t = valid(proposeRatePeriodTransition('part-1', periods, draft({ start_date: '2026-08-01' })))
    expect(t.close).toBeNull()
    expect(t.successor.end_date).toBe('2026-10-31')
  })
})

describe('proposeRatePeriodTransition — successor', () => {
  it('pre-fills the end date from the next period when the draft end is blank', () => {
    const periods = [
      period({ id: 'rp-a', start_date: '2026-05-01', end_date: null, rate: 3.93 }),
      period({ id: 'rp-c', start_date: '2026-11-01', end_date: null, rate: 4.05 }),
    ]
    const t = valid(proposeRatePeriodTransition('part-1', periods, draft({ start_date: '2026-08-01', end_date: '' })))
    expect(t.successor.end_date).toBe('2026-10-31')
    expect(t.close).toEqual({ id: 'rp-a', end_date: '2026-07-31' })
  })

  it('accepts an explicit end date that matches the next period boundary', () => {
    const periods = [period({ id: 'rp-c', start_date: '2026-11-01', end_date: null, rate: 4.05 })]
    const t = valid(proposeRatePeriodTransition('part-1', periods, draft({ start_date: '2026-08-01', end_date: '2026-10-31' })))
    expect(t.successor.end_date).toBe('2026-10-31')
  })

  it('rejects an explicit end date that overlaps the next period', () => {
    const periods = [period({ id: 'rp-c', start_date: '2026-11-01', end_date: null, rate: 4.05 })]
    expect(reasonOf(proposeRatePeriodTransition('part-1', periods, draft({ start_date: '2026-08-01', end_date: '2026-11-30' })))).toBe('overlap-after')
  })

  it('rejects an explicit end date that stops short of the next period', () => {
    const periods = [period({ id: 'rp-c', start_date: '2026-11-01', end_date: null, rate: 4.05 })]
    expect(reasonOf(proposeRatePeriodTransition('part-1', periods, draft({ start_date: '2026-08-01', end_date: '2026-09-30' })))).toBe('overlap-after')
  })

  it('takes the earliest later period as the successor', () => {
    const periods = [
      period({ id: 'rp-d', start_date: '2027-02-01', end_date: null, rate: 4.4 }),
      period({ id: 'rp-c', start_date: '2026-11-01', end_date: '2027-01-31', rate: 4.05 }),
    ]
    const t = valid(proposeRatePeriodTransition('part-1', periods, draft({ start_date: '2026-08-01' })))
    expect(t.successor.end_date).toBe('2026-10-31')
  })

  it('makes an inserted period contiguous with both neighbours', () => {
    const periods = [
      period({ id: 'rp-a', start_date: '2026-05-01', end_date: '2026-12-31', rate: 3.93 }),
      period({ id: 'rp-c', start_date: '2027-01-01', end_date: null, rate: 4.05 }),
    ]
    const t = valid(proposeRatePeriodTransition('part-1', periods, draft({ start_date: '2026-08-01', end_date: '', rate: 4.29 })))
    expect(t.close).toEqual({ id: 'rp-a', end_date: '2026-07-31' })
    expect(t.successor).toEqual({
      loan_part_id: 'part-1', start_date: '2026-08-01', end_date: '2026-12-31', rate: 4.29, rate_type: 'rörlig',
    })
  })
})

// ── Scoping and input shape ──────────────────────────────────────────────────
describe('proposeRatePeriodTransition — scoping and input shape', () => {
  it('ignores periods belonging to another loan part', () => {
    const periods = [
      period({ id: 'rp-other-a', loan_part_id: 'part-2', start_date: '2026-06-01', end_date: null, rate: 4.61 }),
      period({ id: 'rp-other-b', loan_part_id: 'part-2', start_date: '2026-09-01', end_date: null, rate: 4.7 }),
      period({ id: 'rp-other-c', loan_part_id: null, start_date: '2026-07-01', end_date: null, rate: 4.8 }),
    ]
    const t = valid(proposeRatePeriodTransition('part-1', periods, draft({ start_date: '2026-08-01' })))
    expect(t.close).toBeNull()
    expect(t.successor.end_date).toBeNull()
    expect(t.successor.loan_part_id).toBe('part-1')
  })

  it("does not treat another part's period on the same date as a duplicate start", () => {
    const periods = [period({ id: 'rp-other', loan_part_id: 'part-2', start_date: '2026-08-01', end_date: null, rate: 4.61 })]
    expect(proposeRatePeriodTransition('part-1', periods, draft({ start_date: '2026-08-01' })).status).toBe('valid')
  })

  it('sorts unsorted input before resolving neighbours', () => {
    const periods = [
      period({ id: 'rp-c', start_date: '2026-11-01', end_date: null, rate: 4.05 }),
      period({ id: 'rp-a', start_date: '2025-11-01', end_date: '2026-04-30', rate: 4.61 }),
      period({ id: 'rp-b', start_date: '2026-05-01', end_date: null, rate: 3.93 }),
    ]
    const t = valid(proposeRatePeriodTransition('part-1', periods, draft({ start_date: '2026-08-01' })))
    expect(t.close).toEqual({ id: 'rp-b', end_date: '2026-07-31' })
    expect(t.successor.end_date).toBe('2026-10-31')
  })

  it('survives malformed rows without treating them as neighbours', () => {
    const periods = [
      period({ id: 'rp-bad', start_date: '', end_date: null, rate: 3.5 }),
      null as unknown as RatePeriod,
      period({ id: 'rp-a', start_date: '2026-05-01', end_date: null, rate: 3.93 }),
    ]
    const t = valid(proposeRatePeriodTransition('part-1', periods, draft({ start_date: '2026-08-01' })))
    expect(t.close).toEqual({ id: 'rp-a', end_date: '2026-07-31' })
  })

  it('closes a predecessor whose stored end date is unusable', () => {
    const periods = [period({ id: 'rp-a', start_date: '2026-05-01', end_date: 'okänt', rate: 3.93 })]
    const t = valid(proposeRatePeriodTransition('part-1', periods, draft({ start_date: '2026-08-01' })))
    expect(t.close).toEqual({ id: 'rp-a', end_date: '2026-07-31' })
  })

  it('carries the draft rate type and normalises an unknown one to rörlig', () => {
    const bunden = valid(proposeRatePeriodTransition('part-1', [], draft({ rate_type: 'bunden' })))
    expect(bunden.successor.rate_type).toBe('bunden')
    const odd = valid(proposeRatePeriodTransition('part-1', [], draft({ rate_type: 'okänd' as unknown as 'rörlig' })))
    expect(odd.successor.rate_type).toBe('rörlig')
  })

  it('never mutates the periods it is given', () => {
    const periods = [
      period({ id: 'rp-c', start_date: '2026-11-01', end_date: null, rate: 4.05 }),
      period({ id: 'rp-a', start_date: '2026-05-01', end_date: null, rate: 3.93 }),
    ]
    const snapshot = JSON.parse(JSON.stringify(periods))
    proposeRatePeriodTransition('part-1', periods, draft({ start_date: '2026-08-01' }))
    expect(periods).toEqual(snapshot)
  })

  it('leap-day boundary: a period starting 2028-03-01 closes its predecessor on 2028-02-29', () => {
    const periods = [period({ id: 'rp-a', start_date: '2027-12-01', end_date: null, rate: 3.93 })]
    const t = valid(proposeRatePeriodTransition('part-1', periods, draft({ start_date: '2028-03-01', rate: 4.29 })))
    expect(t.close).toEqual({ id: 'rp-a', end_date: '2028-02-29' })
  })

  it('year boundary: a 1 January start closes its predecessor on 31 December', () => {
    const periods = [period({ id: 'rp-a', start_date: '2026-05-01', end_date: null, rate: 3.93 })]
    const t = valid(proposeRatePeriodTransition('part-1', periods, draft({ start_date: '2027-01-01' })))
    expect(t.close).toEqual({ id: 'rp-a', end_date: '2026-12-31' })
  })
})
