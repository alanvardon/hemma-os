/* lonevaxling-store.ts — persistence for Löneväxling. Phase 16g commit 2: the
   whole inputs object persists as one row in the shared tool_state table
   (tool = 'lonevaxling'), with a localStorage write-through cache for offline.
   The persistence skeleton (cache, first-login import, load/save) lives in
   ./tool-store (createToolStateStore); only the `_merge` sanitizer and the key
   strings are tool-specific. Exported signatures unchanged, so Lonevaxling.tsx
   is untouched. */

import { defaultInputs, type LonevaxlingInputs } from './lonevaxling'
import { createToolStateStore } from './tool-store'

export const STORAGE_KEY = 'bostadskalkyl_lonevaxling_v1'

// Merge the saved finite numbers into a fresh defaults object — guards against
// schema drift / bad data. Returns null when nothing valid is present. Runs on
// cloud, cache and legacy blobs alike (idempotent).
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

const store = createToolStateStore<LonevaxlingInputs>({
  tool: 'lonevaxling',
  storageKey: STORAGE_KEY,
  cacheKey: 'bostadskalkyl_lonevaxling_cache_v1',
  importFlag: 'bostadskalkyl_lonevaxling_supabase_imported',
  merge: _merge,
})

// Read the persisted inputs. null = nothing stored yet (caller keeps defaults).
export const load = store.load
// Persist the whole inputs blob. Never rejects — the caller fires and forgets.
export const save = store.save
