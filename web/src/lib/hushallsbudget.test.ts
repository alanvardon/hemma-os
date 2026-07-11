import { describe, it, expect } from 'vitest'
import {
  BOLAN_ROW_IDS, applyMortgageSync, defaultState, computeBudget, buildSubmission, formatWithSpaces, parseFormatted,
} from './hushallsbudget'

describe('applyMortgageSync', () => {
  it('inserts fixed machine-owned rows without changing human row order or seq', () => {
    const state = defaultState()
    const humanIds = state.costs.map((row) => row.id)
    const seq = state.seq

    const synced = applyMortgageSync(state, { ranta: 8_550, amortering: 3_000 })

    expect(synced).not.toBe(state)
    expect(synced.costs.slice(0, 2)).toEqual([
      { id: BOLAN_ROW_IDS.ranta, label: 'Bolån — ränta', amount: 8_550, owner: 'joint', source: 'bolanekoll' },
      { id: BOLAN_ROW_IDS.amortering, label: 'Bolån — amortering', amount: 3_000, owner: 'joint', source: 'bolanekoll' },
    ])
    expect(synced.costs.slice(2).map((row) => row.id)).toEqual(humanIds)
    expect(synced.seq).toBe(seq)
  })

  it('returns the identical state reference when synced figures are unchanged', () => {
    const synced = applyMortgageSync(defaultState(), { ranta: 8_550, amortering: 3_000 })
    expect(applyMortgageSync(synced, { ranta: 8_550, amortering: 3_000 })).toBe(synced)
  })

  it('removes only synced rows when the mortgage gate no longer passes', () => {
    const state = defaultState()
    const synced = applyMortgageSync(state, { ranta: 8_550, amortering: 3_000 })
    const removed = applyMortgageSync(synced, null)
    expect(removed.costs).toEqual(state.costs)
  })

  it('keeps sync rows absent while mortgage sync is switched off', () => {
    const state = { ...defaultState(), mortgageSyncOff: true }
    expect(applyMortgageSync(state, { ranta: 8_550, amortering: 3_000 })).toBe(state)
  })

  it('updates fixed rows when mortgage figures change', () => {
    const synced = applyMortgageSync(defaultState(), { ranta: 8_550, amortering: 3_000 })
    const updated = applyMortgageSync(synced, { ranta: 8_000, amortering: 2_500 })
    expect(updated.costs.slice(0, 2).map((row) => [row.id, row.amount])).toEqual([
      [BOLAN_ROW_IDS.ranta, 8_000], [BOLAN_ROW_IDS.amortering, 2_500],
    ])
  })
})

// ── Ported from the vanilla budget.js pure-math section ──────────────────────
describe('computeBudget — the pot', () => {
  const r = computeBudget(defaultState())

  it('pools both incomes and splits evenly', () => {
    expect(r.incomeA).toBe(46_000)
    expect(r.incomeB).toBe(39_000)
    expect(r.totalIncome).toBe(85_000)
    expect(r.equalShare).toBe(42_500)
  })

  it('settles the salary gap with one half-the-gap transfer (higher earner pays)', () => {
    expect(r.transfer).toEqual({ amount: 3_500, from: 'a', to: 'b' })
  })

  it('sums joint, individual costs and savings', () => {
    expect(r.costsJoint).toBe(44_542)
    expect(r.costsA).toBe(1_500)
    expect(r.costsB).toBe(1_350)
    expect(r.totalCosts).toBe(47_392)
    expect(r.totalSavings).toBe(17_000)
  })

  it('leaves the right surplus and savings rate', () => {
    expect(r.surplus).toBe(20_608)
    expect(r.savingsRate).toBeCloseTo(0.2, 10)
  })

  it("each person's leftover sums back to the household surplus", () => {
    expect(r.personA.leftover + r.personB.leftover).toBe(r.surplus)
  })

  it('breaks joint costs out by category in order', () => {
    expect(r.jointCategories.map((c) => [c.id, c.amount])).toEqual([
      ['c-boende', 15_504],
      ['c-hushall', 12_700],
      ['c-transport', 6_470],
      ['c-forsakring', 4_755],
      ['c-ovrigt', 5_113],
    ])
  })

  it('collects uncategorised joint costs into an Övrigt bucket', () => {
    const r2 = computeBudget({
      categories: [{ id: 'c-1', name: 'Boende' }],
      costs: [
        { id: 'x', label: 'Hyra', amount: 8_000, owner: 'joint', category: 'c-1' },
        { id: 'y', label: 'Strö', amount: 500, owner: 'joint', category: 'c-missing' },
      ],
    })
    const other = r2.jointCategories.find((c) => c.id === '_other')
    expect(other).toEqual({ id: '_other', name: 'Övrigt', amount: 500 })
  })

  it('separates synced mortgage costs into a prepended Bolån bucket', () => {
    const state = applyMortgageSync(defaultState(), { ranta: 8_550, amortering: 3_000 })
    const result = computeBudget(state)
    expect(result.jointCategories[0]).toEqual({ id: '_bolan', name: 'Bolån', amount: 11_550 })
    expect(result.costsJoint).toBe(44_542 + 11_550)
    expect(result.jointCategories.find((category) => category.id === '_other')).toBeUndefined()
  })

  it('tolerates an empty state', () => {
    const empty = computeBudget()
    expect(empty.totalIncome).toBe(0)
    expect(empty.equalShare).toBe(0)
    expect(empty.savingsRate).toBe(0)
  })
})

describe('buildSubmission — Supabase-shaped salary row', () => {
  const rec = buildSubmission({
    month: '2026-06',
    incomesA: [{ label: 'Lön', amount: 46_000 }, { label: 'Barnbidrag', amount: 1_250 }],
    incomesB: [{ label: 'Lön', amount: 39_000 }],
    personAName: 'Alan', personBName: 'Partner',
  })

  it('totals each person and itemises income', () => {
    expect(rec.income_a).toBe(47_250)
    expect(rec.income_b).toBe(39_000)
    expect(rec.income_items).toHaveLength(3)
    expect(rec.income_items[0]).toEqual({ owner: 'a', label: 'Lön', amount: 46_000 })
  })

  it('reuses the pot math for the settle-up and equal share', () => {
    expect(rec.transfer_amount).toBe((47_250 - 39_000) / 2)
    expect(rec.transfer_from).toBe('a')
    expect(rec.transfer_to).toBe('b')
    expect(rec.equal_share).toBe((47_250 + 39_000) / 2)
  })

  it('defaults note to null', () => {
    expect(rec.note).toBeNull()
  })

  it('drops blank income items', () => {
    const r = buildSubmission({ incomesA: [{ label: '', amount: 0 }, { label: 'Lön', amount: 100 }], incomesB: [] })
    expect(r.income_items).toEqual([{ owner: 'a', label: 'Lön', amount: 100 }])
  })
})

describe('formatters', () => {
  it('formatWithSpaces groups thousands', () => {
    expect(formatWithSpaces(1_234_567)).toBe('1 234 567')
    expect(formatWithSpaces(0)).toBe('0')
  })
  it('parseFormatted strips spaces and accepts comma decimals', () => {
    expect(parseFormatted('42 500')).toBe(42_500)
    expect(parseFormatted('1 234,5')).toBe(1_234.5)
    expect(parseFormatted('')).toBe(0)
  })
})
