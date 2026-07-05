/* konsult-store.ts — persistence for Konsultkalkyl. Phase 16g commit 1: the
   inline localStorage read/write from Konsultkalkyl.tsx, extracted behind the
   same async Promise shape the other stores use, so commit 2's cloud swap is a
   body change only. Still localStorage here. */

import { defaultInputs, type KonsultInputs } from './konsult'

export const STORAGE_KEY = 'bostadskalkyl_konsult_v1'

// Merge the saved finite numbers into a fresh defaults object — guards against
// schema drift / bad data (an unknown or non-numeric field falls back to its
// default). Returns null when nothing valid is stored.
function _merge(saved: unknown): KonsultInputs | null {
  if (!saved || typeof saved !== 'object') return null
  const s = saved as Record<string, unknown>
  const d = defaultInputs()
  for (const k of Object.keys(d) as (keyof KonsultInputs)[]) {
    const v = s[k]
    if (typeof v === 'number' && isFinite(v)) d[k] = v
  }
  return d
}

export async function load(): Promise<KonsultInputs | null> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? _merge(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

export async function save(inputs: KonsultInputs): Promise<void> {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(inputs)) } catch { /* private mode / quota */ }
}
