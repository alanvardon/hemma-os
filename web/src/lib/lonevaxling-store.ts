/* lonevaxling-store.ts — persistence for Löneväxling. Phase 16g commit 1: the
   inline localStorage read/write from Lonevaxling.tsx, extracted behind the same
   async Promise shape the other stores use, so commit 2's cloud swap is a body
   change only. Still localStorage here. */

import { defaultInputs, type LonevaxlingInputs } from './lonevaxling'

export const STORAGE_KEY = 'bostadskalkyl_lonevaxling_v1'

// Merge the saved finite numbers into a fresh defaults object — guards against
// schema drift / bad data. Returns null when nothing valid is stored.
function _merge(saved: unknown): LonevaxlingInputs | null {
  if (!saved || typeof saved !== 'object') return null
  const s = saved as Record<string, unknown>
  const d = defaultInputs()
  for (const k of Object.keys(d) as Array<keyof LonevaxlingInputs>) {
    const v = s[k]
    if (typeof v === 'number' && isFinite(v)) (d as unknown as Record<string, number>)[k] = v
  }
  return d
}

export async function load(): Promise<LonevaxlingInputs | null> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? _merge(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

export async function save(inputs: LonevaxlingInputs): Promise<void> {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(inputs)) } catch { /* private mode / quota */ }
}
