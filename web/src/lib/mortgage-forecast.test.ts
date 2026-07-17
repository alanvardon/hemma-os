// Plan 23 — expected next charge: forecast + reconcile + predicted-row matching.
// Every expected number is hand-computed with the arithmetic shown in the
// comment next to it (interest = balance × rate/100 × days/365).
import { describe, it, expect } from 'vitest'
import {
  expectedCharge, expectedCharges, forecastInterest, reconcileCharge,
  matchPredictedRows, hasChargeInMonth, pendingCharge, pendingChargeSeries, partBalance,
  stalePredictedRows, makeLoanPart, effectiveDeclaredAmortization, declaredMonthlyAmortization,
  projectMilestones, profileYearBasis, makeBank,
  learnYearBasis, suggestBankProfile, bankProfileDrift, profileBilling, strictRatePeriodCoverage,
} from './mortgage'
import type { LoanPart, Payment, RatePeriod, Bank, Mortgage } from './mortgage'

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

  it('a bunden part predicts on its contractual rate, not the lagging derived estimate', () => {
    // Locked at a bunden 3.93 %, but the billed history derives to only 3.50 %
    // (an old rate, or a low-billed month still inside the averaging window —
    // the ~2 % cold undershoot seen on the household's parts). For the binding
    // period the contractual rate is ground truth, so the forecast must use
    // 3.93 %, not the derived estimate.
    const lowBilled = [
      interestRow('2026-03-27', 2972.60, { id: 'lb0' }),   // 3.50 % history (seed)
      interestRow('2026-04-27', 2972.60, { id: 'lb1' }),   // 31 d: 1M × 3.50 % × 31/365
      interestRow('2026-05-27', 2876.71, { id: 'lb2' }),   // 30 d: 1M × 3.50 % × 30/365
      interestRow('2026-06-27', 2972.60, { id: 'lb3' }),   // 31 d
    ]
    const bunden = period({ rate: 3.93, rate_type: 'bunden', end_date: '2027-12-31' })
    const c = expectedCharge(part(), [bunden], lowBilled)!
    expect(c.charge_basis).toBe('days')
    expect(c.rate).toBe(3.93)                             // the contractual rate…
    expect(c.rate_source).toBe('listed')                 // …not the derived 3.50 %
    expect(c.confidence).toBe('exact')
    // 1 000 000 × 3.93 % × 30/365 = 3 230.14 — not the derived 2 876.71
    expect(c.interest).toBe(3230.14)
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
    // Amorteringskravets bas: the ORIGINAL loan size, so the 1/2/3 % tiers
    // stay pinned as the balance shrinks (3 000 × 12 / 1 000 000 = 3,6 %).
    expect(c.original_balance).toBe(1_000_000)
    expect(c.amortization).toBe(3000)
    expect(c.gross).toBe(Math.round((c.interest + 3000) * 100) / 100)
  })

  it('predicts the FULL amortering per avi from recent amortering rows, ignoring insatser', () => {
    // Explicit amortering rows exist → use their charge amount (median of the
    // trailing 3), NOT the diluted balance-timeline drop. The 50 000 kr extra
    // amortering is flagged is_insats and must not skew the prediction.
    const pays = [
      ...CLEAN,
      interestRow('2026-04-27', 3000, { id: 'a1', kind: 'amortization' }),
      interestRow('2026-05-27', 3000, { id: 'a2', kind: 'amortization' }),
      interestRow('2026-06-27', 3100, { id: 'a3', kind: 'amortization' }),
      interestRow('2026-06-15', 50_000, { id: 'x1', kind: 'amortization', is_insats: true }),
    ]
    const c = expectedCharge(part(), [period()], pays)!
    expect(c.amortization).toBe(3000)               // median of 3 000 / 3 000 / 3 100
    expect(c.gross).toBe(c.interest + 3000)
  })

  it('derives the amortering as betalning − ränta from the month-paired rows', () => {
    // The bank reports per part a Ränta row and a "Betalning" row that is the
    // TOTAL debited (ränta included). Amortering = the paired difference:
    //   maj: 6 000 − 3 000 = 3 000 · jun: 6 100 − 3 100 = 3 000.
    // The prediction is the median of the trailing paired months, and the
    // betalning field carries the predicted total (ränta + amortering).
    const pays = [
      ...CLEAN,
      interestRow('2026-05-27', 6000, { id: 'b1', kind: 'payment', description: 'Betalning' }),
      interestRow('2026-06-27', 6100, { id: 'b2', kind: 'payment', description: 'Betalning' }),
    ]
    const c = expectedCharge(part(), [period()], pays)!
    expect(c.amortization).toBe(3000)
    expect(c.interest).toBe(3000)                   // 1 000 000 × 3.65/100 × 30/365
    expect(c.betalning).toBe(6000)                  // ränta + amortering — the bank's total
    expect(c.gross).toBe(6000)
  })

  it('an interest-only part whose betalning equals the ränta predicts amortering 0 — betalning = ränta', () => {
    // Betalning 3 100 = Ränta 3 100 → the part stays flat; the avi still has
    // both rows, so the prediction must too (betalning non-null, no principal).
    const pays = [
      ...CLEAN,
      interestRow('2026-05-27', 3000, { id: 'b1', kind: 'payment', description: 'Betalning' }),
      interestRow('2026-06-27', 3100, { id: 'b2', kind: 'payment', description: 'Betalning' }),
    ]
    const c = expectedCharge(part(), [period()], pays)!
    expect(c.amortization).toBe(0)
    expect(c.betalning).toBe(c.interest)
  })

  it('a ledger without betalning rows stays in the legacy shape: betalning is null', () => {
    // Manual ledgers (or other banks) have no per-part total row — the UI
    // then falls back to the separate amortering line item.
    expect(expectedCharge(part(), [period()], CLEAN)!.betalning).toBeNull()
    const withAmort = [
      ...CLEAN,
      interestRow('2026-05-27', 3000, { id: 'a1', kind: 'amortization' }),
      interestRow('2026-06-27', 3000, { id: 'a2', kind: 'amortization' }),
    ]
    const c = expectedCharge(part(), [period()], withAmort)!
    expect(c.amortization).toBe(3000)
    expect(c.betalning).toBeNull()
  })

  it('one-off transfers cannot skew the paired median', () => {
    // A lone big payment row in June (e.g. an extra inbetalning) makes that
    // month's diff jump; the median of the trailing paired months holds.
    const pays = [
      ...CLEAN,
      interestRow('2026-04-27', 6100, { id: 'b0', kind: 'payment', description: 'Betalning' }),
      interestRow('2026-05-27', 6000, { id: 'b1', kind: 'payment', description: 'Betalning' }),
      interestRow('2026-06-27', 6100, { id: 'b2', kind: 'payment', description: 'Betalning' }),
      interestRow('2026-06-15', 50_000, { id: 'x1', kind: 'payment', description: 'Överföring' }),
    ]
    // Diffs: apr 3 000 · maj 3 000 · jun 53 000 → median 3 000.
    expect(expectedCharge(part(), [period()], pays)!.amortization).toBe(3000)
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

describe('flat-monthly billing (30/360 banks)', () => {
  // Danske-style: ränta = balance × rate/12 every month — the charge does NOT
  // scale with the interval's day count (4 061 kr in a 30-day month AND a
  // 31-day month). The days/365 model would wobble ±3 % month to month and,
  // worse, amplify any charge-day noise in the ledger (a 56-day interval →
  // +86 %). Detection: trailing intervals whose charges stay flat while day
  // counts differ → predict from the LAST CHARGE, scaled only by the balance
  // step from amorteringen.
  const B = 1_350_000
  function flatRows(): Payment[] {
    return [
      interestRow('2026-03-01', 4061, { id: 'i1', balance_after: B }),
      interestRow('2026-04-01', 4061, { id: 'i2', balance_after: B }),   // 31-day interval
      interestRow('2026-05-01', 4061, { id: 'i3', balance_after: B }),   // 30-day interval
      interestRow('2026-06-01', 4061, { id: 'i4', balance_after: B }),   // 31-day interval
      interestRow('2026-05-01', 4061, { id: 'b1', kind: 'payment', description: 'Betalning', balance_after: B }),
      interestRow('2026-06-01', 4061, { id: 'b2', kind: 'payment', description: 'Betalning', balance_after: B }),
    ]
  }

  it('an interest-only part predicts EXACTLY the last charge — no day-count wobble', () => {
    const c = expectedCharge(part(), [], flatRows())!
    expect(c.charge_basis).toBe('monthly')
    expect(c.next_date).toBe('2026-07-01')
    expect(c.interest).toBe(4061)                   // NOT 4 061 × 30/31
    expect(c.betalning).toBe(4061)
    expect(c.amortization).toBe(0)
    // Sats shows the bank's nominal monthly-basis rate: 4 061 × 12 / 1 350 000.
    expect(c.rate).toBe(3.61)
  })

  it('rak amortering: the charge steps down with the balance, golden to the öre', () => {
    // Nominal 3,6 % → 0,3 %/month on the balance after the previous month's
    // 8 000 kr amortering: 3 600 → 3 576 → 3 552 → 3 528 → predicts 3 504.
    const pays: Payment[] = []
    let bal = 1_200_000
    const months = ['2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01']
    const charges = [3600, 3576, 3552, 3528]
    months.forEach((d, i) => {
      bal -= 8000
      pays.push(interestRow(d, charges[i], { id: 'i' + i, balance_after: bal }))
      pays.push(interestRow(d, charges[i] + 8000, { id: 'b' + i, kind: 'payment', description: 'Betalning', balance_after: bal }))
    })
    const c = expectedCharge(part(), [], pays)!
    expect(c.charge_basis).toBe('monthly')
    expect(c.balance).toBe(1_168_000)
    expect(c.amortization).toBe(8000)
    expect(c.interest).toBe(3504)                   // 3 528 × 1 168 000 / 1 176 000 = 1 168 000 × 0,3 %
    expect(c.betalning).toBe(11_504)
    expect(c.rate).toBe(3.6)                        // 3 528 × 12 / 1 176 000

    // Rolling holds the pattern: each month −8 000 kr saldo, ränta × B'/B.
    const s = pendingChargeSeries(part(), [], pays)
    expect(s[1].balance).toBe(1_160_000)
    expect(s[1].interest).toBe(3480)                // 3 504 × 1 160 / 1 168
    expect(s[1].betalning).toBe(11_480)
  })

  it('REGRESSION: a moved charge-day cannot scale the amount (the 56-day prod bug)', () => {
    // Legacy ledger rows dated on the 27th outvote the bank's current
    // charge-day (the 1st). The forecast anchors to the current day, so
    // next_date is the 1st (a clean 30-day interval) rather than a 56-day
    // phantom. Belt AND braces: even if the date noise did leak through, the
    // monthly basis keeps the amount fixed — earlier this inflated the ränta
    // by ×56/30 (predicted ~7 565 kr vs the bank's 4 061 kr).
    const noisy = [
      interestRow('2026-02-27', 4061, { id: 'o1', balance_after: B }),
      interestRow('2026-03-27', 4061, { id: 'o2', balance_after: B }),
      interestRow('2026-04-27', 4061, { id: 'o3', balance_after: B }),
      interestRow('2026-05-01', 4061, { id: 'n1', balance_after: B }),
      interestRow('2026-06-01', 4061, { id: 'n2', balance_after: B }),
    ]
    const c = expectedCharge(part(), [], noisy)!
    expect(c.next_date).toBe('2026-07-01')          // anchored to where the bank now bills
    expect(c.days).toBe(30)                         // one month — the phantom 56-day interval is gone
    expect(c.charge_basis).toBe('monthly')
    expect(c.interest).toBe(4061)                   // the amount is immune either way
  })

  it('a bank whose charges track the day count keeps the days/365 model', () => {
    // CLEAN charges are exactly 100 kr × days — proportional to the interval —
    // so the flat-monthly detection must NOT fire.
    const c = expectedCharge(part(), [period()], CLEAN)!
    expect(c.charge_basis).toBe('days')
    expect(c.interest).toBe(3000)
  })
})

describe('billing-day change (days-basis bank)', () => {
  // The bank bills actual/365 — every charge is 100 kr × interval days, so
  // derivedRate reads 3.65 % and charge_basis is 'days' (NOT the flat-monthly
  // case above). It then MOVED its charge day from the 27th to the 1st. The
  // all-history day-mode still picks 27 — it outvotes the two recent 1st-of-
  // month rows — so a naive next_date is 2026-07-27, i.e. 56 days after the
  // last bill on Jun 1. On the days model that inflates the ränta by ×56/30
  // (the real prod bug: ~7 565 kr predicted vs the bank's ~4 061). Unlike the
  // flat-monthly REGRESSION test, the monthly basis does NOT rescue a days-
  // basis bank here, so the interval itself must be corrected: the forecast
  // anchors to where the bank now bills.
  const moved = [
    interestRow('2026-02-27', 3100, { id: 'm0' }),          // seed
    interestRow('2026-03-27', 2800, { id: 'm1' }),          // 28 d → 2 800
    interestRow('2026-04-27', 3100, { id: 'm2' }),          // 31 d → 3 100
    interestRow('2026-05-01', 400, { id: 'm3' }),           // 4 d → 400: the day moves to the 1st
    interestRow('2026-06-01', 3100, { id: 'm4' }),          // 31 d → 3 100
  ]

  it('anchors to the current billing day, not the stale all-history mode', () => {
    const c = expectedCharge(part(), [period()], moved)!
    expect(c.charge_basis).toBe('days')                     // charges track day count
    expect(c.next_date).toBe('2026-07-01')                  // the 1st, where it now bills — NOT 07-27
    expect(c.days).toBe(30)                                 // one month, NOT a 56-day phantom interval
    expect(c.interest).toBe(3000)                           // 1 000 000 × 3.65 % × 30/365, NOT × 56/365 = 5 600
  })
})

describe('end-of-month billing (Danske: last day of month, weekend-rolled)', () => {
  // This bank charges on the LAST day of each month, pushed to the next banking
  // day when month-end is a weekend — so the ledger dates land on the 28th–31st
  // OR on the 1st–2nd of the next month (a rolled month-end), never a fixed
  // mid-month day. Charges are 100 kr × interval days (days basis, 3.65 %).
  //   31 Jan (Sat) → 2 Feb · 28 Feb (Sat) → 2 Mar · 31 Mar · 30 Apr ·
  //   31 May (Sun) → 1 Jun · 30 Jun
  const eom = [
    interestRow('2026-02-02', 3100, { id: 'e0' }),          // Jan month-end, rolled Sat→Mon (seed)
    interestRow('2026-03-02', 2800, { id: 'e1' }),          // Feb, rolled: 28 d → 2 800
    interestRow('2026-03-31', 2900, { id: 'e2' }),          // Mar: 29 d → 2 900
    interestRow('2026-04-30', 3000, { id: 'e3' }),          // Apr: 30 d → 3 000
    interestRow('2026-06-01', 3200, { id: 'e4' }),          // May, rolled Sun→Mon: 32 d → 3 200
    interestRow('2026-06-30', 2900, { id: 'e5' }),          // Jun: 29 d → 2 900
  ]

  it('predicts the last day of next month, not a fixed day-of-month', () => {
    const c = expectedCharge(part(), [period()], eom)!
    expect(c.charge_basis).toBe('days')
    expect(c.next_date).toBe('2026-07-31')                  // month-end, NOT ~the 30th the day-mode would pick
    expect(c.days).toBe(31)                                 // full July accrual (30 Jun → 31 Jul)
    expect(c.interest).toBe(3100)                           // 1 000 000 × 3.65 % × 31/365 — not the 30-day 3 000
  })

  it('rolls month-end to month-end (clamping short months)', () => {
    const s = pendingChargeSeries(part(), [period()], eom)
    expect(s[0].next_date).toBe('2026-07-31')
    expect(s[1].next_date).toBe('2026-08-31')
    expect(s[2].next_date).toBe('2026-09-30')               // clamps to Sep's 30 days
  })

  it('from a rolled early-month last row, the next charge is THIS month-end', () => {
    // Ledger ends on 1 Jun (May's charge, rolled) with June not yet logged —
    // the next uncovered charge is June's, due 30 Jun (a ~one-month interval),
    // never a 60-day jump to July.
    const throughMay = eom.slice(0, 5)                      // …up to 2026-06-01
    const c = expectedCharge(part(), [period()], throughMay)!
    expect(c.next_date).toBe('2026-06-30')
    expect(c.days).toBe(29)                                 // 1 Jun → 30 Jun, one month — never 60 days
  })

  it('a fixed mid-month biller (the 27th) is NOT treated as month-end', () => {
    expect(expectedCharge(part(), [period()], CLEAN)!.next_date).toBe('2026-07-27')
  })

  it('a start-of-month biller (the 1st) is NOT treated as month-end', () => {
    const firsts = [
      interestRow('2026-03-02', 3100, { id: 'f0' }),        // 1st, rolled Sun→Mon
      interestRow('2026-04-01', 3000, { id: 'f1' }),
      interestRow('2026-05-01', 3100, { id: 'f2' }),
      interestRow('2026-06-01', 3100, { id: 'f3' }),
    ]
    const c = expectedCharge(part(), [period()], firsts)!
    expect(c.next_date).toBe('2026-07-01')                  // stays on the 1st, not pushed to 31 Jul
  })
})

describe('360-day bankår (Danske faktisk/360)', () => {
  // Danske accrues the bunden rate over a 360-day year: at 1 200 000 × 3,93 %
  // one day of ränta is exactly 1 200 000 × 0.0393 / 360 = 131,00 kr, and every
  // charge in the household ledger is a whole number of days × 131 (4 192 = 32,
  // 3 930 = 30, 3 799 = 29, 4 061 = 31). Predicting listed/365 undershot every
  // part by 360/365 ≈ −1,4 % (4 005 kr vs the bank's 4 061).
  //
  // CRUCIALLY the bank's charged rentedagar are NOT the elapsed days between
  // postings: the real ledger charges 359 days across a 364-day year (the
  // /360 convention prices ~360 days/year so the annual total ≈ saldo × ränta).
  // A rate-level fit of Σcharge/Σ(saldo × elapsed days) therefore lands BETWEEN
  // the two hypotheses and can flip to /365 — the household's trailing window
  // charged 180 days across 182 elapsed and did exactly that. Only the
  // integer-day property discriminates: charge ÷ (saldo × ränta/360) is a whole
  // number of days on a /360 bank and never on a /365 one. These fixtures are
  // the REAL household ledger, value-date noise included.
  const B = 1_200_000
  const bunden = () => period({ rate: 3.93, rate_type: 'bunden', end_date: '2027-12-31' })
  // A flat (interest-only) part: the bank's actual postings, month-end billed
  // and weekend/holiday-rolled. Comments show the charged days (× 131 kr).
  const danske = [
    interestRow('2025-06-02', 4192, { id: 'g00', balance_after: B }),  // 32 d (maj-terminen, rolled Sat→Mon)
    interestRow('2025-06-30', 3668, { id: 'g01', balance_after: B }),  // 28 d
    interestRow('2025-07-31', 4061, { id: 'g02', balance_after: B }),  // 31 d
    interestRow('2025-09-01', 3930, { id: 'g03', balance_after: B }),  // 30 d (aug, rolled Sun→Mon; 32 d elapsed)
    interestRow('2025-09-30', 3799, { id: 'g04', balance_after: B }),  // 29 d
    interestRow('2025-10-31', 4061, { id: 'g05', balance_after: B }),  // 31 d
    interestRow('2025-12-01', 3930, { id: 'g06', balance_after: B }),  // 30 d (nov, rolled; 31 d elapsed)
    interestRow('2025-12-30', 3799, { id: 'g07', balance_after: B }),  // 29 d (dec, posted the year's last banking day)
    interestRow('2026-02-02', 4192, { id: 'g08', balance_after: B }),  // 32 d (jan, rolled Sat→Mon; 34 d elapsed)
    interestRow('2026-03-02', 3930, { id: 'g09', balance_after: B }),  // 30 d (feb, rolled; only 28 d elapsed)
    interestRow('2026-03-31', 3799, { id: 'g10', balance_after: B }),  // 29 d
    interestRow('2026-04-30', 3799, { id: 'g11', balance_after: B }),  // 29 d (30 d elapsed)
    interestRow('2026-06-01', 4061, { id: 'g12', balance_after: B }),  // 31 d (maj, rolled Sun→Mon; 32 d elapsed)
  ]

  it('golden household case: bunden 3,93 % on 360 basis lands the bank amount to the öre', () => {
    const c = expectedCharge(part(), [bunden()], danske)!
    expect(c.charge_basis).toBe('days')
    expect(c.year_basis).toBe(360)
    expect(c.next_date).toBe('2026-06-30')          // end-of-month biller, anchored one true month past 1 jun
    expect(c.days).toBe(29)
    expect(c.rate).toBe(3.93)
    expect(c.rate_source).toBe('listed')
    // 1 200 000 × 3.93 % / 360 = 131,00 kr/day × 29 = 3 799 — NOT /365's 3 746.96.
    expect(c.interest).toBe(3799)
  })

  it('juni is covered by the 1 juni posting, so the pending series leads with juli = 4 061', () => {
    // THE prod regression: the rate-level fit read this exact ledger as /365
    // and showed 4 005,37 kr for juli. The bank's own forecast is 4 061.
    const s = pendingChargeSeries(part(), [bunden()], danske)
    expect(s[0].next_date).toBe('2026-07-31')
    expect(s[0].days).toBe(31)
    expect(s[0].interest).toBe(4061)                // 31 d × 131 kr
    expect(s[1].next_date).toBe('2026-08-31')
    expect(s[1].interest).toBe(4061)                // 31 d
    expect(s[2].next_date).toBe('2026-09-30')
    expect(s[2].interest).toBe(3930)                // 30 d × 131
  })

  it('amortising part: per-interval balances, and the rolled juli matches the bank to the öre', () => {
    // The household's part 1: 8 000 kr/mån amortering, so each charge accrues
    // on the balance after the PREVIOUS posting. Charges are the bank's real
    // rows — whole-krona roundings of saldo × 3,93 % × dagar/360.
    const paymentRow = (date: string, amount: number, balance_after: number): Payment => ({
      id: 'b' + date, created_at: '', loan_part_id: 'p1', date, kind: 'payment',
      description: 'Betalning', amount, balance_after, paid_by: 'joint', source: 'import:bank.csv',
    })
    const amortising = [
      interestRow('2025-06-02', 3940, { id: 'h00', balance_after: 1_120_000 }),
      interestRow('2025-06-30', 3423, { id: 'h01', balance_after: 1_112_000 }),  // 1 120 000 × .0393/360 × 28 d
      interestRow('2025-07-31', 3763, { id: 'h02', balance_after: 1_104_000 }),  // 31 d
      interestRow('2025-09-01', 3616, { id: 'h03', balance_after: 1_096_000 }),  // 30 d
      interestRow('2025-09-30', 3470, { id: 'h04', balance_after: 1_088_000 }),  // 29 d
      interestRow('2025-10-31', 3682, { id: 'h05', balance_after: 1_080_000 }),  // 31 d
      interestRow('2025-12-01', 3537, { id: 'h06', balance_after: 1_072_000 }),  // 30 d
      interestRow('2025-12-30', 3394, { id: 'h07', balance_after: 1_064_000 }),  // 29 d
      interestRow('2026-02-02', 3717, { id: 'h08', balance_after: 1_056_000 }),  // 32 d
      interestRow('2026-03-02', 3458, { id: 'h09', balance_after: 1_048_000 }),  // 30 d
      interestRow('2026-03-31', 3318, { id: 'h10', balance_after: 1_040_000 }),  // 29 d
      interestRow('2026-04-30', 3292, { id: 'h11', balance_after: 1_032_000 }),  // 29 d
      interestRow('2026-06-01', 3492, { id: 'h12', balance_after: 1_024_000 }),  // 31 d
      // The bank's paired Betalning rows (= ränta + 8 000 amortering).
      paymentRow('2026-03-31', 11318, 1_040_000),
      paymentRow('2026-04-30', 11292, 1_032_000),
      paymentRow('2026-06-01', 11492, 1_024_000),
    ]
    const c = expectedCharge(part(), [bunden()], amortising)!
    expect(c.next_date).toBe('2026-06-30')
    expect(c.balance).toBe(1_024_000)
    expect(c.amortization).toBe(8000)
    // 1 024 000 × 3.93 % × 29/360 = 3 241.81
    expect(c.interest).toBe(3241.81)
    // Juli, after juni's amortering: 1 016 000 × 3.93 % × 31/360 = 3 438.31 —
    // exactly the bank's own kommande-betalning forecast (betalning 11 438.31).
    const s = pendingChargeSeries(part(), [bunden()], amortising)
    expect(s[0].next_date).toBe('2026-07-31')
    expect(s[0].interest).toBe(3438.31)
    expect(s[0].betalning).toBe(11438.31)
  })

  it('a 365-basis bunden bank keeps the Swedish convention', () => {
    // CLEAN charges are exactly listed/365 (100 kr × days at 3.65 %) — whole
    // days under /365, fractional under /360 — so the basis must stay 365.
    const c = expectedCharge(part(), [period({ rate_type: 'bunden', end_date: '2027-12-31' })], CLEAN)!
    expect(c.rate_source).toBe('listed')
    expect(c.interest).toBe(3000)                   // 1 000 000 × 3.65 % × 30/365
  })

  it('thin history defaults to 365', () => {
    // One interval is far too little evidence to leave the Swedish convention.
    const thin = [
      interestRow('2026-05-31', 4061, { id: 't0', balance_after: B }),
      interestRow('2026-06-30', 3930, { id: 't1', balance_after: B }),
    ]
    const c = expectedCharge(part(), [bunden()], thin)!
    expect(c.days).toBe(30)                         // 30 jun → 30 jul (day mode, 2 dates isn't month-end evidence)
    // 1 200 000 × 3.93 % × 30/365 = 3 876.16 — the safe default
    expect(c.interest).toBe(3876.16)
  })

  it('charges that match neither basis stay on 365', () => {
    // History billed at a different rate than the listed 3,93 % (e.g. the
    // binding just changed): implied day counts are fractional under BOTH
    // bases, so there is no decisive evidence — keep the Swedish convention.
    // Charges = 1 200 000 × 4.43 %/360 (147.67 kr/day) × [29, 32, 30, 29, 30, 32] d.
    const offRate = [
      interestRow('2025-12-01', 4282, { id: 'o0', balance_after: B }),
      interestRow('2025-12-30', 4282, { id: 'o1', balance_after: B }),
      interestRow('2026-02-02', 4725, { id: 'o2', balance_after: B }),
      interestRow('2026-03-02', 4430, { id: 'o3', balance_after: B }),
      interestRow('2026-03-31', 4282, { id: 'o4', balance_after: B }),
      interestRow('2026-04-30', 4430, { id: 'o5', balance_after: B }),
      interestRow('2026-06-01', 4725, { id: 'o6', balance_after: B }),
    ]
    const c = expectedCharge(part(), [bunden()], offRate)!
    expect(c.year_basis).toBe(365)
  })
})

describe('bank profile: declared year-basis lock (plan 104, phase 1)', () => {
  // A part wired to a bank via mortgage (part → mortgage → bank). CLEAN is a
  // clean /365-shaped ledger at 3,65 %, so ledger detection reads it as 365 —
  // a declared 360 must therefore override, proving the lock (not the ledger)
  // decides. bunden so lockedBunden is true (the only path that pins a basis).
  const bunden = () => period({ rate_type: 'bunden', end_date: '2027-12-31' })
  const linkedPart = () => part({ mortgage_id: 'm1' })
  const mortgages = (): Mortgage[] => [{ id: 'm1', created_at: '', bank_id: 'b1', label: 'Bolån', start_date: null, archived: false }]
  const banks = (over: Partial<Bank> = {}): Bank[] => [{ id: 'b1', created_at: '', label: 'Danske', ...over }]
  const opts = (over: Partial<Bank> = {}) => ({ banks: banks(over), mortgages: mortgages() })

  it('profileYearBasis returns the basis ONLY when source is declared', () => {
    expect(profileYearBasis(linkedPart(), mortgages(), banks({ year_basis: 360, year_basis_source: 'declared' }))).toBe(360)
    expect(profileYearBasis(linkedPart(), mortgages(), banks({ year_basis: 365, year_basis_source: 'declared' }))).toBe(365)
    // detected / suggested / null do NOT override in phase 1
    expect(profileYearBasis(linkedPart(), mortgages(), banks({ year_basis: 360, year_basis_source: 'detected' }))).toBeNull()
    expect(profileYearBasis(linkedPart(), mortgages(), banks({ year_basis: 360, year_basis_source: 'suggested' }))).toBeNull()
    expect(profileYearBasis(linkedPart(), mortgages(), banks({ year_basis: 360, year_basis_source: null }))).toBeNull()
    // no bank / no mortgage link → null
    expect(profileYearBasis(part(), mortgages(), banks({ year_basis: 360, year_basis_source: 'declared' }))).toBeNull()
    expect(profileYearBasis(linkedPart(), [], [])).toBeNull()
  })

  it('a declared 360 overrides ledger detection on the locked-bunden path', () => {
    // CLEAN detects as 365; the declared lock forces 360.
    // 1 000 000 × 3,65 % × 30/360 = 3 041,67 (vs /365's 3 000).
    const c = expectedCharge(linkedPart(), [bunden()], CLEAN, opts({ year_basis: 360, year_basis_source: 'declared' }))!
    expect(c.year_basis).toBe(360)
    expect(c.interest).toBe(3041.67)
  })

  it('a declared 360 holds across the whole pending series regardless of ledger', () => {
    const s = pendingChargeSeries(linkedPart(), [bunden()], CLEAN, 12, opts({ year_basis: 360, year_basis_source: 'declared' }))
    expect(s.length).toBeGreaterThan(2)
    expect(s.every(r => r.year_basis === 360)).toBe(true)
  })

  it('detected / suggested / null provenance falls back to detection (365 here)', () => {
    for (const source of ['detected', 'suggested', null] as const) {
      const c = expectedCharge(linkedPart(), [bunden()], CLEAN, opts({ year_basis: 360, year_basis_source: source }))!
      expect(c.year_basis).toBe(365)
      expect(c.interest).toBe(3000)                 // 1 000 000 × 3,65 % × 30/365
    }
  })

  it('no bank / omitted opts reproduces the existing #305 behaviour byte-for-byte', () => {
    const golden = expectedCharge(linkedPart(), [bunden()], CLEAN)!
    // an empty opts bag and a bank with no declared lock are both identical to omitting it
    expect(expectedCharge(linkedPart(), [bunden()], CLEAN, {})).toEqual(golden)
    expect(expectedCharge(linkedPart(), [bunden()], CLEAN, opts({ year_basis: null, year_basis_source: null }))).toEqual(golden)
    expect(golden.year_basis).toBe(365)
  })

  it('the derived/rörlig path ignores a declared 360 and stays 365', () => {
    // rörlig → lockedBunden is false → the basis is never pinned.
    const c = expectedCharge(linkedPart(), [period()], CLEAN, opts({ year_basis: 360, year_basis_source: 'declared' }))!
    expect(c.year_basis).toBe(365)
  })

  it('makeBank clamps a malformed year_basis to null (→ detection)', () => {
    expect(makeBank({ label: 'X', year_basis: 400, year_basis_source: 'declared' })).toEqual({ label: 'X', year_basis: null, year_basis_source: 'declared', billing: null, billing_source: null, catalog_id: null })
    expect(makeBank({ label: 'X', year_basis: 360, year_basis_source: 'garbage' })).toEqual({ label: 'X', year_basis: 360, year_basis_source: null, billing: null, billing_source: null, catalog_id: null })
    expect(makeBank({})).toEqual({ label: '', year_basis: null, year_basis_source: null, billing: null, billing_source: null, catalog_id: null })
    // a declared but malformed basis therefore does not override — detection wins
    const bad = expectedCharge(linkedPart(), [bunden()], CLEAN, { banks: [{ id: 'b1', created_at: '', label: 'X', year_basis: 400, year_basis_source: 'declared' }], mortgages: mortgages() })!
    expect(bad.year_basis).toBe(365)
  })

  it('expectedCharges threads opts through to every part', () => {
    const { rows } = expectedCharges([linkedPart()], [bunden()], CLEAN, opts({ year_basis: 360, year_basis_source: 'declared' }))
    expect(rows[0].year_basis).toBe(360)
  })
})

describe('bank profile: window-scoped bank-pooled learner + billing pin (plan 104, phase 2)', () => {
  // A rolling bunden: one steady 3,93 % window, then two quarterly re-fixes at
  // 4,20 % and 3,60 %. Every charge is a whole number of days × that window's
  // /360 day-value (131 / 140 / 120 kr) — a faktisk/360 bank. balance flat at B.
  const B = 1_200_000
  const linkedPart = () => part({ id: 'p1', mortgage_id: 'm1' })
  const mortgages = (): Mortgage[] => [{ id: 'm1', created_at: '', bank_id: 'b1', label: 'Bolån', start_date: null, archived: false }]
  const banks = (over: Partial<Bank> = {}): Bank[] => [{ id: 'b1', created_at: '', label: 'Danske', ...over }]
  const learnerOpts = (over: Partial<Bank> = {}) => ({ banks: banks(over), mortgages: mortgages(), parts: [linkedPart()] })
  const periods = (): RatePeriod[] => [
    { id: 'w1', created_at: '', loan_part_id: 'p1', start_date: '2025-06-01', end_date: '2026-05-31', rate: 3.93, rate_type: 'bunden' },
    { id: 'w2', created_at: '', loan_part_id: 'p1', start_date: '2026-06-01', end_date: '2026-08-31', rate: 4.20, rate_type: 'bunden' },
    { id: 'w3', created_at: '', loan_part_id: 'p1', start_date: '2026-09-01', end_date: '2027-12-31', rate: 3.60, rate_type: 'bunden' },
  ]
  const row = (date: string, amount: number) => interestRow(date, amount, { id: 'i' + date, balance_after: B })
  // 131/day (3,93 %) · 140/day (4,20 %) · 120/day (3,60 %)
  const rolling = [
    row('2026-02-28', 3930), row('2026-03-31', 4061), row('2026-04-30', 3930), row('2026-05-31', 4061), // w1
    row('2026-06-30', 4200), row('2026-07-31', 4340), row('2026-08-31', 4340),                          // w2
    row('2026-09-30', 3600), row('2026-10-31', 3720),                                                   // w3
  ]

  it('learnYearBasis scores WITHIN each window and pools across them → 360, confident', () => {
    const r = learnYearBasis([linkedPart()], periods(), rolling)
    expect(r.basis).toBe(360)
    expect(r.windows).toBeGreaterThanOrEqual(2)  // pooled across ≥ 2 quarters
    expect(r.confident).toBe(true)
  })

  it('one thin 3-month window alone stays below the confidence gate (detected, not suggested)', () => {
    // Only w3's two charges → a single window → not enough to lock.
    const oneWindow = [row('2026-09-30', 3600), row('2026-10-31', 3720)]
    const r = learnYearBasis([linkedPart()], periods(), oneWindow)
    expect(r.windows).toBeLessThan(2)
    expect(r.confident).toBe(false)
  })

  it('the trailing-6 detector reverts to 365 across the rolling reset (documents the bug); the learner holds 360', () => {
    // No entity context → expectedCharge falls back to the classic trailing-6
    // detector, whose window straddles 3,60 %/4,20 %/3,93 % charges and reverts.
    const buggy = expectedCharge(linkedPart(), periods(), rolling)!
    expect(buggy.year_basis).toBe(365)
    // With bank context the window-scoped bank-pooled learner stays 360.
    const fixed = expectedCharge(linkedPart(), periods(), rolling, learnerOpts())!
    expect(fixed.year_basis).toBe(360)
  })

  it('a declared 360 is correct across the reset regardless of the learner', () => {
    const c = expectedCharge(linkedPart(), periods(), rolling, learnerOpts({ year_basis: 360, year_basis_source: 'declared' }))!
    expect(c.year_basis).toBe(360)
  })

  it('suggestBankProfile offers a confident 360 lock on pooled evidence, not on one window', () => {
    expect(suggestBankProfile([linkedPart()], periods(), rolling).year_basis).toEqual({ value: 360, confident: true })
    const oneWindow = [row('2026-09-30', 3600), row('2026-10-31', 3720)]
    expect(suggestBankProfile([linkedPart()], periods(), oneWindow).year_basis.confident).toBe(false)
  })

  it('bankProfileDrift flags a declared lock the fresh evidence now contradicts', () => {
    // Declared 365, but the ledger reads a confident 360 → drift surfaced.
    const drift = bankProfileDrift(banks({ year_basis: 365, year_basis_source: 'declared' })[0], [linkedPart()], periods(), rolling)
    expect(drift).toEqual({ field: 'year_basis', declared: 365, learned: 360 })
    // Declared 360 that matches → no drift.
    expect(bankProfileDrift(banks({ year_basis: 360, year_basis_source: 'declared' })[0], [linkedPart()], periods(), rolling)).toBeNull()
    // No declared lock → nothing to drift against.
    expect(bankProfileDrift(banks({ year_basis: 360, year_basis_source: 'detected' })[0], [linkedPart()], periods(), rolling)).toBeNull()
  })

  it('the billing pin overrides ledger cadence detection both ways', () => {
    // CLEAN bills on the 27th (fixed day) → detected as NOT month-end.
    const bunden = () => period({ rate_type: 'bunden', end_date: '2027-12-31' })
    const pin = (billing: string | null) => ({ banks: banks({ billing, billing_source: billing ? 'declared' : null }), mortgages: mortgages() })
    // declared month-end → the next charge anchors to the month's last day
    expect(expectedCharge(linkedPart(), [bunden()], CLEAN, pin('month-end'))!.next_date).toBe('2026-07-31')
    // declared fixed → keeps the 27th day-of-month cadence
    expect(expectedCharge(linkedPart(), [bunden()], CLEAN, pin('fixed'))!.next_date).toBe('2026-07-27')
    // profileBilling only reads a DECLARED source
    expect(profileBilling(linkedPart(), mortgages(), banks({ billing: 'month-end', billing_source: 'declared' }))).toBe('month-end')
    expect(profileBilling(linkedPart(), mortgages(), banks({ billing: 'month-end', billing_source: 'detected' }))).toBeNull()
  })

  it('undeclared / no-context still reproduces the existing behaviour byte-for-byte', () => {
    const golden = expectedCharge(part(), [period({ rate_type: 'bunden', end_date: '2027-12-31' })], CLEAN)!
    expect(expectedCharge(part(), [period({ rate_type: 'bunden', end_date: '2027-12-31' })], CLEAN, {})).toEqual(golden)
  })

  it('makeBank clamps a malformed billing convention to null (→ detection)', () => {
    expect(makeBank({ label: 'X', billing: 'weird', billing_source: 'declared' })).toEqual({ label: 'X', year_basis: null, year_basis_source: null, billing: null, billing_source: 'declared', catalog_id: null })
    expect(makeBank({ label: 'X', billing: 'month-end', billing_source: 'garbage' })).toEqual({ label: 'X', year_basis: null, year_basis_source: null, billing: 'month-end', billing_source: null, catalog_id: null })
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

  it('holds the month while only ONE of its two transactions is logged', () => {
    // Amortizing loan with only the ränta logged for July: the amortering
    // line is still pending, so the month must NOT roll yet.
    const amortizing = [
      interestRow('2026-03-27', 3100, { balance_after: 1_000_000 }),
      interestRow('2026-04-27', 3100, { balance_after: 997_000 }),
      interestRow('2026-05-27', 3000, { balance_after: 994_000 }),
      interestRow('2026-06-27', 3100, { balance_after: 991_000 }),
      { ...loggedJuly, amount: 2981.15, balance_after: 988_000 },
    ]
    const c = pendingCharge(part({ start_date: '2026-03-01', start_balance: 1_000_000 }), [period()], amortizing)!
    expect(c.next_date).toBe('2026-07-27')
    expect(c.amortization).toBe(3000)
  })

  it('steps the balance down by the amortering when rolling a fully-logged month', () => {
    const amortizing = [
      interestRow('2026-03-27', 3100, { balance_after: 1_000_000 }),
      interestRow('2026-04-27', 3100, { balance_after: 997_000 }),
      interestRow('2026-05-27', 3000, { balance_after: 994_000 }),
      interestRow('2026-06-27', 3100, { balance_after: 991_000 }),
      { ...loggedJuly, amount: 2981.15, balance_after: 988_000 },
      { ...loggedJuly, id: 'pred2', kind: 'amortization' as const, amount: 3000, balance_after: 988_000 },
    ]
    const c = pendingCharge(part({ start_date: '2026-03-01', start_balance: 1_000_000 }), [period()], amortizing)!
    expect(c.next_date).toBe('2026-08-27')
    expect(c.balance).toBe(988_000)                 // 991 000 − 3 000 predicted amortering
    expect(c.amortization).toBe(3000)
  })

  it('bank shape: the month holds until BOTH the ränta and the betalning row are logged', () => {
    // Paired history (betalning = ränta + 3 000). Logging just the July ränta
    // leaves the betalning slot open — the month must not roll; adding the
    // kind-payment betalning row rolls it and steps the balance down by the
    // amortering (NOT by the whole betalning).
    const paired = [
      ...CLEAN,
      interestRow('2026-05-27', 6000, { id: 'b1', kind: 'payment', description: 'Betalning' }),
      interestRow('2026-06-27', 6100, { id: 'b2', kind: 'payment', description: 'Betalning' }),
    ]
    const halfLogged = [...paired, loggedJuly]
    const held = pendingCharge(part(), [period()], halfLogged)!
    expect(held.next_date).toBe('2026-07-27')

    const fullyLogged = [...halfLogged,
      { ...loggedJuly, id: 'predB', kind: 'payment' as const, amount: 6000, balance_after: 997_000 }]
    const rolled = pendingCharge(part(), [period()], fullyLogged)!
    expect(rolled.next_date).toBe('2026-08-27')
    expect(rolled.balance).toBe(997_000)            // 1 000 000 − 3 000 amortering
    expect(rolled.betalning).toBeCloseTo(rolled.interest + 3000, 2)
  })
})

describe('strictRatePeriodCoverage (known-terms boundary)', () => {
  it('distinguishes no usable terms, covered dates and dates outside known terms', () => {
    const p = part()
    expect(strictRatePeriodCoverage(p, [], '2026-07-27')).toBe('unconfigured')
    expect(strictRatePeriodCoverage(p, [
      period({ rate: null }),
      period({ id: 'other', loan_part_id: 'p2' }),
    ], '2026-07-27')).toBe('unconfigured')

    const known = [period({ start_date: '2026-01-01', end_date: '2026-07-27' })]
    expect(strictRatePeriodCoverage(p, known, '2026-07-27')).toBe('covered')
    expect(strictRatePeriodCoverage(p, known, '2026-07-28')).toBe('outside-known-terms')
  })

  it('requires the charge date itself to be inside a successor and does not bridge gaps', () => {
    const periods = [
      period({ end_date: '2026-06-30' }),
      period({ id: 'r2', start_date: '2026-08-01', end_date: null, rate: 4.1 }),
    ]
    expect(strictRatePeriodCoverage(part(), periods, '2026-07-27')).toBe('outside-known-terms')
    expect(strictRatePeriodCoverage(part(), periods, '2026-08-01')).toBe('covered')
  })
})

describe('pending charge known-terms boundary', () => {
  const loggedJuly: Payment = {
    id: 'pred-july', created_at: '', loan_part_id: 'p1', date: '2026-07-27', kind: 'interest',
    description: 'Förväntad avi', amount: 3000, balance_after: 1_000_000, paid_by: 'joint', source: 'predicted',
  }

  it('keeps the next uncovered monthly charge before the end date and on the end date', () => {
    const before = pendingCharge(part(), [period({ end_date: '2026-08-31' })], CLEAN)
    expect(before?.next_date).toBe('2026-07-27')
    expect(before?.interest).toBe(3000)

    const onBoundary = pendingCharge(part(), [period({ end_date: '2026-07-27' })], CLEAN)
    expect(onBoundary?.next_date).toBe('2026-07-27')
    expect(onBoundary?.interest).toBe(3000)
  })

  it('returns no pending charge or series when the last valid month is fully logged', () => {
    const periods = [period({ end_date: '2026-07-27' })]
    const payments = [...CLEAN, loggedJuly]
    expect(expectedCharge(part(), periods, payments)?.next_date).toBe('2026-07-27')
    expect(pendingCharge(part(), periods, payments)).toBeNull()
    expect(pendingChargeSeries(part(), periods, payments)).toEqual([])
  })

  it('suppresses the first calculated charge when it is already after the end date', () => {
    const periods = [period({ end_date: '2026-07-26' })]
    const diagnostic = expectedCharge(part(), periods, CLEAN)
    expect(diagnostic?.next_date).toBe('2026-07-27')
    expect(diagnostic?.interest).toBe(3000)
    expect(pendingCharge(part(), periods, CLEAN)).toBeNull()
    expect(pendingChargeSeries(part(), periods, CLEAN)).toEqual([])
  })

  it('suppresses a quarterly cadence that jumps over the end date', () => {
    const quarterly = [
      interestRow('2025-12-27', 9100),
      interestRow('2026-03-27', 9000),
      interestRow('2026-06-27', 9200),
    ]
    expect(expectedCharge(part(), [period({ end_date: '2026-08-31' })], quarterly)?.next_date).toBe('2026-09-27')
    expect(pendingCharge(part(), [period({ end_date: '2026-08-31' })], quarterly)).toBeNull()
  })

  it('keeps a charge covered by a successor period', () => {
    const periods = [
      period({ end_date: '2026-06-30' }),
      period({ id: 'r2', start_date: '2026-07-01', end_date: '2027-06-30', rate: 4.1 }),
    ]
    const charge = pendingCharge(part(), periods, CLEAN)
    expect(charge?.next_date).toBe('2026-07-27')
    expect(charge?.interest).toBe(3369.86)
  })

  it('suppresses a charge in the gap before a later successor starts', () => {
    const periods = [
      period({ end_date: '2026-06-30' }),
      period({ id: 'r2', start_date: '2026-08-01', end_date: null, rate: 4.1 }),
    ]
    expect(pendingCharge(part(), periods, CLEAN)).toBeNull()
    expect(pendingChargeSeries(part(), periods, CLEAN)).toEqual([])
  })

  it('preserves the existing derived-rate forecast when no usable terms are configured', () => {
    const charge = pendingCharge(part(), [], CLEAN)
    expect(charge?.next_date).toBe('2026-07-27')
    expect(charge?.interest).toBe(3000)
  })
})

describe('pendingChargeSeries (coming-months preview)', () => {
  it('projects a year of avier from the pending one, months chained by cadence', () => {
    const s = pendingChargeSeries(part(), [period()], CLEAN)
    expect(s).toHaveLength(12)                        // monthly cadence → 12 avier
    expect(s[0]).toEqual(pendingCharge(part(), [period()], CLEAN))
    expect(s[1].next_date).toBe('2026-08-27')
    expect(s[11].next_date).toBe('2027-06-27')
    // Interest-only: balance flat, each month repriced on its own day count
    // (27 jul → 27 aug = 31 days → 3 100 kr at 3.65 %).
    expect(s[1].balance).toBe(1_000_000)
    expect(s[1].interest).toBe(3100)
  })

  it('steps the balance down by the amortering month over month', () => {
    const amortizing = [
      interestRow('2026-03-27', 3100, { balance_after: 1_000_000 }),
      interestRow('2026-04-27', 3100, { balance_after: 997_000 }),
      interestRow('2026-05-27', 3000, { balance_after: 994_000 }),
      interestRow('2026-06-27', 3100, { balance_after: 991_000 }),
    ]
    const s = pendingChargeSeries(part({ start_date: '2026-03-01', start_balance: 1_000_000 }), [period()], amortizing)
    expect(s[0].balance).toBe(991_000)
    expect(s[1].balance).toBe(988_000)                // −3 000 per month
    expect(s[2].balance).toBe(985_000)
    expect(s[11].balance).toBe(958_000)
  })

  it('a bunden rate ending mid-horizon caps the preview at the villkorsändringsdag', () => {
    // Rate is bound until 31 Aug 2026 with no successor period: the Jul and
    // Aug avier are known, everything after would just repeat the old rate —
    // noise, not information. The preview must stop, not run 12 months.
    const bunden = period({ rate_type: 'bunden', end_date: '2026-08-31' })
    const s = pendingChargeSeries(part(), [bunden], CLEAN)
    expect(s.map(c => c.next_date)).toEqual(['2026-07-27', '2026-08-27'])
    expect(s.every(c => c.confidence === 'exact')).toBe(true)
  })

  it('a bunden rate followed by an open rörlig period keeps the full horizon', () => {
    // Knowledge does NOT end at the binding when a later period covers the
    // dates after it — the preview continues (rate held flat, ≈ est.).
    const periods = [
      period({ rate_type: 'bunden', end_date: '2026-08-31' }),
      period({ id: 'r2', start_date: '2026-09-01', rate: 4.1, rate_type: 'rörlig' }),
    ]
    const s = pendingChargeSeries(part(), periods, CLEAN)
    expect(s).toHaveLength(12)
  })

  it('stops before a gap even when a later successor exists', () => {
    const periods = [
      period({ rate_type: 'bunden', end_date: '2026-08-31' }),
      period({ id: 'r2', start_date: '2026-10-01', rate: 4.1, rate_type: 'rörlig' }),
    ]
    const s = pendingChargeSeries(part(), periods, CLEAN)
    expect(s.map(c => c.next_date)).toEqual(['2026-07-27', '2026-08-27'])
    expect(s.map(c => c.interest)).toEqual([3000, 3100])
  })

  it('kvartalsvis cadence yields 4 avier over a 12-month horizon', () => {
    const quarterly = [
      interestRow('2025-12-27', 9100), interestRow('2026-03-27', 9000), interestRow('2026-06-27', 9200),
    ]
    const s = pendingChargeSeries(part(), [period()], quarterly)
    expect(s).toHaveLength(4)
    expect(s.map(c => c.next_date)).toEqual(['2026-09-27', '2026-12-27', '2027-03-27', '2027-06-27'])
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

  it('the household shape: one amortizing part, the rest betalning == ränta', () => {
    // All amortering sits on p1 (betalning 3 000 kr over the ränta); p2 pays
    // exactly its ränta and stays flat. Each part predicts its OWN pair —
    // Nästa avisering mirrors the bank: Ränta + Betalning per part.
    const p2 = part({ id: 'p2', label: 'Del 2' })
    const p2ints = CLEAN.map(p => ({ ...p, id: p.id + '-2', loan_part_id: 'p2', balance_after: 2_000_000, amount: p.amount * 2 }))
    const betalningar = [
      interestRow('2026-05-27', 6000, { id: 'b1', kind: 'payment', description: 'Betalning' }),
      interestRow('2026-06-27', 6100, { id: 'b2', kind: 'payment', description: 'Betalning' }),
      interestRow('2026-05-27', 6000, { id: 'b3', kind: 'payment', description: 'Betalning', loan_part_id: 'p2', balance_after: 2_000_000 }),
      interestRow('2026-06-27', 6200, { id: 'b4', kind: 'payment', description: 'Betalning', loan_part_id: 'p2', balance_after: 2_000_000 }),
    ]
    const res = expectedCharges([part(), p2], [period(), period({ id: 'r2', loan_part_id: 'p2' })], [...CLEAN, ...p2ints, ...betalningar])
    expect(res.rows.map(r => [r.loan_part_id, r.amortization, r.betalning])).toEqual([
      ['p1', 3000, 6000],   // ränta 3 000 + amortering 3 000 (diffs: maj 6 000−3 000, jun 6 100−3 100)
      ['p2', 0, 6000],      // betalning == ränta (2 000 000 × 3.65 % × 30/365) — stays flat
    ])
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

  it('pairs an incoming betalning draft with the predicted kind-payment row', () => {
    // The bank's Betalning row (total debit) supersedes the logged prediction
    // just like the ränta row does.
    const predictedBetalning: Payment = { ...predicted, id: 'pred3', kind: 'payment', amount: 6000 }
    const m = matchPredictedRows([predicted, predictedBetalning], [
      { loan_part_id: 'p1', date: '2026-07-27', kind: 'payment', amount: 6010 },
    ])
    expect(m).toHaveLength(1)
    expect(m[0].predicted.id).toBe('pred3')
    expect(m[0].recon.ok).toBe(true)                 // drift 10 kr, inside max(50, 1 %)
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

describe('stalePredictedRows (logged forecasts vs the current model)', () => {
  // Rows logged with "Logga förväntad rad" persist in the ledger with the
  // amounts the model produced AT THAT TIME. When the model improves (the
  // 30/360 fix), those rows go stale — nothing rewrites them automatically
  // (real imports supersede them), so the UI offers a one-click refresh.
  const B = 1_350_000
  const flat: Payment[] = [
    { id: 'i1', created_at: '', loan_part_id: 'p1', date: '2026-03-01', kind: 'interest', description: 'Ränta', amount: 4061, balance_after: B, paid_by: 'joint', source: 'import:bank.csv' },
    { id: 'i2', created_at: '', loan_part_id: 'p1', date: '2026-04-01', kind: 'interest', description: 'Ränta', amount: 4061, balance_after: B, paid_by: 'joint', source: 'import:bank.csv' },
    { id: 'i3', created_at: '', loan_part_id: 'p1', date: '2026-05-01', kind: 'interest', description: 'Ränta', amount: 4061, balance_after: B, paid_by: 'joint', source: 'import:bank.csv' },
    { id: 'i4', created_at: '', loan_part_id: 'p1', date: '2026-06-01', kind: 'interest', description: 'Ränta', amount: 4061, balance_after: B, paid_by: 'joint', source: 'import:bank.csv' },
    { id: 'b3', created_at: '', loan_part_id: 'p1', date: '2026-05-01', kind: 'payment', description: 'Betalning', amount: 4061, balance_after: B, paid_by: 'joint', source: 'import:bank.csv' },
    { id: 'b4', created_at: '', loan_part_id: 'p1', date: '2026-06-01', kind: 'payment', description: 'Betalning', amount: 4061, balance_after: B, paid_by: 'joint', source: 'import:bank.csv' },
  ]
  function predRow(over: Partial<Payment>): Payment {
    return {
      id: 'pr', created_at: '', loan_part_id: 'p1', date: '2026-07-01', kind: 'interest',
      description: 'Förväntad avi', amount: 0, balance_after: null, paid_by: 'joint', source: 'predicted', ...over,
    }
  }

  it('flags old-model rows and returns the corrected amounts (the ×1.86 prod rows)', () => {
    const stale = [
      predRow({ id: 'sr', kind: 'interest', amount: 7565 }),
      predRow({ id: 'sb', kind: 'payment', amount: 7565 }),
    ]
    const out = stalePredictedRows([part()], [], [...flat, ...stale])
    expect(out.map(s => [s.payment.id, s.amount, s.balance_after])).toEqual([
      ['sr', 4061, B],   // interest refreshed to the flat-monthly prediction
      ['sb', 4061, B],   // betalning likewise; interest-only part → saldo unchanged
    ])
  })

  it('leaves rows inside the reconcile tolerance alone, and never touches real rows', () => {
    const fine = predRow({ id: 'ok', amount: 4062 })                       // drift 1 kr — fine
    const realRow = { ...predRow({ id: 'real', amount: 9999 }), source: 'import:bank.csv' }
    expect(stalePredictedRows([part()], [], [...flat, fine, realRow])).toEqual([])
  })

  it('compares rows in LATER months against the rolled forecast', () => {
    const julyOk = [
      predRow({ id: 'jr', amount: 4061 }),
      predRow({ id: 'jb', kind: 'payment', amount: 4061 }),
    ]
    const augustStale = predRow({ id: 'ar', date: '2026-08-01', amount: 8000 })
    const out = stalePredictedRows([part()], [], [...flat, ...julyOk, augustStale])
    expect(out.map(s => [s.payment.id, s.amount])).toEqual([['ar', 4061]])  // flat part: same charge rolled
  })
})

// Plan 105 — the owner can DECLARE a fixed rak amortering (kr/mån) on a part;
// the forecast trusts it over the value derived from ledger history, so a new
// or changed arrangement is correct immediately instead of lagging ~3 months.
describe('plan 105 — declared amortering', () => {
  // A betalning (bank total-debit) row for a given month.
  function betalning(date: string, amount: number, id: string): Payment {
    return interestRow(date, amount, { id, kind: 'payment', description: 'Betalning' })
  }

  it('declared amount wins over a stale paired diff — amortization, betalning and the rolled step', () => {
    // Trailing paired diffs say 6 000 (betalning − ränta), but the owner declared
    // 8 000. Declared wins: amortering 8 000, betalning = ränta + 8 000, and the
    // rolled balance steps by 8 000.
    const pays = [
      ...CLEAN,
      betalning('2026-05-27', 9000, 'b1'),   // 9 000 − 3 000 = 6 000
      betalning('2026-06-27', 9100, 'b2'),   // 9 100 − 3 100 = 6 000
    ]
    const p = part({ planned_amortization: 8000 })
    const c = expectedCharge(p, [period()], pays)!
    expect(c.interest).toBe(3000)                    // unchanged: 1 000 000 × 3.65/100 × 30/365
    expect(c.amortization).toBe(8000)                // declared beats the paired 6 000
    expect(c.amortization_source).toBe('declared')
    expect(c.betalning).toBe(11000)                  // ränta 3 000 + declared 8 000
    expect(c.gross).toBe(11000)
    // The rolled avi (August) steps the balance down by the declared 8 000.
    const series = pendingChargeSeries(p, [period()], pays, 3)
    expect(series[0].amortization).toBe(8000)
    expect(series[1].balance).toBe(992000)           // 1 000 000 − 8 000
    expect(series[1].amortization).toBe(8000)
  })

  it('declared 0 pins the part interest-only, overriding a noisy paired diff', () => {
    // One noisy paired month would otherwise invent 50 kr of amortering; the
    // owner declares 0 → interest-only, betalning = ränta.
    const pays = [
      ...CLEAN,
      betalning('2026-06-27', 3150, 'b1'),   // 3 150 − 3 100 = 50 (noise)
    ]
    const c = expectedCharge(part({ planned_amortization: 0 }), [period()], pays)!
    expect(c.amortization).toBe(0)
    expect(c.amortization_source).toBe('declared')
    expect(c.betalning).toBe(c.interest)             // 3 000 — bank total-debit shape kept
  })

  it('real amortization rows still outrank the declaration (ground-truth precedence)', () => {
    const pays = [
      ...CLEAN,
      interestRow('2026-05-27', 3000, { id: 'a1', kind: 'amortization' }),
      interestRow('2026-06-27', 3000, { id: 'a2', kind: 'amortization' }),
    ]
    const c = expectedCharge(part({ planned_amortization: 8000 }), [period()], pays)!
    expect(c.amortization).toBe(3000)                // real row median wins over declared 8 000
    expect(c.amortization_source).toBe('real')
  })

  it('effective-dating: a future start does not alter the current charge but applies from its date (8 000 → 5 000)', () => {
    // Detection reads 8 000 from the paired history; the owner declares a step
    // DOWN to 5 000 starting 2026-09-01. Months before the start keep 8 000; the
    // declared 5 000 applies only from September on.
    const pays = [
      ...CLEAN,
      betalning('2026-05-27', 11000, 'b1'),  // 11 000 − 3 000 = 8 000
      betalning('2026-06-27', 11100, 'b2'),  // 11 100 − 3 100 = 8 000
    ]
    const p = part({ planned_amortization: 5000, planned_amortization_start: '2026-09-01' })
    const series = pendingChargeSeries(p, [period()], pays, 4)
    // [0] Jul 27, [1] Aug 27 — both before the start → detected 8 000.
    expect(series[0].next_date).toBe('2026-07-27')
    expect(series[0].amortization).toBe(8000)
    expect(series[0].amortization_source).toBe('paired')
    expect(series[1].amortization).toBe(8000)
    // [2] Sep 27 — on/after the start → declared 5 000.
    expect(series[2].next_date).toBe('2026-09-27')
    expect(series[2].amortization).toBe(5000)
    expect(series[2].amortization_source).toBe('declared')
  })

  it('detection is unchanged when nothing is declared (regression guard)', () => {
    // planned_amortization undefined AND explicit null both reproduce the paired
    // golden (betalning − ränta = 3 000), byte-for-byte with the pre-105 path.
    const pays = [
      ...CLEAN,
      betalning('2026-05-27', 6000, 'b1'),
      betalning('2026-06-27', 6100, 'b2'),
    ]
    const base = expectedCharge(part(), [period()], pays)!
    expect(base.amortization).toBe(3000)
    expect(base.amortization_source).toBe('paired')
    expect(base.betalning).toBe(6000)
    const withNull = expectedCharge(part({ planned_amortization: null }), [period()], pays)!
    expect(withNull.amortization).toBe(3000)
    expect(withNull.betalning).toBe(6000)
  })

  it('balance step-down / payoff: declared amortering drives the series and projectBalance, stopping at 0', () => {
    // A 25 000 kr part with a flat ledger (timeline drop 0) and a declared
    // 10 000 kr/mån: the per-part series steps 25 000 → 15 000 → 5 000 and stops
    // (never negative), and the aggregate projection pays off in 3 months.
    const pays = [
      interestRow('2026-04-27', 76, { balance_after: 25000 }),
      interestRow('2026-05-27', 76, { id: 'i2', balance_after: 25000 }),
      interestRow('2026-06-27', 76, { id: 'i3', balance_after: 25000 }),
    ]
    const declared = part({ planned_amortization: 10000 })
    const series = pendingChargeSeries(declared, [period()], pays, 12)
    expect(series.map(s => s.balance)).toEqual([25000, 15000, 5000])   // stops before going negative
    expect(series.every(s => s.balance >= 0)).toBe(true)
    // Aggregate projection: declared drives payoff; the undeclared part is flat.
    expect(projectMilestones([declared], pays, [], {}).payoff_months).toBe(3)
    expect(projectMilestones([part()], pays, [], {}).payoff_months).toBeNull()
  })

  it('effectiveDeclaredAmortization: clamps/ignores malformed and honours effective dates', () => {
    expect(effectiveDeclaredAmortization(part())).toBeNull()                              // undeclared
    expect(effectiveDeclaredAmortization(part({ planned_amortization: 0 }))).toBe(0)       // 0 is valid
    expect(effectiveDeclaredAmortization(part({ planned_amortization: -5 }))).toBeNull()   // negative ignored
    expect(effectiveDeclaredAmortization(part({ planned_amortization: NaN }))).toBeNull()  // NaN ignored
    const dated = part({ planned_amortization: 8000, planned_amortization_start: '2026-09-01', planned_amortization_end: '2026-12-31' })
    expect(effectiveDeclaredAmortization(dated, '2026-08-31')).toBeNull()   // before start
    expect(effectiveDeclaredAmortization(dated, '2026-09-01')).toBe(8000)   // on start (inclusive)
    expect(effectiveDeclaredAmortization(dated, '2026-12-31')).toBe(8000)   // on end (inclusive)
    expect(effectiveDeclaredAmortization(dated, '2027-01-01')).toBeNull()   // after end
  })

  it('declaredMonthlyAmortization: sums declared parts, null when none, archived excluded', () => {
    expect(declaredMonthlyAmortization([part()])).toBeNull()
    expect(declaredMonthlyAmortization([
      part({ planned_amortization: 8000 }),
      part({ id: 'p2', planned_amortization: 0 }),
    ])).toBe(8000)
    expect(declaredMonthlyAmortization([part({ archived: true, planned_amortization: 8000 })])).toBeNull()
  })

  it('makeLoanPart normalises the declared fields defensively', () => {
    expect(makeLoanPart({}).planned_amortization).toBeNull()
    expect(makeLoanPart({ planned_amortization: 0 }).planned_amortization).toBe(0)
    expect(makeLoanPart({ planned_amortization: 8000 }).planned_amortization).toBe(8000)
    expect(makeLoanPart({ planned_amortization: -100 }).planned_amortization).toBeNull()
    expect(makeLoanPart({ planned_amortization: NaN }).planned_amortization).toBeNull()
    expect(makeLoanPart({ planned_amortization: '' as unknown as number }).planned_amortization).toBeNull()
    expect(makeLoanPart({ planned_amortization: '8000' as unknown as number }).planned_amortization).toBe(8000)
    expect(makeLoanPart({ planned_amortization_start: '' }).planned_amortization_start).toBeNull()
    expect(makeLoanPart({ planned_amortization_start: '2026-09-01' }).planned_amortization_start).toBe('2026-09-01')
    expect(makeLoanPart({ planned_amortization_end: '2026-12-31' }).planned_amortization_end).toBe('2026-12-31')
  })
})
