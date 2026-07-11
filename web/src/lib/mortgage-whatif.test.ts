import { describe, it, expect } from 'vitest'
import { rateWhatIf } from './mortgage'

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
