/* salary-store.ts — append-only log of monthly salary submissions.
   Data-access module for the Hushållsbudget pot. Phase 16b: reads and writes the
   Supabase `salary_submissions` table (cloud source-of-truth), with a
   localStorage write-through CACHE so the log still renders offline. Every
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

// Legacy pre-Supabase history — import source + backup. (Exported name kept for
// back-compat; it is no longer the cache.)
export const STORAGE_KEY = 'bostadskalkyl_salary_log_v1'
const CACHE_KEY = 'bostadskalkyl_salary_cache_v1'
const IMPORT_FLAG = 'bostadskalkyl_salary_supabase_imported'
const TABLE = 'salary_submissions'
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
  try {
    const raw = localStorage.getItem(CACHE_KEY)
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
    localStorage.setItem(CACHE_KEY, JSON.stringify({ version: VERSION, submissions }))
  } catch {
    /* private mode / quota — cache is best-effort */
  }
}

// The pre-Supabase history, normalised + guaranteed id/created_at, ready to
// upsert. Read-only: this key is never written after the swap, so the original
// data survives even if every cloud write fails.
function _readLegacy(): SalarySubmission[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const data = JSON.parse(raw)
    const arr: SalarySubmission[] = Array.isArray(data)
      ? data
      : (data && Array.isArray(data.submissions)) ? data.submissions : []
    return arr.map((r) => {
      const row = _migrate({ ...r })
      if (!row.id) row.id = _id()
      if (!row.created_at) row.created_at = new Date().toISOString()
      return row
    })
  } catch {
    return []
  }
}

// Client-side id. The DB column also defaults to gen_random_uuid()::text, so
// this is only needed to stamp a row before the optimistic cache write.
function _id(): string {
  try {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID()
  } catch { /* no crypto */ }
  return 'sub-' + new Date().getTime().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
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
// localStorage history into the cloud (keyed on id, so re-running adds nothing)
// and set a flag. Runs per-origin/per-device — the real history lives on the
// live Pages origin, so this matters there, not on localhost. On any error
// (offline / RLS not ready) it does NOT set the flag and clears the in-memory
// guard, so it retries on the next call. `_importOnce` dedupes concurrent calls
// within a session.
let _importOnce: Promise<void> | null = null
function _importLocalOnce(): Promise<void> {
  if (_importOnce) return _importOnce
  _importOnce = (async () => {
    let already = true
    try { already = localStorage.getItem(IMPORT_FLAG) === '1' } catch { already = false }
    if (already) return
    const legacy = _readLegacy()
    if (legacy.length) {
      const { error } = await supabase.from(TABLE).upsert(legacy.map(_row), { onConflict: 'id' })
      if (error) { _importOnce = null; return } // retry next call — don't mark done
    }
    try { localStorage.setItem(IMPORT_FLAG, '1') } catch { /* ignore */ }
  })()
  return _importOnce
}

// ── Public API (signatures unchanged) ───────────────────────────────────────

// Every submission, newest first. Runs the one-time legacy import first (so
// imported rows appear in this very call), then reads cloud; on any error
// (offline / RLS / down) serves the last-known cache so the log still renders.
export async function list(): Promise<SalarySubmission[]> {
  await _importLocalOnce()
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .order('created_at', { ascending: false })
  if (error || !data) return _sortedDesc(_readCache())
  const rows = (data as SalarySubmission[]).map(_migrate)
  _writeCache(rows)
  return rows
}

// Append one record. Stamps id + created_at (the DB would default them too),
// inserts to the cloud, updates the cache optimistically, then resolves the
// saved row. Throws on a write error so the caller can surface it — NB the
// pre-Supabase store never rejected here, so the call site guards for it.
export async function add(record: SalarySubmission): Promise<SalarySubmission> {
  const saved: SalarySubmission = {
    ...record,
    id: record.id || _id(),
    created_at: record.created_at || new Date().toISOString(),
  }
  const { error } = await supabase.from(TABLE).insert(_row(saved))
  _writeCache([saved, ..._readCache().filter((r) => r.id !== saved.id)])
  if (error) throw error
  return saved
}

// Drop one record by id; resolves the remaining (cached) count.
export async function remove(id: string): Promise<number> {
  const { error } = await supabase.from(TABLE).delete().eq('id', id)
  const rows = _readCache().filter((r) => r.id !== id)
  _writeCache(rows)
  if (error) throw error
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

  const existing = await list()
  const seen = new Set(existing.map((r) => r.id))

  const toAdd: SalarySubmission[] = []
  incoming.forEach((raw) => {
    if (!raw || typeof raw !== 'object') return
    const row = _migrate({ ...raw })
    if (!row.id) row.id = _id()
    if (seen.has(row.id)) return // already have it — skip (idempotent restore)
    if (!row.created_at) row.created_at = new Date().toISOString()
    seen.add(row.id)
    toAdd.push(row)
  })

  if (toAdd.length) {
    const { error } = await supabase.from(TABLE).insert(toAdd.map(_row))
    if (error) throw error
    _writeCache(_sortedDesc([...toAdd, ..._readCache()]))
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
