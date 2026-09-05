// Plan 128 stage 1 — replay goldens for `fitBankProfile`.
//
// The fitter replays every historical interest charge from the balance at
// interval start, the listed rate covering the whole interval and the observed
// dates, then scores three candidate models:
//
//   360-days → balance × rate/100 × days / 360
//   365-days → balance × rate/100 × days / 365
//   monthly  → balance × rate/100 / 12 × period_months   (no year basis at all)
//
// Every amount below is hand-computed with the arithmetic shown beside it, so a
// fixture that stops being exact is a broken formula, not a broken expectation.
import { describe, it, expect } from 'vitest'
import { fitBankProfile } from './mortgage'
import type { LoanPart, Payment, RatePeriod } from './mortgage'

function part(over: Partial<LoanPart> = {}): LoanPart {
  return {
    id: 'p1', created_at: '', label: 'Del 1', loan_number: '',
    start_balance: 1_000_000, start_date: '2025-01-01', archived: false, ...over,
  }
}
function period(over: Partial<RatePeriod> = {}): RatePeriod {
  return {
    id: 'r1', created_at: '', loan_part_id: 'p1',
    start_date: '2025-01-01', end_date: '2027-12-31', rate: 3.65, rate_type: 'bunden', ...over,
  }
}
// Interest rows carry a constant saldo, so the balance at every interval start
// resolves to the same B — the replay isolates the convention, not the balance.
const row = (date: string, amount: number, balance: number, over: Partial<Payment> = {}): Payment => ({
  id: 'i' + date, created_at: '', loan_part_id: 'p1', date, kind: 'interest',
  description: 'Ränta', amount, balance_after: balance, paid_by: 'joint', source: 'import:bank.csv', ...over,
})

describe('fitBankProfile — a known faktisk/360 bank', () => {
  // 1 200 000 kr at 3,60 % on a 360-day bankår = 120 kr/dag, billed month-end.
  const B = 1_200_000
  const rows = [
    row('2026-01-31', 3720, B), // opener (31 d from december) — interval start only
    row('2026-02-28', 3360, B), // 28 d × 120
    row('2026-03-31', 3720, B), // 31 d × 120
    row('2026-04-30', 3600, B), // 30 d × 120
    row('2026-05-31', 3720, B), // 31 d × 120
    row('2026-06-30', 3600, B), // 30 d × 120
  ]
  const periods = [period({ rate: 3.60 })]

  it('fits 360 / days exactly and proves it', () => {
    const fit = fitBankProfile([part({ start_balance: B })], periods, rows)!
    expect(fit).not.toBeNull()
    expect(fit.year_basis).toBe(360)
    expect(fit.charge_basis).toBe('days')
    expect(fit.covered).toBe(5)
    expect(fit.residual).toBe(0)
    expect(fit.proven).toBe(true)
  })

  it('beats /365 and flat-monthly by a wide margin, and reads the month-end cadence', () => {
    const fit = fitBankProfile([part({ start_balance: B })], periods, rows)!
    // /365 misprices every interval by ~1,4 %; flat monthly (3 600 kr) misses
    // the 28- and 31-day months entirely. Either way the runner-up is far off.
    expect(fit.runner_up_residual).toBeGreaterThan(200)
    expect(fit.billing).toBe('month-end')
  })
})

describe('fitBankProfile — a known actual/365 bank', () => {
  // 1 000 000 kr at 3,65 % on 365 dagar = 100 kr/dag, billed the 27th.
  const B = 1_000_000
  const rows = [
    row('2026-01-27', 3100, B), // opener
    row('2026-02-27', 3100, B), // 31 d × 100
    row('2026-03-27', 2800, B), // 28 d × 100
    row('2026-04-27', 3100, B), // 31 d × 100
    row('2026-05-27', 3000, B), // 30 d × 100
    row('2026-06-27', 3100, B), // 31 d × 100
  ]

  it('fits 365 / days exactly and proves it', () => {
    const fit = fitBankProfile([part()], [period()], rows)!
    expect(fit.year_basis).toBe(365)
    expect(fit.charge_basis).toBe('days')
    expect(fit.covered).toBe(5)
    expect(fit.residual).toBe(0)
    expect(fit.proven).toBe(true)
    expect(fit.billing).toBe('fixed') // a fixed day-of-month, not month-end
  })
})

describe('fitBankProfile — a flat-monthly (30/360) bank', () => {
  // 900 000 kr at 4,00 % = 3 000 kr per månad, identical in a 28- and a 31-day
  // month: the charge does not scale with the day count at all.
  const B = 900_000
  const rows = [
    row('2026-01-31', 3000, B), row('2026-02-28', 3000, B), row('2026-03-31', 3000, B),
    row('2026-04-30', 3000, B), row('2026-05-31', 3000, B), row('2026-06-30', 3000, B),
  ]

  it('fits the flat month exactly, with the inert 365 placeholder as year basis', () => {
    const fit = fitBankProfile([part({ start_balance: B })], [period({ rate: 4.00 })], rows)!
    expect(fit.charge_basis).toBe('monthly')
    expect(fit.year_basis).toBe(365) // nominal — never consumed by the monthly formula
    expect(fit.covered).toBe(5)
    expect(fit.residual).toBe(0)
    expect(fit.proven).toBe(true)
    // The next-best model is a distinct one (a days model), never a second
    // copy of the monthly winner — otherwise the margin would prove nothing.
    expect(fit.runner_up_residual).toBeGreaterThan(300)
  })
})

describe('fitBankProfile — an ambiguous history proves nothing', () => {
  const B = 1_000_000
  // Charges sitting midway between /365 (100,0000 kr/dag) and /360 (101,3889
  // kr/dag): 100,6944 kr/dag. Neither model reproduces the ledger.
  const equidistant = [
    row('2026-01-27', 3121.53, B), // opener
    row('2026-02-27', 3121.53, B), // 31 d × 100,6944
    row('2026-03-27', 2819.44, B), // 28 d × 100,6944
    row('2026-04-27', 3121.53, B), // 31 d
    row('2026-05-27', 3020.83, B), // 30 d × 100,6944
    row('2026-06-27', 3121.53, B), // 31 d
  ]
  // Charges leaning towards /365 (100,30 kr/dag) — close enough that the
  // residual clears the kronor tolerance, but the runner-up is inside the 4×
  // margin, so uniqueness is NOT established.
  const nearMiss = [
    row('2026-01-27', 3109.30, B), // opener
    row('2026-02-27', 3109.30, B), // 31 d × 100,30
    row('2026-03-27', 2808.40, B), // 28 d × 100,30
    row('2026-04-27', 3109.30, B), // 31 d
    row('2026-05-27', 3009.00, B), // 30 d × 100,30
    row('2026-06-27', 3109.30, B), // 31 d
  ]

  it('a history equidistant between two models is not proven', () => {
    const fit = fitBankProfile([part()], [period()], equidistant)!
    expect(fit.covered).toBe(5)
    expect(fit.proven).toBe(false)
    expect(fit.runner_up_residual).toBeLessThan(4 * fit.residual)
  })

  it('a near-miss inside the 4× margin is not proven even though the residual is small', () => {
    const fit = fitBankProfile([part()], [period()], nearMiss)!
    const charged = 3109.30 * 3 + 2808.40 + 3009.00
    expect(fit.covered).toBe(5)
    expect(fit.residual).toBeLessThanOrEqual(0.005 * charged) // inside tolerance
    expect(fit.runner_up_residual).toBeLessThan(4 * fit.residual) // but not unique
    expect(fit.proven).toBe(false)
  })
})

describe('fitBankProfile — no covering rate period', () => {
  const B = 1_000_000
  const rows = [
    row('2026-01-27', 3100, B), row('2026-02-27', 3100, B), row('2026-03-27', 2800, B),
    row('2026-04-27', 3100, B), row('2026-05-27', 3000, B), row('2026-06-27', 3100, B),
  ]

  it('returns null when no rate period exists at all', () => {
    expect(fitBankProfile([part()], [], rows)).toBeNull()
  })

  it('returns null when every period expired before the charges', () => {
    const expired = [period({ start_date: '2024-01-01', end_date: '2025-12-31' })]
    expect(fitBankProfile([part()], expired, rows)).toBeNull()
  })

  it('returns null when there are no interest charges to replay', () => {
    expect(fitBankProfile([part()], [period()], [])).toBeNull()
  })
})

describe('fitBankProfile — a rate change inside an interval is skipped', () => {
  // A faktisk/360 bank at 1 200 000 kr: 3,93 % (131 kr/dag) until 2026-03-31,
  // then 4,80 % (160 kr/dag). The 03-31 → 04-30 accrual straddles the
  // villkorsändring, and the bank's blended 4 500 kr for it matches no single
  // rate — if the fitter replayed it, the residual would be 300 kr and nothing
  // would be proven.
  const B = 1_200_000
  const periods: RatePeriod[] = [
    { id: 'w1', created_at: '', loan_part_id: 'p1', start_date: '2025-06-01', end_date: '2026-03-31', rate: 3.93, rate_type: 'bunden' },
    { id: 'w2', created_at: '', loan_part_id: 'p1', start_date: '2026-04-01', end_date: '2027-12-31', rate: 4.80, rate_type: 'bunden' },
  ]
  const rows = [
    row('2026-01-31', 4061, B), // opener
    row('2026-02-28', 3668, B), // 28 d × 131   (w1)
    row('2026-03-31', 4061, B), // 31 d × 131   (w1)
    row('2026-04-30', 4500, B), // straddles w1/w2 — blended, replayable by neither
    row('2026-05-31', 4960, B), // 31 d × 160   (w2)
    row('2026-06-30', 4800, B), // 30 d × 160   (w2)
    row('2026-07-31', 4960, B), // 31 d × 160   (w2)
  ]

  it('counts only the intervals sitting inside ONE rate period', () => {
    const fit = fitBankProfile([part({ start_balance: B })], periods, rows)!
    expect(fit.covered).toBe(5) // 6 pairs, minus the straddling one
    expect(fit.year_basis).toBe(360)
    expect(fit.charge_basis).toBe('days')
    expect(fit.residual).toBe(0) // exact — the blended 4 500 kr never entered the replay
    expect(fit.proven).toBe(true)
  })
})

describe('fitBankProfile — pooling across a bank\'s parts', () => {
  // Two parts of the same bank, both faktisk/360 at 3,60 %: 600 000 kr (60
  // kr/dag) and 300 000 kr (30 kr/dag). Neither part alone reaches the four
  // replayed charges the proof requires; pooled they do.
  const p1 = part({ id: 'p1', start_balance: 600_000 })
  const p2 = part({ id: 'p2', start_balance: 300_000 })
  const periods: RatePeriod[] = [
    period({ id: 'r1', loan_part_id: 'p1', rate: 3.60 }),
    period({ id: 'r2', loan_part_id: 'p2', rate: 3.60 }),
  ]
  const rows = [
    row('2026-01-31', 1860, 600_000), row('2026-02-28', 1680, 600_000), row('2026-03-31', 1860, 600_000), // 28/31 d × 60
    row('2026-01-31', 930, 300_000, { id: 'j1', loan_part_id: 'p2' }),  // opener
    row('2026-02-28', 840, 300_000, { id: 'j2', loan_part_id: 'p2' }),  // 28 d × 30
    row('2026-03-31', 930, 300_000, { id: 'j3', loan_part_id: 'p2' }),  // 31 d × 30
  ]

  it('pools every part\'s intervals into one fit', () => {
    expect(fitBankProfile([p1], periods, rows)!.covered).toBe(2)   // too thin alone
    expect(fitBankProfile([p1], periods, rows)!.proven).toBe(false)
    const pooled = fitBankProfile([p1, p2], periods, rows)!
    expect(pooled.covered).toBe(4)
    expect(pooled.year_basis).toBe(360)
    expect(pooled.residual).toBe(0)
    expect(pooled.proven).toBe(true)
  })
})
