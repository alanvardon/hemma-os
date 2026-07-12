// Plan 23 — expected next charge: forecast + reconcile + predicted-row matching.
// Every expected number is hand-computed with the arithmetic shown in the
// comment next to it (interest = balance × rate/100 × days/365).
import { describe, it, expect } from 'vitest'
import {
  expectedCharge, expectedCharges, forecastInterest, reconcileCharge,
  matchPredictedRows, hasChargeInMonth, pendingCharge, partBalance,
} from './mortgage'
import type { LoanPart, Payment, RatePeriod } from './mortgage'

function part(over: Partial<LoanPart> = {}): LoanPart {
  return { id: 'p1', created_at: '', label: 'Del 1', loan_number: '', start_balance: 0, start_date: '2026-01-01', archived: false, ...over }
}
function period(over: Partial<RatePeriod> = {}): RatePeriod {
  return { id: 'r1', created_at: '', loan_part_id: 'p1', start_date: '2026-01-01', end_date: null, rate: 3.65, rate_type: 'rörlig', ...over }
}
function interestRow(date: string, amount: number, over: Partial<Payment> = {}): Payment {
  return {
    id: 'i' + date, created_at: '', loan_part_id: 'p1', date, kind: 'interest',
    description: 'Ränta', amount, balance_after: 1_000_000, paid_by: 'joint', source: 'import:bank.csv', ...over,
  }
}

// Clean monthly history on the 27th, 1 000 000 kr flat, bank on a 365-day
// basis at 3.65 % — every charge is exactly 100 kr × days in the interval, so
// derivedRate reverse-engineers 3.65 % and matches the listed rate.
//   2026-03-27 → 04-27: 31 d → 3 100 · 04-27 → 05-27: 30 d → 3 000 · 05-27 → 06-27: 31 d → 3 100
const CLEAN = [
  interestRow('2026-03-27', 3100),
  interestRow('2026-04-27', 3100),
  interestRow('2026-05-27', 3000),
  interestRow('2026-06-27', 3100),
]

describe('expectedCharge', () => {
  it('golden monthly case: derived rate, day-of-month cadence, interest to the öre', () => {
    const c = expectedCharge(part(), [period()], CLEAN)!
    expect(c).not.toBeNull()
    expect(c.next_date).toBe('2026-07-27')          // last date + 1 month at the mode day
    expect(c.days).toBe(30)                         // 27 jun → 27 jul
    expect(c.period_months).toBe(1)
    expect(c.balance).toBe(1_000_000)
    expect(c.rate).toBe(3.65)
    expect(c.rate_source).toBe('derived')
    expect(c.rate_type).toBe('rörlig')
    // 1 000 000 × 3.65/100 × 30/365 = 3 000 exactly
    expect(c.interest).toBe(3000)
    expect(c.amortization).toBe(0)                  // interest-only: balance flat
    expect(c.gross).toBe(3000)
    expect(c.confidence).toBe('assumed')            // rörlig held flat
    expect(c.calibration_gap).toBe(0)               // listed 3.65 − derived 3.65
  })

  it('absorbs a 360-day-basis bank via the derived rate; calibration_gap is the diagnostic', () => {
    // Bank bills listed 3.50 % on a 360-day basis: charge = 1 000 000 × 0.035 × days/360.
    //   31 d → 3 013.89 · 30 d → 2 916.67 — implies 3.50 × 365/360 ≈ 3.5486 → r2 → 3.55 %.
    const pays = [
      interestRow('2026-03-27', 3013.89),
      interestRow('2026-04-27', 3013.89),
      interestRow('2026-05-27', 2916.67),
      interestRow('2026-06-27', 3013.89),
    ]
    const c = expectedCharge(part(), [period({ rate: 3.50 })], pays)!
    expect(c.rate).toBe(3.55)
    expect(c.rate_source).toBe('derived')
    // Predicting with the listed 3.50 would run ~1.4 % cold and flag drift every
    // month; the derived 3.55 matches the bank: 1 000 000 × 3.55/100 × 30/365 = 2 917.81.
    expect(c.interest).toBe(2917.81)
    expect(c.calibration_gap).toBe(-0.05)           // listed 3.50 − derived 3.55
  })

  it('clamps the charge day to month end: billed on the 31st → 30 April', () => {
    const pays = [
      interestRow('2026-01-31', 3100),
      interestRow('2026-02-28', 2800),
      interestRow('2026-03-31', 3100),
    ]
    // Gaps 28 & 31 d → median 29.5 → monthly; day mode = 31 (twice) over 28 (once).
    const c = expectedCharge(part(), [period()], pays)!
    expect(c.period_months).toBe(1)
    expect(c.next_date).toBe('2026-04-30')
    expect(c.days).toBe(30)
  })

  it('clamps into February', () => {
    const pays = [interestRow('2026-12-31', 3100), interestRow('2027-01-31', 3100)]
    const c = expectedCharge(part(), [period()], pays)!
    expect(c.next_date).toBe('2027-02-28')          // 2027 is not a leap year
    expect(c.days).toBe(28)
  })

  it('charge-day tie → most recent day wins', () => {
    const pays = [
      interestRow('2026-01-27', 3100), interestRow('2026-02-26', 3000),
      interestRow('2026-03-27', 2900), interestRow('2026-04-26', 3000),
    ]
    const c = expectedCharge(part(), [period()], pays)!
    expect(c.next_date).toBe('2026-05-26')          // 26 and 27 both ×2; 26 is more recent
  })

  it('detects kvartalsvis cadence and prices the actual 92-day quarter', () => {
    // Exactly 3.65 %: charge = 100 kr × days. 15 jan → 15 apr: 90 d · 15 apr → 15 jul: 91 d.
    const pays = [
      interestRow('2026-01-15', 9000),
      interestRow('2026-04-15', 9000),
      interestRow('2026-07-15', 9100),
    ]
    const c = expectedCharge(part(), [period()], pays)!
    expect(c.period_months).toBe(3)
    expect(c.next_date).toBe('2026-10-15')
    expect(c.days).toBe(92)                         // 15 jul → 15 okt
    // 1 000 000 × 3.65/100 × 92/365 = 9 200
    expect(c.interest).toBe(9200)
  })

  it('falls back to the listed rate with confidence unknown on thin history', () => {
    // One interest row — derivedRate needs ≥ 2 rows, so listed 3.50 % is used.
    const c = expectedCharge(part(), [period({ rate: 3.50 })], [interestRow('2026-06-27', 3100)])!
    expect(c.rate).toBe(3.50)
    expect(c.rate_source).toBe('listed')
    expect(c.confidence).toBe('unknown')
    expect(c.calibration_gap).toBeNull()
    expect(c.next_date).toBe('2026-07-27')          // cold start: monthly, last row's day
    // 1 000 000 × 3.50/100 × 30/365 = 2 876.71
    expect(c.interest).toBe(2876.71)
  })

  it('bunden inside its binding ⇒ exact; no rate period at all keeps assumed', () => {
    const bunden = period({ rate_type: 'bunden', end_date: '2027-12-31' })
    expect(expectedCharge(part(), [bunden], CLEAN)!.confidence).toBe('exact')
    // Derived history but no rate period: still predicts (derived), stays assumed.
    const noPeriod = expectedCharge(part(), [], CLEAN)!
    expect(noPeriod.confidence).toBe('assumed')
    expect(noPeriod.rate).toBe(3.65)
    expect(noPeriod.calibration_gap).toBeNull()
  })

  it('bunden past its villkorsändringsdag drops back to assumed', () => {
    const expired = period({ rate_type: 'bunden', end_date: '2026-07-01' }) // before next_date 2026-07-27
    expect(expectedCharge(part(), [expired], CLEAN)!.confidence).toBe('assumed')
  })

  it('returns null only when there is neither an interest row nor a rate period', () => {
    expect(expectedCharge(part(), [], [])).toBeNull()
    // Rate period but no history: cold start off today, listed rate, unknown.
    const c = expectedCharge(part({ start_balance: 500_000 }), [period({ rate: 3.50 })], [])!
    expect(c).not.toBeNull()
    expect(c.rate_source).toBe('listed')
    expect(c.confidence).toBe('unknown')
    expect(c.period_months).toBe(1)
    expect(c.balance).toBe(500_000)
    expect(c.interest).toBeGreaterThan(0)
  })

  it('predicts the amortering from the observed monthly balance drop', () => {
    // Same 27th-of-month cadence, but the saldo steps down 3 000 kr/month —
    // monthlyAmortizationRate reads the drop off the balance timeline. The
    // part is anchored where the history starts: an earlier start_date with
    // start_balance 0 would put zero-months in front and zero out the drop.
    const pays = [
      interestRow('2026-03-27', 3100, { balance_after: 1_000_000 }),
      interestRow('2026-04-27', 3100, { balance_after: 997_000 }),
      interestRow('2026-05-27', 3000, { balance_after: 994_000 }),
      interestRow('2026-06-27', 3100, { balance_after: 991_000 }),
    ]
    const c = expectedCharge(part({ start_date: '2026-03-01', start_balance: 1_000_000 }), [period()], pays)!
    expect(c.balance).toBe(991_000)
    expect(c.amortization).toBe(3000)
    expect(c.gross).toBe(Math.round((c.interest + 3000) * 100) / 100)
  })

  it('ignores logged predictions when calibrating (round-trip invariance)', () => {
    const before = expectedCharge(part(), [period()], CLEAN)!
    const logged: Payment = {
      id: 'pred1', created_at: '', loan_part_id: 'p1', date: before.next_date, kind: 'interest',
      description: 'Förväntad avi', amount: before.interest, balance_after: before.balance,
      paid_by: 'joint', source: 'predicted',
    }
    const after = expectedCharge(part(), [period()], [...CLEAN, logged])
    expect(after).toEqual(before)                   // prediction doesn't feed itself
    // …and the ledger balance is untouched for an interest-only part.
    expect(partBalance(part(), [...CLEAN, logged])).toBe(1_000_000)
  })
})

describe('pendingCharge (rolls past covered months)', () => {
  const loggedJuly: Payment = {
    id: 'pred1', created_at: '', loan_part_id: 'p1', date: '2026-07-27', kind: 'interest',
    description: 'Förväntad avi', amount: 3000, balance_after: 1_000_000, paid_by: 'joint', source: 'predicted',
  }

  it('equals expectedCharge while the next month is uncovered', () => {
    expect(pendingCharge(part(), [period()], CLEAN)).toEqual(expectedCharge(part(), [period()], CLEAN))
  })

  it('advances to the following month once the predicted month is logged', () => {
    const c = pendingCharge(part(), [period()], [...CLEAN, loggedJuly])!
    expect(c.next_date).toBe('2026-08-27')
    expect(c.days).toBe(31)                         // 27 jul → 27 aug
    expect(c.balance).toBe(1_000_000)               // interest-only: flat
    // 1 000 000 × 3.65/100 × 31/365 = 3 100
    expect(c.interest).toBe(3100)
    expect(c.rate).toBe(3.65)                       // calibration untouched by the predicted row
  })

  it('returns to the unclamped billing day after a clamped month', () => {
    // Billed on the 31st; April clamps to the 30th. Once 30 Apr is logged,
    // the roll must come back to 31 May — not drift to the 30th forever.
    const pays = [
      interestRow('2026-01-31', 3100), interestRow('2026-02-28', 2800), interestRow('2026-03-31', 3100),
      { ...loggedJuly, id: 'predApr', date: '2026-04-30' },
    ]
    const c = pendingCharge(part(), [period()], pays)!
    expect(c.charge_day).toBe(31)
    expect(c.next_date).toBe('2026-05-31')
    expect(c.days).toBe(31)
  })

  it('steps the balance down by the amortering when rolling an amortizing part', () => {
    const amortizing = [
      interestRow('2026-03-27', 3100, { balance_after: 1_000_000 }),
      interestRow('2026-04-27', 3100, { balance_after: 997_000 }),
      interestRow('2026-05-27', 3000, { balance_after: 994_000 }),
      interestRow('2026-06-27', 3100, { balance_after: 991_000 }),
      { ...loggedJuly, amount: 2981.15, balance_after: 988_000 },
    ]
    const c = pendingCharge(part({ start_date: '2026-03-01', start_balance: 1_000_000 }), [period()], amortizing)!
    expect(c.next_date).toBe('2026-08-27')
    expect(c.balance).toBe(988_000)                 // 991 000 − 3 000 predicted amortering
    expect(c.amortization).toBe(3000)
  })
})

describe('expectedCharges / forecastInterest', () => {
  it('sums active parts and skips archived ones', () => {
    const p2 = part({ id: 'p2', label: 'Del 2' })
    const p2pays = CLEAN.map(p => ({ ...p, id: p.id + '-2', loan_part_id: 'p2', balance_after: 2_000_000, amount: p.amount * 2 }))
    const dead = part({ id: 'p3', archived: true })
    const res = expectedCharges([part(), p2, dead], [period(), period({ id: 'r2', loan_part_id: 'p2' })], [...CLEAN, ...p2pays])
    expect(res.rows).toHaveLength(2)
    expect(res.total_interest).toBe(3000 + 6000)
    expect(res.total_gross).toBe(9000)
  })

  it('12-month flat forecast = 12 × one monthly charge, through ränteavdrag', () => {
    const f = forecastInterest([part()], [period()], CLEAN)
    expect(f.interest).toBe(36_000)                 // 12 × 3 000
    expect(f.deduction).toBe(10_800)                // 36 000 × 0.30 (below the knee)
    expect(f.net).toBe(25_200)
    expect(f.assumed).toBe(true)                    // rörlig held flat
  })

  it('applies the 100 000 kr / 30→21 % knee', () => {
    // Scale ×10: 10 000 000 kr flat, charges 1 000 kr × days → 30 000 kr/month.
    const big = CLEAN.map(p => ({ ...p, amount: p.amount * 10, balance_after: 10_000_000 }))
    const f = forecastInterest([part()], [period()], big)
    expect(f.interest).toBe(360_000)
    // 100 000 × 0.30 + 260 000 × 0.21 = 30 000 + 54 600 = 84 600
    expect(f.deduction).toBe(84_600)
    expect(f.net).toBe(275_400)
  })

  it('assumed is false only when every part is bunden inside its binding', () => {
    const bunden = period({ rate_type: 'bunden', end_date: '2027-12-31' })
    expect(forecastInterest([part()], [bunden], CLEAN).assumed).toBe(false)
  })
})

describe('reconcileCharge', () => {
  it('tolerance is max(50 kr, 1 %) — boundary values pass, just past them flag', () => {
    // Small charge (1 % = 30 kr < 50 kr): the 50 kr floor governs.
    expect(reconcileCharge(3000, 3050).ok).toBe(true)      // drift exactly 50
    expect(reconcileCharge(3000, 2950).ok).toBe(true)      // symmetric
    expect(reconcileCharge(3000, 3050.01).ok).toBe(false)  // just past the floor
    // Large charge (1 % = 100 kr > 50 kr): the percentage governs.
    expect(reconcileCharge(10_000, 10_100).ok).toBe(true)  // drift exactly 1 %
    expect(reconcileCharge(10_000, 10_100.02).ok).toBe(false)
  })

  it('accepts a full ExpectedCharge and reports signed drift', () => {
    const c = expectedCharge(part(), [period()], CLEAN)!
    const r = reconcileCharge(c, 3175)
    expect(r).toEqual({ expected: 3000, actual: 3175, drift: 175, ok: false })
  })
})

describe('matchPredictedRows', () => {
  const predicted: Payment = {
    id: 'pred1', created_at: '', loan_part_id: 'p1', date: '2026-07-27', kind: 'interest',
    description: 'Förväntad avi', amount: 3000, balance_after: 1_000_000, paid_by: 'joint', source: 'predicted',
  }

  it('pairs an interest draft with the predicted row on the same part + month', () => {
    const drafts: Array<Partial<Payment>> = [
      { loan_part_id: 'p1', date: '2026-07-25', kind: 'interest', amount: 3010 },      // matches (same month)
      { loan_part_id: 'p1', date: '2026-07-25', kind: 'amortization', amount: 3010 },  // no predicted amortering row
      { loan_part_id: 'p2', date: '2026-07-25', kind: 'interest', amount: 3010 },      // wrong part
      { loan_part_id: 'p1', date: '2026-08-27', kind: 'interest', amount: 3010 },      // wrong month
    ]
    const m = matchPredictedRows([...CLEAN, predicted], drafts)
    expect(m).toHaveLength(1)
    expect(m[0].draftIndex).toBe(0)
    expect(m[0].predicted.id).toBe('pred1')
    expect(m[0].recon).toEqual({ expected: 3000, actual: 3010, drift: 10, ok: true })
  })

  it('pairs ränta and amortering drafts each with the predicted row of ITS kind', () => {
    const predictedAmort: Payment = { ...predicted, id: 'pred2', kind: 'amortization', amount: 3000 }
    const m = matchPredictedRows([predicted, predictedAmort], [
      { loan_part_id: 'p1', date: '2026-07-27', kind: 'amortization', amount: 3000 },
      { loan_part_id: 'p1', date: '2026-07-27', kind: 'interest', amount: 3010 },
    ])
    expect(m).toHaveLength(2)
    expect(m.find(x => x.draftIndex === 0)!.predicted.id).toBe('pred2')  // amort ↔ amort
    expect(m.find(x => x.draftIndex === 1)!.predicted.id).toBe('pred1')  // ränta ↔ ränta
  })

  it('ignores non-predicted existing rows and consumes each predicted row once', () => {
    // Only real imports in the ledger → nothing to supersede.
    expect(matchPredictedRows(CLEAN, [{ loan_part_id: 'p1', date: '2026-06-25', kind: 'interest', amount: 3100 }]))
      .toHaveLength(0)
    // Two interest drafts in the predicted month: only the first pairs.
    const m = matchPredictedRows([predicted], [
      { loan_part_id: 'p1', date: '2026-07-25', kind: 'interest', amount: 3000 },
      { loan_part_id: 'p1', date: '2026-07-27', kind: 'interest', amount: 3000 },
    ])
    expect(m).toHaveLength(1)
  })

  it('flags drift outside tolerance', () => {
    const m = matchPredictedRows([predicted], [{ loan_part_id: 'p1', date: '2026-07-27', kind: 'interest', amount: 3175 }])
    expect(m[0].recon.ok).toBe(false)
    expect(m[0].recon.drift).toBe(175)
  })
})

describe('hasChargeInMonth (double-log guard)', () => {
  it('sees both real and predicted rows of the asked kind in the month', () => {
    const predicted: Payment = {
      id: 'pred1', created_at: '', loan_part_id: 'p1', date: '2026-07-27', kind: 'interest',
      description: '', amount: 3000, balance_after: null, paid_by: 'joint', source: 'predicted',
    }
    expect(hasChargeInMonth([...CLEAN, predicted], 'p1', '2026-07-01')).toBe(true)  // predicted counts
    expect(hasChargeInMonth(CLEAN, 'p1', '2026-06-15')).toBe(true)                  // real counts
    expect(hasChargeInMonth(CLEAN, 'p1', '2026-07-15')).toBe(false)                 // nothing logged yet
    expect(hasChargeInMonth(CLEAN, 'p2', '2026-06-15')).toBe(false)                 // other part
    expect(hasChargeInMonth(CLEAN, null, '2026-06-15')).toBe(false)
    // Kind-scoped: an interest row does not cover the amortering slot.
    expect(hasChargeInMonth(CLEAN, 'p1', '2026-06-15', 'amortization')).toBe(false)
    const amort: Payment = { ...predicted, id: 'a1', kind: 'amortization' }
    expect(hasChargeInMonth([amort], 'p1', '2026-07-15', 'amortization')).toBe(true)
  })
})
