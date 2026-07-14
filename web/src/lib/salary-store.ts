/* salary-store.ts — append-only log of monthly salary submissions.
   Data-access module for the Hushållsbudget pot. Phase 16b: reads and writes the
   Supabase `salary_submissions` table, with a scoped durable cache/outbox so
   dirty local rows remain visible until cloud acknowledgement. Every
   exported signature is unchanged, so the call sites in Hushallsbudget.tsx don't
   change. supabase-js never throws — it returns { data, error } — so we check
   `error` and fall back to the cache on reads / surface it on writes.

   Two localStorage keys, deliberately separate (see below):
   - STORAGE_KEY  — the PRE-Supabase history. Now the one-time import SOURCE and a
     permanent backup; never written after the swap. Keeping it distinct from the
     cache is what makes the first-login import safe: the cache write can never
     clobber the original history before it's uploaded.
   - CACHE_KEY    — the write-through offline cache of cloud rows. */

import type { SalarySubmission } from './hushallsbudget'
import { supabase } from './supabase'
import { genId } from './id'
import { makeImportOnce, materializeImport } from './store-helpers'
import { syncCoordinator } from './sync'
import { cachedTombstoneIds, loadTombstoneIds, queueTableDelete, queueTableUpsert, registerTableSync, withoutTombstones } from './sync-table'
import { legacyImportAssignedToActive } from './legacy-data'
import { rememberRowRevisions, revisionKey } from './sync-rpc'

// Legacy pre-Supabase history — import source + backup. (Exported name kept for
// back-compat; it is no longer the cache.)
export const STORAGE_KEY = 'bostadskalkyl_salary_log_v1'
const CACHE_KEY = 'bostadskalkyl_salary_cache_v1'
const IMPORT_FLAG = 'bostadskalkyl_salary_supabase_imported'
const TABLE = 'salary_submissions'
const RESOURCE = TABLE
const VERSION = 2 // v2 adds income_items (itemised income per person)

// Forward-migrate a stored row to the current shape. v1 rows have scalar
// income_a/income_b but no income_items — synthesise a single salary item per
// person so older submissions still render and export with a breakdown.
// Idempotent: a row that already has income_items is returned untouched, so it
// is safe to run on cloud rows (born with income_items) and cached rows alike.
function _migrate(row: SalarySubmission): SalarySubmission {
  if (!row || Array.isArray(row.income_items)) return row
  row.income_items = [
    { owner: 'a', label: 'Lön / Salary', amount: row.income_a || 0 },
    { owner: 'b', label: 'Lön / Salary', amount: row.income_b || 0 },
  ]
  return row
}

// ── localStorage cache (offline fallback) ───────────────────────────────────
function _readCache(): SalarySubmission[] {
  return _readCacheFrom(syncCoordinator.captureScope())
}

function _readCacheFrom(scope: ReturnType<typeof syncCoordinator.captureScope>): SalarySubmission[] {
  try {
    const raw = scope.read(CACHE_KEY)
    if (!raw) return []
    const data = JSON.parse(raw)
    if (!data || !Array.isArray(data.submissions)) return []
    return data.submissions.map(_migrate)
  } catch {
    return []
  }
}

function _writeCache(submissions: SalarySubmission[]): void {
  try {
    syncCoordinator.writeScoped(CACHE_KEY, JSON.stringify({ version: VERSION, submissions }))
  } catch {
    /* private mode / quota — cache is best-effort */
  }
}

// The pre-Supabase history, normalised + guaranteed id/created_at, ready to
// upsert. Read-only: this key is never written after the swap, so the original
// data survives even if every cloud write fails.
function _readLegacy(scope: ReturnType<typeof syncCoordinator.captureScope>): SalarySubmission[] {
  const raw = scope.read(STORAGE_KEY)
  if (!raw) return []
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch { return [] }
  const arr: SalarySubmission[] = Array.isArray(data)
    ? data
    : (data && Array.isArray((data as { submissions?: unknown }).submissions))
      ? (data as { submissions: SalarySubmission[] }).submissions : []
  return materializeImport('salary-legacy', raw, () => arr.map((r) => {
      const row = _migrate({ ...r })
      if (!row.id) row.id = genId('sub')
      if (!row.created_at) row.created_at = new Date().toISOString()
      return row
    }))
}

// Newest first (by created_at). Used for the cache fallback path; the cloud
// query orders server-side.
function _sortedDesc(rows: SalarySubmission[]): SalarySubmission[] {
  return rows.slice().sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
}

// Project a submission down to exactly the table's columns for insert/upsert.
// Crucially this OMITS household_id + updated_at — the column default
// (private.current_household()) and the moddatetime trigger fill those; the
// client must never send them. created_at is always present by the time we
// write (callers stamp it), so including it preserves original dates.
function _row(s: SalarySubmission): Record<string, unknown> {
  return {
    id: s.id,
    created_at: s.created_at,
    month: s.month,
    person_a_name: s.person_a_name ?? null,
    income_a: s.income_a ?? null,
    person_b_name: s.person_b_name ?? null,
    income_b: s.income_b ?? null,
    transfer_from: s.transfer_from ?? null,
    transfer_to: s.transfer_to ?? null,
    transfer_amount: s.transfer_amount ?? null,
    equal_share: s.equal_share ?? null,
    note: s.note ?? null,
    income_items: s.income_items ?? null,
  }
}

// ── First-login import (one-time, idempotent) ───────────────────────────────
// On the first authenticated load after the household exists, upsert the legacy
// localStorage history into the cloud (keyed on id, so re-running adds nothing).
// Runs per-origin/per-device — the real history lives on the live Pages origin,
// so this matters there, not on localhost.
const _importLocalOnce = makeImportOnce(() => syncCoordinator.scopedStorageKey(IMPORT_FLAG), async () => {
  const scope = syncCoordinator.captureScope()
  if (!legacyImportAssignedToActive() || !scope.isActive()) return true
  const legacy = _readLegacy(scope)
  if (!legacy.length) return true
  if (!scope.isActive()) return false
  try {
    await syncCoordinator.mutateBatch([{
      resource: RESOURCE,
      operation: 'upsert',
      payload: { rows: legacy.map(_row), seed: true },
      entityIds: legacy.map((row) => row.id!),
      expectedRevisions: Object.fromEntries(legacy.map((row) => [revisionKey(RESOURCE, row.id!), null])),
      applyLocal: () => {
        const ids = new Set(legacy.map((row) => row.id))
        _writeCache(_sortedDesc([...legacy, ..._readCache().filter((row) => !ids.has(row.id))]))
      },
    }])
    return true
  } catch { return false }
})

registerTableSync(RESOURCE, TABLE)

// ── Public API (signatures unchanged) ───────────────────────────────────────

// Every submission, newest first. Runs the one-time legacy import first (so
// imported rows appear in this very call), then reads cloud; on any error
// (offline / RLS / down) serves the last-known cache so the log still renders.
export async function list(): Promise<SalarySubmission[]> {
  const scope = syncCoordinator.captureScope()
  await _importLocalOnce()
  const fallback = () => _sortedDesc(withoutTombstones(_readCacheFrom(scope), cachedTombstoneIds(scope, RESOURCE)))
  if (!scope.isActive() || syncCoordinator.isDirty(RESOURCE)) return fallback()
  const [result, tombstones] = await Promise.all([
    supabase.from(TABLE).select('*').order('created_at', { ascending: false }),
    loadTombstoneIds(scope, RESOURCE),
  ])
  if (!scope.isActive() || syncCoordinator.isDirty(RESOURCE)) return fallback()
  if (result.error || !result.data) return fallback()
  rememberRowRevisions(RESOURCE, result.data as Record<string, unknown>[])
  const rows = withoutTombstones((result.data as SalarySubmission[]).map(_migrate), tombstones)
  if (scope.isActive()) scope.write(CACHE_KEY, JSON.stringify({ version: VERSION, submissions: rows }))
  return rows
}

// Append one record. The stable id/timestamp and operation are durably queued
// before the optimistic cache patch. A failed replay remains visibly dirty and
// retryable; only server acknowledgement clears the operation.
export async function add(record: SalarySubmission): Promise<SalarySubmission> {
  const saved: SalarySubmission = {
    ...record,
    id: record.id || genId('sub'),
    created_at: record.created_at || new Date().toISOString(),
  }
  await queueTableUpsert(RESOURCE, [_row(saved)], [saved.id!], () => {
    _writeCache([saved, ..._readCache().filter((r) => r.id !== saved.id)])
  })
  return saved
}

// Drop one record by id; resolves the remaining (cached) count.
export async function remove(id: string): Promise<number> {
  const rows = _readCache().filter((r) => r.id !== id)
  await queueTableDelete(RESOURCE, [id], () => _writeCache(rows))
  return rows.length
}

// Pretty-printed export of the whole log, shaped for migration/backup.
export async function exportJSON(): Promise<string> {
  const submissions = await list()
  return JSON.stringify({ version: VERSION, submissions }, null, 2)
}

// Merge submissions from a previously-exported JSON string (the { version,
// submissions } envelope or a bare array) into the cloud. Deduped by id against
// what's already there, so re-importing the same backup is idempotent — a
// restore, not a wipe. Resolves the number of NEW rows added; rejects on
// unparseable input.
export async function importJSON(text: string): Promise<number> {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new Error('That file isn’t valid JSON.') }
  const incoming: SalarySubmission[] | null = Array.isArray(parsed)
    ? (parsed as SalarySubmission[])
    : (parsed && Array.isArray((parsed as { submissions?: unknown }).submissions))
      ? ((parsed as { submissions: SalarySubmission[] }).submissions)
      : null
  if (!incoming) throw new Error('No submissions found in that file.')

  const scope = syncCoordinator.captureScope()
  const normalized = materializeImport('salary-backup', text, () => incoming
    .filter((raw) => !!raw && typeof raw === 'object')
    .map((raw) => {
      const row = _migrate({ ...raw })
      if (!row.id) row.id = genId('sub')
      if (!row.created_at) row.created_at = new Date().toISOString()
      return row
    }))

  const existing = await list()
  if (!scope.isActive()) throw new Error('Sync identity changed during salary import')
  const seen = new Set(existing.map((r) => r.id))

  const toAdd: SalarySubmission[] = []
  normalized.forEach((row) => {
    if (seen.has(row.id)) return // already have it — skip (idempotent restore)
    seen.add(row.id)
    toAdd.push(row)
  })

  if (toAdd.length) {
    await syncCoordinator.mutate({
      resource: RESOURCE, operation: 'upsert', payload: { rows: toAdd.map(_row), seed: true },
      entityIds: toAdd.map((row) => row.id!),
      expectedRevisions: Object.fromEntries(toAdd.map((row) => [revisionKey(RESOURCE, row.id!), null])),
      applyLocal: () => {
        _writeCache(_sortedDesc([...toAdd, ..._readCache()]))
      },
    })
  }
  return toAdd.length
}

// One CSV field: quote + double up inner quotes when it holds a comma, quote
// or newline (RFC 4180).
function _csvCell(v: unknown): string {
  const s = (v === null || v === undefined) ? '' : String(v)
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

// Flat, spreadsheet-friendly export of the scalar summary columns (the
// itemised income breakdown stays in the JSON export). Newest first.
export async function exportCSV(): Promise<string> {
  const cols = ['month', 'created_at', 'person_a_name', 'income_a', 'person_b_name',
    'income_b', 'transfer_from', 'transfer_to', 'transfer_amount', 'equal_share', 'note']
  const lines = [cols.join(',')]
  const rows = await list()
  rows.forEach((r) => {
    lines.push(cols.map((c) => _csvCell((r as unknown as Record<string, unknown>)[c])).join(','))
  })
  return Promise.resolve(lines.join('\r\n'))
}
