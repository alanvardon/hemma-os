import { describe, it, expect } from 'vitest'
import { buildSubmission, type IncomeItem, type SalarySubmission } from './hushallsbudget'
import { buildMonthViews, replaceHalf } from './loner'
import type { SalaryDraft } from './salary-drafts-store'

// Golden values for plan 139. Every expected figure is hand-checked in the
// comment beside it: buildSubmission's rule is income = sum of the person's
// items, transfer = |a − b| / 2 paid by a when a − b ≥ 0 (else by b), and
// equal_share = (a + b) / 2. Full precision — nothing is rounded here.

const BASE_A: IncomeItem[] = [{ label: 'Lön', amount: 38450 }, { label: 'Barnbidrag', amount: 1250 }]
const BASE_B: IncomeItem[] = [{ label: 'Lön', amount: 31200 }]

function stored(incomesA: IncomeItem[], incomesB: IncomeItem[], over: Partial<SalarySubmission> = {}): SalarySubmission {
  return {
    ...buildSubmission({ month: '2026-10', incomesA, incomesB, personAName: 'Anna', personBName: 'Bo', note: 'oktober' }),
    id: 'sub-1',
    created_at: '2026-10-03T08:00:00.000Z',
    ...over,
  }
}

function draft(over: Partial<SalaryDraft> & Pick<SalaryDraft, 'slot'>): SalaryDraft {
  return {
    month: '2026-10',
    income_items: [{ label: 'Lön', amount: 31200 }],
    note: null,
    submitted_via: 'email',
    updated_at: '2026-10-03T08:00:00.123456+00:00',
    ...over,
  }
}

describe('golden transfers', () => {
  it('Base: A 38 450 + 1 250, B 31 200', () => {
    const row = stored(BASE_A, BASE_B)
    // income_a = 38 450 + 1 250 = 39 700; income_b = 31 200
    expect(row.income_a).toBe(39700)
    expect(row.income_b).toBe(31200)
    // transfer = (39 700 − 31 200) / 2 = 8 500 / 2 = 4 250, a → b
    expect(row.transfer_amount).toBe(4250)
    expect([row.transfer_from, row.transfer_to]).toEqual(['a', 'b'])
    // equal_share = (39 700 + 31 200) / 2 = 70 900 / 2 = 35 450
    expect(row.equal_share).toBe(35450)
  })

  it('Edit B via replaceHalf: B → Lön 33 000 + Barnbidrag 1 250', () => {
    const row = replaceHalf(stored(BASE_A, BASE_B), 'b', [{ label: 'Lön', amount: 33000 }, { label: 'Barnbidrag', amount: 1250 }], 'oktober')
    // income_a unchanged = 39 700; income_b = 33 000 + 1 250 = 34 250
    expect(row.income_a).toBe(39700)
    expect(row.income_b).toBe(34250)
    // transfer = (39 700 − 34 250) / 2 = 5 450 / 2 = 2 725, a → b
    expect(row.transfer_amount).toBe(2725)
    expect([row.transfer_from, row.transfer_to]).toEqual(['a', 'b'])
    // equal_share = (39 700 + 34 250) / 2 = 73 950 / 2 = 36 975
    expect(row.equal_share).toBe(36975)
  })

  it('B overtakes via replaceHalf: B → Lön 45 000', () => {
    const row = replaceHalf(stored(BASE_A, BASE_B), 'b', [{ label: 'Lön', amount: 45000 }], null)
    // income_a = 39 700; income_b = 45 000
    expect(row.income_a).toBe(39700)
    expect(row.income_b).toBe(45000)
    // gap = 39 700 − 45 000 = −5 300 < 0 → b pays a; |−5 300| / 2 = 2 650
    expect(row.transfer_amount).toBe(2650)
    expect([row.transfer_from, row.transfer_to]).toEqual(['b', 'a'])
    // equal_share = (39 700 + 45 000) / 2 = 84 700 / 2 = 42 350
    expect(row.equal_share).toBe(42350)
  })

  it('Equal: 30 000 each → nothing to transfer, direction a → b by convention', () => {
    const row = stored([{ label: 'Lön', amount: 30000 }], [{ label: 'Lön', amount: 30000 }])
    // gap = 0 ≥ 0 → a → b; 0 / 2 = 0
    expect(row.transfer_amount).toBe(0)
    expect([row.transfer_from, row.transfer_to]).toEqual(['a', 'b'])
    // equal_share = 60 000 / 2 = 30 000
    expect(row.equal_share).toBe(30000)
  })

  it('Half-krona: 30 001 vs 30 000 stores 0.5 and 30 000.5 unrounded', () => {
    const row = replaceHalf(stored(BASE_A, BASE_B), 'a', [{ label: 'Lön', amount: 30001 }], null)
    const both = replaceHalf(row, 'b', [{ label: 'Lön', amount: 30000 }], null)
    // gap = 30 001 − 30 000 = 1 → 1 / 2 = 0.5, a → b
    expect(both.income_a).toBe(30001)
    expect(both.income_b).toBe(30000)
    expect(both.transfer_amount).toBe(0.5)
    expect([both.transfer_from, both.transfer_to]).toEqual(['a', 'b'])
    // equal_share = 60 001 / 2 = 30 000.5
    expect(both.equal_share).toBe(30000.5)
  })

  it('Negative item: A 20 000 − 1 500 vs B 18 500 → 0', () => {
    const row = stored([{ label: 'Lön', amount: 20000 }, { label: 'Återbetalning', amount: -1500 }], [{ label: 'Lön', amount: 18500 }])
    // income_a = 20 000 − 1 500 = 18 500; income_b = 18 500
    expect(row.income_a).toBe(18500)
    expect(row.income_b).toBe(18500)
    // gap = 0 → 0, a → b; equal_share = 37 000 / 2 = 18 500
    expect(row.transfer_amount).toBe(0)
    expect([row.transfer_from, row.transfer_to]).toEqual(['a', 'b'])
    expect(row.equal_share).toBe(18500)
  })
})

describe('replaceHalf', () => {
  it('keeps id, created_at, the name snapshot and the other owner’s items in stored order (A first)', () => {
    const before = stored(BASE_A, BASE_B, { person_a_name: 'Anna (då)', person_b_name: 'Bo (då)' })
    const after = replaceHalf(before, 'b', [{ label: 'Lön', amount: 33000 }], 'oktober')
    expect(after.id).toBe('sub-1')
    expect(after.created_at).toBe('2026-10-03T08:00:00.000Z')
    expect(after.month).toBe('2026-10')
    expect(after.person_a_name).toBe('Anna (då)')
    expect(after.person_b_name).toBe('Bo (då)')
    expect(after.income_items).toEqual([
      { owner: 'a', label: 'Lön', amount: 38450 },
      { owner: 'a', label: 'Barnbidrag', amount: 1250 },
      { owner: 'b', label: 'Lön', amount: 33000 },
    ])
  })

  it('replacing A keeps B’s items after A’s', () => {
    const after = replaceHalf(stored(BASE_A, BASE_B), 'a', [{ label: 'Lön', amount: 40000 }], null)
    expect(after.income_items).toEqual([
      { owner: 'a', label: 'Lön', amount: 40000 },
      { owner: 'b', label: 'Lön', amount: 31200 },
    ])
    // 40 000 − 31 200 = 8 800 → 4 400 a → b; (40 000 + 31 200) / 2 = 35 600
    expect(after.transfer_amount).toBe(4400)
    expect(after.equal_share).toBe(35600)
  })

  it('drops blank-label + zero-amount items and trims labels (buildSubmission’s rule)', () => {
    const after = replaceHalf(stored(BASE_A, BASE_B), 'b', [
      { label: '  ', amount: 0 }, { label: ' Lön ', amount: 31200 }, { label: '', amount: 500 }, { label: 'Tom', amount: 0 },
    ], null)
    expect(after.income_items.filter((i) => i.owner === 'b')).toEqual([
      { owner: 'b', label: 'Lön', amount: 31200 },
      { owner: 'b', label: '', amount: 500 },
      { owner: 'b', label: 'Tom', amount: 0 },
    ])
    // income_b = 31 200 + 500 + 0 = 31 700
    expect(after.income_b).toBe(31700)
  })

  it('sets the given note; null or empty clears it', () => {
    const before = stored(BASE_A, BASE_B)
    expect(replaceHalf(before, 'a', BASE_A, 'ny anteckning').note).toBe('ny anteckning')
    expect(replaceHalf(before, 'a', BASE_A, before.note).note).toBe('oktober')
    expect(replaceHalf(before, 'a', BASE_A, null).note).toBeNull()
    expect(replaceHalf(before, 'a', BASE_A, '').note).toBeNull()
  })

  it('does not mutate the input row', () => {
    const before = stored(BASE_A, BASE_B)
    const snapshot = JSON.parse(JSON.stringify(before))
    replaceHalf(before, 'b', [{ label: 'Lön', amount: 1 }], null)
    expect(before).toEqual(snapshot)
  })

  it('a legacy row without income_items keeps the other person’s scalar income', () => {
    const legacy = { ...stored(BASE_A, BASE_B), income_items: undefined } as unknown as SalarySubmission
    const after = replaceHalf(legacy, 'b', [{ label: 'Lön', amount: 30000 }], null)
    // A synthesised from income_a = 39 700; 39 700 − 30 000 = 9 700 → 4 850
    expect(after.income_items).toEqual([
      { owner: 'a', label: 'Lön / Salary', amount: 39700 },
      { owner: 'b', label: 'Lön', amount: 30000 },
    ])
    expect(after.transfer_amount).toBe(4850)
  })
})

describe('buildMonthViews', () => {
  it('empty household → only the current month, empty', () => {
    expect(buildMonthViews([], [], '2026-10')).toEqual([
      { month: '2026-10', status: 'empty', halves: {}, submission: null, duplicates: [] },
    ])
  })

  it('one draft → waiting, with the half’s amounts, channel and exact updated_at', () => {
    const [view] = buildMonthViews([], [draft({ slot: 'b', note: 'föräldraledig' })], '2026-10')
    expect(view.status).toBe('waiting')
    expect(view.halves.a).toBeUndefined()
    expect(view.halves.b).toEqual({
      slot: 'b', items: [{ label: 'Lön', amount: 31200 }], total: 31200, note: 'föräldraledig',
      source: 'email', draftUpdatedAt: '2026-10-03T08:00:00.123456+00:00',
    })
    expect(view.submission).toBeNull()
  })

  it('an app draft reports source app', () => {
    const [view] = buildMonthViews([], [draft({ slot: 'a', submitted_via: 'app' })], '2026-10')
    expect(view.halves.a?.source).toBe('app')
  })

  it('both drafts summing to 0 → zero_total', () => {
    const [view] = buildMonthViews([], [
      draft({ slot: 'a', income_items: [{ label: 'Lön', amount: 0 }] }),
      draft({ slot: 'b', income_items: [{ label: 'Återbetalning', amount: -100 }, { label: 'Lön', amount: 100 }] }),
    ], '2026-10')
    // 0 + (−100 + 100) = 0 ≤ 0
    expect(view.status).toBe('zero_total')
    expect(view.halves.a?.total).toBe(0)
    expect(view.halves.b?.total).toBe(0)
  })

  it('submission + stale draft → complete, draft ignored', () => {
    const row = stored(BASE_A, BASE_B)
    const [view] = buildMonthViews([row], [draft({ slot: 'b', income_items: [{ label: 'Lön', amount: 99999 }] })], '2026-10')
    expect(view.status).toBe('complete')
    expect(view.submission).toBe(row)
    expect(view.duplicates).toEqual([row])
    expect(view.halves.a).toEqual({
      slot: 'a', items: BASE_A, total: 39700, note: null, source: 'complete', draftUpdatedAt: null,
    })
    expect(view.halves.b?.items).toEqual(BASE_B)
    expect(view.halves.b?.total).toBe(31200)
  })

  it('legacy duplicate month → both rows in duplicates, newest as submission', () => {
    const older = stored(BASE_A, BASE_B, { id: 'old', created_at: '2026-10-01T08:00:00.000Z' })
    const newer = stored(BASE_A, [{ label: 'Lön', amount: 45000 }], { id: 'new', created_at: '2026-10-05T08:00:00.000Z' })
    const views = buildMonthViews([older, newer], [], '2026-10')
    expect(views).toHaveLength(1)
    expect(views[0].duplicates.map((r) => r.id)).toEqual(['new', 'old'])
    expect(views[0].submission?.id).toBe('new')
    expect(views[0].halves.b?.total).toBe(45000)
  })

  it('legacy row without income_items → halves synthesised from the scalar totals', () => {
    const legacy = { ...stored(BASE_A, BASE_B), income_items: undefined } as unknown as SalarySubmission
    const [view] = buildMonthViews([legacy], [], '2026-10')
    expect(view.halves.a).toMatchObject({ items: [{ label: 'Lön / Salary', amount: 39700 }], total: 39700 })
    expect(view.halves.b).toMatchObject({ items: [{ label: 'Lön / Salary', amount: 31200 }], total: 31200 })
  })

  it('unions submission and draft months, newest first, always including current', () => {
    const views = buildMonthViews(
      [stored(BASE_A, BASE_B, { month: '2026-08' }), stored(BASE_A, BASE_B, { id: 'sub-2', month: '2026-09' })],
      [draft({ slot: 'a', month: '2026-09' }), draft({ slot: 'b', month: '2026-07' })],
      '2026-11',
    )
    expect(views.map((v) => [v.month, v.status])).toEqual([
      ['2026-11', 'empty'],
      ['2026-09', 'complete'],
      ['2026-08', 'complete'],
      ['2026-07', 'waiting'],
    ])
  })
})
