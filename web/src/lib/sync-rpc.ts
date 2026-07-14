import { supabase } from './supabase'
import { syncCoordinator } from './sync'
import type { RevisionMap, SyncOperation } from './sync-coordinator'

export interface RevisionedRow {
  id?: unknown
  revision?: unknown
}

interface SyncRpcResult {
  status?: unknown
  revisions?: unknown
}

export async function receiptRpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> {
  const first = await supabase.rpc(name, args)
  const error = first.error as { status?: number; message?: string } | null
  if (!error || (error.status !== 0 && !/fetch|network|offline/i.test(error.message ?? ''))) return first
  // The transaction may have committed before the response was lost. One
  // immediate retry uses the same operation id, so the durable receipt makes
  // it a read, not a second mutation. A genuinely offline client still fails.
  return supabase.rpc(name, args)
}

export function revisionKey(resource: string, id: string): string {
  return `${resource}:${id}`
}

export function expectedRevisions(resource: string, ids: string[]): RevisionMap {
  return Object.fromEntries(ids.map((id) => {
    const key = revisionKey(resource, id)
    return [key, syncCoordinator.getRevision(key)]
  }))
}

export function rememberRowRevisions(resource: string, rows: RevisionedRow[]): void {
  const revisions: RevisionMap = {}
  for (const row of rows) {
    if (typeof row.id !== 'string' || !row.id) continue
    const revision = Number(row.revision)
    if (Number.isSafeInteger(revision) && revision > 0) revisions[revisionKey(resource, row.id)] = revision
  }
  if (Object.keys(revisions).length) syncCoordinator.recordRevisions(revisions)
}

export function rememberToolRevision(tool: string, row: { revision?: unknown } | null | undefined): void {
  const revision = Number(row?.revision)
  if (Number.isSafeInteger(revision) && revision > 0) {
    syncCoordinator.recordRevisions({ [revisionKey('tool_state', tool)]: revision })
  }
}

function parseRevisionMap(raw: unknown): RevisionMap | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const revisions: RevisionMap = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!key) return null
    if (value === null) revisions[key] = null
    else {
      const revision = Number(value)
      if (!Number.isSafeInteger(revision) || revision <= 0) return null
      revisions[key] = revision
    }
  }
  return revisions
}

export function syncRpcResult(data: unknown): { revisions: RevisionMap } {
  const result = (data && typeof data === 'object' ? data : {}) as SyncRpcResult
  const revisions = parseRevisionMap(result.revisions)
  if (!revisions) throw { status: 500, message: 'Malformed sync response' }
  if (result.status === 'conflict') {
    throw { status: 409, message: 'revision conflict', currentRevisions: revisions }
  }
  if (result.status !== 'applied') throw { status: 500, message: 'Malformed sync response' }
  return { revisions }
}

/** Plan 97 entries have no trusted base revision. Read current revisions only
 * to make their conflict recoverable; never dispatch their mutation. */
export async function rejectLegacyRowOperation(operation: SyncOperation, resource: string): Promise<void> {
  if (operation.expectedRevisions !== undefined) return
  const ids = operation.entityIds
  const { data, error } = await supabase.from(resource).select('id,revision').in('id', ids)
  if (error) throw error
  const current: RevisionMap = Object.fromEntries(ids.map((id) => [revisionKey(resource, id), null]))
  for (const row of (data ?? []) as Array<{ id?: unknown; revision?: unknown }>) {
    if (typeof row.id !== 'string') continue
    const revision = Number(row.revision)
    if (Number.isSafeInteger(revision) && revision > 0) current[revisionKey(resource, row.id)] = revision
  }
  throw { status: 409, message: 'legacy operation has no base revision', currentRevisions: current }
}

export async function rejectLegacyToolOperation(operation: SyncOperation, tool: string): Promise<void> {
  if (operation.expectedRevisions !== undefined) return
  const key = revisionKey('tool_state', tool)
  const { data, error } = await supabase.from('tool_state').select('revision').eq('tool', tool).maybeSingle()
  if (error) throw error
  const revision = Number((data as { revision?: unknown } | null)?.revision)
  throw {
    status: 409,
    message: 'legacy operation has no base revision',
    currentRevisions: { [key]: Number.isSafeInteger(revision) && revision > 0 ? revision : null },
  }
}
