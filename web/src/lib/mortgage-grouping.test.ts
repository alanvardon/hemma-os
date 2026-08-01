import { describe, it, expect } from 'vitest'
import { groupLoanParts, bindingStatus, partsMissingCurrentRateTerms } from './mortgage'
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
  // Plan 126 — added so a uniform-type group survives part-6's move to the
  // catch-all: with dated grouping, part-6's lapsed timeline no longer forms a
  // group of its own, and part-1/2/3 are deliberately mixed-type.
  part({ id: 'part-7', label: 'Part 7', start_balance: 1000000 }),
]

const periods: RatePeriod[] = [
  period({ id: 'r1', loan_part_id: 'part-1', end_date: '2027-01-01', rate: 3.45, rate_type: 'bunden' }),
  period({ id: 'r2', loan_part_id: 'part-2', end_date: '2027-01-01', rate: 3.45, rate_type: 'bunden' }),
  period({ id: 'r3', loan_part_id: 'part-3', end_date: '2027-01-01', rate: 2.10, rate_type: 'rörlig' }),
  // part-4 intentionally has no rate period → catch-all
  // part-6's only period LAPSED before ASOF → no current coverage → catch-all
  period({ id: 'r6', loan_part_id: 'part-6', end_date: '2025-06-01', rate: 4.00, rate_type: 'bunden' }),
  period({ id: 'r5', loan_part_id: 'part-5-archived', end_date: '2027-01-01', rate: 3.45, rate_type: 'bunden' }),
  period({ id: 'r7', loan_part_id: 'part-7', end_date: '2026-06-01', rate: 4.00, rate_type: 'bunden' }),
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
    const uniformGroup = groups.find(g => g.parts.some(p => p.id === 'part-7'))!
    expect(uniformGroup.rate_type).toBe('bunden')
    expect(uniformGroup.rate).toBeCloseTo(4.0, 2)
  })

  it('puts a part with no complete rate period into the catch-all group', () => {
    const groups = groupLoanParts(parts, periods, [], ASOF)
    const catchall = groups.find(g => g.is_catchall)!
    // part-4 has no period at all; part-6 has one that lapsed before ASOF.
    expect(catchall.parts.map(p => p.id)).toEqual(['part-4', 'part-6'])
    expect(catchall.end_date).toBeNull()
  })

  it('excludes archived parts from every group', () => {
    const groups = groupLoanParts(parts, periods, [], ASOF)
    expect(groups.some(g => g.parts.some(p => p.id === 'part-5-archived'))).toBe(false)
  })

  it('orders groups ascending by reprice date, catch-all last', () => {
    const groups = groupLoanParts(parts, periods, [], ASOF)
    const order = groups.map(g => g.is_catchall ? 'catchall' : g.parts.map(p => p.id).sort().join('+'))
    expect(order).toEqual(['part-7', 'part-1+part-2+part-3', 'catchall'])
  })

  // Plan 126 §2 — THE GROUPING CONSEQUENCE of dated resolution, stated
  // explicitly because it moves a part between groups. The bucket key is the
  // covering period's end_date, so a part with no coverage at `asOf` resolves
  // period = null and lands in __catchall__, giving up its rate, days_left and
  // expiry rendering. Intended: the part stays VISIBLE with no current rate
  // rather than being priced from terms that do not apply. Bolånekoll names it
  // in the "Räntevillkor saknas för idag" warning, which is the only reason
  // this is not a silent loss.
  it('moves a part whose periods lapsed before asOf into the catch-all, dropping its rate', () => {
    const groups = groupLoanParts(parts, periods, [], ASOF)
    const lapsedGroup = groups.find(g => g.parts.some(p => p.id === 'part-6'))!
    expect(lapsedGroup.is_catchall).toBe(true)
    // No rate, no countdown, no expiry badge — nothing invented from the
    // lapsed 4,00 % period.
    expect(lapsedGroup.rate).toBeNull()
    expect(lapsedGroup.rate_type).toBeNull()
    expect(lapsedGroup.days_left).toBeNull()
    expect(lapsedGroup.expired).toBe(false)
    // …but the part is still on the page, with its balance counted.
    expect(lapsedGroup.parts.map(p => p.id)).toContain('part-6')
    expect(lapsedGroup.total_balance).toBe(2000000)   // part-4 0,5m + part-6 1,5m
    // …and it is exactly the part the warning names (part-4, with no villkor at
    // all, belongs to the other message).
    expect(partsMissingCurrentRateTerms(parts, periods, ASOF).map(m => m.loan_part_id))
      .toEqual(['part-6'])
  })

  // The other half of the consequence: a period ending exactly ON asOf still
  // covers it, so the part keeps its group and its countdown right up to the
  // villkorsändringsdag. A successor starting the next day does not displace it.
  it('keeps a part in its dated group on the last day of its period, even with a successor queued', () => {
    const p = part({ id: 'edge', start_balance: 1000000 })
    const per = [
      period({ id: 'edge-now', loan_part_id: 'edge', start_date: '2025-01-01', end_date: ASOF, rate: 3.00, rate_type: 'bunden' }),
      period({ id: 'edge-next', loan_part_id: 'edge', start_date: '2026-01-02', end_date: null, rate: 5.00, rate_type: 'rörlig' }),
    ]
    const today = groupLoanParts([p], per, [], ASOF)
    expect(today).toHaveLength(1)
    expect(today[0].is_catchall).toBe(false)
    expect(today[0].end_date).toBe(ASOF)
    expect(today[0].rate).toBeCloseTo(3.00, 2)       // today's rate, not the successor's 5,00 %
    expect(today[0].days_left).toBe(0)

    // Tomorrow the successor takes over: open-ended, so the group is the
    // catch-all one and the rate steps to 5,00 %.
    const tomorrow = groupLoanParts([p], per, [], '2026-01-02')
    expect(tomorrow[0].is_catchall).toBe(true)
    expect(partsMissingCurrentRateTerms([p], per, '2026-01-02')).toEqual([])
  })

  it('sums total_balance and share_pct per group against all active parts', () => {
    const groups = groupLoanParts(parts, periods, [], ASOF)
    const g = groups.find(g => g.parts.some(p => p.id === 'part-1'))!
    // part-1 (2m) + part-2 (2m) + part-3 (1m) = 5m
    expect(g.total_balance).toBe(5000000)
    // grand total across active parts = 2m+2m+1m+0.5m+1.5m+1m = 8m
    // (part-7 was added for the uniform-type group; the divisor moved with it)
    expect(g.share_pct).toBeCloseTo(5000000 / 8000000 * 100, 2)
  })
})

// Plan 126 §2 — the two missing-terms messages are disjoint by construction.
describe('partsMissingCurrentRateTerms', () => {
  const covered = part({ id: 'covered', start_balance: 1000000 })
  const coveredPeriod = period({ id: 'c1', loan_part_id: 'covered', end_date: null, rate: 3.0 })

  it('ignores a part with no rate periods at all — that is the other prompt', () => {
    expect(partsMissingCurrentRateTerms([part({ id: 'bare' })], [], ASOF)).toEqual([])
  })

  it('ignores a part covered at asOf', () => {
    expect(partsMissingCurrentRateTerms([covered], [coveredPeriod], ASOF)).toEqual([])
  })

  it('names a lapsed, a gapped, an all-future and an overlapping timeline', () => {
    const lapsed = part({ id: 'lapsed', label: 'Lapsed' })
    const gapped = part({ id: 'gapped', label: 'Gapped' })
    const future = part({ id: 'future', label: 'Future' })
    const overlap = part({ id: 'overlap', label: 'Overlap' })
    const per = [
      coveredPeriod,
      period({ id: 'l1', loan_part_id: 'lapsed', end_date: '2025-06-01', rate: 4.0 }),
      // 2025-12-31 … 2026-02-01 leaves ASOF (2026-01-01) uncovered.
      period({ id: 'g1', loan_part_id: 'gapped', end_date: '2025-12-31', rate: 4.0 }),
      period({ id: 'g2', loan_part_id: 'gapped', start_date: '2026-02-01', end_date: null, rate: 4.1 }),
      period({ id: 'f1', loan_part_id: 'future', start_date: '2027-01-01', end_date: null, rate: 4.0 }),
      // Two rows both claiming ASOF — conflicting terms are as unusable as none.
      period({ id: 'o1', loan_part_id: 'overlap', end_date: null, rate: 3.0 }),
      period({ id: 'o2', loan_part_id: 'overlap', start_date: '2025-06-01', end_date: null, rate: 4.0 }),
    ]
    expect(partsMissingCurrentRateTerms([covered, lapsed, gapped, future, overlap], per, ASOF).map(m => m.label))
      .toEqual(['Lapsed', 'Gapped', 'Future', 'Overlap'])
  })

  it('excludes archived parts', () => {
    const archived = part({ id: 'gone', archived: true })
    const per = [period({ id: 'a1', loan_part_id: 'gone', end_date: '2025-06-01', rate: 4.0 })]
    expect(partsMissingCurrentRateTerms([archived], per, ASOF)).toEqual([])
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
