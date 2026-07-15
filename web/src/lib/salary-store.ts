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
import { isRecord, parseFiniteJson, parseISODateTime, parseYearMonth, salvageFiniteJsonRows, type ISODateTime, type PersistedSalarySubmission, type RejectedRecord } from './persistence-schema'
import { reportPersistenceWarning } from './persistence-error'

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

function warning(rejected: RejectedRecord[]): void {
  if (!rejected.length) return
  const count = `${rejected.length} ${rejected.length === 1 ? 'post' : 'poster'}`
  reportPersistenceWarning(`Några sparade löneunderlag kunde inte läsas (${count}). Övriga sparade uppgifter finns kvar.`)
}

export function parseSubmission(raw: unknown): PersistedSalarySubmission | null {
  if (!isRecord(raw) || !parseFiniteJson(raw).ok) return null
  const month = parseYearMonth(raw.month)
  if (!month.ok) return null
  const stringOrNull = (key: string) => raw[key] === undefined || raw[key] === null || typeof raw[key] === 'string'
  const numberOrNull = (key: string) => raw[key] === undefined || raw[key] === null || (typeof raw[key] === 'number' && Number.isFinite(raw[key]))
  if (!stringOrNull('id') || !stringOrNull('created_at') || !stringOrNull('month')
    || !stringOrNull('person_a_name') || !stringOrNull('person_b_name') || !stringOrNull('transfer_from') || !stringOrNull('transfer_to') || !stringOrNull('note')
    || !numberOrNull('income_a') || !numberOrNull('income_b') || !numberOrNull('transfer_amount') || !numberOrNull('equal_share')) return null
  if (raw.id !== undefined && (typeof raw.id !== 'string' || !raw.id.trim())) return null
  const created = raw.created_at === undefined || raw.created_at === null ? null : parseISODateTime(raw.created_at)
  if (created && !created.ok) return null
  if ((raw.transfer_from !== undefined && raw.transfer_from !== 'a' && raw.transfer_from !== 'b')
    || (raw.transfer_to !== undefined && raw.transfer_to !== 'a' && raw.transfer_to !== 'b')) return null
  if (raw.income_items !== undefined && (!Array.isArray(raw.income_items) || raw.income_items.some((item) => !isRecord(item)
    || (item.owner !== 'a' && item.owner !== 'b') || typeof item.label !== 'string' || typeof item.amount !== 'number' || !Number.isFinite(item.amount)))) return null
  const migrated = _migrate({
    month: month.value, income_a: typeof raw.income_a === 'number' ? raw.income_a : 0, income_b: typeof raw.income_b === 'number' ? raw.income_b : 0,
    income_items: Array.isArray(raw.income_items) ? raw.income_items as SalarySubmission['income_items'] : undefined,
    person_a_name: typeof raw.person_a_name === 'string' ? raw.person_a_name : '', person_b_name: typeof raw.person_b_name === 'string' ? raw.person_b_name : '',
    transfer_amount: typeof raw.transfer_amount === 'number' ? raw.transfer_amount : 0, transfer_from: raw.transfer_from === 'b' ? 'b' : 'a', transfer_to: raw.transfer_to === 'a' ? 'a' : 'b',
    equal_share: typeof raw.equal_share === 'number' ? raw.equal_share : 0, note: typeof raw.note === 'string' ? raw.note : null,
    ...(typeof raw.id === 'string' ? { id: raw.id } : {}), ...(typeof raw.created_at === 'string' ? { created_at: raw.created_at } : {}),
  } as unknown as SalarySubmission)
  const result = { ...migrated, month: month.value }
  return created && created.ok ? { ...result, created_at: created.value as ISODateTime } : result as PersistedSalarySubmission
}

function salvageSubmissions(raw: unknown): { value: SalarySubmission[]; rejected: RejectedRecord[] } {
  const base = salvageFiniteJsonRows(raw, 'löneunderlag')
  const value: SalarySubmission[] = []
  base.value.forEach((row, index) => {
    const parsed = parseSubmission(row)
    if (parsed) value.push(parsed); else base.rejected.push({ record: `löneunderlag ${index + 1}`, reason: 'has an invalid field' })
  })
  return { value, rejected: base.rejected }
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
    if (!isRecord(data) || !Array.isArray(data.submissions)) { warning([{ record: 'salary cache', reason: 'must be an object with submissions' }]); return [] }
    const parsed = salvageSubmissions(data.submissions)
    warning(parsed.rejected)
    return parsed.value
  } catch {
    warning([{ record: 'salary cache', reason: 'contains invalid JSON' }])
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
type LegacyRead = { status: 'absent' } | { status: 'invalid' } | { status: 'valid'; value: SalarySubmission[] }

function _readLegacy(scope: ReturnType<typeof syncCoordinator.captureScope>): LegacyRead {
  const raw = scope.read(STORAGE_KEY)
  if (raw === null) return { status: 'absent' }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch { warning([{ record: 'salary backup', reason: 'contains invalid JSON' }]); return { status: 'invalid' } }
  if (!Array.isArray(data) && !(isRecord(data) && Array.isArray(data.submissions))) {
    warning([{ record: 'salary backup', reason: 'must be an array or object with submissions' }]); return { status: 'invalid' }
  }
  const arr = Array.isArray(data) ? data : data.submissions
  const valid = salvageSubmissions(arr)
  if (valid.rejected.length) { warning(valid.rejected); return { status: 'invalid' } }
  const value = materializeImport('salary-legacy', raw, () => valid.value.map((r) => {
      const row = _migrate({ ...r } as SalarySubmission)
      if (!row.id) row.id = genId('sub')
      if (!row.created_at) row.created_at = new Date().toISOString()
      return row
    }))
  return { status: 'valid', value }
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
  const legacyRead = _readLegacy(scope)
  if (legacyRead.status === 'absent') return true
  if (legacyRead.status === 'invalid') return false
  const legacy = legacyRead.value
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
  const parsed = salvageSubmissions(result.data)
  warning(parsed.rejected)
  const rows = withoutTombstones(parsed.value, tombstones)
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
  const incoming = Array.isArray(parsed) ? parsed : (isRecord(parsed) && Array.isArray(parsed.submissions) ? parsed.submissions : null)
  if (!incoming) throw new Error('No submissions found in that file.')
  const checked = salvageSubmissions(incoming)
  if (checked.rejected.length) throw new Error(`Löneunderlaget innehåller ogiltiga poster: ${checked.rejected.map((r) => r.record).join(', ')}.`)

  const scope = syncCoordinator.captureScope()
  const normalized = materializeImport('salary-backup', text, () => checked.value
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
