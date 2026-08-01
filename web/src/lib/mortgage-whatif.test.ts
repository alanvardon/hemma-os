import { describe, it, expect } from 'vitest'
import { mortgageMonthlyFigures, rateWhatIf } from './mortgage'
import type { LoanPart, Payment, RatePeriod } from './mortgage'

// Plan 126 §7 — mortgageMonthlyFigures is now a THREE-way outcome, and every
// input (balance, the balances the blended rate is weighted by, and the
// amortisation history) is read at one `asOf`. The old single "null" conflated
// "nothing to sync" with "we cannot price today", and swallowed a legitimately
// covered 0 % period; both are separated here.
function part(over: Partial<LoanPart> = {}): LoanPart {
  return {
    id: 'part-1', created_at: '', label: 'Bolån', loan_number: '1',
    start_balance: 3_003_000, start_date: '2026-01-01', archived: false, ...over,
  }
}
function period(over: Partial<RatePeriod> = {}): RatePeriod {
  return {
    id: 'rate-1', created_at: '', loan_part_id: 'part-1',
    start_date: '2026-01-01', end_date: null, rate: 3.42, rate_type: 'rörlig', ...over,
  }
}
function amortRow(id: string, date: string, amount: number, balance_after: number, loan_part_id = 'part-1'): Payment {
  return {
    id, created_at: '', loan_part_id, date, kind: 'amortization',
    description: '', amount, balance_after, paid_by: 'joint', source: '',
  }
}

describe('mortgageMonthlyFigures', () => {
  // Saldo 3 003 000 on 2026-01-31, 3 000 000 on 2026-02-28.
  const LEDGER = [
    amortRow('pay-1', '2026-01-31', 3_000, 3_003_000),
    amortRow('pay-2', '2026-02-28', 3_000, 3_000_000),
  ]

  it('ok: steady-state gross interest and observed monthly amortization at asOf', () => {
    // Balance at 2026-03-15 = latest saldo 3 000 000 (no later rows).
    // Interest  = 3 000 000 × 3.42/100 / 12 = 8 550 kr/mån.
    // Amort     = timeline 2026-01 (3 003 000) → 2026-02 (3 000 000) over
    //             1 month = 3 000 kr/mån.
    expect(mortgageMonthlyFigures([part()], [period()], LEDGER, '2026-03-15'))
      .toEqual({ status: 'ok', figures: { ranta: 8_550, amortering: 3_000 } })
  })

  it('ok: a COVERED 0 % period is a real rate — 0 kr ränta, never "empty"', () => {
    // The old `blended <= 0` gate treated this as broken data and wiped the
    // synced rows. 0 % is contractual: the ränta row belongs in the budget at
    // 0 kr, and the amortering row is untouched by it.
    expect(mortgageMonthlyFigures([part()], [period({ rate: 0 })], LEDGER, '2026-03-15'))
      .toEqual({ status: 'ok', figures: { ranta: 0, amortering: 3_000 } })
  })

  it('ok: the blended rate weights the SAME as-of balances the interest uses', () => {
    // Two parts, 1 000 000 kr at 4 % and 3 000 000 kr at 2 % as of 2026-03-15.
    // A 2026-06-30 saldo on the cheap part would flip the weighting if the
    // as-of date leaked; it must not.
    const parts: LoanPart[] = [
      part({ id: 'a', start_balance: 1_000_000 }),
      part({ id: 'b', start_balance: 3_000_000 }),
    ]
    const periods: RatePeriod[] = [
      period({ id: 'ra', loan_part_id: 'a', rate: 4 }),
      period({ id: 'rb', loan_part_id: 'b', rate: 2 }),
    ]
    const payments = [amortRow('future', '2026-06-30', 2_900_000, 100_000, 'b')]
    // Blended = (4 × 1 000 000 + 2 × 3 000 000) / 4 000 000 = 2.5 %
    // Interest = 4 000 000 × 2.5/100 / 12 = 8 333.33 kr/mån
    const out = mortgageMonthlyFigures(parts, periods, payments, '2026-03-15')
    expect(out).toEqual({ status: 'ok', figures: { ranta: 8_333.33, amortering: 0 } })
  })

  it('ok: amortisation history ignores ledger rows dated after asOf', () => {
    const payments = [
      amortRow('m1', '2026-01-31', 10_000, 990_000),
      amortRow('m2', '2026-02-28', 10_000, 980_000),
      amortRow('m3', '2026-03-31', 80_000, 900_000), // after asOf — invisible
    ]
    // As of 2026-02-28: balance 980 000, timeline 2026-01 (990 000) →
    // 2026-02 (980 000) over 1 month = 10 000 kr/mån. Including the March row
    // would read 45 000 kr/mån off a 2-month drop of 90 000.
    // Interest = 980 000 × 3/100 / 12 = 2 450 kr/mån.
    expect(mortgageMonthlyFigures(
      [part({ start_balance: 1_000_000 })], [period({ rate: 3 })], payments, '2026-02-28',
    )).toEqual({ status: 'ok', figures: { ranta: 2_450, amortering: 10_000 } })
  })

  it('empty: no active part carries a positive balance at asOf', () => {
    expect(mortgageMonthlyFigures([], [period()], [], '2026-03-15')).toEqual({ status: 'empty' })
    // Fully repaid before asOf.
    expect(mortgageMonthlyFigures(
      [part({ start_balance: 100_000 })], [period()],
      [amortRow('done', '2026-02-01', 100_000, 0)], '2026-03-15',
    )).toEqual({ status: 'empty' })
    // Archived parts are not synced at all.
    expect(mortgageMonthlyFigures([part({ archived: true })], [period()], LEDGER, '2026-03-15'))
      .toEqual({ status: 'empty' })
  })

  it('missing-current-rate: a funded part with no rate period at all', () => {
    expect(mortgageMonthlyFigures([part()], [], LEDGER, '2026-03-15'))
      .toEqual({ status: 'missing-current-rate', loan_part_ids: ['part-1'] })
  })

  it('missing-current-rate: names exactly the uncovered funded parts', () => {
    const parts: LoanPart[] = [
      part({ id: 'covered', start_balance: 1_000_000 }),
      part({ id: 'future', start_balance: 1_000_000 }),
      part({ id: 'gapped', start_balance: 1_000_000 }),
      part({ id: 'settled', start_balance: 0 }),
      part({ id: 'archived', start_balance: 1_000_000, archived: true }),
    ]
    const periods: RatePeriod[] = [
      period({ id: 'r-cov', loan_part_id: 'covered' }),
      // Starts tomorrow — the reported defect. Never promoted to "today".
      period({ id: 'r-fut', loan_part_id: 'future', start_date: '2026-03-16' }),
      // A hole around asOf.
      period({ id: 'r-gap-a', loan_part_id: 'gapped', start_date: '2026-01-01', end_date: '2026-02-28' }),
      period({ id: 'r-gap-b', loan_part_id: 'gapped', start_date: '2026-04-01', end_date: null }),
      // Uncovered, but settled / archived — must not block the sync.
      period({ id: 'r-arch', loan_part_id: 'archived', start_date: '2026-09-01' }),
    ]
    expect(mortgageMonthlyFigures(parts, periods, [], '2026-03-15'))
      .toEqual({ status: 'missing-current-rate', loan_part_ids: ['future', 'gapped'] })
  })

  it('missing-current-rate: overlapping periods are conflicting terms, not a rate', () => {
    const periods = [
      period({ id: 'r-a', start_date: '2026-01-01', end_date: null, rate: 3.42 }),
      period({ id: 'r-b', start_date: '2026-02-01', end_date: null, rate: 3.9 }),
    ]
    expect(mortgageMonthlyFigures([part()], periods, LEDGER, '2026-03-15'))
      .toEqual({ status: 'missing-current-rate', loan_part_ids: ['part-1'] })
  })

  it('a period ending today still covers today; its successor takes over tomorrow', () => {
    const periods = [
      period({ id: 'now', start_date: '2026-01-01', end_date: '2026-03-15', rate: 3.42 }),
      period({ id: 'next', start_date: '2026-03-16', end_date: null, rate: 4.02 }),
    ]
    // 3 000 000 × 3.42/100 / 12 = 8 550 today; × 4.02/100 / 12 = 10 050 tomorrow.
    expect(mortgageMonthlyFigures([part()], periods, LEDGER, '2026-03-15'))
      .toEqual({ status: 'ok', figures: { ranta: 8_550, amortering: 3_000 } })
    expect(mortgageMonthlyFigures([part()], periods, LEDGER, '2026-03-16'))
      .toEqual({ status: 'ok', figures: { ranta: 10_050, amortering: 3_000 } })
  })
})

// Plan 82 — rate what-if. Both legs COMPUTED with balance × rate/100 / 12 + the
// observed monthly amortization; deduction applies ranteavdrag() to the MONTHLY
// interest (same convention as monthlyCost). Every expected number below is
// hand-computed with the arithmetic shown in the comment.
describe('rateWhatIf', () => {
  it('golden case: 3 000 000 kr, Ø 3,42 % → 4,00 %, 3 000 kr/mån amort', () => {
    const w = rateWhatIf(3_000_000, 3.42, 4.0, 3000)!
    expect(w).not.toBeNull()

    // now (3.42 %): interest = 3 000 000 × 3.42/100 / 12 = 8 550
    //               gross    = 8 550 + 3 000              = 11 550
    //               deduction = 8 550 × 0.30              = 2 565  (< 100 000, flat 30 %)
    //               net      = 11 550 − 2 565             = 8 985
    expect(w.now.interest).toBe(8550)
    expect(w.now.gross).toBe(11550)
    expect(w.now.deduction).toBe(2565)
    expect(w.now.net).toBe(8985)

    // hyp (4.00 %): interest = 3 000 000 × 4/100 / 12 = 10 000
    //               gross    = 10 000 + 3 000          = 13 000
    //               deduction = 10 000 × 0.30          = 3 000
    //               net      = 13 000 − 3 000          = 10 000
    expect(w.hyp.interest).toBe(10000)
    expect(w.hyp.gross).toBe(13000)
    expect(w.hyp.deduction).toBe(3000)
    expect(w.hyp.net).toBe(10000)

    // delta_month = 13 000 − 11 550 = 1 450 ; delta_year = 1 450 × 12 = 17 400
    expect(w.delta_month).toBe(1450)
    expect(w.delta_year).toBe(17400)
    // no household costs passed → no household total
    expect(w.household).toBeNull()
  })

  it('household total layers only the rate delta on the budgeted shared costs', () => {
    // shared costs 40 000 kr/mån (mortgage line left as budgeted); rate 3,42→4,00
    const w = rateWhatIf(3_000_000, 3.42, 4.0, 3000, 40000)!
    // now = budgeted shared costs, untouched
    expect(w.household!.now).toBe(40000)
    // hyp = 40 000 + delta_month(1 450) = 41 450 — only the rate effect is added
    expect(w.household!.hyp).toBe(41450)
  })

  it('household total moves down on a rate cut', () => {
    const w = rateWhatIf(3_000_000, 3.42, 2.92, 3000, 40000)!
    // delta_month = −1 250 → household hyp = 40 000 − 1 250 = 38 750
    expect(w.household!.now).toBe(40000)
    expect(w.household!.hyp).toBe(38750)
  })

  it('household is null when shared costs are zero or omitted', () => {
    expect(rateWhatIf(3_000_000, 3.42, 4, 3000, 0)!.household).toBeNull()
    expect(rateWhatIf(3_000_000, 3.42, 4, 3000)!.household).toBeNull()
  })

  it('rate cut: 3 000 000 kr, Ø 3,42 % → 2,92 %', () => {
    const w = rateWhatIf(3_000_000, 3.42, 2.92, 3000)!
    // hyp interest = 3 000 000 × 2.92/100 / 12 = 7 300 ; gross = 7 300 + 3 000 = 10 300
    expect(w.hyp.interest).toBe(7300)
    expect(w.hyp.gross).toBe(10300)
    // delta_month = 10 300 − 11 550 = −1 250 ; delta_year = −1 250 × 12 = −15 000
    expect(w.delta_month).toBe(-1250)
    expect(w.delta_year).toBe(-15000)
  })

  it('bracket quirk runs on monthly figures: 50 M kr at 3,00 %', () => {
    const w = rateWhatIf(50_000_000, 3.0, 3.0, 0)!
    // interest  = 50 000 000 × 3/100 / 12 = 125 000
    // deduction = 100 000 × 0.30 + 25 000 × 0.21 = 30 000 + 5 250 = 35 250
    // net       = 125 000 − 35 250 = 89 750  (gross = interest, amort = 0)
    expect(w.hyp.interest).toBe(125000)
    expect(w.hyp.gross).toBe(125000)
    expect(w.hyp.deduction).toBe(35250)
    expect(w.hyp.net).toBe(89750)
    // both legs identical → zero delta
    expect(w.delta_month).toBe(0)
    expect(w.delta_year).toBe(0)
  })

  it('rate = 0 is a valid question ("what if it were free")', () => {
    const w = rateWhatIf(3_000_000, 3.42, 0, 3000)!
    expect(w).not.toBeNull()
    expect(w.hyp.interest).toBe(0)
    expect(w.hyp.gross).toBe(3000)         // just the amortization
    expect(w.hyp.deduction).toBe(0)
    // delta_month = 3 000 − 11 550 = −8 550
    expect(w.delta_month).toBe(-8550)
  })

  it('negative amortization clamps to 0', () => {
    const w = rateWhatIf(3_000_000, 3.42, 4.0, -500)!
    // amort clamps to 0 → gross == interest on both legs
    expect(w.amortization).toBe(0)
    expect(w.now.gross).toBe(8550)
    expect(w.hyp.gross).toBe(10000)
  })

  it('gates to null: zero balance', () => {
    expect(rateWhatIf(0, 3.42, 4, 3000)).toBeNull()
  })
  it('gates to null: zero/absent base rate', () => {
    expect(rateWhatIf(3_000_000, 0, 4, 3000)).toBeNull()
  })
  it('gates to null: negative hypothetical rate', () => {
    expect(rateWhatIf(3_000_000, 3.42, -1, 3000)).toBeNull()
  })
})
