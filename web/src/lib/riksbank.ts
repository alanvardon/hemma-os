// riksbank.ts — Swedish policy-rate (styrränta) watcher (plan 70).
// The Riksbank SWEA API isn't browser-callable — an Origin header gets a 200
// with an empty body, no CORS — so every read goes through the
// `riksbank-proxy` Edge Function, which also collapses the per-banking-day
// series into change points server-side. `collapseChanges` below mirrors that
// same logic for the pure-helper tests; the Edge Function runs on Deno and
// can't import from web/src, so keep the two in sync by hand if it changes.
import { supabase } from './supabase'
import { daysUntil } from './date'
import decisionsData from './riksbank-decisions.json'

export interface RatePoint { date: string; value: number }

export interface PolicyRateData {
  latest: RatePoint
  changes: RatePoint[]
}

export interface Acknowledged { date: string; value: number }

// Announcement (09:30 publication) dates, generated from riksbank.se by
// scripts/scrape-riksbank-calendar.mjs (see .github/workflows/riksbank-calendar.yml).
// This array is DATA, not hand-authored — edit the scraper, not the list.
// The literal fallback is the last resort if the JSON is ever empty, so the
// card degrades to "se riksbank.se" rather than throwing.
const FALLBACK_DECISIONS = ['2026-08-19', '2026-09-23', '2026-11-03', '2026-12-15']
export const RIKSBANK_DECISIONS: string[] =
  (decisionsData.decisions?.length ? decisionsData.decisions : FALLBACK_DECISIONS)

/**
 * Collapse a per-banking-day observation series into change points — keep
 * only rows whose value differs from the previous kept row. Assumes
 * `observations` is already sorted oldest → newest.
 */
export function collapseChanges(observations: RatePoint[]): RatePoint[] {
  const out: RatePoint[] = []
  for (const obs of observations || []) {
    const prev = out[out.length - 1]
    if (!prev || prev.value !== obs.value) out.push(obs)
  }
  return out
}

/**
 * The Riksbank's `Latest` endpoint stamps every observation with TODAY's date
 * (it's "the rate as of now"), not the date it took effect — so it can't be
 * used for "sedan {date}" or for change-acknowledgment (the date would drift
 * daily even when the rate hasn't moved). The last entry in `changes` is the
 * genuine effective-from point; fall back to `latest` only if history is empty.
 */
export function currentPoint(data: PolicyRateData): RatePoint {
  return data.changes[data.changes.length - 1] ?? data.latest
}

/** Next upcoming announcement date on/after `today` (YYYY-MM-DD), or null once the calendar is exhausted. */
export function nextDecision(today: string, calendar: string[] = RIKSBANK_DECISIONS): string | null {
  return (calendar || []).find((d) => d >= today) ?? null
}

/** Most recent announcement date before `today`, or null before the calendar's first entry. */
export function lastDecision(today: string, calendar: string[] = RIKSBANK_DECISIONS): string | null {
  const past = (calendar || []).filter((d) => d < today)
  return past[past.length - 1] ?? null
}

// A decision is announced at 09:30 but the new rate takes effect ~a week
// later, so the change point's date (= effective date in the SWEA series)
// trails the announcement. This window pairs them up.
const EFFECT_WINDOW_DAYS = 14

/** The change point a given announcement produced, or null if the rate was held (oförändrad). */
export function decisionOutcome(decisionDate: string, changes: RatePoint[]): RatePoint | null {
  return (
    (changes || []).find((c) => {
      const gap = daysUntil(c.date, decisionDate)
      return gap != null && gap >= 0 && gap <= EFFECT_WINDOW_DAYS
    }) ?? null
  )
}

/** Is `latest` a change the user hasn't acknowledged yet? */
export function detectChange(latest: RatePoint | null, acknowledged: Acknowledged | null): boolean {
  if (!latest) return false
  if (!acknowledged) return true
  return acknowledged.date !== latest.date || acknowledged.value !== latest.value
}

const ACK_KEY = 'hemma-riksbank-ack-v1'

export function readAcknowledged(): Acknowledged | null {
  try {
    const raw = localStorage.getItem(ACK_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.date === 'string' && typeof parsed.value === 'number') return parsed
    return null
  } catch { return null }
}

export function acknowledge(point: RatePoint): void {
  try { localStorage.setItem(ACK_KEY, JSON.stringify({ date: point.date, value: point.value })) } catch { /* private mode / quota */ }
}

// The banner's × is deliberately only session-deep ("not now") — an accidental
// click costs one visit, not the whole news window. Permanent dismissal is the
// separate "visa inte igen" link → acknowledge() above.
const HIDE_KEY = 'hemma-riksbank-hide-v1'

export function readSessionHidden(): Acknowledged | null {
  try {
    const raw = sessionStorage.getItem(HIDE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.date === 'string' && typeof parsed.value === 'number') return parsed
    return null
  } catch { return null }
}

export function hideForSession(point: RatePoint): void {
  try { sessionStorage.setItem(HIDE_KEY, JSON.stringify({ date: point.date, value: point.value })) } catch { /* private mode / quota */ }
}

const SESSION_CACHE_KEY = 'hemma-riksbank-rate-v1'
const SESSION_CACHE_TTL_MS = 60 * 60 * 1000

interface SessionCacheEntry { at: number; data: PolicyRateData }

function readSessionCache(): PolicyRateData | null {
  try {
    const raw = sessionStorage.getItem(SESSION_CACHE_KEY)
    if (!raw) return null
    const entry: SessionCacheEntry = JSON.parse(raw)
    if (!entry || Date.now() - entry.at > SESSION_CACHE_TTL_MS) return null
    return entry.data
  } catch { return null }
}

function writeSessionCache(data: PolicyRateData): void {
  try {
    sessionStorage.setItem(SESSION_CACHE_KEY, JSON.stringify({ at: Date.now(), data }))
  } catch { /* private mode / quota */ }
}

/**
 * Fetches the current policy rate + change history via the `riksbank-proxy`
 * Edge Function, cached in sessionStorage for an hour so Home and Bolånekoll
 * don't both hit the function on every load. Throws on failure — callers must
 * treat this as best-effort and never block on it (plan 70's failure path).
 */
export async function fetchPolicyRate(): Promise<PolicyRateData> {
  const cached = readSessionCache()
  if (cached) return cached
  const { data, error } = await supabase.functions.invoke<PolicyRateData>('riksbank-proxy')
  if (error || !data) throw error ?? new Error('riksbank-proxy: empty response')
  writeSessionCache(data)
  return data
}
