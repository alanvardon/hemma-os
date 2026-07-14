import { describe, it, expect } from 'vitest'
import {
  makeLoanPart, mortgageForPart, bankForPart, reconcileBalance,
  totalAmortized, groupLoanParts,
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
