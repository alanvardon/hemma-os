import { describe, expect, it } from 'vitest'
import {
  activeAgreementMonthlyCost,
  type LoanPart,
  type Mortgage,
  type Payment,
  type RatePeriod,
} from './mortgage'

const CREATED = '2026-07-01T10:00:00.000Z'

function mortgage(over: Partial<Mortgage> = {}): Mortgage {
  return {
    id: 'm-current', created_at: CREATED, bank_id: 'bank-current', label: 'Nuvarande bolån',
    start_date: '2024-01-01', archived: false, end_date: null, ...over,
  }
}

function part(id: string, over: Partial<LoanPart> = {}): LoanPart {
  return {
    id, created_at: CREATED, label: id, loan_number: id, start_balance: 1_000_000,
    start_date: '2024-01-01', archived: false, mortgage_id: 'm-current',
    original_balance: 1_000_000, original_date: '2024-01-01',
    planned_amortization: null, planned_amortization_start: null,
    planned_amortization_end: null, ...over,
  }
}

function payment(id: string, loanPartId: string, over: Partial<Payment> = {}): Payment {
  return {
    id, created_at: CREATED, loan_part_id: loanPartId, mortgage_id: 'm-current',
    date: '2026-06-30', kind: 'amortization', description: '', amount: 0,
    balance_after: null, paid_by: 'joint', source: 'import', is_insats: false,
    paid_split: null, ...over,
  }
}

function period(id: string, loanPartId: string, rate: number): RatePeriod {
  return {
    id, created_at: CREATED, loan_part_id: loanPartId, start_date: '2026-01-01',
    end_date: null, rate, rate_type: 'rörlig',
  }
}

describe('activeAgreementMonthlyCost', () => {
  it('GOLDEN: scopes balance/rates once to the active agreement and keeps legacy-unscoped rows', () => {
    const mortgages = [
      mortgage({ id: 'm-old', bank_id: 'bank-old', archived: true, end_date: '2025-12-31' }),
      mortgage(),
    ]
    const parts = [
      part('old', { mortgage_id: 'm-old', start_balance: 9_000_000, original_balance: 9_000_000 }),
      part('current-a', { start_balance: 900_000, original_balance: 900_000 }),
      part('legacy', { mortgage_id: null, start_balance: 600_000, original_balance: 600_000 }),
    ]
    const payments = [
      payment('old-saldo', 'old', { kind: 'payment', balance_after: 8_000_000, source: 'predicted' }),
      payment('accepted-prediction', 'current-a', { kind: 'payment', amount: 20_000, balance_after: 880_000, source: 'predicted' }),
      payment('legacy-saldo', 'legacy', { kind: 'payment', balance_after: 600_000 }),
      payment('old-amort', 'old', { amount: 500_000 }),
    ]
    const periods = [period('old-rate', 'old', 9), period('current-rate', 'current-a', 3), period('legacy-rate', 'legacy', 4.25)]

    const result = activeAgreementMonthlyCost(mortgages, parts, periods, payments, '2026-07-21')

    expect(result).toEqual({
      mortgageId: 'm-current',
      balance: 1_480_000,
      rate: 3.51,
      interest: 4_329,
      regularAmortization: 0,
      amortizationSource: 'none',
      missingRatePartIds: [],
    })
  })

  it('declared regular amortisation wins over observed, extra and predicted rows', () => {
    const parts = [
      part('a', { planned_amortization: 4_000 }),
      part('b', { planned_amortization: 2_000 }),
    ]
    const payments = [
      payment('real', 'a', { amount: 3_000 }),
      payment('extra', 'a', { amount: 50_000, is_insats: true }),
      payment('predicted', 'b', { amount: 8_000, source: 'predicted' }),
    ]

    expect(activeAgreementMonthlyCost([mortgage()], parts, [period('ra', 'a', 3), period('rb', 'b', 3)], payments, '2026-07-21'))
      .toMatchObject({ regularAmortization: 6_000, amortizationSource: 'declared' })
  })

  it('excludes a fully repaid non-archived part from current recurring amortisation', () => {
    const parts = [
      part('outstanding', { planned_amortization: 4_000 }),
      part('repaid', { planned_amortization: 9_000 }),
    ]
    const payments = [
      payment('repaid-saldo', 'repaid', { kind: 'payment', amount: 0, balance_after: 0 }),
      payment('repaid-history', 'repaid', { date: '2026-05-31', amount: 9_000 }),
    ]

    expect(activeAgreementMonthlyCost(
      [mortgage()], parts,
      [period('outstanding-rate', 'outstanding', 3), period('repaid-rate', 'repaid', 3)],
      payments,
      '2026-07-21',
    )).toMatchObject({
      balance: 1_000_000,
      regularAmortization: 4_000,
      amortizationSource: 'declared',
      missingRatePartIds: [],
    })
  })

  it('uses median real ordinary evidence per part and excludes is_insats and predicted-only evidence', () => {
    const parts = [part('a'), part('b')]
    const payments = [
      payment('a-apr', 'a', { date: '2026-04-30', amount: 4_000 }),
      payment('a-may', 'a', { date: '2026-05-31', amount: 4_100 }),
      payment('a-jun', 'a', { date: '2026-06-30', amount: 4_000 }),
      payment('a-extra', 'a', { date: '2026-06-30', amount: 50_000, is_insats: true }),
      payment('a-predicted', 'a', { date: '2026-07-31', amount: 4_500, source: 'predicted' }),
      payment('b-interest', 'b', { kind: 'interest', amount: 2_000 }),
      payment('b-debit', 'b', { kind: 'payment', amount: 5_000 }),
    ]

    expect(activeAgreementMonthlyCost([mortgage()], parts, [period('ra', 'a', 3), period('rb', 'b', 3)], payments, '2026-07-21'))
      .toMatchObject({ regularAmortization: 7_000, amortizationSource: 'observed' })
  })

  it('reports none for predicted-only amortisation and null cost for missing rate terms', () => {
    const parts = [part('a')]
    const result = activeAgreementMonthlyCost(
      [mortgage()], parts, [],
      [payment('prediction', 'a', { amount: 4_000, source: 'predicted' })],
      '2026-07-21',
    )

    expect(result).toMatchObject({
      balance: 996_000,
      rate: null,
      interest: null,
      regularAmortization: 0,
      amortizationSource: 'none',
      missingRatePartIds: ['a'],
    })
  })
})
