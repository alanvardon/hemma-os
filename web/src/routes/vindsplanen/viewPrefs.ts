// Per-device viewing choices for Vindsplanen (zones, rafters, cut-away, dims,
// sun, quality). They describe how you look at the design, not the design, so
// they live in localStorage and never in the shared plan. Every storage access
// is guarded: private mode / blocked storage must never break the page.

import { defaultViewPrefs, sanitizeViewPrefs, SUN_DATE_DEF, type ViewPrefs } from '../../lib/vindsplanen/plan'

export const VIEW_KEY = 'vp-view-v1'

function isCoarse(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
  } catch {
    return false
  }
}

/**
 * Today's Swedish calendar date as 'MM-DD', the default day for the real sun
 * (plan 144). Read here, at load, so the pure sanitizer stays deterministic.
 * 02-29 falls back to SUN_DATE_DEF inside defaultViewPrefs.
 */
export function todayMonthDay(now: Date = new Date()): string {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Stockholm', month: '2-digit', day: '2-digit' }).formatToParts(now)
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? ''
    return `${get('month')}-${get('day')}`
  } catch {
    return SUN_DATE_DEF
  }
}

export function loadViewPrefs(): ViewPrefs {
  const coarse = isCoarse()
  const today = todayMonthDay()
  try {
    const text = localStorage.getItem(VIEW_KEY)
    if (text) return sanitizeViewPrefs(JSON.parse(text), coarse, today)
  } catch {
    /* unreadable or blocked: fall back to defaults */
  }
  return defaultViewPrefs(coarse, today)
}

export function saveViewPrefs(v: ViewPrefs): void {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(v))
  } catch {
    /* best effort */
  }
}
