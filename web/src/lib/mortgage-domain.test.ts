import { describe, it, expect } from 'vitest'
import {
  makeLoanPart, mortgageForPart, bankForPart, reconcileBalance,
  totalAmortized, groupLoanParts, effectiveRatePeriod, strictRatePeriodCoverage,
  learnYearBasis,
} from './mortgage'
import type { LoanPart, Payment, Bank, Mortgage, RatePeriod } from './mortgage'

// ── Fixtures ─────────────────────────────────────────────────────────────────
function part(p: Partial<LoanPart>): LoanPart {
  return {
    id: 'p', created_at: 't', label: '', loan_number: '',
    start_balance: 0, start_date: '', archived: false,
    mortgage_id: null, original_balance: null, original_date: null, ...p,
  }
}
function saldo(loan_part_id: string, date: string, balance_after: number): Payment {
  return { id: 'pay-' + date, created_at: 't', loan_part_id, date, kind: 'payment', description: '', amount: 0, balance_after, paid_by: 'joint', source: 'import' }
}
function amort(loan_part_id: string, date: string, amount: number): Payment {
  return { id: 'am-' + date, created_at: 't', loan_part_id, date, kind: 'amortization', description: '', amount, balance_after: null, paid_by: 'joint', source: 'import' }
}

// ── Normaliser: original_balance clamp / fallback ────────────────────────────
describe('makeLoanPart — origination anchor', () => {
  it('keeps a valid original_balance (rounded) and carries mortgage_id/original_date', () => {
    const r = makeLoanPart({ original_balance: 1200000.004, original_date: '2020-01-01', mortgage_id: 'm1' })
    expect(r.original_balance).toBe(1200000)
    expect(r.original_date).toBe('2020-01-01')
    expect(r.mortgage_id).toBe('m1')
  })
  it('clamps a negative original_balance to null (falls back downstream)', () => {
    expect(makeLoanPart({ original_balance: -5 }).original_balance).toBeNull()
  })
  it('ignores a NaN original_balance', () => {
    expect(makeLoanPart({ original_balance: Number.NaN }).original_balance).toBeNull()
    expect(makeLoanPart({ original_balance: 'abc' as unknown as number }).original_balance).toBeNull()
  })
  it('defaults the new fields to null when absent', () => {
    const r = makeLoanPart({ label: 'X' })
    expect(r.original_balance).toBeNull()
    expect(r.original_date).toBeNull()
    expect(r.mortgage_id).toBeNull()
  })
})

// ── Origination split: partOriginal / totalAmortized read original_balance ───
describe('origination split — totalAmortized', () => {
  it('measures amortised from original_balance, not the ledger opening', () => {
    const p = part({ id: 'p1', original_balance: 1200000, original_date: '2020-01-01' })
    const pays = [saldo('p1', '2024-01-01', 1008000)]
    // 1 200 000 origination − 1 008 000 current = 192 000 amortised.
    expect(totalAmortized([p], pays)).toBe(192000)
  })
  it('falls back to start_balance when original_balance is null', () => {
    const p = part({ id: 'p1', original_balance: null, start_balance: 1000000, start_date: '2020-01-01' })
    const pays = [saldo('p1', '2024-01-01', 900000)]
    expect(totalAmortized([p], pays)).toBe(100000)
  })
})

// ── Resolvers: part → mortgage → bank ────────────────────────────────────────
describe('bank / mortgage resolvers', () => {
  const banks: Bank[] = [
    { id: 'b1', created_at: 't', label: 'Danske' },
    { id: 'b2', created_at: 't', label: 'SBAB' },
  ]
  const mortgages: Mortgage[] = [
    { id: 'm1', created_at: 't', bank_id: 'b1', label: 'Bolån', start_date: null, archived: false },
    { id: 'm2', created_at: 't', bank_id: 'b2', label: 'Bolån 2', start_date: null, archived: false },
  ]
  it('resolves a part to its bank through the mortgage link', () => {
    const p = part({ id: 'p1', mortgage_id: 'm1' })
    expect(mortgageForPart(p, mortgages)?.id).toBe('m1')
    expect(bankForPart(p, mortgages, banks)?.label).toBe('Danske')
  })
  it('change-bank: new mortgage resolves to the new bank, old parts to the old bank', () => {
    const oldPart = part({ id: 'p1', mortgage_id: 'm1' })
    const newPart = part({ id: 'p2', mortgage_id: 'm2' })
    expect(bankForPart(oldPart, mortgages, banks)?.label).toBe('Danske')
    expect(bankForPart(newPart, mortgages, banks)?.label).toBe('SBAB')
  })
  it('legacy row with no mortgage_id resolves to null without crashing', () => {
    const legacy = part({ id: 'p1', mortgage_id: null })
    expect(mortgageForPart(legacy, mortgages)).toBeNull()
    expect(bankForPart(legacy, mortgages, banks)).toBeNull()
    // Undefined / empty inputs never throw.
    expect(bankForPart(undefined, [], [])).toBeNull()
    expect(bankForPart(part({ mortgage_id: 'missing' }), mortgages, banks)).toBeNull()
  })
})

// ── Reconcile: no false alarm on pre-import amortisation ─────────────────────
describe('reconcileBalance — origination anchor', () => {
  it('does NOT flag when origination predates the ledger (the 192 000 case)', () => {
    const p = part({ id: 'p1', original_balance: 1200000, original_date: '2020-01-01' })
    const pays = [saldo('p1', '2024-01-01', 1008000), saldo('p1', '2024-06-01', 1000000)]
    const r = reconcileBalance([p], pays)[0]
    expect(r.drift).toBeNull()
  })
  it('still fires on a genuine partial import (origination within the window, unexplained gap)', () => {
    const p = part({ id: 'p1', original_balance: 1200000, original_date: '2024-01-01' })
    // Earliest ledger row is on the origination date; no amortisation between →
    // the opening Saldo should equal the anchor, but it is 192 000 short.
    const pays = [saldo('p1', '2024-01-01', 1008000)]
    const r = reconcileBalance([p], pays)[0]
    expect(r.drift).toBe(192000)
  })
  it('reconciles forward when the logged amortisation explains the gap → no drift', () => {
    const p = part({ id: 'p1', original_balance: 1000000, original_date: '2024-01-01' })
    const pays = [amort('p1', '2024-03-01', 20000), saldo('p1', '2024-06-01', 980000)]
    const r = reconcileBalance([p], pays)[0]
    expect(r.drift).toBe(0)
  })
  it('never crashes on malformed anchors', () => {
    const p = part({ id: 'p1', original_balance: 'x' as unknown as number, start_balance: -5 })
    const pays = [saldo('p1', '2024-01-01', 1000000)]
    expect(() => reconcileBalance([p], pays)).not.toThrow()
    expect(reconcileBalance([p], pays)[0].drift).toBeNull()
  })
})

// ── Strict dated rate-period resolution (plan 126) ───────────────────────────
describe('effectiveRatePeriod — strict dated coverage', () => {
  const p = part({ id: 'p1' })
  const rp = (over: Partial<RatePeriod> & { id: string }): RatePeriod => ({
    created_at: 't', loan_part_id: 'p1', start_date: '2026-01-01', end_date: null,
    rate: 3.6, rate_type: 'rörlig', ...over,
  })

  it('THE REPORTED BUG: a period ending today is still current when a successor starts tomorrow', () => {
    // Owner report 2026-07-31 — saving the successor made it today's rate.
    const current = rp({ id: 'now', start_date: '2026-01-01', end_date: '2026-07-31', rate: 3.93 })
    const successor = rp({ id: 'next', start_date: '2026-08-01', end_date: null, rate: 3.54 })
    const periods = [current, successor]
    expect(effectiveRatePeriod(p, periods, '2026-07-31')?.id).toBe('now')
    expect(effectiveRatePeriod(p, periods, '2026-07-31')?.rate).toBe(3.93)
    expect(effectiveRatePeriod(p, periods, '2026-08-01')?.id).toBe('next')
    expect(strictRatePeriodCoverage(p, periods, '2026-07-31')).toBe('covered')
    expect(strictRatePeriodCoverage(p, periods, '2026-08-01')).toBe('covered')
  })

  it('a gap between two periods has no current rate', () => {
    const periods = [
      rp({ id: 'a', start_date: '2026-01-01', end_date: '2026-06-30' }),
      rp({ id: 'b', start_date: '2026-08-01', end_date: null, rate: 4.1 }),
    ]
    expect(effectiveRatePeriod(p, periods, '2026-07-15')).toBeNull()
    expect(strictRatePeriodCoverage(p, periods, '2026-07-15')).toBe('outside-known-terms')
    // The days on either side of the gap are still covered.
    expect(effectiveRatePeriod(p, periods, '2026-06-30')?.id).toBe('a')
    expect(effectiveRatePeriod(p, periods, '2026-08-01')?.id).toBe('b')
  })

  it('overlapping periods return no rate rather than picking the later start', () => {
    const periods = [
      rp({ id: 'a', start_date: '2026-01-01', end_date: '2026-08-31', rate: 3.93 }),
      rp({ id: 'b', start_date: '2026-07-01', end_date: null, rate: 3.54 }),
    ]
    expect(effectiveRatePeriod(p, periods, '2026-07-15')).toBeNull()
    expect(strictRatePeriodCoverage(p, periods, '2026-07-15')).toBe('outside-known-terms')
    // Days covered by exactly one of the two still resolve.
    expect(effectiveRatePeriod(p, periods, '2026-06-30')?.id).toBe('a')
    expect(effectiveRatePeriod(p, periods, '2026-09-01')?.id).toBe('b')
  })

  it('an all-future timeline is never promoted to today', () => {
    const periods = [rp({ id: 'future', start_date: '2026-09-01', end_date: null })]
    expect(effectiveRatePeriod(p, periods, '2026-07-31')).toBeNull()
    expect(strictRatePeriodCoverage(p, periods, '2026-07-31')).toBe('outside-known-terms')
  })

  it('an all-expired timeline is never stretched to today', () => {
    const periods = [
      rp({ id: 'old', start_date: '2024-01-01', end_date: '2025-12-31' }),
      rp({ id: 'older', start_date: '2023-01-01', end_date: '2023-12-31', rate: 1.5 }),
    ]
    expect(effectiveRatePeriod(p, periods, '2026-07-31')).toBeNull()
    expect(strictRatePeriodCoverage(p, periods, '2026-07-31')).toBe('outside-known-terms')
  })

  it('an open-ended current period covers every day from its start onwards', () => {
    const periods = [rp({ id: 'rorlig', start_date: '2026-03-01', end_date: null })]
    expect(effectiveRatePeriod(p, periods, '2026-03-01')?.id).toBe('rorlig')
    expect(effectiveRatePeriod(p, periods, '2030-12-31')?.id).toBe('rorlig')
    expect(effectiveRatePeriod(p, periods, '2026-02-28')).toBeNull()
  })

  it('the bare call is unchanged: latest start wins, regardless of coverage', () => {
    const periods = [
      rp({ id: 'old', start_date: '2024-01-01', end_date: '2025-12-31', rate: 1.5 }),
      rp({ id: 'future', start_date: '2026-09-01', end_date: null, rate: 3.54 }),
    ]
    expect(effectiveRatePeriod(p, periods)?.id).toBe('future')
    // Periods with no rate, and other parts' periods, are still ignored.
    expect(effectiveRatePeriod(p, [rp({ id: 'norate', rate: null })])).toBeNull()
    expect(effectiveRatePeriod(p, [rp({ id: 'other', loan_part_id: 'p2' })])).toBeNull()
    expect(effectiveRatePeriod(p, [])).toBeNull()
  })

  it('strictRatePeriodCoverage still separates "never configured" from "not for this day"', () => {
    expect(strictRatePeriodCoverage(p, [], '2026-07-31')).toBe('unconfigured')
    expect(strictRatePeriodCoverage(p, [rp({ id: 'norate', rate: null })], '2026-07-31')).toBe('unconfigured')
    expect(strictRatePeriodCoverage(p, [rp({ id: 'other', loan_part_id: 'p2' })], '2026-07-31')).toBe('unconfigured')
  })
})

// ── learnYearBasis no longer scores pairs outside the entered terms ──────────
describe('learnYearBasis — strict resolution skips out-of-coverage pairs', () => {
  const B = 1_200_000
  const learner = part({ id: 'p1', mortgage_id: 'm1', start_balance: B, start_date: '2025-12-01' })
  // 1 200 000 × 3,60 % / 360 = 120 kr/day → 30 whole /360 days per charge.
  const interest = (date: string, amount: number): Payment => ({
    id: 'i-' + date, created_at: 't', loan_part_id: 'p1', date, kind: 'interest',
    description: 'Ränta', amount, balance_after: B, paid_by: 'joint', source: 'import',
  })
  const rows = [interest('2026-05-31', 3600), interest('2026-06-30', 3600)]
  const terms = (end_date: string | null): RatePeriod[] => [
    { id: 'w1', created_at: 't', loan_part_id: 'p1', start_date: '2026-01-01', end_date, rate: 3.6, rate_type: 'bunden' },
  ]

  it('scores a pair whose whole accrual sits inside one bunden period', () => {
    const r = learnYearBasis([learner], terms('2026-12-31'), rows)
    expect(r.used).toBe(1)
    expect(r.windows).toBe(1)
  })

  it('REGRESSION: an expired period no longer swallows charges billed after it', () => {
    // Both dates fall after 2026-03-31. The old fallback resolved both to the
    // same latest period, so `rpPrev.id === rp.id` passed and the pair was
    // scored against terms that had already lapsed.
    const r = learnYearBasis([learner], terms('2026-03-31'), rows)
    expect(r.used).toBe(0)
    expect(r.windows).toBe(0)
  })
})

// ── Per-part mixed binding preserved under a mortgage ────────────────────────
describe('per-part mixed rörlig/bunden still groups within a mortgage', () => {
  it('a bunden and a rörlig part under one mortgage forecast on their own periods', () => {
    const bunden = part({ id: 'p1', mortgage_id: 'm1', start_balance: 500000, start_date: '2023-01-01' })
    const rorlig = part({ id: 'p2', mortgage_id: 'm1', start_balance: 500000, start_date: '2023-01-01' })
    const periods: RatePeriod[] = [
      { id: 'r1', created_at: 't', loan_part_id: 'p1', start_date: '2023-01-01', end_date: '2026-01-01', rate: 3.5, rate_type: 'bunden' },
      { id: 'r2', created_at: 't', loan_part_id: 'p2', start_date: '2023-01-01', end_date: null, rate: 4.2, rate_type: 'rörlig' },
    ]
    const groups = groupLoanParts([bunden, rorlig], periods, [])
    // Distinct reprice destinies → two separate groups, each keeping its type.
    expect(groups).toHaveLength(2)
    const bundenGroup = groups.find(g => g.rate_type === 'bunden')
    const rorligGroup = groups.find(g => g.is_catchall)
    expect(bundenGroup?.parts.map(p => p.id)).toEqual(['p1'])
    expect(rorligGroup?.parts.map(p => p.id)).toEqual(['p2'])
  })
})
