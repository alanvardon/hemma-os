// vindsplanen-store.ts — persistence for Vindsplanen. Household-scoped
// `attic_plans` rows, one per plan variant (plan 149), each holding the whole
// plan as a PlanV2 jsonb document, with a scoped durable cache/outbox.
// Modelled on huskalendern-store: writes go through the shared sync outbox
// (sync_apply_rows / sync_delete_rows, revision-checked, receipt-backed); save
// errors surface via throw so the route can toast them; a failed save stays
// dirty for replay.
//
// Data-safety rules (plan 140 / plan 43 / plan 149):
// * Every read runs `plan` through sanitizePlan. A cloud row that fails is
//   returned in `invalid` and is NEVER written back, cached, deleted, or used
//   as the base revision for a save — savePlan/deletePlan refuse its id.
// * A revision conflict is surfaced, never merged: savePlan rejects with a
//   PersistenceError('conflict') and the operation stays in the outbox as a
//   failed conflict (syncCoordinator.getConflicts()). Conflicts are per row:
//   pendingConflict/takeTheirs/keepMine take the open variant's id, so a
//   conflict on one variant never resolves or blocks another.
// * A delete is all-or-nothing from the user's point of view: the row leaves
//   the cache only after the server applied the delete. A failed delete
//   throws, keeps the row, and its operation is dropped from the outbox so it
//   can never replay later behind the user's back. Deleted ids are
//   tombstoned server-side and never re-used (duplicates get a fresh uuid).
// * The cache is ONE envelope `{ version: 2, rows }` rewritten row-by-row.
//   Row writes rebase on the RAW cached rows (PR #332 landmine): sibling rows
//   are preserved verbatim, validation happens only when serving reads. The
//   plan-140 single-row envelope `{ version: 1, row }` is read as `[row]`.
//
// supabase-js returns { data, error } (never throws) — reads fall back to the
// cache, writes surface via throw (toPersistenceError).

import { sanitizePlan, type PlanV2 } from './vindsplanen/plan'
import { genId } from './id'
import { PersistenceError, toPersistenceError } from './persistence-error'
import { supabase } from './supabase'
import { SYNC_STATUS_EVENT, syncCoordinator } from './sync'
import type { SyncOperation } from './sync-coordinator'
import { cachedTombstoneIds, loadTombstoneIds, queueTableDelete, queueTableUpsert, registerTableSync } from './sync-table'
import { rememberRowRevisions } from './sync-rpc'

const CACHE_KEY = 'vindsplanen_attic_plans_cache_v1'
const TABLE = 'attic_plans'
const RESOURCE = TABLE
const VERSION = 2
const DEFAULT_NAME = 'Vindsplanen'
/** attic_plans.name check constraint: char_length between 1 and 80. */
export const MAX_PLAN_NAME = 80

export interface AtticPlanRow {
  id: string
  name: string
  schema_version: 2
  plan: PlanV2
  created_at: string
}

/** A stored row whose `plan` failed sanitizePlan. `raw` is that stored `plan` value. */
export interface InvalidPlanRow {
  id: string
  raw: unknown
}

export interface LoadPlansResult {
  /** Sanitized variants, oldest first (created_at, then id). */
  rows: AtticPlanRow[]
  /** True when the cloud was not read (dirty outbox, offline, or a cloud error). */
  fromCache: boolean
  /** Rows that failed validation. Never cached, saved over, or deleted. */
  invalid: InvalidPlanRow[]
}

/** Single-plan view of loadPlans(): the oldest row. Kept for the pre-variant editor. */
export interface LoadPlanResult {
  /** The sanitized plan row; null when there is none (or the oldest is invalid). */
  row: AtticPlanRow | null
  /** True when the cloud was not read (dirty outbox, offline, or a cloud error). */
  fromCache: boolean
  /** The raw `plan` value of an oldest row that failed sanitizePlan. Never saved over. */
  invalid?: unknown
}

type Scope = ReturnType<typeof syncCoordinator.captureScope>

type Entry =
  | { kind: 'row'; row: AtticPlanRow }
  | { kind: 'invalid'; id: string; raw: unknown; created_at: string }

interface Loaded { entries: Entry[]; fromCache: boolean }

// Ids that held an unreadable plan in this session. savePlan/deletePlan
// refuse them so an invalid row is never overwritten or removed.
const invalidIds = new Set<string>()
// Ids deleted in this session. savePlan refuses them so a late debounced save
// cannot queue a doomed write against a tombstoned row.
const deletedIds = new Set<string>()

function rawId(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const id = (raw as Record<string, unknown>).id
  return typeof id === 'string' && id ? id : null
}

/** Validate a loaded row (cloud or cache). null = not a usable plan row. */
function toRow(raw: unknown): AtticPlanRow | null {
  const id = rawId(raw)
  if (!id) return null
  const r = raw as Record<string, unknown>
  const plan = sanitizePlan(r.plan)
  if (!plan) return null
  return {
    id,
    name: typeof r.name === 'string' && r.name ? r.name : DEFAULT_NAME,
    schema_version: 2,
    plan,
    created_at: typeof r.created_at === 'string' && r.created_at ? r.created_at : new Date().toISOString(),
  }
}

function toEntry(raw: unknown): Entry | null {
  const row = toRow(raw)
  if (row) return { kind: 'row', row }
  const id = rawId(raw)
  if (!id) return null
  const r = raw as Record<string, unknown>
  return { kind: 'invalid', id, raw: r.plan, created_at: typeof r.created_at === 'string' ? r.created_at : '' }
}

const entryId = (e: Entry) => (e.kind === 'row' ? e.row.id : e.id)
const entryCreated = (e: Entry) => (e.kind === 'row' ? e.row.created_at : e.created_at)

function sortEntries(entries: Entry[]): Entry[] {
  return entries.slice().sort((a, b) =>
    entryCreated(a).localeCompare(entryCreated(b)) || entryId(a).localeCompare(entryId(b)))
}

// Only a cloud read may clear an id: the cache never holds an unreadable
// cloud row, so a valid cached copy says nothing about the cloud's version.
function track(entries: Entry[], fromCloud: boolean): void {
  for (const e of entries) {
    if (e.kind === 'invalid') invalidIds.add(e.id)
    else if (fromCloud) invalidIds.delete(e.row.id)
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
/**
 * The cached rows exactly as stored — the WRITE BASE for every row write.
 * Migrates the plan-140 envelope `{ version: 1, row }` to `[row]`; anything
 * unreadable is `[]`. Never validates or drops entries (PR #332).
 */
function _readCacheRaw(scope: Scope): unknown[] {
  try {
    const text = scope.read(CACHE_KEY)
    if (!text) return []
    const env = JSON.parse(text) as unknown
    if (!env || typeof env !== 'object' || Array.isArray(env)) return []
    const e = env as Record<string, unknown>
    if (Array.isArray(e.rows)) return e.rows.slice()
    if ('row' in e) return e.row == null ? [] : [e.row]
    return []
  } catch { return [] }
}

function _writeCacheRows(scope: Scope, rows: unknown[]): void {
  try { scope.write(CACHE_KEY, JSON.stringify({ version: VERSION, rows })) }
  catch { /* private mode / quota — cache is best-effort */ }
}

/** Rewrite one row of the cache (or drop it with `next === null`), siblings verbatim. */
function _patchCacheRow(scope: Scope, id: string, next: AtticPlanRow | null): void {
  const rows = _readCacheRaw(scope)
  const index = rows.findIndex((raw) => rawId(raw) === id)
  if (next === null) {
    if (index < 0) return
    _writeCacheRows(scope, rows.filter((raw) => rawId(raw) !== id))
    return
  }
  if (index >= 0) rows[index] = next
  else rows.push(next)
  _writeCacheRows(scope, rows)
}

/** The validated read view of the cache. */
function cacheLoaded(scope: Scope): Loaded {
  const tombstones = cachedTombstoneIds(scope, RESOURCE)
  const seen = new Set<string>()
  const entries: Entry[] = []
  for (const raw of _readCacheRaw(scope)) {
    const entry = toEntry(raw)
    if (!entry) continue
    const id = entryId(entry)
    if (seen.has(id) || tombstones.has(id) || deletedIds.has(id)) continue
    seen.add(id)
    entries.push(entry)
  }
  track(entries, false)
  return { entries: sortEntries(entries), fromCache: true }
}

function toPlans({ entries, fromCache }: Loaded): LoadPlansResult {
  const rows: AtticPlanRow[] = []
  const invalid: InvalidPlanRow[] = []
  for (const e of entries) {
    if (e.kind === 'row') rows.push(e.row)
    else invalid.push({ id: e.id, raw: e.raw })
  }
  return { rows, fromCache, invalid }
}

function toSingle({ entries, fromCache }: Loaded): LoadPlanResult {
  const first = entries[0]
  if (!first) return { row: null, fromCache }
  if (first.kind === 'invalid') return { row: null, fromCache, invalid: first.raw }
  return { row: first.row, fromCache }
}

/** Synchronous snapshot of the write-through cache for a first paint, oldest first. */
export function cachedSnapshot(): AtticPlanRow[] {
  return toPlans(cacheLoaded(syncCoordinator.captureScope())).rows
}

registerTableSync(RESOURCE, TABLE)

/** A fresh, unsaved row for a plan (first save, import, or example). */
export function newPlanRow(plan: PlanV2, name = DEFAULT_NAME): AtticPlanRow {
  return { id: genId('attic'), name, schema_version: 2, plan, created_at: new Date().toISOString() }
}

/** Trimmed variant name, or null when empty or longer than the column allows. */
export function normalizePlanName(input: string): string | null {
  const name = typeof input === 'string' ? input.trim() : ''
  return name && name.length <= MAX_PLAN_NAME ? name : null
}

/** "<name> (copy)", shortening the base name so the result fits MAX_PLAN_NAME. */
export function copyName(name: string): string {
  const suffix = ' (copy)'
  const base = (typeof name === 'string' && name.trim() ? name.trim() : DEFAULT_NAME)
    .slice(0, MAX_PLAN_NAME - suffix.length).trimEnd()
  return base + suffix
}

/**
 * An unsaved copy of a variant: always a NEW id (a deleted id is tombstoned
 * and must never be re-used), a fresh created_at, and a deep copy of the plan.
 */
export function duplicatePlanRow(source: AtticPlanRow, name = copyName(source.name)): AtticPlanRow {
  return newPlanRow(JSON.parse(JSON.stringify(source.plan)) as PlanV2, name)
}

async function _load(): Promise<Loaded> {
  const scope = syncCoordinator.captureScope()
  if (!scope.isActive() || syncCoordinator.isDirty(RESOURCE)) return cacheLoaded(scope)
  const [result, tombstones] = await Promise.all([
    supabase.from(TABLE).select('*').order('created_at', { ascending: true }),
    loadTombstoneIds(scope, RESOURCE),
  ])
  if (!scope.isActive() || syncCoordinator.isDirty(RESOURCE)) return cacheLoaded(scope)
  if (result.error || !Array.isArray(result.data)) return cacheLoaded(scope)
  const entries: Entry[] = []
  const validRaw: Record<string, unknown>[] = []
  for (const raw of result.data as Record<string, unknown>[]) {
    const entry = toEntry(raw)
    if (!entry || tombstones.has(entryId(entry))) continue
    entries.push(entry)
    if (entry.kind === 'row') validRaw.push(raw)
  }
  track(entries, true)
  // Never cache, or remember the revision of, an unreadable row.
  rememberRowRevisions(RESOURCE, validRaw)
  const sorted = sortEntries(entries)
  _writeCacheRows(scope, sorted.flatMap((e) => (e.kind === 'row' ? [e.row] : [])))
  return { entries: sorted, fromCache: false }
}

/**
 * Load every plan variant of the household, oldest first. Cache-first while
 * this resource has queued local writes (the outbox is the newer truth);
 * otherwise reads the cloud, falling back to the cache on error.
 */
export async function loadPlans(): Promise<LoadPlansResult> {
  return toPlans(await _load())
}

/**
 * The oldest variant only — exactly the pre-plan-149 single-plan behaviour.
 * Prefer loadPlans() + the route's active-variant choice.
 */
export async function loadPlan(): Promise<LoadPlanResult> {
  return toSingle(await _load())
}

/**
 * Save the whole plan document of one variant. Applies to that variant's
 * cache entry once durably queued (siblings untouched), then replays. Throws
 * a PersistenceError on failure; the edit stays dirty for replay (or, for
 * category 'conflict', until takeTheirs/keepMine).
 */
export async function savePlan(row: AtticPlanRow): Promise<void> {
  if (!row || typeof row.id !== 'string' || !row.id || invalidIds.has(row.id) || deletedIds.has(row.id)) {
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
  if (cachedTombstoneIds(scope, RESOURCE).has(saved.id)) throw new PersistenceError('validation')
  await queueTableUpsert(RESOURCE, [_row(saved)], [saved.id], () => { _patchCacheRow(scope, saved.id, saved) })
}

/**
 * Delete one variant. The row leaves the cache only after the server applied
 * the delete. On failure (offline, a revision conflict, or a server without
 * the attic_plans delete arm — 22023 → 'validation') this throws a
 * PersistenceError, the row stays in the cache, and the delete is removed
 * from the outbox so it never replays later.
 */
export async function deletePlan(id: string): Promise<void> {
  if (typeof id !== 'string' || !id || invalidIds.has(id)) throw new PersistenceError('validation')
  const scope = syncCoordinator.captureScope()
  let operationId: string | null = null
  try {
    await queueTableDelete(RESOURCE, [id], (operation) => { operationId = operation.id })
  } catch (error) {
    if (operationId && scope.isActive()) syncCoordinator.discardOperation(operationId)
    throw toPersistenceError(error)
  }
  if (!scope.isActive()) return
  deletedIds.add(id)
  _patchCacheRow(scope, id, null)
}

// ── Conflicts ──────────────────────────────────────────────────────────────
/** True when a save rejected because the partner saved a newer revision. */
export function isConflictError(error: unknown): boolean {
  return toPersistenceError(error).category === 'conflict'
}

const isPlanConflict = (op: SyncOperation, id?: string) =>
  op.resource === RESOURCE && (id === undefined || op.entityIds.includes(id))

/**
 * The outstanding revision conflict for one variant (`id`), or for any
 * variant when `id` is omitted.
 */
export function pendingConflict(id?: string): SyncOperation | null {
  return syncCoordinator.getConflicts().find((op) => isPlanConflict(op, id)) ?? null
}

/**
 * Notify on every sync status change (the shared SYNC_STATUS_EVENT) with the
 * current conflict for variant `id` (any variant when omitted). Returns an
 * unsubscribe function.
 */
export function onConflictChange(listener: (conflict: SyncOperation | null) => void, id?: string): () => void {
  if (typeof window === 'undefined') return () => undefined
  const handler = () => listener(pendingConflict(id))
  window.addEventListener(SYNC_STATUS_EVENT, handler)
  return () => window.removeEventListener(SYNC_STATUS_EVENT, handler)
}

/**
 * "Load theirs": drop the conflicting local edits of variant `id` (every
 * variant when omitted) and reload. Other variants' conflicts are kept, in
 * which case the reload is served from the cache.
 */
export async function takeTheirs(id?: string): Promise<LoadPlansResult> {
  for (const op of syncCoordinator.getConflicts()) {
    if (isPlanConflict(op, id)) syncCoordinator.reloadConflict(op.id)
  }
  return loadPlans()
}

/**
 * "Keep mine": re-send variant `id`'s local plan (the first conflicted
 * variant when omitted) with the server's new revision as its base. Throws if
 * it still does not land (e.g. the partner saved again, which surfaces as a
 * fresh conflict).
 */
export async function keepMine(id?: string): Promise<void> {
  const conflict = pendingConflict(id)
  if (!conflict) return
  await syncCoordinator.keepConflict(conflict.id)
  const retained = syncCoordinator.getOutbox().find((op) => op.id === conflict.id)
  if (retained) throw new PersistenceError(retained.lastErrorCategory ?? 'unknown')
}
