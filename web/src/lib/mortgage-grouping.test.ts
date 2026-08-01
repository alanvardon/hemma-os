import { describe, it, expect } from 'vitest'
import { groupLoanParts, bindingStatus } from './mortgage'
import type { LoanPart, RatePeriod } from './mortgage'

function part(p: Partial<LoanPart> & { id: string }): LoanPart {
  return {
    created_at: '2026-01-01T00:00:00Z', label: p.id, loan_number: '', start_date: '2020-01-01',
    archived: false, start_balance: 0, ...p,
  }
}
function period(p: Partial<RatePeriod> & { id: string; loan_part_id: string }): RatePeriod {
  return {
    created_at: '2026-01-01T00:00:00Z', start_date: '2020-01-01', end_date: null, rate: null,
    rate_type: 'rörlig', ...p,
  }
}

const ASOF = '2026-01-01'

const parts: LoanPart[] = [
  part({ id: 'part-1', label: 'Part 1', start_balance: 2000000 }),
  part({ id: 'part-2', label: 'Part 2', start_balance: 2000000 }),
  part({ id: 'part-3', label: 'Part 3', start_balance: 1000000 }),
  part({ id: 'part-4', label: 'Part 4', start_balance: 500000 }),
  part({ id: 'part-6', label: 'Part 6', start_balance: 1500000 }),
  part({ id: 'part-5-archived', label: 'Part 5', start_balance: 900000, archived: true }),
]

const periods: RatePeriod[] = [
  period({ id: 'r1', loan_part_id: 'part-1', end_date: '2027-01-01', rate: 3.45, rate_type: 'bunden' }),
  period({ id: 'r2', loan_part_id: 'part-2', end_date: '2027-01-01', rate: 3.45, rate_type: 'bunden' }),
  period({ id: 'r3', loan_part_id: 'part-3', end_date: '2027-01-01', rate: 2.10, rate_type: 'rörlig' }),
  // part-4 intentionally has no rate period → catch-all
  period({ id: 'r6', loan_part_id: 'part-6', end_date: '2025-06-01', rate: 4.00, rate_type: 'bunden' }),
  period({ id: 'r5', loan_part_id: 'part-5-archived', end_date: '2027-01-01', rate: 3.45, rate_type: 'bunden' }),
]

describe('groupLoanParts', () => {
  it('merges all parts sharing an end_date into one group, regardless of rate', () => {
    const groups = groupLoanParts(parts, periods, [], ASOF)
    const g = groups.find(g => g.parts.some(p => p.id === 'part-1'))!
    // part-1 & part-2 (bunden 3.45) and part-3 (rörlig 2.10) all reprice 2027-01-01
    expect(g.parts.map(p => p.id).sort()).toEqual(['part-1', 'part-2', 'part-3'])
    expect(g.is_singleton).toBe(false)
  })

  it('marks a mixed-rate group rate_type null and blends the rate by balance', () => {
    const groups = groupLoanParts(parts, periods, [], ASOF)
    const g = groups.find(g => g.parts.some(p => p.id === 'part-1'))!
    expect(g.rate_type).toBeNull()
    // (3.45*2m + 3.45*2m + 2.10*1m) / 5m = 3.18
    expect(g.rate).toBeCloseTo(3.18, 2)
  })

  it('keeps rate_type when every member in a group shares one type', () => {
    const groups = groupLoanParts(parts, periods, [], ASOF)
    const expiredGroup = groups.find(g => g.parts.some(p => p.id === 'part-6'))!
    expect(expiredGroup.rate_type).toBe('bunden')
    expect(expiredGroup.rate).toBeCloseTo(4.0, 2)
  })

  it('puts a part with no complete rate period into the catch-all group', () => {
    const groups = groupLoanParts(parts, periods, [], ASOF)
    const catchall = groups.find(g => g.is_catchall)!
    expect(catchall.parts.map(p => p.id)).toEqual(['part-4'])
    expect(catchall.end_date).toBeNull()
  })

  it('excludes archived parts from every group', () => {
    const groups = groupLoanParts(parts, periods, [], ASOF)
    expect(groups.some(g => g.parts.some(p => p.id === 'part-5-archived'))).toBe(false)
  })

  it('orders expired groups first, then ascending by date, catch-all last', () => {
    const groups = groupLoanParts(parts, periods, [], ASOF)
    const order = groups.map(g => g.is_catchall ? 'catchall' : g.parts.map(p => p.id).sort().join('+'))
    expect(order).toEqual(['part-6', 'part-1+part-2+part-3', 'catchall'])
  })

  // Plan 126 — strict dated resolution. part-6's only period ended 2025-06-01,
  // so nothing covers ASOF (2026-01-01): bindingStatus reports NO current
  // binding rather than stretching the lapsed period far enough to call it
  // `expired`. A lapsed timeline is therefore surfaced as missing current
  // terms, not as an expiry countdown computed from terms that no longer apply.
  // `expired` is unreachable on any dated call by construction — coverage means
  // asOf <= end_date, so days_left is never negative.
  it('reports no current binding for a lapsed-only timeline and keeps the countdown on a covered group', () => {
    const groups = groupLoanParts(parts, periods, [], ASOF)
    const lapsedGroup = groups.find(g => g.parts.some(p => p.id === 'part-6'))!
    const futureGroup = groups.find(g => g.parts.some(p => p.id === 'part-1'))!
    expect(lapsedGroup.expired).toBe(false)
    expect(lapsedGroup.days_left).toBeNull()
    expect(futureGroup.expired).toBe(false)
    expect(futureGroup.days_left).toBeGreaterThan(0)
  })

  it('sums total_balance and share_pct per group against all active parts', () => {
    const groups = groupLoanParts(parts, periods, [], ASOF)
    const g = groups.find(g => g.parts.some(p => p.id === 'part-1'))!
    // part-1 (2m) + part-2 (2m) + part-3 (1m) = 5m
    expect(g.total_balance).toBe(5000000)
    // grand total across active parts = 2m+2m+1m+0.5m+1.5m = 7m
    expect(g.share_pct).toBeCloseTo(5000000 / 7000000 * 100, 2)
  })
})

describe('bindingStatus widened for dated rörlig', () => {
  it('counts a dated rörlig period as bound', () => {
    const p = part({ id: 'r-part', start_balance: 100000 })
    const per = [period({ id: 'rp', loan_part_id: 'r-part', end_date: '2026-06-01', rate: 2.0, rate_type: 'rörlig' })]
    const bs = bindingStatus(p, per, ASOF)
    expect(bs.bound).toBe(true)
    expect(bs.until).toBe('2026-06-01')
  })

  it('leaves an undated rörlig period unbound', () => {
    const p = part({ id: 'r-part2', start_balance: 100000 })
    const per = [period({ id: 'rp2', loan_part_id: 'r-part2', end_date: null, rate: 2.0, rate_type: 'rörlig' })]
    const bs = bindingStatus(p, per, ASOF)
    expect(bs.bound).toBe(false)
  })
})
