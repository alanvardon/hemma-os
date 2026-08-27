// Plan 127 §5 — Historiken (derivedRate) must reverse-engineer the rate from
// REAL imported/manual rows only. Plan 126 froze an accepted forecast row
// forever as source:'predicted' even once it is authoritative for balance
// (see resolvePartBalance's comment, mortgage.ts ~468-472); replaying that
// same row back into this estimator would let a logged prediction inflate
// confidence in the very number it was generated from. The existing
// `source !== 'predicted'` marker (mortgage.ts:546, :1588, :1661, :1807 …) is
// still current after plan 126, so derivedRate reuses it.
import { describe, it, expect } from 'vitest'
import { derivedRate } from './mortgage'
import type { LoanPart, Payment } from './mortgage'

function part(over: Partial<LoanPart> = {}): LoanPart {
  return {
    id: 'p1', created_at: '', label: 'Del 1', loan_number: '',
    start_balance: 1_000_000, start_date: '2026-01-01', archived: false, ...over,
  }
}
function interestRow(date: string, amount: number, over: Partial<Payment> = {}): Payment {
  return {
    id: 'i' + date, created_at: '', loan_part_id: 'p1', date, kind: 'interest',
    description: 'Ränta', amount, balance_after: 1_000_000, paid_by: 'joint',
    source: 'import:bank.csv', ...over,
  }
}

// Clean monthly history on the 27th, 1 000 000 kr flat, 3,65 % on a 365-day
// basis — the same golden fixture as mortgage-forecast.test.ts's CLEAN.
//   03-27→04-27: 31 d → 3 100 kr · 04-27→05-27: 30 d → 3 000 kr · 05-27→06-27: 31 d → 3 100 kr
// Each interval: amount / balance × 365/days = 3100/1_000_000 × 365/31
//   = 100 × 365 / 1_000_000 = 0,0365 → 3,65 % exactly, in all three intervals,
// so the day-weighted average is 3,65 % regardless of the interval weights.
const REAL = [
  interestRow('2026-03-27', 3100),
  interestRow('2026-04-27', 3100),
  interestRow('2026-05-27', 3000),
  interestRow('2026-06-27', 3100),
]

describe('derivedRate — real rows only (plan 127 §5)', () => {
  it('reverse-engineers 3,65 % from a clean real history', () => {
    expect(derivedRate(part(), REAL)).toBe(3.65)
  })

  it('does not move when an accepted forecast row (source: predicted) is appended', () => {
    const baseline = derivedRate(part(), REAL)
    // 6 000 kr instead of ~3 100 kr for the same 30-day gap would roughly
    // double the derived rate if this interval fed the trailing-3 window.
    const withPredicted = [...REAL, interestRow('2026-07-27', 6000, { source: 'predicted' })]
    expect(derivedRate(part(), withPredicted)).toBe(baseline)
  })

  it('does move when the same amount lands as a real (non-predicted) row', () => {
    const baseline = derivedRate(part(), REAL)
    const withReal = [...REAL, interestRow('2026-07-27', 6000, { source: 'import:bank2.csv' })]
    expect(derivedRate(part(), withReal)).not.toBe(baseline)
  })

  it('ignores a predicted row entirely even as the ONLY history (fewer than 2 real rows)', () => {
    // Only one real interest row plus a predicted one — derivedRate requires
    // at least two REAL observations to form an interval, so this must stay
    // null rather than pairing the real row with the predicted one.
    const onlyOneReal = [interestRow('2026-03-27', 3100), interestRow('2026-04-27', 6000, { source: 'predicted' })]
    expect(derivedRate(part(), onlyOneReal)).toBeNull()
  })
})
