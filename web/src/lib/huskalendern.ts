// huskalendern.ts — Huskalendern (the house's memory): the PURE core.
// Derives the vertical timeline around "today" from a flat list of house items.
// No DOM/storage/React — importable by a Deno Edge Function later (plan 72), so
// only self-contained date math here (mirrors lib/date.ts, duplicated to stay
// dependency-free for the Deno port).
//
// Two item kinds:
//  - 'log'      — something that was done on `date`. With `interval_years` it
//                 also projects a SOFT future milestone ("due again ≈ …").
//  - 'contract' — something that runs out ON `date`; flagged within `remind_days`.

export type HouseItemType = 'log' | 'contract'
export type HouseCategory = 'underhåll' | 'avtal' | 'besiktning' | 'övrigt'

export interface HouseItem {
  id: string
  created_at: string
  type: HouseItemType
  title: string
  category: string
  /** log: when it was done · contract: when it expires. YYYY-MM-DD or ''/null. */
  date: string | null
  cost: number | null
  vendor: string | null
  /** logs only: "every N years" soft hint. */
  interval_years: number | null
  /** contracts: flag when within this many days of `date`. */
  remind_days: number
  notes: string | null
}

export type ItemStatus = 'overdue' | 'soon' | 'ok' | 'none'

// Interval-hint items enter the "soon" (amber) window this many days before
// their projected next-due date — softer than a contract's own remind_days
// because the date itself is only an estimate.
export const INTERVAL_SOON_DAYS = 90

// ── Self-contained date helpers (no imports — Deno-portable) ─────────────────

const pad = (n: number) => String(n).padStart(2, '0')

/** Parse YYYY-MM-DD → a local Date at midnight, or null on bad/empty input. */
function parseISO(iso: string | null | undefined): Date | null {
  if (!iso || typeof iso !== 'string') return null
  const d = new Date(iso + 'T00:00:00')
  return isNaN(d.getTime()) ? null : d
}

function toISO(d: Date): string {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

/** Whole days from `today` to `target` (both YYYY-MM-DD); null on bad input. */
export function daysUntil(target: string | null, today: string): number | null {
  const dt = parseISO(target), dn = parseISO(today)
  if (!dt || !dn) return null
  return Math.round((dt.getTime() - dn.getTime()) / 86400000)
}

/** `iso` shifted by whole years, as YYYY-MM-DD. Leap-day overflow rolls forward
 * the way Date does (2028-02-29 + 1 år → 2029-03-01). null on bad input. */
export function addYearsISO(iso: string | null, years: number): string | null {
  const d = parseISO(iso)
  if (d == null || !isFinite(years)) return null
  d.setFullYear(d.getFullYear() + years)
  return toISO(d)
}

// ── Derivations ──────────────────────────────────────────────────────────────

/**
 * The next date this item is "due":
 *  - contract → its expiry `date`.
 *  - log with a positive `interval_years` → date + interval (soft estimate).
 *  - log without an interval → none (it's just history).
 * Returns YYYY-MM-DD or null.
 */
export function nextDue(item: HouseItem): string | null {
  if (!item || !item.date) return null
  if (item.type === 'contract') return item.date
  const iv = Number(item.interval_years)
  if (item.type === 'log' && isFinite(iv) && iv > 0) return addYearsISO(item.date, iv)
  return null
}

/**
 * Attention status relative to `today` (YYYY-MM-DD):
 *  - 'none'    — no future due date (a plain history log).
 *  - 'overdue' — the next-due date is in the past (< today).
 *  - 'soon'    — within the reminder window (contract: `remind_days`;
 *                interval hint: INTERVAL_SOON_DAYS).
 *  - 'ok'      — a future due date beyond the window.
 * Expiry/next-due falling exactly ON today counts as 'soon', not 'overdue'.
 */
export function status(item: HouseItem, today: string): ItemStatus {
  const due = nextDue(item)
  if (!due) return 'none'
  const days = daysUntil(due, today)
  if (days == null) return 'none'
  if (days < 0) return 'overdue'
  const window = item.type === 'contract'
    ? (isFinite(Number(item.remind_days)) ? Number(item.remind_days) : 60)
    : INTERVAL_SOON_DAYS
  return days <= window ? 'soon' : 'ok'
}

// ── Timeline ─────────────────────────────────────────────────────────────────

export type MilestoneKind = 'log' | 'expiry' | 'interval'

/**
 * One dot on the rail. A log with an interval produces TWO entries: its
 * done-date (kind 'log', in the past) AND its projected next-due
 * (kind 'interval', in the future, `soft: true`, rendered with "≈").
 */
export interface TimelineEntry {
  id: string          // item id (+ suffix for the interval projection)
  itemId: string      // the underlying house_item id (both entries share it)
  kind: MilestoneKind // 'log' (history) · 'expiry' (contract) · 'interval' (soft future)
  date: string        // YYYY-MM-DD of this milestone
  title: string
  category: string
  vendor: string | null
  cost: number | null
  notes: string | null
  soft: boolean       // interval projections only — render dashed + "≈"
  past: boolean       // strictly before today
  status: ItemStatus  // attention status of the parent item (drives colour)
  item: HouseItem     // the source row, for the edit dialog
}

/** The "Idag" divider injected into the sorted stream. */
export interface TodayDivider { kind: 'today'; date: string }

export type TimelineNode = TimelineEntry | TodayDivider

export function isDivider(n: TimelineNode): n is TodayDivider {
  return (n as TodayDivider).kind === 'today'
}

/** A year's worth of nodes, in ascending date order. */
export interface YearBucket { year: number; nodes: TimelineNode[] }

/**
 * Build the timeline: one entry per milestone — every log's done-date (past)
 * and every item's nextDue (future) — sorted ascending, with a `today` divider
 * injected at the today boundary, then bucketed by year.
 *
 * An interval log therefore appears twice: as history AND as a future soft
 * ("≈") milestone. A contract appears once, as its expiry. The divider's year
 * bucket is `today`'s year; if a year has only the divider it still gets a
 * bucket so the "Idag" line always has a home.
 */
export function timelineEntries(items: HouseItem[], today: string): YearBucket[] {
  const entries: TimelineEntry[] = []
  const todayDays = 0 // reference; we compare via daysUntil(date, today)

  for (const item of items || []) {
    if (!item) continue
    const st = status(item, today)

    // History milestone: a log's done-date (contracts have no "done" event).
    if (item.type === 'log' && item.date) {
      const d = daysUntil(item.date, today)
      if (d != null) {
        entries.push({
          id: item.id + ':log', itemId: item.id, kind: 'log', date: item.date,
          title: item.title, category: item.category, vendor: item.vendor,
          cost: item.cost, notes: item.notes, soft: false,
          past: d < todayDays, status: st, item,
        })
      }
    }

    // Future (or overdue) milestone: contract expiry, or interval projection.
    const due = nextDue(item)
    if (due) {
      const d = daysUntil(due, today)
      if (d != null) {
        const kind: MilestoneKind = item.type === 'contract' ? 'expiry' : 'interval'
        entries.push({
          id: item.id + ':' + kind, itemId: item.id, kind, date: due,
          title: item.title, category: item.category, vendor: item.vendor,
          // A projected interval milestone carries no cost (it hasn't happened).
          cost: item.type === 'contract' ? item.cost : null,
          notes: item.notes, soft: kind === 'interval',
          past: d < todayDays, status: st, item,
        })
      }
    }
  }

  // Sort ascending by date; ties keep past logs before future projections, then
  // by title for stability.
  entries.sort((a, b) =>
    a.date.localeCompare(b.date) ||
    (a.past === b.past ? 0 : a.past ? -1 : 1) ||
    a.title.localeCompare(b.title),
  )

  // Inject the "Idag" divider at the today boundary — before the first strictly
  // future node (past === false).
  const nodes: TimelineNode[] = []
  const divider: TodayDivider = { kind: 'today', date: today }
  let placed = false
  for (const e of entries) {
    if (!placed && !e.past) { nodes.push(divider); placed = true }
    nodes.push(e)
  }
  if (!placed) nodes.push(divider) // all history (or empty) → divider at the end

  // Bucket by year (divider counts toward its own calendar year).
  const buckets: YearBucket[] = []
  let current: YearBucket | null = null
  for (const n of nodes) {
    const year = Number(n.date.slice(0, 4))
    if (!current || current.year !== year) {
      current = { year, nodes: [] }
      buckets.push(current)
    }
    current.nodes.push(n)
  }
  return buckets
}

/** Items needing attention (soon/overdue), for the "Behöver ses över" strip and
 * the hub count. Sorted by nearest due date first. */
export function needsAttention(items: HouseItem[], today: string): HouseItem[] {
  return (items || [])
    .filter((it) => it && (status(it, today) === 'soon' || status(it, today) === 'overdue'))
    .sort((a, b) => {
      const da = daysUntil(nextDue(a), today) ?? Infinity
      const db = daysUntil(nextDue(b), today) ?? Infinity
      return da - db
    })
}

/** The nearest upcoming (non-past) milestone, for the hub tile when nothing
 * needs attention. null when there is no future milestone at all. */
export function nextMilestone(items: HouseItem[], today: string): { title: string; date: string; days: number } | null {
  let best: { title: string; date: string; days: number } | null = null
  for (const item of items || []) {
    const due = nextDue(item)
    if (!due) continue
    const days = daysUntil(due, today)
    if (days == null || days < 0) continue
    if (!best || days < best.days) best = { title: item.title, date: due, days }
  }
  return best
}
