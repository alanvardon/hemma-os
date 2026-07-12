import { describe, it, expect } from 'vitest'
import {
  nextDue, status, timelineEntries, needsAttention, nextMilestone,
  isDivider, addYearsISO, daysUntil, INTERVAL_SOON_DAYS,
  type HouseItem, type TimelineEntry,
} from './huskalendern'

// ── Fixture builder ───────────────────────────────────────────────────────────
function item(over: Partial<HouseItem>): HouseItem {
  return {
    id: over.id ?? 'x',
    created_at: '2026-01-01T00:00:00.000Z',
    type: over.type ?? 'log',
    title: over.title ?? 'Item',
    category: over.category ?? 'övrigt',
    date: over.date ?? null,
    cost: over.cost ?? null,
    vendor: over.vendor ?? null,
    interval_years: over.interval_years ?? null,
    remind_days: over.remind_days ?? 60,
    notes: over.notes ?? null,
    ...over,
  }
}

const TODAY = '2026-07-12'

// ── date helpers ──────────────────────────────────────────────────────────────
describe('date helpers', () => {
  it('addYearsISO crosses a year boundary and handles leap-day overflow', () => {
    expect(addYearsISO('2024-05-01', 3)).toBe('2027-05-01')
    // 2028-02-29 + 1yr → 2029 has no Feb 29 → rolls to Mar 1 (Date semantics).
    expect(addYearsISO('2028-02-29', 1)).toBe('2029-03-01')
    expect(addYearsISO(null, 2)).toBeNull()
    expect(addYearsISO('', 2)).toBeNull()
  })
  it('daysUntil is 0 for the same day and null on bad input', () => {
    expect(daysUntil(TODAY, TODAY)).toBe(0)
    expect(daysUntil('2026-07-13', TODAY)).toBe(1)
    expect(daysUntil('not-a-date', TODAY)).toBeNull()
  })
})

// ── nextDue ───────────────────────────────────────────────────────────────────
describe('nextDue', () => {
  it('contract → its expiry date', () => {
    expect(nextDue(item({ type: 'contract', date: '2027-03-01' }))).toBe('2027-03-01')
  })
  it('log with interval → date + interval', () => {
    expect(nextDue(item({ type: 'log', date: '2023-05-01', interval_years: 4 }))).toBe('2027-05-01')
  })
  it('log without interval → none', () => {
    expect(nextDue(item({ type: 'log', date: '2023-05-01' }))).toBeNull()
    expect(nextDue(item({ type: 'log', date: '2023-05-01', interval_years: 0 }))).toBeNull()
  })
  it('no date → none', () => {
    expect(nextDue(item({ type: 'contract', date: null }))).toBeNull()
  })
})

// ── status ────────────────────────────────────────────────────────────────────
describe('status', () => {
  it('no-interval log has status none', () => {
    expect(status(item({ type: 'log', date: '2020-01-01' }), TODAY)).toBe('none')
  })
  it('expiry exactly today counts as soon, not overdue', () => {
    expect(status(item({ type: 'contract', date: TODAY }), TODAY)).toBe('soon')
  })
  it('contract inside its remind window is soon; outside is ok', () => {
    // remind_days 60 → 2026-08-01 is 20 days out → soon; 2026-12-01 is far → ok.
    expect(status(item({ type: 'contract', date: '2026-08-01', remind_days: 60 }), TODAY)).toBe('soon')
    expect(status(item({ type: 'contract', date: '2026-12-01', remind_days: 60 }), TODAY)).toBe('ok')
  })
  it('a passed contract expiry is overdue', () => {
    expect(status(item({ type: 'contract', date: '2026-06-01' }), TODAY)).toBe('overdue')
  })
  it('interval hint uses the 90-day soft window, independent of remind_days', () => {
    // Due 2026-09-01 (~51 days) → within 90 → soon, even though remind_days is 60.
    const due = item({ type: 'log', date: '2022-09-01', interval_years: 4, remind_days: 60 })
    expect(nextDue(due)).toBe('2026-09-01')
    expect(daysUntil('2026-09-01', TODAY)! <= INTERVAL_SOON_DAYS).toBe(true)
    expect(status(due, TODAY)).toBe('soon')
    // Due 2027-01-01 (far) → ok.
    expect(status(item({ type: 'log', date: '2023-01-01', interval_years: 4 }), TODAY)).toBe('ok')
    // An interval already in the past → overdue.
    expect(status(item({ type: 'log', date: '2020-01-01', interval_years: 3 }), TODAY)).toBe('overdue')
  })
})

// ── timelineEntries ───────────────────────────────────────────────────────────
describe('timelineEntries', () => {
  const flat = (buckets: ReturnType<typeof timelineEntries>) =>
    buckets.flatMap((b) => b.nodes)

  it('injects an Idag divider between past and future', () => {
    const buckets = timelineEntries([
      item({ id: 'a', type: 'log', date: '2024-01-01', title: 'Roof' }),
      item({ id: 'b', type: 'contract', date: '2027-01-01', title: 'El' }),
    ], TODAY)
    const nodes = flat(buckets)
    const divIdx = nodes.findIndex(isDivider)
    expect(divIdx).toBeGreaterThan(-1)
    // everything before divider is past, everything after is future
    nodes.slice(0, divIdx).forEach((n) => expect(isDivider(n) || (n as TimelineEntry).past).toBeTruthy())
    nodes.slice(divIdx + 1).forEach((n) => expect((n as TimelineEntry).past).toBe(false))
  })

  it('an interval log appears BOTH as history and as a future ≈ milestone', () => {
    const buckets = timelineEntries([
      item({ id: 'pump', type: 'log', date: '2023-05-01', interval_years: 4, title: 'Avloppsspolning' }),
    ], TODAY)
    const entries = flat(buckets).filter((n) => !isDivider(n)) as TimelineEntry[]
    const forPump = entries.filter((e) => e.itemId === 'pump')
    expect(forPump).toHaveLength(2)
    const history = forPump.find((e) => e.kind === 'log')!
    const future = forPump.find((e) => e.kind === 'interval')!
    expect(history.date).toBe('2023-05-01')
    expect(history.past).toBe(true)
    expect(history.soft).toBe(false)
    expect(future.date).toBe('2027-05-01') // crosses a year boundary from today
    expect(future.past).toBe(false)
    expect(future.soft).toBe(true)          // rendered with "≈" / dashed
    expect(future.cost).toBeNull()          // projection carries no cost
  })

  it('a no-interval log appears only once, in history', () => {
    const buckets = timelineEntries([
      item({ id: 'once', type: 'log', date: '2022-03-03', title: 'Målning' }),
    ], TODAY)
    const entries = flat(buckets).filter((n) => !isDivider(n)) as TimelineEntry[]
    expect(entries.filter((e) => e.itemId === 'once')).toHaveLength(1)
    expect(entries[0].kind).toBe('log')
  })

  it('buckets ascending by year and always has a home for Idag', () => {
    const buckets = timelineEntries([], TODAY)
    // Empty → a single bucket for today's year holding just the divider.
    expect(buckets).toHaveLength(1)
    expect(buckets[0].year).toBe(2026)
    expect(buckets[0].nodes.every(isDivider)).toBe(true)
    // Years strictly ascending for a mixed fixture.
    const mixed = timelineEntries([
      item({ id: 'a', type: 'log', date: '2024-01-01' }),
      item({ id: 'b', type: 'log', date: '2022-06-01' }),
      item({ id: 'c', type: 'contract', date: '2028-02-01' }),
    ], TODAY)
    const years = mixed.map((b) => b.year)
    expect(years).toEqual([...years].sort((x, y) => x - y))
  })

  it('all-history fixture still gets an Idag divider (at the end)', () => {
    const buckets = timelineEntries([
      item({ id: 'a', type: 'log', date: '2020-01-01' }),
    ], TODAY)
    const nodes = flat(buckets)
    expect(nodes.some(isDivider)).toBe(true)
    expect(isDivider(nodes[nodes.length - 1])).toBe(true)
  })
})

// ── needsAttention / nextMilestone (hub + strip) ──────────────────────────────
describe('needsAttention', () => {
  it('collects soon + overdue, nearest first', () => {
    const items = [
      item({ id: 'ok', type: 'contract', date: '2027-12-01' }),           // ok
      item({ id: 'soon', type: 'contract', date: '2026-08-01' }),          // soon (20d)
      item({ id: 'over', type: 'contract', date: '2026-06-01' }),          // overdue
      item({ id: 'hist', type: 'log', date: '2020-01-01' }),              // none
    ]
    const flagged = needsAttention(items, TODAY)
    expect(flagged.map((i) => i.id)).toEqual(['over', 'soon'])
  })
})

describe('nextMilestone', () => {
  it('returns the nearest future milestone, ignoring overdue and history', () => {
    const items = [
      item({ id: 'over', type: 'contract', date: '2026-06-01' }),
      item({ id: 'near', type: 'contract', date: '2026-09-01', title: 'TV-paket' }),
      item({ id: 'far', type: 'contract', date: '2028-01-01' }),
    ]
    const m = nextMilestone(items, TODAY)
    expect(m?.title).toBe('TV-paket')
    expect(m?.date).toBe('2026-09-01')
  })
  it('returns null when nothing is upcoming', () => {
    expect(nextMilestone([item({ id: 'h', type: 'log', date: '2020-01-01' })], TODAY)).toBeNull()
  })
})
