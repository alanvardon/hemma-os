// vindsplanen-store.ts — persistence for Vindsplanen. One household-scoped
// `attic_plans` row holding the whole plan as a PlanV2 jsonb document, with a
// scoped durable cache/outbox. Modelled on huskalendern-store:
// writes go through the shared sync outbox (sync_apply_rows, revision-checked,
// receipt-backed); save errors surface via throw so the route can toast them;
// a failed write stays dirty for replay.
//
// Data-safety rules (plan 140 / plan 43):
// * Every read runs `plan` through sanitizePlan. A cloud row that fails is
//   returned as `invalid` and is NEVER written back, cached, or used as the
//   base revision for a save — savePlan refuses its id.
// * A revision conflict is surfaced, never merged: savePlan rejects with a
//   PersistenceError('conflict') and the operation stays in the outbox as a
//   failed conflict (syncCoordinator.getConflicts()). The route resolves it
//   with takeTheirs() (drop local, reload cloud) or keepMine() (re-save over
//   the server's new revision) — thin wrappers over the coordinator's
//   existing reloadConflict/keepConflict.
// * No delete path exists (reset-to-example is a save), so no tombstones.
//
// supabase-js returns { data, error } (never throws) — reads fall back to the
// cache, writes surface via throw (toPersistenceError).

import { sanitizePlan, type PlanV2 } from './vindsplanen/plan'
import { genId } from './id'
import { PersistenceError, toPersistenceError } from './persistence-error'
import { supabase } from './supabase'
import { SYNC_STATUS_EVENT, syncCoordinator } from './sync'
import type { SyncOperation } from './sync-coordinator'
import { queueTableUpsert, registerTableSync } from './sync-table'
import { rememberRowRevisions } from './sync-rpc'

const CACHE_KEY = 'vindsplanen_attic_plans_cache_v1'
const TABLE = 'attic_plans'
const RESOURCE = TABLE
const VERSION = 1
const DEFAULT_NAME = 'Vindsplanen'

export interface AtticPlanRow {
  id: string
  name: string
  schema_version: 2
  plan: PlanV2
  created_at: string
}

export interface LoadPlanResult {
  /** The sanitized plan row; null when there is none (or it is invalid). */
  row: AtticPlanRow | null
  /** True when the cloud was not read (dirty outbox, offline, or a cloud error). */
  fromCache: boolean
  /** The raw `plan` value of a row that failed sanitizePlan. Never saved over. */
  invalid?: unknown
}

interface Envelope { version: number; row: unknown }

type Scope = ReturnType<typeof syncCoordinator.captureScope>

// Cloud ids that held an unreadable plan in this session. savePlan refuses
// them so an invalid row is never overwritten by a derived or reset plan.
const invalidIds = new Set<string>()

/** Validate a loaded row (cloud or cache). null = not a usable plan row. */
function toRow(raw: unknown): AtticPlanRow | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return null
  const plan = sanitizePlan(r.plan)
  if (!plan) return null
  return {
    id: r.id,
    name: typeof r.name === 'string' && r.name ? r.name : DEFAULT_NAME,
    schema_version: 2,
    plan,
    created_at: typeof r.created_at === 'string' && r.created_at ? r.created_at : new Date().toISOString(),
  }
}

// ── Column projector — send exactly the client-owned columns; OMIT
// household_id, updated_at and revision so the column default and the
// set_sync_revision trigger own them. Must match
// private.sync_allowed_row_keys('attic_plans').
function _row(row: AtticPlanRow): Record<string, unknown> {
  return { id: row.id, created_at: row.created_at, name: row.name, schema_version: 2, plan: row.plan }
}

// ── localStorage cache (offline fallback) ───────────────────────────────────
function _readCacheFrom(scope: Scope): { row: AtticPlanRow | null; raw: unknown } {
  try {
    const text = scope.read(CACHE_KEY)
    if (!text) return { row: null, raw: null }
    const env = JSON.parse(text) as Partial<Envelope> | null
    if (!env || typeof env !== 'object' || env.row == null) return { row: null, raw: null }
    return { row: toRow(env.row), raw: env.row }
  } catch { return { row: null, raw: null } }
}

function _writeCache(scope: Scope, row: AtticPlanRow | null): void {
  try { scope.write(CACHE_KEY, JSON.stringify({ version: VERSION, row })) }
  catch { /* private mode / quota — cache is best-effort */ }
}

function cacheResult(scope: Scope): LoadPlanResult {
  const { row, raw } = _readCacheFrom(scope)
  if (row || raw == null) return { row, fromCache: true }
  const plan = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).plan : raw
  return { row: null, fromCache: true, invalid: plan }
}

/** Synchronous snapshot of the write-through cache for a first paint. */
export function cachedSnapshot(): AtticPlanRow | null {
  return _readCacheFrom(syncCoordinator.captureScope()).row
}

registerTableSync(RESOURCE, TABLE)

/** A fresh, unsaved row for a plan (first save, import, or example). */
export function newPlanRow(plan: PlanV2, name = DEFAULT_NAME): AtticPlanRow {
  return { id: genId('attic'), name, schema_version: 2, plan, created_at: new Date().toISOString() }
}

/**
 * Load the household's plan. Cache-first while this resource has queued local
 * writes (the outbox is the newer truth); otherwise reads the cloud, falling
 * back to the cache on error. With several rows (two first saves racing on
 * two devices) the oldest by created_at is the plan.
 */
export async function loadPlan(): Promise<LoadPlanResult> {
  const scope = syncCoordinator.captureScope()
  if (!scope.isActive() || syncCoordinator.isDirty(RESOURCE)) return cacheResult(scope)
  const result = await supabase.from(TABLE).select('*').order('created_at', { ascending: true })
  if (!scope.isActive() || syncCoordinator.isDirty(RESOURCE)) return cacheResult(scope)
  if (result.error || !Array.isArray(result.data)) return cacheResult(scope)
  const rows = result.data as Record<string, unknown>[]
  const raw = rows[0]
  if (!raw) {
    _writeCache(scope, null)
    return { row: null, fromCache: false }
  }
  const row = toRow(raw)
  if (!row) {
    // Never cache, remember the revision of, or overwrite an unreadable row.
    if (typeof raw.id === 'string') invalidIds.add(raw.id)
    return { row: null, fromCache: false, invalid: raw.plan }
  }
  invalidIds.delete(row.id)
  rememberRowRevisions(RESOURCE, [raw])
  _writeCache(scope, row)
  return { row, fromCache: false }
}

/**
 * Save the whole plan document. Applies to the cache once durably queued, then
 * replays. Throws a PersistenceError on failure; the edit stays dirty for
 * replay (or, for category 'conflict', until takeTheirs/keepMine).
 */
export async function savePlan(row: AtticPlanRow): Promise<void> {
  if (!row || typeof row.id !== 'string' || !row.id || invalidIds.has(row.id)) {
    throw new PersistenceError('validation')
  }
  const plan = sanitizePlan(row.plan)
  if (!plan) throw new PersistenceError('validation')
  const saved: AtticPlanRow = {
    id: row.id,
    name: typeof row.name === 'string' && row.name ? row.name : DEFAULT_NAME,
    schema_version: 2,
    plan,
    created_at: row.created_at || new Date().toISOString(),
  }
  const scope = syncCoordinator.captureScope()
  await queueTableUpsert(RESOURCE, [_row(saved)], [saved.id], () => { _writeCache(scope, saved) })
}

// ── Conflicts ──────────────────────────────────────────────────────────────
/** True when a save rejected because the partner saved a newer revision. */
export function isConflictError(error: unknown): boolean {
  return toPersistenceError(error).category === 'conflict'
}

/** The outstanding revision conflict for the plan, if any. */
export function pendingConflict(): SyncOperation | null {
  return syncCoordinator.getConflicts().find((op) => op.resource === RESOURCE) ?? null
}

/**
 * Notify on every sync status change (the shared SYNC_STATUS_EVENT) with the
 * plan's current conflict. Returns an unsubscribe function.
 */
export function onConflictChange(listener: (conflict: SyncOperation | null) => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  const handler = () => listener(pendingConflict())
  window.addEventListener(SYNC_STATUS_EVENT, handler)
  return () => window.removeEventListener(SYNC_STATUS_EVENT, handler)
}

/** "Ladda deras version": drop the conflicting local edits, reload the cloud row. */
export async function takeTheirs(): Promise<LoadPlanResult> {
  for (const op of syncCoordinator.getConflicts()) {
    if (op.resource === RESOURCE) syncCoordinator.reloadConflict(op.id)
  }
  return loadPlan()
}

/**
 * "Behåll min": re-send the local plan with the server's new revision as its
 * base. Throws if it still does not land (e.g. the partner saved again, which
 * surfaces as a fresh conflict).
 */
export async function keepMine(): Promise<void> {
  const conflict = pendingConflict()
  if (!conflict) return
  await syncCoordinator.keepConflict(conflict.id)
  const retained = syncCoordinator.getOutbox().find((op) => op.id === conflict.id)
  if (retained) throw new PersistenceError(retained.lastErrorCategory ?? 'unknown')
}
