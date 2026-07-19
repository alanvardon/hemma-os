// hub-stats.ts — pure derivations for the hub's living-bento cards (plan 30).
// Every figure the homepage shows comes from one of these functions so they
// can be unit-tested without DOM/storage; Home.tsx only loads the stores and
// hands the rows over. A stat function returns null when the underlying store
// has no real content yet — the card then falls back to its description prose
// (never 0 kr / NaN).

import { totalBalance, balanceTimeline, purchasePrice, costBasisOwnedPct } from './mortgage'
import type { LoanPart, Payment as MortgagePayment, Valuation } from './mortgage'
import type { Item as MonthEndItem, Payment as MonthEndPayment, MonthEndSettings } from './manadsavslut'
import { computeBudget, type BudgetState } from './hushallsbudget'
import { derive, type Constants } from './calc'
import type { Scenario } from './storage'
import { needsAttention, nextMilestone, type HouseItem } from './huskalendern'

// ── Bolånekoll ───────────────────────────────────────────────────────────────

export interface MortgageStat {
  debt: number
  /** Total balance per month over the payment history, oldest → newest (for the sparkline). */
  spark: number[]
  /** Cost-basis ownership share (%), when a purchase valuation exists — else null. */
  ownedPct: number | null
}

export function mortgageStat(
  parts: LoanPart[],
  payments: MortgagePayment[],
  valuations: Valuation[],
): MortgageStat | null {
  const active = (parts || []).filter((p) => p && !p.archived)
  if (!active.length) return null
  const debt = totalBalance(active, payments)
  if (debt <= 0) return null
  // Cap the sparkline to the last 24 months — enough to read the trend at 120px.
  const spark = balanceTimeline(active, payments).map((r) => r.balance).slice(-24)
  const price = purchasePrice(valuations || [])
  const ownedPct = price > 0 ? costBasisOwnedPct(price, debt) : null
  return { debt, spark, ownedPct }
}

// ── Månadsavslut ─────────────────────────────────────────────────────────────

export interface SettleStat {
  from: string; to: string; amount: number
  /** The legacy A/B slots behind the transfer, so the hub can resolve canonical
      names + the "Du" marker through the person-identity binding (plan 111)
      without changing this household-wide figure. */
  fromSlot: 'a' | 'b'; toSlot: 'a' | 'b'
}

export interface MonthEndStat {
  /** Days until the last day of the current month (0 = today is month-end). */
  days: number
  /** The most recent settlement, or null if none (or it netted to zero). */
  settle: SettleStat | null
}

export function daysToMonthEnd(now: Date): number {
  // Day 0 of next month = last day of this month; works across the year
  // boundary (Dec → month index 12 → Jan 0 → Dec 31) and leap Februaries.
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  return last - now.getDate()
}

export function latestSettle(
  payments: MonthEndPayment[],
  settings: MonthEndSettings,
): SettleStat | null {
  const sorted = (payments || [])
    .filter(Boolean)
    .slice()
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
  const p = sorted[0]
  if (!p || !p.from_person || !p.to_person || !(Number(p.amount) > 0)) return null
  const name = (person: 'a' | 'b') =>
    person === 'a' ? settings.person_a_name : settings.person_b_name
  return { from: name(p.from_person), to: name(p.to_person), amount: Number(p.amount), fromSlot: p.from_person, toSlot: p.to_person }
}

export function monthEndStat(
  items: MonthEndItem[],
  payments: MonthEndPayment[],
  settings: MonthEndSettings,
  now: Date,
): MonthEndStat | null {
  // A fresh browser has neither items nor settlements — the countdown alone
  // would be noise, so the card falls back to prose until the tool is used.
  if (!(items || []).length && !(payments || []).length) return null
  return { days: daysToMonthEnd(now), settle: latestSettle(payments, settings) }
}

// ── Hushållsbudget ───────────────────────────────────────────────────────────

export interface BudgetStat { a: number; b: number; equal: boolean }

export function budgetStat(state: BudgetState | null): BudgetStat | null {
  if (!state) return null
  const r = computeBudget(state)
  if (!(r.totalIncome > 0)) return null
  const a = r.personA.leftover
  const b = r.personB.leftover
  return { a, b, equal: Math.round(a) === Math.round(b) }
}

// ── Bostadskalkyl ────────────────────────────────────────────────────────────

export interface ScenarioStat {
  count: number
  /** Monthly cost of the single saved scenario — only when count === 1. */
  monthly: number | null
}

export function scenarioStat(scenarios: Scenario[], globalConstants: Constants): ScenarioStat | null {
  const list = scenarios || []
  if (!list.length) return null
  const monthly = list.length === 1 ? derive(list[0].inputs, list[0].constants ?? globalConstants).totalMonthly : null
  return { count: list.length, monthly }
}

// ── Huskalendern ───────────────────────────────────────────────────────────

export interface HouseStat {
  /** How many items need attention (soon/overdue) — the "N saker" flag. */
  attention: number
  /** The nearest upcoming milestone, shown when nothing needs attention. */
  next: { title: string; days: number } | null
}

export function houseStat(items: HouseItem[], today: string): HouseStat | null {
  const list = items || []
  if (!list.length) return null
  const attention = needsAttention(list, today).length
  const nm = nextMilestone(list, today)
  return { attention, next: nm ? { title: nm.title, days: nm.days } : null }
}

// ── Last-opened ordering ─────────────────────────────────────────────────────

export const LAST_OPENED_PREFIX = 'hemma-last-opened.'

/**
 * Sort tool entries by last-opened recency, most recent first. Entries with no
 * timestamp keep their authored relative order after the timestamped ones
 * (Array.prototype.sort is stable); with no timestamps at all, the authored
 * order is returned unchanged.
 */
export function orderTools<T extends { path: string }>(
  entries: T[],
  timestamps: Record<string, number | undefined>,
): T[] {
  return entries.slice().sort((x, y) => (timestamps[y.path] ?? 0) - (timestamps[x.path] ?? 0))
}

export function markOpened(path: string, now: number): void {
  try {
    localStorage.setItem(LAST_OPENED_PREFIX + path, String(now))
  } catch { /* private mode / quota */ }
}

export function readLastOpened(paths: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  try {
    for (const path of paths) {
      const raw = localStorage.getItem(LAST_OPENED_PREFIX + path)
      const t = raw == null ? NaN : Number(raw)
      if (Number.isFinite(t)) out[path] = t
    }
  } catch { /* private mode */ }
  return out
}
