import { supabase } from './supabase'
import { syncCoordinator } from './sync'

interface TablePayload {
  rows?: Record<string, unknown>[]
  ids?: string[]
  seed?: boolean
}

const TOMBSTONE_TOOL = 'sync-tombstones-v1'
const TOMBSTONE_CACHE = 'sync-tombstones-cache-v1'
interface TombstoneLedger { version: 1; resources: Record<string, Record<string, string>> }

function parseLedger(raw: unknown): TombstoneLedger | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<TombstoneLedger>
  if (value.version !== 1 || !value.resources || typeof value.resources !== 'object') return null
  return value as TombstoneLedger
}

function cachedLedger(scope: ReturnType<typeof syncCoordinator.captureScope>): TombstoneLedger | null {
  try {
    const raw = scope.read(TOMBSTONE_CACHE)
    return raw ? parseLedger(JSON.parse(raw)) : null
  } catch { return null }
}

export function cachedTombstoneIds(
  scope: ReturnType<typeof syncCoordinator.captureScope>, resource: string,
): Set<string> {
  return new Set(Object.keys(cachedLedger(scope)?.resources?.[resource] ?? {}))
}

export async function loadTombstoneIds(
  scope: ReturnType<typeof syncCoordinator.captureScope>,
  resource: string,
): Promise<Set<string>> {
  const fallback = () => cachedTombstoneIds(scope, resource)
  const { data, error } = await supabase.from('tool_state').select('data').eq('tool', TOMBSTONE_TOOL).maybeSingle()
  if (!scope.isActive() || error) return fallback()
  if (!data) {
    try { scope.write(TOMBSTONE_CACHE, JSON.stringify({ version: 1, resources: {} })) } catch { /* best effort */ }
    return new Set()
  }
  const ledger = parseLedger((data as { data?: unknown }).data)
  if (!ledger) return fallback()
  try { scope.write(TOMBSTONE_CACHE, JSON.stringify(ledger)) } catch { /* best effort */ }
  return new Set(Object.keys(ledger.resources[resource] ?? {}))
}

export function withoutTombstones<T extends { id?: string }>(rows: T[], ids: Set<string>): T[] {
  return rows.filter((row) => !row.id || !ids.has(String(row.id)))
}

export function registerTableSync(resource: string, table: string): void {
  syncCoordinator.register(resource, async (operation) => {
    const payload = operation.payload as TablePayload
    if (operation.operation === 'upsert') {
      if (!Array.isArray(payload?.rows)) throw { status: 400, message: 'Malformed row upsert' }
      if (!payload.rows.length) return
      if (payload.seed === true) {
        for (const row of payload.rows) {
          const { error } = await supabase.from(table).upsert([row], { onConflict: 'id', ignoreDuplicates: true })
          if ((error as { code?: string } | null)?.code === '23505') continue
          if (error) throw error
        }
        return
      }
      const { error } = await supabase.from(table).upsert(payload.rows, {
        onConflict: 'id',
      })
      if (error) throw error
      return
    }
    if (!Array.isArray(payload?.ids) || !payload.ids.every((id) => typeof id === 'string')) {
      throw { status: 400, message: 'Malformed row delete' }
    }
    if (!payload.ids.length) return
    if (table !== resource) throw { status: 500, message: 'Sync resource/table mismatch' }
    const { error } = await supabase.rpc('delete_household_rows', {
      p_resource: resource,
      p_ids: payload.ids,
    })
    if (error) throw error
  }, (operation) => {
    const payload = operation.payload as TablePayload
    if (operation.operation === 'upsert') {
      if (!Array.isArray(payload?.rows) || !payload.rows.every((row) => !!row && typeof row === 'object'
        && typeof row.id === 'string' && !!row.id)
        || (payload.seed !== undefined && typeof payload.seed !== 'boolean')) return false
      const rowIds = payload.rows.map((row) => String(row.id))
      return rowIds.length === operation.entityIds.length && rowIds.every((id, index) => id === operation.entityIds[index])
    }
    return Array.isArray(payload?.ids) && payload.ids.every((id) => typeof id === 'string' && !!id)
      && payload.ids.length === operation.entityIds.length
      && payload.ids.every((id, index) => id === operation.entityIds[index])
  })
}

export async function queueTableUpsert(
  resource: string,
  rows: Record<string, unknown>[],
  entityIds: string[],
  applyLocal: () => void,
): Promise<void> {
  if (!rows.length) { applyLocal(); return }
  await syncCoordinator.mutate({
    resource,
    operation: 'upsert',
    payload: { rows },
    entityIds,
    applyLocal,
  })
}

export async function queueTableDelete(
  resource: string,
  ids: string[],
  applyLocal: () => void,
): Promise<void> {
  const clean = ids.filter(Boolean)
  if (!clean.length) return
  await syncCoordinator.mutate({
    resource,
    operation: 'delete',
    payload: { ids: clean },
    entityIds: clean,
    applyLocal,
  })
}
