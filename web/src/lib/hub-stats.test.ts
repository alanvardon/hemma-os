import { describe, it, expect } from 'vitest'
import {
  mortgageStat,
  daysToMonthEnd,
  latestSettle,
  monthEndStat,
  budgetStat,
  scenarioStat,
  orderTools,
} from './hub-stats'
import type { LoanPart, Payment as MortgagePayment, Valuation } from './mortgage'
import type { Payment as MonthEndPayment, MonthEndSettings, Item as MonthEndItem } from './manadsavslut'
import { defaultState, type BudgetState } from './hushallsbudget'
import { DEFAULT_INPUTS, DEFAULT_CONSTANTS } from './calc'
import type { Scenario } from './storage'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const part = (over: Partial<LoanPart> = {}): LoanPart =>
  ({
    id: 'p1',
    created_at: '2026-01-01T00:00:00Z',
    name: 'Del 1',
    start_balance: 1_000_000,
    start_date: '2026-01-15',
    archived: false,
    ...over,
  }) as LoanPart

const payment = (over: Partial<MortgagePayment> = {}): MortgagePayment =>
  ({
    id: 'pay1',
    created_at: '2026-02-01T00:00:00Z',
    loan_part_id: 'p1',
    date: '2026-02-27',
    amount: 2000,
    kind: 'amortization',
    balance_after: 998_000,
    paid_by: 'a',
    source: 'csv',
    ...over,
  }) as MortgagePayment

const maSettings: MonthEndSettings = {
  person_a_name: 'Alan',
  person_b_name: 'Sofia',
  currency: 'SEK',
  default_split: true,
}

const settle = (over: Partial<MonthEndPayment> = {}): MonthEndPayment =>
  ({
    id: 'set1',
    created_at: '2026-06-30T12:00:00Z',
    item_ids: ['i1'],
    from_person: 'b',
    to_person: 'a',
    amount: 1234,
    period_label: 'juni 2026',
    note: '',
    ...over,
  }) as MonthEndPayment

const item = (over: Partial<MonthEndItem> = {}): MonthEndItem =>
  ({
    id: 'i1',
    created_at: '2026-06-05T00:00:00Z',
    date_purchased: '2026-06-04',
    description: 'ICA',
    enter_amount: 500,
    split: true,
    amount: 250,
    fronted_by: 'a',
    owed_by: 'b',
    paid: false,
    pending: false,
    payment_id: null,
    note: '',
    personal_items: [],
    personal_a: 0,
    personal_b: 0,
    source: 'csv',
    ...over,
  }) as MonthEndItem

const scenario = (over: Partial<Scenario> = {}): Scenario => ({
  id: 's1',
  name: 'Radhus',
  savedAt: '2026-06-01T00:00:00Z',
  inputs: { ...DEFAULT_INPUTS },
  ...over,
})

// ── mortgageStat ─────────────────────────────────────────────────────────────

describe('mortgageStat', () => {
  it('returns null with no loan parts (fresh browser)', () => {
    expect(mortgageStat([], [], [])).toBeNull()
  })

  it('returns null when every part is archived', () => {
    expect(mortgageStat([part({ archived: true })], [], [])).toBeNull()
  })

  it('returns null when the debt is fully paid off', () => {
    expect(mortgageStat([part()], [payment({ balance_after: 0 })], [])).toBeNull()
  })

  it('derives debt from the latest balance and a monthly sparkline', () => {
    const stat = mortgageStat(
      [part()],
      [
        payment({ id: 'a', date: '2026-02-27', balance_after: 998_000 }),
        payment({ id: 'b', date: '2026-03-27', balance_after: 996_000 }),
      ],
      [],
    )
    expect(stat).not.toBeNull()
    expect(stat!.debt).toBe(996_000)
    // Jan (start) → Feb → Mar, oldest first, ending at the current balance.
    expect(stat!.spark.length).toBeGreaterThanOrEqual(2)
    expect(stat!.spark[stat!.spark.length - 1]).toBe(996_000)
    expect(stat!.spark[0]).toBeGreaterThanOrEqual(stat!.spark[stat!.spark.length - 1])
  })

  it('omits ownedPct without a purchase valuation, includes it with one', () => {
    const parts = [part()]
    const pays = [payment()]
    expect(mortgageStat(parts, pays, [])!.ownedPct).toBeNull()
    const vals = [
      { id: 'v1', created_at: '2026-01-01T00:00:00Z', date: '2026-01-15', value: 2_000_000, is_purchase: true } as unknown as Valuation,
    ]
    const withVal = mortgageStat(parts, pays, vals)!
    // 2 000 000 price − 998 000 debt = 50.1 % owned
    expect(withVal.ownedPct).toBeCloseTo(50.1, 1)
  })
})

// ── daysToMonthEnd ───────────────────────────────────────────────────────────

describe('daysToMonthEnd', () => {
  it('counts days in a 31-day month', () => {
    expect(daysToMonthEnd(new Date(2026, 6, 3))).toBe(28) // 3 juli → 31 juli
  })

  it('is 0 on the last day of the month', () => {
    expect(daysToMonthEnd(new Date(2026, 6, 31))).toBe(0)
  })

  it('handles the year boundary (December)', () => {
    expect(daysToMonthEnd(new Date(2026, 11, 1))).toBe(30)
    expect(daysToMonthEnd(new Date(2026, 11, 31))).toBe(0)
  })

  it('handles leap and non-leap February', () => {
    expect(daysToMonthEnd(new Date(2028, 1, 1))).toBe(28) // 2028 leap → 29 feb
    expect(daysToMonthEnd(new Date(2027, 1, 1))).toBe(27) // 2027 → 28 feb
  })
})

// ── latestSettle / monthEndStat ──────────────────────────────────────────────

describe('latestSettle', () => {
  it('returns null with no settlements', () => {
    expect(latestSettle([], maSettings)).toBeNull()
  })

  it('picks the most recent settlement and maps person keys to names', () => {
    const s = latestSettle(
      [
        settle({ id: 'old', created_at: '2026-05-31T12:00:00Z', amount: 999 }),
        settle({ id: 'new', created_at: '2026-06-30T12:00:00Z', from_person: 'b', to_person: 'a', amount: 1234 }),
      ],
      maSettings,
    )
    expect(s).toEqual({ from: 'Sofia', to: 'Alan', amount: 1234, fromSlot: 'b', toSlot: 'a' })
  })

  it('returns null when the latest settlement netted to zero / has no direction', () => {
    expect(latestSettle([settle({ from_person: null, to_person: null, amount: 0 })], maSettings)).toBeNull()
  })
})

describe('monthEndStat', () => {
  const now = new Date(2026, 6, 3)

  it('returns null on a fresh store (no items, no settlements)', () => {
    expect(monthEndStat([], [], maSettings, now)).toBeNull()
  })

  it('returns the countdown once the tool has data, settle optional', () => {
    const withItems = monthEndStat([item()], [], maSettings, now)
    expect(withItems).toEqual({ days: 28, settle: null })
    const withSettle = monthEndStat([], [settle()], maSettings, now)
    expect(withSettle!.settle).toEqual({ from: 'Sofia', to: 'Alan', amount: 1234, fromSlot: 'b', toSlot: 'a' })
  })
})

// ── budgetStat ───────────────────────────────────────────────────────────────

describe('budgetStat', () => {
  it('returns null when nothing is stored', () => {
    expect(budgetStat(null)).toBeNull()
  })

  it('returns null when the stored budget has no income', () => {
    const empty: BudgetState = { ...defaultState(), incomes: [], costs: [], savings: [] }
    expect(budgetStat(empty)).toBeNull()
  })

  it('derives per-person leftovers from the pot math', () => {
    const s = defaultState()
    const stat = budgetStat(s)!
    expect(stat).not.toBeNull()
    // Mirrors computeBudget: equalShare − joint/2 − own costs − savings.
    expect(typeof stat.a).toBe('number')
    expect(typeof stat.b).toBe('number')
    expect(stat.equal).toBe(Math.round(stat.a) === Math.round(stat.b))
  })
})

// ── scenarioStat ─────────────────────────────────────────────────────────────

describe('scenarioStat', () => {
  it('returns null with no saved scenarios', () => {
    expect(scenarioStat([], DEFAULT_CONSTANTS)).toBeNull()
  })

  it('returns the monthly cost when exactly one scenario is saved', () => {
    const stat = scenarioStat([scenario()], DEFAULT_CONSTANTS)!
    expect(stat.count).toBe(1)
    expect(stat.monthly).toBeGreaterThan(0)
  })

  it('returns only the count for several scenarios', () => {
    const stat = scenarioStat([scenario(), scenario({ id: 's2' })], DEFAULT_CONSTANTS)!
    expect(stat.count).toBe(2)
    expect(stat.monthly).toBeNull()
  })
})

// ── orderTools ───────────────────────────────────────────────────────────────

describe('orderTools', () => {
  const entries = [{ path: '/a' }, { path: '/b' }, { path: '/c' }, { path: '/d' }]

  it('keeps authored order when no timestamps exist (first visit)', () => {
    expect(orderTools(entries, {}).map((e) => e.path)).toEqual(['/a', '/b', '/c', '/d'])
  })

  it('sorts by recency, most recent first', () => {
    const t = { '/a': 100, '/b': 300, '/c': 200, '/d': 50 }
    expect(orderTools(entries, t).map((e) => e.path)).toEqual(['/b', '/c', '/a', '/d'])
  })

  it('puts timestamped entries first, untimestamped keep authored order (stable)', () => {
    const t = { '/c': 500 }
    expect(orderTools(entries, t).map((e) => e.path)).toEqual(['/c', '/a', '/b', '/d'])
  })

  it('does not mutate the input array', () => {
    const t = { '/d': 1 }
    orderTools(entries, t)
    expect(entries.map((e) => e.path)).toEqual(['/a', '/b', '/c', '/d'])
  })
})
