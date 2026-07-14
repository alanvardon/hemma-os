/* konsult-store.ts — persistence for Konsultkalkyl. Phase 16g commit 2: the
   whole inputs object persists as one row in the shared tool_state table
   (tool = 'konsultkalkyl'), with a scoped cache and durable operation outbox.
   The persistence skeleton (cache, first-login import, load/save) lives in
   ./tool-store (createToolStateStore); only the `_merge` sanitizer and the key
   strings are tool-specific. Exported signatures unchanged, so Konsultkalkyl.tsx
   is untouched. */

import { defaultInputs, type KonsultInputs } from './konsult'
import { createToolStateStore } from './tool-store'

export const STORAGE_KEY = 'bostadskalkyl_konsult_v1'

// Merge the saved finite numbers into a fresh defaults object — guards against
// schema drift / bad data. Returns null when nothing valid is present. Runs on
// cloud, cache and legacy blobs alike (idempotent).
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

const store = createToolStateStore<KonsultInputs>({
  tool: 'konsultkalkyl',
  storageKey: STORAGE_KEY,
  cacheKey: 'bostadskalkyl_konsult_cache_v1',
  importFlag: 'bostadskalkyl_konsult_supabase_imported',
  merge: _merge,
})

// Read the persisted inputs. null = nothing stored yet (caller keeps defaults).
export const load = store.load
// Persist through the durable outbox; rejects until the cloud acknowledges.
export const save = store.save
