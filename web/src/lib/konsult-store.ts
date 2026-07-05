/* konsult-store.ts — persistence for Konsultkalkyl. Phase 16g commit 2: the
   whole inputs object persists as one row in the shared tool_state table
   (tool = 'konsultkalkyl'), with a localStorage write-through cache for offline.
   No new SQL table — reuses tool_state. Exported signatures unchanged, so
   Konsultkalkyl.tsx is untouched. supabase-js never throws — it returns
   { data, error } — so reads fall back to the cache and the fire-and-forget save
   swallows failures.

   Key-split (as the other stores): STORAGE_KEY (the pre-Supabase blob) becomes a
   read-only import source + backup; a NEW *_cache key holds the write-through
   cache, so the cache write can't clobber the legacy blob before the import. */

import { defaultInputs, type KonsultInputs } from './konsult'
import { supabase } from './supabase'

export const STORAGE_KEY = 'bostadskalkyl_konsult_v1'
const CACHE_KEY = 'bostadskalkyl_konsult_cache_v1'
const IMPORT_FLAG = 'bostadskalkyl_konsult_supabase_imported'
const STATE = 'tool_state'
const TOOL = 'konsultkalkyl'

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

function _readCache(): KonsultInputs | null {
  try { const raw = localStorage.getItem(CACHE_KEY); return raw ? _merge(JSON.parse(raw)) : null } catch { return null }
}
function _writeCache(inputs: KonsultInputs): void {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(inputs)) } catch { /* quota */ }
}
function _readLegacy(): KonsultInputs | null {
  try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? _merge(JSON.parse(raw)) : null } catch { return null }
}

// First-login import (one-time, idempotent): seed the tool_state blob from the
// legacy localStorage blob, but only if no cloud row exists yet (so a partner's
// saved inputs aren't clobbered). On error, leave the flag unset to retry.
let _importOnce: Promise<void> | null = null
function _importLocalOnce(): Promise<void> {
  if (_importOnce) return _importOnce
  _importOnce = (async () => {
    let already = true
    try { already = localStorage.getItem(IMPORT_FLAG) === '1' } catch { already = false }
    if (already) return
    const legacy = _readLegacy()
    if (legacy) {
      const { data, error: selErr } = await supabase.from(STATE).select('tool').eq('tool', TOOL).maybeSingle()
      if (selErr) { _importOnce = null; return }
      if (!data) {
        const { error } = await supabase.from(STATE).upsert({ tool: TOOL, data: legacy }, { onConflict: 'household_id,tool' })
        if (error) { _importOnce = null; return }
      }
    }
    try { localStorage.setItem(IMPORT_FLAG, '1') } catch { /* ignore */ }
  })()
  return _importOnce
}

// Read the persisted inputs. Runs the one-time import first, then reads cloud;
// on error serves the cache. null = nothing stored yet (caller keeps defaults).
export async function load(): Promise<KonsultInputs | null> {
  await _importLocalOnce()
  const { data, error } = await supabase.from(STATE).select('data').eq('tool', TOOL).maybeSingle()
  if (error) return _readCache()
  if (!data) return null
  const inputs = _merge(data.data)
  if (inputs) _writeCache(inputs)
  return inputs
}

// Persist the whole inputs blob. Optimistic cache, then upsert. Never rejects —
// the caller fires this and forgets; offline edits live on in the cache.
export async function save(inputs: KonsultInputs): Promise<void> {
  _writeCache(inputs)
  try { await supabase.from(STATE).upsert({ tool: TOOL, data: inputs }, { onConflict: 'household_id,tool' }) } catch { /* offline */ }
}
