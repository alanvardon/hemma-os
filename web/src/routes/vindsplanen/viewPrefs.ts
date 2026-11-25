// Per-device viewing choices for Vindsplanen (zones, rafters, cut-away, dims,
// sun, quality). They describe how you look at the design, not the design, so
// they live in localStorage and never in the shared plan. Every storage access
// is guarded: private mode / blocked storage must never break the page.

import { defaultViewPrefs, sanitizeViewPrefs, type ViewPrefs } from '../../lib/vindsplanen/plan'

export const VIEW_KEY = 'vp-view-v1'

function isCoarse(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
  } catch {
    return false
  }
}

export function loadViewPrefs(): ViewPrefs {
  const coarse = isCoarse()
  try {
    const text = localStorage.getItem(VIEW_KEY)
    if (text) return sanitizeViewPrefs(JSON.parse(text), coarse)
  } catch {
    /* unreadable or blocked: fall back to defaults */
  }
  return defaultViewPrefs(coarse)
}

export function saveViewPrefs(v: ViewPrefs): void {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(v))
  } catch {
    /* best effort */
  }
}
