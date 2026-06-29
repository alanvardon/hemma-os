import { describe, it, expect } from 'vitest'
import { classifyToItemFields, makeItem, buildSettlement, computeOwed, netBalance, personalSums } from './manadsavslut'
import { normalizeItem } from './manadsavslut-store'
import type { Item } from './manadsavslut'

// A full Item with overridable fields, so settlement tests stay type-safe.
const item = (over: Partial<Item>): Item => ({
  id: 'x', created_at: '', date_purchased: '', description: '', enter_amount: 0,
  split: true, amount: 0, fronted_by: 'a', owed_by: 'b', paid: false, pending: false,
  payment_id: null, note: '', personal_items: [], personal_a: 0, personal_b: 0, source: 'manual', ...over,
})

// ── "ask later" (pending) triage — mirrors the vanilla manadsavslut.test.js ──
describe('pending ("ask later") triage', () => {
  it('classifyToItemFields flags a pending row with a provisional split', () => {
    expect(classifyToItemFields('pending', 'a')).toEqual({ split: true, owed_by: 'b', pending: true })
    expect(classifyToItemFields('pending', 'b')).toEqual({ split: true, owed_by: 'a', pending: true })
  })

  it('makeItem defaults pending to false and carries an explicit flag', () => {
    expect(makeItem({ enter_amount: 400, fronted_by: 'a' }).pending).toBe(false)
    const p = makeItem({ enter_amount: 400, split: true, fronted_by: 'a', pending: true })
    expect(p.pending).toBe(true)
    expect(p.amount).toBe(200) // provisional half retained while pending
  })

  it('buildSettlement ignores pending items so an undecided charge never settles', () => {
    const s = buildSettlement([
      item({ id: 'i1', amount: 150 }),
      item({ id: 'i2', amount: 100, pending: true }),
    ], {})
    expect(s.item_ids).toEqual(['i1'])
    expect(s.amount).toBe(150)

    const empty = buildSettlement([item({ id: 'p1', amount: 100, pending: true })], {})
    expect(empty.item_ids).toEqual([])
    expect({ from: empty.from_person, to: empty.to_person, amount: empty.amount })
      .toEqual({ from: null, to: null, amount: 0 })
  })

  it('a pending refund keeps a negative provisional amount but stays out of the math', () => {
    const refund = makeItem({ enter_amount: -200, split: true, fronted_by: 'a', pending: true })
    expect(refund.amount).toBe(-100)
    expect(refund.pending).toBe(true)
    const s = buildSettlement([item({ id: 'r1', amount: -100, pending: true })], {})
    expect(s.item_ids).toEqual([])
    expect(s.amount).toBe(0)
  })
})

// ── personal offsets: carve out personal spend before the 50/50 split ────────
// The line stays whole (enter_amount = one bank transaction); the carve-out
// lives in personal_a / personal_b and only adjusts the OWED share.
describe('computeOwed — personal offsets (Split only)', () => {
  it('no offset matches a plain half-split', () => {
    expect(computeOwed(800, true, 'a', 0, 0)).toBe(400)
  })

  it('payer-only personal: shrinks the shared base, non-payer owes half of the rest', () => {
    // Alex (payer) has 100 personal → shared 700 → Sam owes 350.
    expect(computeOwed(800, true, 'a', 100, 0)).toBe(350)
  })

  it("other-only personal: non-payer owes half the shared base PLUS their own personal", () => {
    // Sam (non-payer) has 150 personal → shared 650 → Sam owes 325 + 150 = 475.
    expect(computeOwed(800, true, 'a', 0, 150)).toBe(475)
  })

  it('both personal in one transaction (worked example)', () => {
    // Alex pays 800, personal_a 100, personal_b 150 → shared 550 → Sam owes 275 + 150 = 425.
    expect(computeOwed(800, true, 'a', 100, 150)).toBe(425)
  })

  it('direction flips with the payer: when B pays, A owes their own personal', () => {
    // Bob (b) pays 800, personal_a 100, personal_b 150 → shared 550 → Alex owes 275 + 100 = 375.
    expect(computeOwed(800, true, 'b', 100, 150)).toBe(375)
  })

  it('personal_a + personal_b === enter_amount → shared 0 → owed = the non-payer’s personal', () => {
    // Alex pays 500, personal_a 200, personal_b 300 → shared 0 → Sam owes 0 + 300 = 300.
    expect(computeOwed(500, true, 'a', 200, 300)).toBe(300)
  })

  it('owes-all (split=false) ignores personal entirely', () => {
    expect(computeOwed(800, false, 'a', 100, 150)).toBe(800)
  })

  it('rounds each component to 2dp', () => {
    // shared 101 → 50.5 half + 0 personal.
    expect(computeOwed(101, true, 'a', 0, 0)).toBe(50.5)
  })
})

describe('personalSums — per-person totals from the entry list', () => {
  it('sums an empty list to 0 / 0', () => {
    expect(personalSums([])).toEqual({ a: 0, b: 0 })
  })

  it('sums multiple entries per person', () => {
    const sums = personalSums([
      { person: 'a', amount: 100, note: 'powder' },
      { person: 'a', amount: 40, note: 'book' },
      { person: 'b', amount: 150, note: 'magazine' },
    ])
    expect(sums).toEqual({ a: 140, b: 150 })
  })
})

describe('makeItem — personal_items as the source of truth', () => {
  it('defaults to an empty list and untouched split when no entries', () => {
    const it = makeItem({ enter_amount: 400, fronted_by: 'a' })
    expect(it.personal_items).toEqual([])
    expect(it.personal_a).toBe(0)
    expect(it.personal_b).toBe(0)
    expect(it.amount).toBe(200)
  })

  it('derives the per-person sums and amount from the entry list', () => {
    const it = makeItem({
      enter_amount: 800, split: true, fronted_by: 'a',
      personal_items: [
        { person: 'a', amount: 100, note: 'powder' },
        { person: 'b', amount: 150, note: 'magazine' },
      ],
    })
    expect(it.personal_a).toBe(100)
    expect(it.personal_b).toBe(150)
    expect(it.amount).toBe(425) // shared 550 → Sam owes 275 + 150
    expect(it.personal_items).toHaveLength(2)
  })

  it('collapses several same-person entries into the derived sum', () => {
    const it = makeItem({
      enter_amount: 800, split: true, fronted_by: 'a',
      personal_items: [
        { person: 'a', amount: 100, note: 'powder' },
        { person: 'a', amount: 40, note: 'book' },
        { person: 'b', amount: 150, note: 'magazine' },
      ],
    })
    expect(it.personal_a).toBe(140)
    expect(it.personal_b).toBe(150)
    // shared 510 → Sam owes 255 + 150 = 405
    expect(it.amount).toBe(405)
  })

  it('drops zero/negative entries when deriving', () => {
    const it = makeItem({
      enter_amount: 800, split: true, fronted_by: 'a',
      personal_items: [
        { person: 'a', amount: 100, note: 'powder' },
        { person: 'a', amount: 0, note: 'free sample' },
      ],
    })
    expect(it.personal_a).toBe(100)
    expect(it.personal_items).toHaveLength(1)
  })
})

describe('normalizeItem — migration & defaults on read', () => {
  it('gives a pre-personal item an empty list', () => {
    const raw = { id: 'i1', enter_amount: 400 } as unknown as Item
    const n = normalizeItem(raw)
    expect(n.personal_items).toEqual([])
    expect(n.personal_a).toBe(0)
    expect(n.personal_b).toBe(0)
  })

  it('synthesises entries from a v1 item (personal_a/b + single note)', () => {
    const raw = { id: 'i1', enter_amount: 800, personal_a: 100, personal_b: 150, personal_note: 'Alex powder' } as unknown as Item
    const n = normalizeItem(raw)
    expect(n.personal_items).toEqual([
      { person: 'a', amount: 100, note: 'Alex powder' },
      { person: 'b', amount: 150, note: '' },
    ])
    expect(n.personal_a).toBe(100)
    expect(n.personal_b).toBe(150)
  })

  it('re-derives the cached sums from an existing list (idempotent)', () => {
    const raw = { id: 'i1', personal_items: [{ person: 'a', amount: 100, note: '' }, { person: 'a', amount: 40, note: '' }], personal_a: 0, personal_b: 0 } as unknown as Item
    const n = normalizeItem(raw)
    expect(n.personal_a).toBe(140)
    expect(n.personal_items).toHaveLength(2)
  })
})

describe('settlement integration with a personal offset', () => {
  it('nets the offset-adjusted owed share correctly', () => {
    // Alex pays 800 with 425 owed (offset), plus a plain 200 split where Sam owes 100.
    const items = [
      item({ id: 'i1', amount: 425, personal_a: 100, personal_b: 150 }),
      item({ id: 'i2', amount: 100 }),
    ]
    const t = netBalance(items)
    expect(t).toEqual({ from: 'b', to: 'a', amount: 525 })
    const s = buildSettlement(items, {})
    expect(s.from_person).toBe('b')
    expect(s.to_person).toBe('a')
    expect(s.amount).toBe(525)
    expect(s.item_ids).toEqual(['i1', 'i2'])
  })
})
