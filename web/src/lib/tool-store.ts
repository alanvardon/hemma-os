/* tool-store.ts — factory for the single-blob `tool_state` persistence pattern
   shared by Konsultkalkyl, Löneväxling and Hushållsbudget. Each of those tools
   persists its whole state object as ONE row in the shared `tool_state` table
   (keyed by (household_id, tool)), with a household/user-scoped cache, durable
   operation outbox, and explicit-assignment import from the pre-Supabase blob.

   Reads fall back to the cache on error. Writes retain an optimistic local
   cache but reject explicitly when the cloud does not accept the mutation.
   This is the extraction of the
   previously-triplicated `_readCache`/`_writeCache`/`_readLegacy`/
   `_importLocalOnce`/`load`/`save` skeleton; only the per-tool `merge`
   (validate/migrate) function and the three key strings differ between tools.

   The row-based stores (mortgage-store, manadsavslut-store) and the list store
   (salary-store) do NOT use this factory — their table shapes and import
   models differ enough that forcing them through here would obscure both. */

import { supabase } from './supabase'
import { syncCoordinator } from './sync'
import { makeImportOnce } from './store-helpers'
import { legacyImportAssignedToActive } from './legacy-data'
import { receiptRpc, rejectLegacyToolOperation, rememberToolRevision, revisionKey, syncRpcResult } from './sync-rpc'
import { parseFiniteJson } from './persistence-schema'
import { PersistenceError, reportPersistenceWarning } from './persistence-error'

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
  const resource = `tool_state:${tool}`
  const warnInvalid = (source: string): void => reportPersistenceWarning(`Sparade uppgifter för ${tool} kunde inte läsas från ${source}. Övriga sparade uppgifter finns kvar.`)

  function readCache(): T | null {
    try { const raw = syncCoordinator.readScoped(cacheKey); if (!raw) return null; const data = JSON.parse(raw); if (!parseFiniteJson(data).ok) { warnInvalid('cachen'); return null }; const value = merge(data); if (!value) warnInvalid('cachen'); return value } catch { warnInvalid('cachen'); return null }
  }
  function readCapturedCache(scope: ReturnType<typeof syncCoordinator.captureScope>): T | null | undefined {
    try { const raw = scope.read(cacheKey); if (raw === null) return undefined; const data = JSON.parse(raw); if (!parseFiniteJson(data).ok) { warnInvalid('cachen'); return null }; const value = merge(data); if (!value) { warnInvalid('cachen'); return null }; return value } catch { warnInvalid('cachen'); return null }
  }
  function writeCache(data: T): void {
    syncCoordinator.writeScoped(cacheKey, JSON.stringify(data))
  }
  function readLegacy(): T | null {
    try { const raw = syncCoordinator.readScoped(storageKey); if (!raw) return null; const data = JSON.parse(raw); if (!parseFiniteJson(data).ok) { warnInvalid('säkerhetskopian'); return null }; const value = merge(data); if (!value) warnInvalid('säkerhetskopian'); return value } catch { warnInvalid('säkerhetskopian'); return null }
  }

  const importLocalOnce = makeImportOnce(() => syncCoordinator.scopedStorageKey(importFlag), async () => {
    const scope = syncCoordinator.captureScope()
    if (!legacyImportAssignedToActive() || !scope.isActive()) return true
    // The cache can contain the failed local edit this plan is recovering;
    // the pre-cloud blob is only a fallback backup and may be older.
    const cached = readCapturedCache(scope)
    if (cached === null) return false
    const legacy = cached === undefined ? (() => {
      try { const raw = scope.read(storageKey); if (raw === null) return undefined; const data = JSON.parse(raw); if (!parseFiniteJson(data).ok) { warnInvalid('säkerhetskopian'); return null }; const value = merge(data); if (!value) { warnInvalid('säkerhetskopian'); return null }; return value } catch { warnInvalid('säkerhetskopian'); return null }
    })() : cached
    if (legacy === null) return false
    if (legacy === undefined) return true
    if (!scope.isActive()) return false
    try {
      await syncCoordinator.mutate({
        resource,
        operation: 'upsert',
        payload: { tool, data: legacy, seed: true },
        entityIds: [tool],
        expectedRevisions: { [revisionKey('tool_state', tool)]: syncCoordinator.getRevision(revisionKey('tool_state', tool)) },
        applyLocal: () => scope.write(cacheKey, JSON.stringify(legacy)),
      })
      return true
    } catch { return false }
  })

  syncCoordinator.register(resource, async (operation) => {
    const payload = operation.payload as { tool?: unknown; data?: unknown; seed?: unknown }
    if (!payload || payload.tool !== tool || !('data' in payload)) throw { status: 400, message: 'Malformed tool-state operation' }
    await rejectLegacyToolOperation(operation, tool)
    const { data, error } = await receiptRpc('sync_apply_tool_state', {
      p_operation_id: operation.id,
      p_tool: tool,
      p_data: payload.data,
      p_expected_revision: operation.expectedRevisions?.[revisionKey('tool_state', tool)] ?? null,
      p_seed: payload.seed === true,
    })
    if (error) throw error
    return syncRpcResult(data)
  }, (operation) => {
    const payload = operation.payload as { tool?: unknown; data?: unknown; seed?: unknown }
    return operation.operation === 'upsert' && payload?.tool === tool && Object.prototype.hasOwnProperty.call(payload, 'data')
      && (payload.seed === undefined || typeof payload.seed === 'boolean')
      && operation.entityIds.length === 1 && operation.entityIds[0] === tool
  })

  // Read the persisted blob. Runs the one-time import first (so a seeded blob
  // appears in this very call), then reads cloud; on error serves the cache.
  // null = nothing stored yet (caller keeps its defaults).
  async function load(): Promise<T | null> {
    const scope = syncCoordinator.captureScope()
    await importLocalOnce()
    if (!scope.isActive()) return readCapturedCache(scope) ?? null
    if (syncCoordinator.isDirty(resource)) return readCapturedCache(scope) ?? null
    const { data, error } = await supabase.from(table).select('data,revision').eq('tool', tool).maybeSingle()
    if (!scope.isActive() || syncCoordinator.isDirty(resource)) return readCapturedCache(scope) ?? null
    if (error) return readCapturedCache(scope) ?? null
    if (!data) return null
    rememberToolRevision(tool, data)
    if (!parseFiniteJson(data.data).ok) { warnInvalid('molnet'); return readCapturedCache(scope) ?? null }
    const merged = merge(data.data)
    if (!merged) { warnInvalid('molnet'); return readCapturedCache(scope) ?? null }
    if (merged && scope.isActive()) scope.write(cacheKey, JSON.stringify(merged))
    return merged
  }

  // Persist the whole blob. The local cache remains optimistic, but a rejected
  // cloud write is explicit: cache-only is not the same as saved.
  async function save(data: T): Promise<void> {
    if (!parseFiniteJson(data).ok) throw new PersistenceError('validation')
    await syncCoordinator.mutate({
      resource,
      operation: 'upsert',
      payload: { tool, data },
      entityIds: [tool],
      expectedRevisions: { [revisionKey('tool_state', tool)]: syncCoordinator.getRevision(revisionKey('tool_state', tool)) },
      applyLocal: () => writeCache(data),
    })
  }

  return { load, save, readCache, writeCache, readLegacy, importLocalOnce }
}
