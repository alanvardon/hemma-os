import { describe, it, expect } from 'vitest'
import { upcomingRatePeriods, addDaysISO, todayISO } from './mortgage'
import type { LoanPart, RatePeriod } from './mortgage'

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Realistic fictional Swedish mortgage terms: rates in the 3–5 % band. Dates
// are built relative to `today` (via addDaysISO), never hard-coded, so the
// suite doesn't rot as the wall clock moves (plan 127 §4 — the whole feature
// is date-relative, same lesson as Stage 3).
const today = todayISO()
function inDays(n: number): string {
  const d = addDaysISO(today, n)
  if (d == null) throw new Error('addDaysISO failed in test fixture')
  return d
}

function part(p: Partial<LoanPart> & { id: string }): LoanPart {
  return {
    created_at: '2026-01-01T00:00:00Z', label: p.id, loan_number: '', start_date: '2020-01-01',
    archived: false, start_balance: 1_000_000, ...p,
  }
}
function period(p: Partial<RatePeriod> & { id: string; loan_part_id: string }): RatePeriod {
  return {
    created_at: '2026-01-01T00:00:00Z', start_date: inDays(30), end_date: null, rate: 3.93,
    rate_type: 'rörlig', ...p,
  }
}

const partA = part({ id: 'part-a', label: 'Lånedel A' })
const partB = part({ id: 'part-b', label: 'Lånedel B' })

describe('upcomingRatePeriods — grouping and ordering', () => {
  it('groups periods by start_date and returns groups ascending', () => {
    const periods = [
      period({ id: 'rp-late', loan_part_id: 'part-a', start_date: inDays(60), rate: 4.29 }),
      period({ id: 'rp-early', loan_part_id: 'part-b', start_date: inDays(10), rate: 3.93 }),
    ]
    const result = upcomingRatePeriods([partA, partB], periods, today)
    expect(result.groups.map(g => g.start_date)).toEqual([inDays(10), inDays(60)])
  })

  it('buckets same-day periods from different parts into one group', () => {
    const periods = [
      period({ id: 'rp-a', loan_part_id: 'part-a', start_date: inDays(15), rate: 3.93 }),
      period({ id: 'rp-b', loan_part_id: 'part-b', start_date: inDays(15), rate: 4.05 }),
    ]
    const result = upcomingRatePeriods([partA, partB], periods, today)
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].items).toHaveLength(2)
  })

  it('the earliest group start_date becomes earliestStartDate', () => {
    const periods = [
      period({ id: 'rp-a', loan_part_id: 'part-a', start_date: inDays(45) }),
      period({ id: 'rp-b', loan_part_id: 'part-b', start_date: inDays(5) }),
    ]
    const result = upcomingRatePeriods([partA, partB], periods, today)
    expect(result.earliestStartDate).toBe(inDays(5))
  })

  it('carries the part label and rate/type/end_date onto each item', () => {
    const periods = [period({ id: 'rp-a', loan_part_id: 'part-a', start_date: inDays(20), rate: 4.29, rate_type: 'bunden', end_date: inDays(400) })]
    const result = upcomingRatePeriods([partA], periods, today)
    const item = result.groups[0].items[0]
    expect(item.partId).toBe('part-a')
    expect(item.partLabel).toBe('Lånedel A')
    expect(item.period.rate).toBe(4.29)
    expect(item.period.rate_type).toBe('bunden')
    expect(item.period.end_date).toBe(inDays(400))
  })
})

describe('upcomingRatePeriods — unique-part count vs. group count', () => {
  it('counts unique parts, not date groups: one shared date, two parts → 1 group, 2 parts', () => {
    const periods = [
      period({ id: 'rp-a', loan_part_id: 'part-a', start_date: inDays(15) }),
      period({ id: 'rp-b', loan_part_id: 'part-b', start_date: inDays(15) }),
    ]
    const result = upcomingRatePeriods([partA, partB], periods, today)
    expect(result.groups).toHaveLength(1)
    expect(result.uniquePartCount).toBe(2)
  })

  it('counts unique parts, not date groups: one part with two future periods → 2 groups, 1 part', () => {
    const periods = [
      period({ id: 'rp-a', loan_part_id: 'part-a', start_date: inDays(15) }),
      period({ id: 'rp-b', loan_part_id: 'part-a', start_date: inDays(90) }),
    ]
    const result = upcomingRatePeriods([partA], periods, today)
    expect(result.groups).toHaveLength(2)
    expect(result.uniquePartCount).toBe(1)
  })
})

describe('upcomingRatePeriods — active-view scoping', () => {
  it('excludes a period whose part is not in the passed-in active-view parts', () => {
    const archived = part({ id: 'part-archived', label: 'Gammal lånedel' })
    const periods = [
      period({ id: 'rp-a', loan_part_id: 'part-a', start_date: inDays(10) }),
      period({ id: 'rp-archived', loan_part_id: 'part-archived', start_date: inDays(10) }),
    ]
    // Only partA is passed as the active view — partArchived is deliberately omitted.
    const result = upcomingRatePeriods([partA], periods, today)
    expect(result.uniquePartCount).toBe(1)
    expect(result.groups[0].items.map(i => i.partId)).toEqual(['part-a'])
    void archived
  })
})

describe('upcomingRatePeriods — asOf boundary (plan 126 dated resolution)', () => {
  it('a period starting exactly on asOf is current, not upcoming — it leaves Kommande the same day', () => {
    const periods = [period({ id: 'rp-a', loan_part_id: 'part-a', start_date: today })]
    const result = upcomingRatePeriods([partA], periods, today)
    expect(result.groups).toHaveLength(0)
  })

  it('a period starting one day after asOf is still upcoming', () => {
    const periods = [period({ id: 'rp-a', loan_part_id: 'part-a', start_date: inDays(1) })]
    const result = upcomingRatePeriods([partA], periods, today)
    expect(result.groups).toHaveLength(1)
  })
})

describe('upcomingRatePeriods — past periods and empty results', () => {
  it('excludes a period that already started in the past', () => {
    const periods = [period({ id: 'rp-a', loan_part_id: 'part-a', start_date: inDays(-10) })]
    const result = upcomingRatePeriods([partA], periods, today)
    expect(result.groups).toHaveLength(0)
    expect(result.uniquePartCount).toBe(0)
    expect(result.earliestStartDate).toBeNull()
  })

  it('returns an empty summary when there are no periods at all', () => {
    const result = upcomingRatePeriods([partA], [], today)
    expect(result).toEqual({ groups: [], earliestStartDate: null, uniquePartCount: 0 })
  })

  it('returns an empty summary when every period is current or past', () => {
    const periods = [
      period({ id: 'rp-a', loan_part_id: 'part-a', start_date: inDays(-30), end_date: null }),
    ]
    const result = upcomingRatePeriods([partA], periods, today)
    expect(result.groups).toHaveLength(0)
  })
})

describe('upcomingRatePeriods — malformed rows', () => {
  it('skips a period with a blank start_date', () => {
    const periods = [
      period({ id: 'rp-bad', loan_part_id: 'part-a', start_date: '' }),
      period({ id: 'rp-ok', loan_part_id: 'part-a', start_date: inDays(10) }),
    ]
    const result = upcomingRatePeriods([partA], periods, today)
    expect(result.groups.flatMap(g => g.items.map(i => i.period.id))).toEqual(['rp-ok'])
  })

  it('skips a period with an unparseable start_date', () => {
    const periods = [period({ id: 'rp-bad', loan_part_id: 'part-a', start_date: 'okänt' })]
    const result = upcomingRatePeriods([partA], periods, today)
    expect(result.groups).toHaveLength(0)
  })

  it('skips a period with a null loan_part_id', () => {
    const periods = [period({ id: 'rp-bad', loan_part_id: null as unknown as string, start_date: inDays(10) })]
    const result = upcomingRatePeriods([partA], periods, today)
    expect(result.groups).toHaveLength(0)
  })

  it('skips a null row in the periods array without throwing', () => {
    const periods = [null as unknown as RatePeriod, period({ id: 'rp-ok', loan_part_id: 'part-a', start_date: inDays(10) })]
    expect(() => upcomingRatePeriods([partA], periods, today)).not.toThrow()
    const result = upcomingRatePeriods([partA], periods, today)
    expect(result.groups.flatMap(g => g.items.map(i => i.period.id))).toEqual(['rp-ok'])
  })

  it('deduplicates a repeated period id rather than counting it twice', () => {
    const dup = period({ id: 'rp-dup', loan_part_id: 'part-a', start_date: inDays(10) })
    const result = upcomingRatePeriods([partA], [dup, { ...dup }], today)
    expect(result.groups[0].items).toHaveLength(1)
  })

  it('skips a part with no id in the active-view parts list', () => {
    const brokenPart = { ...partA, id: '' as unknown as string }
    const periods = [period({ id: 'rp-a', loan_part_id: '', start_date: inDays(10) })]
    const result = upcomingRatePeriods([brokenPart], periods, today)
    expect(result.groups).toHaveLength(0)
  })

  it('never mutates the parts or periods it is given', () => {
    const periods = [period({ id: 'rp-a', loan_part_id: 'part-a', start_date: inDays(10) })]
    const partsSnapshot = JSON.parse(JSON.stringify([partA]))
    const periodsSnapshot = JSON.parse(JSON.stringify(periods))
    upcomingRatePeriods([partA], periods, today)
    expect([partA]).toEqual(partsSnapshot)
    expect(periods).toEqual(periodsSnapshot)
  })
})
