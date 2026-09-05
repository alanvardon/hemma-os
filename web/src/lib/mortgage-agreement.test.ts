// Plan 109b — effective bank-profile resolution, drift, agreement scoping,
// the agreement-agnostic copy preview and cross-agreement ownership.
// Every golden number is hand-computed; the arithmetic is in the comment
// beside it. Pure-function tests only — no store, no UI.
import { describe, it, expect } from 'vitest'
import {
  effectiveBankProfile, copyPartsPreview,
  activeMortgage, partsForMortgage, paymentsForMortgage,
  activeAgreementMortgage, activeAgreementParts, activeAgreementPayments, activeAgreementBalance,
  lifetimeAmortized, partsMissingRateTerms,
  learnYearBasis, expectedCharge, expectedCharges, totalBalance, totalAmortized,
  contributionSplit, costBasisSplit, costBasisEquity, defaultSettings, groupLoanParts,
} from './mortgage'
import type { Bank, CatalogBank, LoanPart, Mortgage, Payment, RatePeriod } from './mortgage'

// ── Shared fixture helpers ───────────────────────────────────────────────────

function part(over: Partial<LoanPart> = {}): LoanPart {
  return {
    id: 'p1', created_at: '', label: 'Del 1', loan_number: '',
    start_balance: 0, start_date: '2026-01-01', archived: false,
    mortgage_id: null, original_balance: null, original_date: null, ...over,
  }
}
function bank(over: Partial<Bank> = {}): Bank {
  return { id: 'b1', created_at: '', label: 'Banken', year_basis: null, year_basis_source: null, billing: null, billing_source: null, charge_basis: null, charge_basis_source: null, catalog_id: null, ...over }
}
function catalog(over: Partial<CatalogBank> = {}): CatalogBank {
  return { id: 'cat1', slug: 'banken', label: 'Banken', year_basis: null, billing: null, charge_basis: null, ...over }
}
function mortgage(over: Partial<Mortgage> = {}): Mortgage {
  return { id: 'm1', created_at: '', bank_id: 'b1', label: 'Bolån', start_date: '2021-09-01', archived: false, end_date: null, ...over }
}
function interestRow(date: string, amount: number, over: Partial<Payment> = {}): Payment {
  return {
    id: 'i' + date + (over.id ?? ''), created_at: '', loan_part_id: 'p1', date, kind: 'interest',
    description: 'Ränta', amount, balance_after: null, paid_by: 'joint', source: 'import:bank.csv', ...over,
  }
}
function saldoRow(loan_part_id: string, date: string, balance_after: number): Payment {
  return { id: 's-' + loan_part_id + date, created_at: '', loan_part_id, date, kind: 'payment', description: '', amount: 0, balance_after, paid_by: 'joint', source: 'import' }
}
function amortRow(loan_part_id: string, date: string, amount: number, over: Partial<Payment> = {}): Payment {
  return { id: 'a-' + loan_part_id + date, created_at: '', loan_part_id, date, kind: 'amortization', description: '', amount, balance_after: null, paid_by: 'joint', source: 'manual', ...over }
}

// The plan-104 window-scoped bank-pooled learner fixture (same shape as the
// verified mortgage-forecast goldens): B = 1 200 000, three bunden windows,
// every charge a whole number of days × that window's /360 day-value
// (131 / 140 / 120 kr) — a faktisk/360 bank read confidently by the learner.
const B = 1_200_000
const learnerPeriods = (): RatePeriod[] => [
  { id: 'w1', created_at: '', loan_part_id: 'p1', start_date: '2025-06-01', end_date: '2026-05-31', rate: 3.93, rate_type: 'bunden' },
  { id: 'w2', created_at: '', loan_part_id: 'p1', start_date: '2026-06-01', end_date: '2026-08-31', rate: 4.20, rate_type: 'bunden' },
  { id: 'w3', created_at: '', loan_part_id: 'p1', start_date: '2026-09-01', end_date: '2027-12-31', rate: 3.60, rate_type: 'bunden' },
]
const learnerRow = (date: string, amount: number) => interestRow(date, amount, { balance_after: B })
// 131 kr/day (3,93 %): 30 d → 3 930 · 31 d → 4 061; 140 kr/day (4,20 %); 120 kr/day (3,60 %).
const confidentLedger = () => [
  learnerRow('2026-02-28', 3930), learnerRow('2026-03-31', 4061), learnerRow('2026-04-30', 3930), learnerRow('2026-05-31', 4061), // w1: 3 pairs
  learnerRow('2026-06-30', 4200), learnerRow('2026-07-31', 4340), learnerRow('2026-08-31', 4340),                                 // w2: 2 pairs
  learnerRow('2026-09-30', 3600), learnerRow('2026-10-31', 3720),                                                                 // w3: 1 pair
] // used = 6 pairs ≥ 3, err360 = 0, err365 ≈ 0.4/pair > 0.2·6; windows = 3 ≥ 2 → confident 360
// One thin window: a single usable pair (used = 1 < 3, windows = 1 < 2) → below the gate.
const thinLedger = () => [learnerRow('2026-09-30', 3600), learnerRow('2026-10-31', 3720)]

// ── Effective bank-profile precedence (owner decision 2026-07-16) ────────────

describe('effectiveBankProfile — precedence lock > confident detection > catalogue > fallback', () => {
  const parts = () => [part()]

  it('the fixture sits on the plan-104 confidence gate exactly as documented', () => {
    const confident = learnYearBasis(parts(), learnerPeriods(), confidentLedger())
    expect(confident).toMatchObject({ basis: 360, confident: true })
    expect(confident.used).toBe(6)
    expect(confident.windows).toBe(3)
    const thin = learnYearBasis(parts(), learnerPeriods(), thinLedger())
    expect(thin.confident).toBe(false)
    expect(thin.used).toBeLessThan(3)
  })

  it('a household-declared lock outranks confident detection AND the catalogue', () => {
    // Lock 365 vs confident ledger 360 vs catalogue 360 → the lock wins.
    const r = effectiveBankProfile(
      bank({ year_basis: 365, year_basis_source: 'declared' }),
      catalog({ year_basis: 360 }),
      parts(), learnerPeriods(), confidentLedger())
    expect(r.year_basis).toEqual({ value: 365, source: 'declared' })
    // …and the contradiction is surfaced as drift, never silently rewritten.
    expect(r.drift).toEqual([{ field: 'year_basis', against: 'declared', held: 365, observed: 360, effective: 365 }])
  })

  it('confident household detection outranks the catalogue value', () => {
    // No lock; catalogue says 365; the household ledger confidently reads 360.
    const r = effectiveBankProfile(bank(), catalog({ year_basis: 365 }), parts(), learnerPeriods(), confidentLedger())
    expect(r.year_basis).toEqual({ value: 360, source: 'detected' })
    // The outranked catalogue value is reported as drift so the UI can badge it.
    expect(r.drift).toEqual([{ field: 'year_basis', against: 'catalog', held: 365, observed: 360, effective: 360 }])
  })

  it('below the confidence threshold the catalogue value wins (other side of the gate)', () => {
    // Same bank, same catalogue — but only one thin window of evidence.
    const r = effectiveBankProfile(bank(), catalog({ year_basis: 360 }), parts(), learnerPeriods(), thinLedger())
    expect(r.year_basis).toEqual({ value: 360, source: 'catalog' })
    expect(r.drift).toEqual([])
  })

  it('no lock, no confident detection, no catalogue → the generic fallback (365, fixed)', () => {
    const r = effectiveBankProfile(bank(), null, parts(), learnerPeriods(), thinLedger())
    expect(r.year_basis).toEqual({ value: 365, source: 'default' })
    expect(r.billing).toEqual({ value: 'fixed', source: 'default' })
    expect(r.drift).toEqual([])
  })

  it('an agreeing lock produces no drift', () => {
    const r = effectiveBankProfile(
      bank({ year_basis: 360, year_basis_source: 'declared' }),
      catalog({ year_basis: 365 }),
      parts(), learnerPeriods(), confidentLedger())
    expect(r.year_basis).toEqual({ value: 360, source: 'declared' })
    expect(r.drift).toEqual([])
  })

  it('a malformed declared value is NOT a lock — resolution falls through', () => {
    // year_basis 400 with source declared: the lock is void; the confident
    // detection (360) takes over. Garbage never becomes a convention.
    const r = effectiveBankProfile(
      bank({ year_basis: 400, year_basis_source: 'declared' }),
      catalog({ year_basis: 365 }),
      parts(), learnerPeriods(), confidentLedger())
    expect(r.year_basis).toEqual({ value: 360, source: 'detected' })
  })

  it('a malformed catalogue value is ignored — falls to the generic default', () => {
    const r = effectiveBankProfile(bank(), catalog({ year_basis: 400, billing: 'weird' }), parts(), learnerPeriods(), thinLedger())
    expect(r.year_basis).toEqual({ value: 365, source: 'default' })
    expect(r.billing).toEqual({ value: 'fixed', source: 'default' })
  })

  it('stored detected/suggested provenance never short-circuits — detection is recomputed fresh', () => {
    // A stale stored year_basis: 360/source detected, but the fresh ledger is
    // thin → resolution must NOT trust the stored value (plan-104 phase-1 rule:
    // only declared short-circuits) and lands on the catalogue/default.
    const r = effectiveBankProfile(
      bank({ year_basis: 360, year_basis_source: 'detected' }),
      null, parts(), learnerPeriods(), thinLedger())
    expect(r.year_basis).toEqual({ value: 365, source: 'default' })
  })

  it('a custom bank with no rules starts on Auto: pure detection, no catalogue', () => {
    const custom = bank({ id: 'bx', label: 'Min egen bank', catalog_id: null })
    // No history at all → generic defaults.
    const cold = effectiveBankProfile(custom, null, parts(), [], [])
    expect(cold.year_basis).toEqual({ value: 365, source: 'default' })
    expect(cold.billing).toEqual({ value: 'fixed', source: 'default' })
    // Once the ledger accumulates confident evidence, detection takes over.
    const warm = effectiveBankProfile(custom, null, parts(), learnerPeriods(), confidentLedger())
    expect(warm.year_basis).toEqual({ value: 360, source: 'detected' })
  })

  it('returning to a bank reuses its private locks (profile is bank-keyed, not agreement-keyed)', () => {
    // The household's private profile row survives the agreement change; the
    // resolution depends only on (bank, catalogue, ledger) — so coming back to
    // the bank with its old declared lock yields the identical resolution.
    const locked = bank({ year_basis: 360, year_basis_source: 'declared' })
    const before = effectiveBankProfile(locked, catalog(), parts(), learnerPeriods(), confidentLedger())
    const afterReturn = effectiveBankProfile(locked, catalog(), parts(), learnerPeriods(), confidentLedger())
    expect(afterReturn).toEqual(before)
    expect(afterReturn.year_basis).toEqual({ value: 360, source: 'declared' })
  })
})

describe('effectiveBankProfile — billing convention', () => {
  // Month-end-shaped ledger: 4 dated charges, all at a month boundary (03-31,
  // 04-30, 06-01 = rolled 05-31, 06-30), ≥ 2 genuinely late → the plan-104
  // suggest criterion reads a confident 'month-end'.
  const monthEndLedger = () => [
    interestRow('2026-03-31', 3100), interestRow('2026-04-30', 3000),
    interestRow('2026-06-01', 3100), interestRow('2026-06-30', 2900),
  ]
  // Fixed mid-month biller (the 27th): never confident — 'fixed' is the
  // unremarkable default with no promotable criterion.
  const fixedLedger = () => [
    interestRow('2026-03-27', 3100), interestRow('2026-04-27', 3100),
    interestRow('2026-05-27', 3000), interestRow('2026-06-27', 3100),
  ]

  it('confident month-end detection outranks a catalogue fixed value, with drift', () => {
    const r = effectiveBankProfile(bank(), catalog({ billing: 'fixed' }), [part()], [], monthEndLedger())
    expect(r.billing).toEqual({ value: 'month-end', source: 'detected' })
    expect(r.drift).toEqual([{ field: 'billing', against: 'catalog', held: 'fixed', observed: 'month-end', effective: 'month-end' }])
  })

  it('a declared fixed lock outranks confident month-end detection, surfacing drift', () => {
    const r = effectiveBankProfile(bank({ billing: 'fixed', billing_source: 'declared' }), null, [part()], [], monthEndLedger())
    expect(r.billing).toEqual({ value: 'fixed', source: 'declared' })
    expect(r.drift).toEqual([{ field: 'billing', against: 'declared', held: 'fixed', observed: 'month-end', effective: 'fixed' }])
  })

  it('a fixed-day ledger is never confident: the catalogue month-end wins without drift', () => {
    // 'fixed' has no promotable confident criterion (plan 104), so detection
    // can never outrank — or contradict — a month-end catalogue value.
    const r = effectiveBankProfile(bank(), catalog({ billing: 'month-end' }), [part()], [], fixedLedger())
    expect(r.billing).toEqual({ value: 'month-end', source: 'catalog' })
    expect(r.drift).toEqual([])
  })
})

// ── charge_basis / räntemodell (plan 128 stage 2) ────────────────────────────
// The third convention is the only one resolved by the REPLAY fitter: its
// "detected" input counts only when fitBankProfile reproduced the bank's own
// charges (`proven`). An unproven fit is worth nothing and must fall through.
describe('effectiveBankProfile — charge_basis convention', () => {
  const parts = () => [part()]
  // A flat-monthly biller on w3 (2026-09-01 → 2027-12-31 @ 3,60 %):
  // B × 3,60 % / 12 = 3 600 kr EVERY month, whatever the day count — where a
  // days basis would read 120 kr/day (31 d → 3 720). 4 replayable pairs, exact.
  const monthlyLedger = () => [
    learnerRow('2026-09-30', 3600), learnerRow('2026-10-31', 3600),
    learnerRow('2026-11-30', 3600), learnerRow('2026-12-31', 3600),
    learnerRow('2027-01-31', 3600),
  ]

  it('a proven flat-monthly fit is the detected räntemodell', () => {
    const r = effectiveBankProfile(bank(), null, parts(), learnerPeriods(), monthlyLedger())
    expect(r.charge_basis).toEqual({ value: 'monthly', source: 'detected' })
  })

  it('a proven per-day fit reads days, and outranks a contradicting catalogue value with drift', () => {
    const r = effectiveBankProfile(bank(), catalog({ charge_basis: 'monthly' }), parts(), learnerPeriods(), confidentLedger())
    expect(r.charge_basis).toEqual({ value: 'days', source: 'detected' })
    expect(r.drift).toContainEqual({ field: 'charge_basis', against: 'catalog', held: 'monthly', observed: 'days', effective: 'days' })
  })

  it('an UNPROVEN fit is discarded: the catalogue value wins', () => {
    // One thin pair — below the replay proof (covered ≥ 4), so nothing is detected.
    const r = effectiveBankProfile(bank(), catalog({ charge_basis: 'monthly' }), parts(), learnerPeriods(), thinLedger())
    expect(r.charge_basis).toEqual({ value: 'monthly', source: 'catalog' })
    expect(r.drift).toEqual([])
  })

  it('no proof and no catalogue → the generic Swedish default (days)', () => {
    // 'days' is the ordinary convention; flat 30/360 is the exception and is
    // never assumed without evidence.
    const r = effectiveBankProfile(bank(), null, parts(), learnerPeriods(), thinLedger())
    expect(r.charge_basis).toEqual({ value: 'days', source: 'default' })
    const cold = effectiveBankProfile(bank(), null, parts(), [], [])
    expect(cold.charge_basis).toEqual({ value: 'days', source: 'default' })
  })

  it('a declared räntemodell always wins over the fitter, surfacing drift', () => {
    const r = effectiveBankProfile(
      bank({ charge_basis: 'monthly', charge_basis_source: 'declared' }),
      catalog({ charge_basis: 'days' }),
      parts(), learnerPeriods(), confidentLedger())
    expect(r.charge_basis).toEqual({ value: 'monthly', source: 'declared' })
    expect(r.drift).toContainEqual({ field: 'charge_basis', against: 'declared', held: 'monthly', observed: 'days', effective: 'monthly' })
  })

  it('a malformed declared räntemodell is NOT a lock — resolution falls through', () => {
    const r = effectiveBankProfile(
      bank({ charge_basis: 'weekly', charge_basis_source: 'declared' }),
      null, parts(), learnerPeriods(), confidentLedger())
    expect(r.charge_basis).toEqual({ value: 'days', source: 'detected' })
  })
})

// ── Copy preview (agreement-agnostic; plan 109 decision 4) ───────────────────

describe('copyPartsPreview', () => {
  // P1 'Bottenlån': origination 1 200 000 @ 2024-01-01; Saldo 1 000 000 @
  // 2026-05-31; amortering 8 000 @ 2026-06-27. Declared plan 8 000 kr/mån.
  const p1 = () => part({
    id: 'p1', label: 'Bottenlån', loan_number: '9160-123456', mortgage_id: 'mOld',
    original_balance: 1_200_000, original_date: '2024-01-01',
    planned_amortization: 8000, planned_amortization_start: '2024-01-01', planned_amortization_end: null,
  })
  // P2 'Topplån': origination 500 000 @ 2024-01-01; one Betalning month with a
  // MISSING Ränta row → the resolver estimates (principal 5 000, warning).
  const p2 = () => part({ id: 'p2', label: 'Topplån', mortgage_id: 'mOld', original_balance: 500_000, original_date: '2024-01-01' })
  const ledger = (): Payment[] => [
    saldoRow('p1', '2026-05-31', 1_000_000),
    amortRow('p1', '2026-06-27', 8000),
    { id: 'bet-p2', created_at: '', loan_part_id: 'p2', date: '2026-06-27', kind: 'payment', description: 'Betalning', amount: 5000, balance_after: null, paid_by: 'joint', source: 'import' },
  ]

  it('resolves each part at the effective date with golden balances', () => {
    const r = copyPartsPreview([p1(), p2()], ledger(), '2026-07-01')
    expect(r.effective_date).toBe('2026-07-01')
    // P1: Saldo anchor 1 000 000 − 8 000 amortering = 992 000, observed.
    expect(r.drafts[0]).toEqual({
      source_part_id: 'p1', label: 'Bottenlån',
      balance: 992_000, balance_quality: 'observed', balance_source: 'saldo',
      planned_amortization: 8000, warnings: [],
    })
    // P2: origination anchor 500 000 − inferred betalning principal 5 000 =
    // 495 000 — but the missing Ränta row makes it an ESTIMATE, never silently clean.
    expect(r.drafts[1]).toEqual({
      source_part_id: 'p2', label: 'Topplån',
      balance: 495_000, balance_quality: 'estimated', balance_source: 'origination',
      planned_amortization: null, warnings: ['missing-interest'],
    })
    expect(r.total_balance).toBe(1_487_000)          // 992 000 + 495 000
    expect(r.estimated).toBe(true)
    expect(r.warnings).toEqual([])
  })

  it('honours the effective date: earlier date excludes later ledger rows', () => {
    // At 2026-06-01 the 27 Jun amortering has not happened: P1 = 1 000 000.
    const r = copyPartsPreview([p1()], ledger(), '2026-06-01')
    expect(r.drafts[0].balance).toBe(1_000_000)
    expect(r.drafts[0].balance_quality).toBe('observed')
  })

  it('copies ONLY the approved fields — no numbers, rates, dates, histories or ids', () => {
    const r = copyPartsPreview([p1()], ledger(), '2026-07-01')
    // The draft shape is exactly label + resolved balance (+ provenance) +
    // amortisation suggestion. loan_number, original_balance/date, rate data,
    // created_at and the old row id must be absent by construction.
    expect(Object.keys(r.drafts[0]).sort()).toEqual([
      'balance', 'balance_quality', 'balance_source', 'label', 'planned_amortization', 'source_part_id', 'warnings',
    ])
  })

  it('is agreement-agnostic: identical output whatever agreement the parts belong to', () => {
    const inOld = copyPartsPreview([p1()], ledger(), '2026-07-01')
    const inOther = copyPartsPreview([{ ...p1(), mortgage_id: 'mCompletelyDifferent' }], ledger(), '2026-07-01')
    expect(inOther).toEqual(inOld)
  })

  it('a declared plan that ended before the effective date is not suggested', () => {
    // The old plan's end date belongs to the old contract; a dead plan must
    // not resurrect as a suggestion.
    const ended = { ...p1(), planned_amortization_end: '2026-01-31' }
    const r = copyPartsPreview([ended], ledger(), '2026-07-01')
    expect(r.drafts[0].planned_amortization).toBeNull()
  })

  it('skips archived parts — only active debt is proposed', () => {
    const r = copyPartsPreview([p1(), { ...p2(), archived: true }], ledger(), '2026-07-01')
    expect(r.drafts.map(d => d.source_part_id)).toEqual(['p1'])
  })

  it('a malformed effective date yields no drafts and a typed warning — never a guess', () => {
    for (const bad of ['', '2026-13-01', '2026-02-30', 'not-a-date']) {
      const r = copyPartsPreview([p1()], ledger(), bad)
      expect(r.drafts).toEqual([])
      expect(r.warnings).toEqual(['invalid-effective-date'])
    }
  })

  it('conflicting Saldo evidence stays estimated with its warning carried through', () => {
    const conflict = [
      saldoRow('p1', '2026-05-31', 1_000_000),
      { ...saldoRow('p1', '2026-05-31', 998_000), id: 's-dup' },
    ]
    const r = copyPartsPreview([p1()], conflict, '2026-07-01')
    expect(r.drafts[0].balance_quality).toBe('estimated')
    expect(r.drafts[0].warnings).toEqual(['conflicting-saldo'])
    expect(r.drafts[0].balance).toBe(998_000)        // min of the conflicting saldos, resolver rule
    expect(r.estimated).toBe(true)
  })
})

// ── Agreement scoping + cross-agreement ownership (plan 109 decision 6) ──────

describe('agreement scoping and cross-agreement ownership', () => {
  // The refinance household:
  //   Purchase 5 000 000. Down payments: a 600 000, b 400 000 (agreement M1).
  //   M1 (Bank X): P1 original 4 000 000 @ 2021-09-01.
  //     a's extra amortering 300 000 @ 2023-06-01 (is_insats).
  //     Closing Saldo 3 700 000 @ 2025-12-31.
  //   Refinance 2026-01-01 → M2 (Bank Y): P2 opens at the copied 3 700 000.
  //     b's amortering 100 000 @ 2026-03-27 (saldo 3 600 000).
  // NOTE: the 3 700 000 payoff of Bank X is a DEBT TRANSFER — deliberately
  // never recorded as an amortisation row.
  const m1 = () => mortgage({ id: 'm1', bank_id: 'bX', archived: true, end_date: '2026-01-01' })
  const m2 = () => mortgage({ id: 'm2', bank_id: 'bY', start_date: '2026-01-01' })
  // The bank-change RPC archives the AGREEMENT, not the old parts — a part is
  // out of the active picture because its agreement closed.
  const oldPart = () => part({ id: 'p1', label: 'Gamla lånet', mortgage_id: 'm1', original_balance: 4_000_000, original_date: '2021-09-01' })
  const newPart = () => part({ id: 'p2', label: 'Nya lånet', mortgage_id: 'm2', original_balance: 3_700_000, original_date: '2026-01-01' })
  const downPayment = (id: string, paid_by: 'a' | 'b', amount: number): Payment => ({
    id, created_at: '', loan_part_id: null, date: '2021-09-01', kind: 'down_payment',
    description: 'Kontantinsats', amount, balance_after: null, paid_by, source: 'manual', is_insats: true, mortgage_id: 'm1',
  })
  const ledger = (): Payment[] => [
    downPayment('dp-a', 'a', 600_000),
    downPayment('dp-b', 'b', 400_000),
    // A fully-personal extra amortering now carries an explicit 100/0 split;
    // that is what attributes all 300 000 to a under the new contract.
    amortRow('p1', '2023-06-01', 300_000, { paid_by: 'a', is_insats: true, paid_split: { a: 300_000, b: 0 } }),
    saldoRow('p1', '2025-12-31', 3_700_000),
    amortRow('p2', '2026-03-27', 100_000, { paid_by: 'b', balance_after: 3_600_000 }),
  ]
  const settings = { ...defaultSettings(), i_am: 'a' as const, my_ownership_pct: 50 }

  it('activeMortgage picks the single unarchived agreement', () => {
    expect(activeMortgage([m1(), m2()])?.id).toBe('m2')
    expect(activeMortgage([m1()])).toBeNull()
    expect(activeMortgage([])).toBeNull()
  })

  it('active debt uses only the active agreement: 3 600 000, not 7 300 000', () => {
    const parts = [oldPart(), newPart()]
    const active = partsForMortgage(parts, activeMortgage([m1(), m2()])?.id)
    expect(active.map(p => p.id)).toEqual(['p2'])
    // P2: opening 3 700 000 − 100 000 amortering = 3 600 000. The old part's
    // frozen 3 700 000 must NOT be added on top.
    expect(totalBalance(active, ledger())).toBe(3_600_000)
  })

  it('an archived agreement history view sees only its own rows', () => {
    const parts = [oldPart(), newPart()]
    const history = paymentsForMortgage(ledger(), parts, 'm1')
    expect(history.map(p => p.id).sort()).toEqual(['a-p12023-06-01', 'dp-a', 'dp-b', 's-p12025-12-31'])
    const active = paymentsForMortgage(ledger(), parts, 'm2')
    expect(active.map(p => p.id)).toEqual(['a-p22026-03-27'])
    // Partless down payments follow their own mortgage_id provenance.
    expect(history.filter(p => p.kind === 'down_payment')).toHaveLength(2)
    expect(active.filter(p => p.kind === 'down_payment')).toHaveLength(0)
    // Unknown / null agreement scopes to nothing rather than everything.
    expect(paymentsForMortgage(ledger(), parts, 'nope')).toEqual([])
    expect(paymentsForMortgage(ledger(), parts, null)).toEqual([])
  })

  it('active forecasts never consume old-agreement parts or transactions', () => {
    const parts = [oldPart(), newPart()]
    const activeParts = partsForMortgage(parts, 'm2')
    const activeLedger = paymentsForMortgage(ledger(), parts, 'm2')
    expect(activeLedger.some(p => p.loan_part_id === 'p1')).toBe(false)
    const periods: RatePeriod[] = [{ id: 'r2', created_at: '', loan_part_id: 'p2', start_date: '2026-01-01', end_date: null, rate: 3.5, rate_type: 'rörlig' }]
    const { rows } = expectedCharges(activeParts, periods, activeLedger)
    expect(rows.every(r => r.loan_part_id === 'p2')).toBe(true)
    expect(rows.some(r => r.loan_part_id === 'p1')).toBe(false)
  })

  it('GOLDEN: lifetime amortisation spans both agreements without double counting the transfer', () => {
    // M1: 4 000 000 original − 3 700 000 closing = 300 000 amortised.
    // M2: 3 700 000 opening − 3 600 000 current  = 100 000 amortised.
    // Lifetime = 400 000. The 3 700 000 transfer contributes ZERO — the old
    // closing debt and new opening debt cancel by construction.
    expect(lifetimeAmortized([oldPart(), newPart()], ledger())).toBe(400_000)
    // The active-only figure (existing behaviour, untouched) sees only M2's
    // 100 000 — which is exactly why the lifetime figure exists.
    const active = partsForMortgage([oldPart(), newPart()], 'm2')
    expect(totalAmortized(active, ledger())).toBe(100_000)
  })

  it('GOLDEN: ownership after refinance still counts the original deposit and the early extra amortering', () => {
    // a: 600 000 deposit + 300 000 extra = 900 000.
    // b: 400 000 deposit + 100 000 amortering = 500 000. Total 1 400 000.
    const split = contributionSplit(ledger(), [], settings)
    expect(split).toMatchObject({ a: 900_000, b: 500_000, total: 1_400_000 })
    // a_pct = 900 000 / 1 400 000 × 100 = 64.29 (r2), b_pct = 35.71.
    expect(split.a_pct).toBe(64.29)
    expect(split.b_pct).toBe(35.71)
    // Cost-basis equity against the ACTIVE debt: 5 000 000 − 3 600 000 =
    // 1 400 000 = deposit 1 000 000 + lifetime amortised 400 000 (invariant).
    const equity = costBasisEquity(5_000_000, 3_600_000)
    expect(equity).toBe(1_400_000)
    expect(equity).toBe(1_000_000 + lifetimeAmortized([oldPart(), newPart()], ledger()))
    const cb = costBasisSplit(5_000_000, 3_600_000, ledger(), [], settings)
    expect(cb).toMatchObject({ a: 900_000, b: 500_000 })
  })

  it('recording the payoff as amortisation WOULD double count — which is why it is forbidden', () => {
    // Documenting test: if the 3 700 000 Bank-X payoff were logged as an
    // ordinary amortering, the "contributed equity" would explode from
    // 1 400 000 to 5 100 000 and lifetime amortisation from 400 000 to
    // 4 100 000 (old part resolves to 0). The model therefore never records
    // a refinance payoff as amortisation (plan 109 decision 6).
    const wrongWorld = [...ledger(), amortRow('p1', '2026-01-01', 3_700_000, { id: 'payoff' })]
    expect(contributionSplit(wrongWorld, [], settings).total).toBe(5_100_000)
    expect(lifetimeAmortized([oldPart(), newPart()], wrongWorld)).toBe(4_100_000)
  })
})

// ── Plan 118 — active-agreement balance selectors (Bostadskalkyl pull) ───────
// These encode the Bolånekoll ROUTE's legacy-tolerant active-agreement view
// scope so the cross-tool "pull current balance" and Bolånekoll's hero cannot
// drift. Every golden is hand-computed; the arithmetic is in the comment.
describe('plan 118 — active-agreement balance selectors', () => {
  it('GOLDEN: one active agreement, several parts — equals the hero scope + arithmetic', () => {
    // Active agreement m1. P1: Saldo 1 000 000 − 8 000 amortering = 992 000.
    // P2: Saldo 500 000, no later rows = 500 000. Total = 1 492 000.
    const ms = [mortgage({ id: 'm1' })]
    const p1 = part({ id: 'p1', mortgage_id: 'm1' })
    const p2 = part({ id: 'p2', mortgage_id: 'm1' })
    const parts = [p1, p2]
    const payments = [
      saldoRow('p1', '2026-05-31', 1_000_000),
      amortRow('p1', '2026-06-27', 8000),
      saldoRow('p2', '2026-05-31', 500_000),
    ]
    // Reconstruct exactly what Bolånekoll's hero computes and assert equality.
    const m = activeAgreementMortgage(ms)
    const ap = activeAgreementParts(parts, m?.id ?? null)
    const pp = activeAgreementPayments(payments, ap, m?.id ?? null)
    expect(activeAgreementBalance(ms, parts, payments)).toBe(totalBalance(ap, pp))
    expect(activeAgreementBalance(ms, parts, payments)).toBe(1_492_000)
  })

  it('GOLDEN: plan-107 payment semantics preserved across mechanisms', () => {
    // One active agreement m1 with four parts, each exercising one mechanism:
    //   pA explicit Saldo:            800 000                       = 800 000
    //   pB Betalning − Ränta:  600 000 − (12 000 − 2 000 = 10 000)  = 590 000
    //   pC extra amortering:   400 000 − 50 000                     = 350 000
    //   pD accepted predicted: 300 000 − 20 000 (source:predicted)  = 280 000
    // Total = 2 020 000.
    const ms = [mortgage({ id: 'm1' })]
    const pA = part({ id: 'pA', mortgage_id: 'm1' })
    const pB = part({ id: 'pB', mortgage_id: 'm1', original_balance: 600_000, original_date: '2024-01-01' })
    const pC = part({ id: 'pC', mortgage_id: 'm1', original_balance: 400_000, original_date: '2024-01-01' })
    const pD = part({ id: 'pD', mortgage_id: 'm1', original_balance: 300_000, original_date: '2024-01-01' })
    const parts = [pA, pB, pC, pD]
    const payments: Payment[] = [
      saldoRow('pA', '2026-05-31', 800_000),
      { id: 'betB', created_at: '', loan_part_id: 'pB', date: '2026-06-27', kind: 'payment', description: 'Betalning', amount: 12_000, balance_after: null, paid_by: 'joint', source: 'import' },
      interestRow('2026-06-27', 2000, { id: 'rB', loan_part_id: 'pB' }),
      amortRow('pC', '2026-03-27', 50_000, { is_insats: true }),
      amortRow('pD', '2026-04-27', 20_000, { id: 'predD', source: 'predicted' }),
    ]
    expect(activeAgreementBalance(ms, parts, payments)).toBe(2_020_000)
  })

  it('GOLDEN: an archived predecessor agreement is excluded after a bank change (no double count)', () => {
    // m1 archived (Bank X), m2 active (Bank Y). Old part frozen at 3 700 000;
    // new part 3 700 000 − 100 000 amortering = 3 600 000. Only m2 counts.
    const ms = [mortgage({ id: 'm1', bank_id: 'bX', archived: true, end_date: '2026-01-01' }), mortgage({ id: 'm2', bank_id: 'bY', start_date: '2026-01-01' })]
    const oldPart = part({ id: 'p1', mortgage_id: 'm1' })
    const newPart = part({ id: 'p2', mortgage_id: 'm2', original_balance: 3_700_000, original_date: '2026-01-01' })
    const parts = [oldPart, newPart]
    const payments = [
      saldoRow('p1', '2025-12-31', 3_700_000),
      amortRow('p2', '2026-03-27', 100_000, { balance_after: 3_600_000 }),
    ]
    expect(activeAgreementMortgage(ms)?.id).toBe('m2')
    expect(activeAgreementBalance(ms, parts, payments)).toBe(3_600_000)
    // The naive sum of both agreements' parts (7 300 000) is what scoping avoids.
    expect(activeAgreementBalance(ms, parts, payments)).not.toBe(7_300_000)
  })

  it('legacy unscoped parts (mortgage_id null) are included exactly once with an active agreement', () => {
    // Active m1 part 1 000 000 + a legacy unlinked part 250 000 (repair state,
    // still visible in the hero) = 1 250 000, each counted once.
    const ms = [mortgage({ id: 'm1' })]
    const scoped = part({ id: 'p1', mortgage_id: 'm1' })
    const legacy = part({ id: 'pLegacy', mortgage_id: null })
    const parts = [scoped, legacy]
    const payments = [
      saldoRow('p1', '2026-05-31', 1_000_000),
      saldoRow('pLegacy', '2026-05-31', 250_000),
    ]
    const ap = activeAgreementParts(parts, 'm1')
    expect(ap.map(p => p.id)).toEqual(['p1', 'pLegacy'])
    expect(activeAgreementBalance(ms, parts, payments)).toBe(1_250_000)
  })

  it('legacy-tolerant fallback: only-archived agreements still surface (matches the hero), empty scopes out', () => {
    // Documenting the deliberate legacy tolerance that differs from the stricter
    // activeMortgage(). When EVERY agreement is archived, the route (and this
    // selector) still surface the first one rather than making its debt vanish —
    // so its non-archived parts ARE counted, exactly as Bolånekoll's hero shows.
    const onlyArchived = [mortgage({ id: 'm1', archived: true })]
    const p1 = part({ id: 'p1', mortgage_id: 'm1' })
    const payments = [saldoRow('p1', '2026-05-31', 900_000)]
    expect(activeMortgage(onlyArchived)).toBeNull()                 // strict domain: none
    expect(activeAgreementMortgage(onlyArchived)?.id).toBe('m1')     // legacy-tolerant: the archived one
    expect(activeAgreementBalance(onlyArchived, [p1], payments)).toBe(900_000)
    // With NO agreements at all, agreement-scoped parts have nothing to attach
    // to and are excluded; only genuinely unscoped legacy parts remain.
    expect(activeAgreementMortgage([])).toBeNull()
    const legacy = part({ id: 'pL', mortgage_id: null })
    const mixed = [p1, legacy]
    const scopedOut = activeAgreementParts(mixed, null)
    expect(scopedOut.map(p => p.id)).toEqual(['pL'])                 // p1 (scoped to m1) excluded
    expect(activeAgreementBalance([], mixed, [saldoRow('pL', '2026-05-31', 120_000), saldoRow('p1', '2026-05-31', 900_000)])).toBe(120_000)
  })
})

// ── Lifecycle invariants (plan 109 lifecycle events 1–3) ─────────────────────

describe('lifecycle invariants', () => {
  it('a rate-period rollover never creates, archives or ends an agreement or a part', () => {
    // Event 1: binding expiry → a NEW RATE PERIOD only. Same agreement, same
    // part, same debt continuity.
    const m = mortgage()
    const p = part({ id: 'p1', mortgage_id: 'm1', original_balance: 1_000_000, original_date: '2024-01-01' })
    const expiring: RatePeriod = { id: 'r1', created_at: '', loan_part_id: 'p1', start_date: '2024-01-01', end_date: '2026-08-31', rate: 3.93, rate_type: 'bunden' }
    const successor: RatePeriod = { id: 'r2', created_at: '', loan_part_id: 'p1', start_date: '2026-09-01', end_date: '2027-08-31', rate: 4.10, rate_type: 'bunden' }
    const ledger = [saldoRow('p1', '2026-06-30', 900_000)]

    const mortgagesBefore = JSON.stringify([m])
    const partsBefore = JSON.stringify([p])
    // The rollover is purely additive on rate periods…
    const afterRollover = [expiring, successor]
    // …and the entity graph is untouched: still one active agreement, the
    // same unarchived part, the same resolved balance.
    expect(activeMortgage([m])?.id).toBe('m1')
    expect(partsForMortgage([p], 'm1').map(x => x.id)).toEqual(['p1'])
    expect(p.archived).toBe(false)
    expect(totalBalance([p], ledger)).toBe(900_000)
    expect(partsMissingRateTerms([p], afterRollover)).toEqual([])
    // The forecast simply follows the successor's listed rate after the
    // villkorsändringsdag — reading it mutates nothing.
    const c = expectedCharge(p, afterRollover, [interestRow('2026-08-31', 3000, { loan_part_id: 'p1', balance_after: 900_000 })])
    expect(c).not.toBeNull()
    expect(groupLoanParts([p], afterRollover, ledger)).toHaveLength(1)
    expect(JSON.stringify([m])).toBe(mortgagesBefore)
    expect(JSON.stringify([p])).toBe(partsBefore)
  })

  it('a same-bank restructure archives/creates parts only WITHIN the active agreement', () => {
    // Event 2: split 600 000 of remaining debt into two new parts at a
    // villkorsändringsdag. The agreement continues; only parts change.
    const m = mortgage()
    const archivedOld = part({ id: 'pOld', mortgage_id: 'm1', archived: true, original_balance: 1_000_000, original_date: '2023-01-01' })
    const new1 = part({ id: 'pNew1', mortgage_id: 'm1', original_balance: 400_000, original_date: '2026-06-01' })
    const new2 = part({ id: 'pNew2', mortgage_id: 'm1', original_balance: 200_000, original_date: '2026-06-01' })
    const ledger = [saldoRow('pOld', '2026-05-31', 600_000)]

    // The agreement is untouched: still active, no end_date, all three parts attached.
    expect(activeMortgage([m])?.id).toBe('m1')
    expect(m.archived).toBe(false)
    expect(m.end_date).toBeNull()
    expect(partsForMortgage([archivedOld, new1, new2], 'm1')).toHaveLength(3)
    // Active debt counts only the new parts: 400 000 + 200 000.
    expect(totalBalance([archivedOld, new1, new2], ledger)).toBe(600_000)
    // Lifetime amortisation counts the old part's history exactly once:
    // (1 000 000 − 600 000) + 0 + 0 = 400 000 — the restructure transfer
    // (600 000 closing → 600 000 opening) contributes nothing.
    expect(lifetimeAmortized([archivedOld, new1, new2], ledger)).toBe(400_000)
  })

  it('parts lacking a current rate period signal missing rate terms — never a silent 0 % forecast', () => {
    // Event 3 aftermath: a fresh post-bank-change part has NO rate periods
    // (rates are deliberately not copied) and no ledger yet.
    const fresh = part({ id: 'pNew', label: 'Nya lånet', mortgage_id: 'm2', original_balance: 3_700_000, original_date: '2026-01-01' })
    expect(partsMissingRateTerms([fresh], [])).toEqual([{ loan_part_id: 'pNew', label: 'Nya lånet' }])
    // The forecast returns null — a typed absence, not a 0 % projection.
    expect(expectedCharge(fresh, [], [])).toBeNull()
    // A rate period with a NULL rate is still missing terms.
    const rateless: RatePeriod = { id: 'r0', created_at: '', loan_part_id: 'pNew', start_date: '2026-01-01', end_date: null, rate: null, rate_type: 'rörlig' }
    expect(partsMissingRateTerms([fresh], [rateless])).toHaveLength(1)
    // Adding real rate terms clears the signal and enables the forecast.
    const withRate: RatePeriod = { ...rateless, id: 'r1', rate: 3.5 }
    expect(partsMissingRateTerms([fresh], [withRate])).toEqual([])
    const c = expectedCharge(fresh, [withRate], [])
    expect(c).not.toBeNull()
    expect(c!.rate).toBe(3.5)
    // Archived parts are not nagged about missing terms.
    expect(partsMissingRateTerms([{ ...fresh, archived: true }], [])).toEqual([])
  })
})
