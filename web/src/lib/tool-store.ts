/* tool-store.ts — factory for the single-blob `tool_state` persistence pattern
   shared by Konsultkalkyl, Löneväxling and Hushållsbudget. Each of those tools
   persists its whole state object as ONE row in the shared `tool_state` table
   (keyed by (household_id, tool)), with a localStorage write-through cache for
   offline and a one-time first-login import from the pre-Supabase blob.

   supabase-js never throws — it returns { data, error } — so reads fall back to
   the cache on error and writes swallow failures; the cache carries offline
   edits until the next successful save. This is the extraction of the
   previously-triplicated `_readCache`/`_writeCache`/`_readLegacy`/
   `_importLocalOnce`/`load`/`save` skeleton; only the per-tool `merge`
   (validate/migrate) function and the three key strings differ between tools.

   The row-based stores (mortgage-store, manadsavslut-store) and the list store
   (salary-store) do NOT use this factory — their table shapes and import
   models differ enough that forcing them through here would obscure both. */

import { supabase } from './supabase'
import { makeImportOnce } from './store-helpers'

export interface ToolStateStoreConfig<T> {
  /** `tool_state.tool` discriminator, e.g. 'konsultkalkyl'. */
  tool: string
  /** Pre-Supabase localStorage blob — read-only import source + backup. */
  storageKey: string
  /** Write-through offline cache key (kept distinct from storageKey so the
   *  cache write can't clobber the legacy blob before the import). */
  cacheKey: string
  /** One-time-import guard flag key. */
  importFlag: string
  /** Table holding the blob; defaults to the shared 'tool_state'. */
  table?: string
  /** Validate/migrate a raw stored value into T, or null if unusable. Runs on
   *  cloud, cache and legacy blobs alike, so it must be idempotent. */
  merge: (raw: unknown) => T | null
}

export interface ToolStateStore<T> {
  load(): Promise<T | null>
  save(data: T): Promise<void>
  readCache(): T | null
  writeCache(data: T): void
  readLegacy(): T | null
  importLocalOnce(): Promise<void>
}

export function createToolStateStore<T>(cfg: ToolStateStoreConfig<T>): ToolStateStore<T> {
  const table = cfg.table ?? 'tool_state'
  const { tool, storageKey, cacheKey, importFlag, merge } = cfg

  function readCache(): T | null {
    try { const raw = localStorage.getItem(cacheKey); return raw ? merge(JSON.parse(raw)) : null } catch { return null }
  }
  function writeCache(data: T): void {
    try { localStorage.setItem(cacheKey, JSON.stringify(data)) } catch { /* private mode / quota — cache is best-effort */ }
  }
  function readLegacy(): T | null {
    try { const raw = localStorage.getItem(storageKey); return raw ? merge(JSON.parse(raw)) : null } catch { return null }
  }

  // First-login import (one-time, idempotent): seed the tool_state blob from the
  // legacy localStorage blob, but ONLY if no cloud row exists yet (so a
  // partner's saved state is never clobbered).
  const importLocalOnce = makeImportOnce(importFlag, async () => {
    const legacy = readLegacy()
    if (!legacy) return true
    const { data, error: selErr } = await supabase.from(table).select('tool').eq('tool', tool).maybeSingle()
    if (selErr) return false
    if (!data) {
      const { error } = await supabase.from(table).upsert({ tool, data: legacy }, { onConflict: 'household_id,tool' })
      if (error) return false
    }
    return true
  })

  // Read the persisted blob. Runs the one-time import first (so a seeded blob
  // appears in this very call), then reads cloud; on error serves the cache.
  // null = nothing stored yet (caller keeps its defaults).
  async function load(): Promise<T | null> {
    await importLocalOnce()
    const { data, error } = await supabase.from(table).select('data').eq('tool', tool).maybeSingle()
    if (error) return readCache()
    if (!data) return null
    const merged = merge(data.data)
    if (merged) writeCache(merged)
    return merged
  }

  // Persist the whole blob. Optimistic cache, then upsert (household_id fills
  // from the column default; conflict key = (household_id, tool)). Never rejects
  // — the caller fires this and forgets; an offline write lives on in the cache
  // until the next successful save.
  async function save(data: T): Promise<void> {
    writeCache(data)
    try { await supabase.from(table).upsert({ tool, data }, { onConflict: 'household_id,tool' }) } catch { /* offline */ }
  }

  return { load, save, readCache, writeCache, readLegacy, importLocalOnce }
}
