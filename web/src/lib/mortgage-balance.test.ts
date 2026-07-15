import { describe, expect, it } from 'vitest'
import {
  amorteringskravStatus,
  balanceTimeline,
  costBasisEquity,
  costBasisOwnedPct,
  equity,
  equityBridge,
  groupLoanParts,
  loanToValue,
  partBalance,
  projectMilestones,
  resolvePartBalance,
  totalAmortized,
  totalBalance,
} from './mortgage'
import { mortgageStat } from './hub-stats'
import type { LoanPart, Payment, Valuation } from './mortgage'

function part(over: Partial<LoanPart> = {}): LoanPart {
  return {
    id: 'part-a', created_at: '2024-01-01', label: 'Del A', loan_number: 'A',
    start_balance: 1_000_000, start_date: '2024-01-01', archived: false,
    original_balance: 1_000_000, original_date: '2024-01-01',
    ...over,
  }
}

function payment(over: Partial<Payment> = {}): Payment {
  return {
    id: 'row', created_at: '2024-01-01', loan_part_id: 'part-a',
    date: '2024-02-01', kind: 'amortization', description: '', amount: 1_000,
    balance_after: null, paid_by: 'joint', source: 'manual',
    ...over,
  }
}

function saldo(date: string, balance: number, over: Partial<Payment> = {}): Payment {
  return payment({ id: `saldo-${date}`, date, kind: 'payment', amount: 0, balance_after: balance, ...over })
}

describe('resolvePartBalance — chronological principal ledger', () => {
  it('applies an amortering strictly after the latest Saldo (reported regression)', () => {
    const rows = [
      saldo('2024-01-31', 1_000_000),
      payment({ id: 'amort', date: '2024-02-28', amount: 10_000 }),
    ]
    expect(resolvePartBalance(part(), rows)).toEqual({
      balance: 990_000,
      principalPaid: 10_000,
      anchor: { date: '2024-01-31', balance: 1_000_000, source: 'saldo' },
      quality: 'observed',
      warnings: [],
    })
    expect(partBalance(part(), rows)).toBe(990_000)
  })

  it('uses a full unpaired Betalning provisionally and reports missing interest', () => {
    const rows = [saldo('2024-01-31', 1_000_000), payment({ kind: 'payment', amount: 6_000 })]
    expect(resolvePartBalance(part(), rows)).toMatchObject({
      balance: 994_000,
      principalPaid: 6_000,
      quality: 'estimated',
      warnings: ['missing-interest'],
    })
  })

  it('revises inferred principal when same-part/month Ränta arrives', () => {
    const rows = [
      saldo('2024-01-31', 1_000_000),
      payment({ id: 'debit', kind: 'payment', amount: 6_000 }),
      payment({ id: 'interest', date: '2024-02-28', kind: 'interest', amount: 3_000 }),
    ]
    expect(resolvePartBalance(part(), rows)).toMatchObject({
      balance: 997_000,
      principalPaid: 3_000,
      quality: 'observed',
      warnings: [],
    })
  })

  it('adds paired Betalning principal and every same-month explicit Amortering', () => {
    const rows = [
      saldo('2024-01-31', 1_000_000),
      payment({ id: 'debit', kind: 'payment', amount: 6_000 }),
      payment({ id: 'interest', kind: 'interest', amount: 3_000 }),
      payment({ id: 'extra', kind: 'amortization', amount: 20_000, is_insats: true }),
    ]
    expect(resolvePartBalance(part(), rows)).toMatchObject({ balance: 977_000, principalPaid: 23_000 })
  })

  it('gives ordinary and is_insats amortering identical debt effect', () => {
    const ordinary = resolvePartBalance(part(), [payment({ amount: 20_000, is_insats: false })])
    const insats = resolvePartBalance(part(), [payment({ amount: 20_000, is_insats: true })])
    expect(ordinary.balance).toBe(980_000)
    expect(insats.balance).toBe(ordinary.balance)
  })

  it('uses a later Saldo as a post-transaction anchor and applies only strictly later rows', () => {
    const rows = [
      payment({ id: 'old-unpaired', date: '2024-02-01', kind: 'payment', amount: 6_000 }),
      saldo('2024-03-15', 950_000),
      payment({ id: 'same-day', date: '2024-03-15', amount: 10_000 }),
      payment({ id: 'later', date: '2024-03-16', amount: 5_000 }),
    ]
    expect(resolvePartBalance(part(), rows)).toEqual({
      balance: 945_000,
      principalPaid: 5_000,
      anchor: { date: '2024-03-15', balance: 950_000, source: 'saldo' },
      quality: 'observed',
      warnings: [],
    })
  })

  it('never pairs Betalning and Ränta across loan parts or calendar months', () => {
    const rows = [
      payment({ id: 'a-debit', kind: 'payment', amount: 6_000 }),
      payment({ id: 'b-interest', loan_part_id: 'part-b', kind: 'interest', amount: 3_000 }),
      payment({ id: 'a-later-interest', date: '2024-03-01', kind: 'interest', amount: 3_000 }),
    ]
    expect(resolvePartBalance(part(), rows)).toMatchObject({
      balance: 994_000,
      warnings: ['missing-interest'],
    })
  })

  it('handles interest-only and interest above payment without negative principal', () => {
    const anchor = saldo('2024-01-31', 1_000_000)
    const debit = payment({ id: 'debit', kind: 'payment', amount: 3_000 })
    const equal = resolvePartBalance(part(), [anchor, debit, payment({ id: 'i1', kind: 'interest', amount: 3_000 })])
    expect(equal).toMatchObject({ balance: 1_000_000, principalPaid: 0, warnings: [] })

    const above = resolvePartBalance(part(), [anchor, debit, payment({ id: 'i2', kind: 'interest', amount: 4_000 })])
    expect(above).toMatchObject({
      balance: 1_000_000,
      principalPaid: 0,
      quality: 'estimated',
      warnings: ['interest-exceeds-payment'],
    })

    const zeroInterest = resolvePartBalance(part(), [anchor, debit, payment({ id: 'i0', kind: 'interest', amount: 0 })])
    expect(zeroInterest).toMatchObject({
      balance: 997_000,
      principalPaid: 3_000,
      quality: 'observed',
      warnings: [],
    })
  })

  it('aggregates rows deterministically, ignores order and floors debt at zero', () => {
    const rows = [
      payment({ id: 'p1', kind: 'payment', amount: 4_000 }),
      payment({ id: 'p2', date: '2024-02-28', kind: 'payment', amount: 2_000 }),
      payment({ id: 'i1', kind: 'interest', amount: 1_000 }),
      payment({ id: 'i2', date: '2024-02-28', kind: 'interest', amount: 2_000 }),
      payment({ id: 'a1', kind: 'amortization', amount: 500 }),
    ]
    expect(resolvePartBalance(part(), rows).balance).toBe(996_500)
    expect(resolvePartBalance(part(), rows.slice().reverse()).balance).toBe(996_500)
    expect(resolvePartBalance(part({ start_balance: 1_000, original_balance: 1_000 }), [
      payment({ kind: 'amortization', amount: 2_000 }),
    ]).balance).toBe(0)
  })

  it('uses the same resolver for as-of dates and month-end timeline balances', () => {
    const rows = [
      saldo('2024-01-31', 1_000_000),
      payment({ id: 'feb', date: '2024-02-15', amount: 10_000 }),
      payment({ id: 'mar', date: '2024-03-15', amount: 20_000 }),
    ]
    expect(resolvePartBalance(part(), rows, '2024-02-29').balance).toBe(990_000)
    expect(resolvePartBalance(part(), rows, '2024-03-31').balance).toBe(970_000)
    expect(balanceTimeline([part()], rows).at(-1)?.balance).toBe(970_000)
    expect(partBalance(part(), rows)).toBe(970_000)
  })

  it('excludes malformed events and warns on conflicting same-date Saldo values', () => {
    const rows = [
      saldo('2024-01-31', 910_000, { id: 'saldo-high' }),
      saldo('2024-01-31', 900_000, { id: 'saldo-low' }),
      saldo('not-a-date', 1, { id: 'bad-saldo' }),
      payment({ id: 'bad-date', date: '2024-02-31', amount: 50_000 }),
      payment({ id: 'negative', date: '2024-02-01', amount: -10_000 }),
      payment({ id: 'zero', date: '2024-02-01', amount: 0 }),
      payment({ id: 'missing-part', loan_part_id: null, date: '2024-02-01', amount: 10_000 }),
      payment({ id: 'nan', date: '2024-02-01', amount: Number.NaN }),
    ]
    expect(resolvePartBalance(part(), rows)).toEqual({
      balance: 900_000,
      principalPaid: 0,
      anchor: { date: '2024-01-31', balance: 900_000, source: 'saldo' },
      quality: 'estimated',
      warnings: ['conflicting-saldo'],
    })
  })
})

describe('shared balance dependency contract', () => {
  it('propagates a post-Saldo amortering through pure debt-derived consumers', () => {
    const loan = part({ planned_amortization: 10_000 })
    const rows = [
      saldo('2024-01-31', 1_000_000),
      payment({ id: 'reported-fix', date: '2024-03-31', amount: 10_000, paid_by: 'a' }),
    ]
    const valuations: Valuation[] = [
      { id: 'purchase', created_at: '', date: '2024-01-01', value: 2_000_000, note: '', is_purchase: true },
      { id: 'current', created_at: '', date: '2024-01-31', value: 2_000_000, note: '' },
    ]

    const debt = totalBalance([loan], rows)
    expect(debt).toBe(990_000)
    expect(equity(2_000_000, debt)).toBe(1_010_000)
    expect(costBasisEquity(2_000_000, debt)).toBe(1_010_000)
    expect(loanToValue(debt, 2_000_000)).toBe(49.5)
    expect(costBasisOwnedPct(2_000_000, debt)).toBe(50.5)
    expect(totalAmortized([loan], rows)).toBe(10_000)
    expect(balanceTimeline([loan], rows).at(-1)?.balance).toBe(990_000)
    expect(equityBridge([loan], rows, valuations, '2024-01-31', '2024-03-31')).toMatchObject({
      start_balance: 1_000_000,
      end_balance: 990_000,
      amortization_gain: 10_000,
    })
    expect(amorteringskravStatus([loan], rows, valuations, { household_income_yearly: 200_000 })).toMatchObject({
      ltv: 49.5,
      dti: 4.95,
      required_pct: 1,
      required_annual: 9_900,
    })
    expect(projectMilestones([loan], rows, valuations, {}).current_ltv).toBe(49.5)
    expect(projectMilestones([loan], rows, valuations, {}).payoff_months).toBe(99)
    expect(groupLoanParts([loan], [], rows)[0].total_balance).toBe(990_000)

    const hub = mortgageStat([loan], rows, valuations)
    expect(hub).toMatchObject({ debt: 990_000, ownedPct: 50.5 })
    expect(hub?.spark.at(-1)).toBe(990_000)
  })
})
