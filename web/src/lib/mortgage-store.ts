/* mortgage-store.ts — persistence for Bolånekoll.
   Phase 16e: five data tables in Supabase (mortgage_loan_parts / _rate_periods /
   _payments / _valuations / _contributions) + settings in the shared tool_state
   blob (tool = 'bolanekoll-settings'), with a localStorage write-through CACHE
   of the whole envelope for offline. Every exported signature is unchanged (they
   were already Promise-returning), so Bolanekoll.tsx / Home.tsx are untouched.
   supabase-js never throws — it returns { data, error } — so we check `error`
   and fall back to the cache on reads / surface it on writes.

   Two localStorage keys, deliberately separate (as in salary/manadsavslut):
   - STORAGE_KEY — the PRE-Supabase data. Now the one-time import SOURCE and a
     permanent backup; never written after the swap. Keeping it distinct from the
     cache is what makes the first-login import safe.
   - CACHE_KEY   — the write-through offline cache mirroring the whole envelope. */

import { defaultSettings, makeRatePeriod } from './mortgage'
import type { LoanPart, RatePeriod, Payment, Valuation, Contribution, MortgageSettings, ColNameMapping, Bank, Mortgage } from './mortgage'
import { supabase } from './supabase'
import { makeImportOnce, materializeImport, stamp } from './store-helpers'
import type { MutationInput } from './sync-coordinator'
import { syncCoordinator } from './sync'
import { cachedTombstoneIds, loadTombstoneIds, queueTableDelete, queueTableUpsert, registerTableSync, withoutTombstones } from './sync-table'
import { legacyImportAssignedToActive } from './legacy-data'
import {
  receiptRpc, rejectLegacyToolOperation, rememberRowRevisions,
  rememberToolRevision, revisionKey, syncRpcResult,
} from './sync-rpc'

// Legacy pre-Supabase data — import source + backup. (Exported name kept for
// back-compat; it is no longer the write target.)
export const STORAGE_KEY = 'bostadskalkyl_mortgage_v1'
const CACHE_KEY = 'bostadskalkyl_mortgage_cache_v1'
const IMPORT_FLAG = 'bostadskalkyl_mortgage_supabase_imported'
const VERSION = 4
const STATE = 'tool_state'
const SETTINGS_TOOL = 'bolanekoll-settings'
const SETTINGS_RESOURCE = `tool_state:${SETTINGS_TOOL}`
const CASCADE_RESOURCE = 'mortgage-loan-part-cascade'

const T = {
  banks: 'mortgage_banks',
  mortgages: 'mortgages',
  parts: 'mortgage_loan_parts',
  periods: 'mortgage_rate_periods',
  payments: 'mortgage_payments',
  valuations: 'mortgage_valuations',
  contributions: 'mortgage_contributions',
} as const

const RESOURCES = T

// The writable data columns per table. `id` + `created_at` are added by `_row`;
// `household_id` (column default) + `updated_at` (trigger) are never sent. Field
// names already match column names 1:1 (both snake_case), so a plain pick works.
const COLS = {
  banks: ['label', 'year_basis', 'year_basis_source', 'billing', 'billing_source'],
  mortgages: ['bank_id', 'label', 'start_date', 'archived'],
  parts: ['label', 'loan_number', 'start_balance', 'start_date', 'archived', 'mortgage_id', 'original_balance', 'original_date', 'planned_amortization', 'planned_amortization_start', 'planned_amortization_end'],
  periods: ['loan_part_id', 'start_date', 'end_date', 'rate', 'rate_type'],
  payments: ['loan_part_id', 'date', 'kind', 'description', 'amount', 'balance_after', 'paid_by', 'source', 'is_insats', 'paid_split'],
  valuations: ['date', 'value', 'note', 'is_purchase'],
  contributions: ['owner', 'date', 'amount', 'note'],
} as const

interface StoreEnvelope {
  version: number
  banks: Bank[]
  mortgages: Mortgage[]
  loan_parts: LoanPart[]
  payments: Payment[]
  valuations: Valuation[]
  rate_periods: RatePeriod[]
  contributions: Contribution[]
  settings: MortgageSettings
}

// ── Pure helpers (unchanged from the localStorage store) ─────────────────────
function dayBefore(iso: string): string | null {
  const d = new Date(iso + 'T00:00:00')
  if (isNaN(d.getTime())) return null
  d.setDate(d.getDate() - 1)
  const p = (n: number) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

function byDateDesc<T extends { date?: string; created_at?: string }>(rows: T[]): T[] {
  return rows.slice().sort((a, b) => {
    const d = String(b.date || '').localeCompare(String(a.date || ''))
    return d !== 0 ? d : String(b.created_at || '').localeCompare(String(a.created_at || ''))
  })
}

function byStartDesc(rows: RatePeriod[]): RatePeriod[] {
  return rows.slice().sort((a, b) => String(b.start_date).localeCompare(String(a.start_date)))
}

// v<4 forward-migration: fold legacy per-part interest_rate + rate_changes into
// rate_periods. Runs in-memory on the import/cache path only — cloud rows are
// born v4, so it never fires on cloud data.
function migrateToPeriods(out: StoreEnvelope, raw: Record<string, unknown>): void {
  if (out.rate_periods.length) return
  const oldChanges = Array.isArray(raw.rate_changes) ? (raw.rate_changes as Array<Record<string, unknown>>) : []
  const periods: RatePeriod[] = []
  for (const p of out.loan_parts) {
    if (!p) continue
    const pr = p as LoanPart & Record<string, unknown>
    const seeds: Array<{ start_date: string; rate: number; rate_type: 'rörlig' | 'bunden'; end_date: string | null }> = []
    if (pr.interest_rate != null && pr.interest_rate !== '') {
      seeds.push({
        start_date: String(p.start_date || ''), rate: Number(pr.interest_rate),
        rate_type: pr.rate_type === 'bunden' ? 'bunden' : 'rörlig',
        end_date: (pr.rate_type === 'bunden' && pr.rate_binding_until) ? String(pr.rate_binding_until) : null,
      })
    }
    for (const r of oldChanges.filter(r => r && r.loan_part_id === p.id))
      seeds.push({ start_date: String(r.date || ''), rate: Number(r.rate), rate_type: 'rörlig', end_date: null })
    seeds.sort((a, b) => a.start_date.localeCompare(b.start_date))
    seeds.forEach((s, i) => {
      const next = seeds[i + 1]
      if (s.end_date == null && next?.start_date) s.end_date = dayBefore(next.start_date)
      periods.push(stamp({ ...makeRatePeriod(s), loan_part_id: p.id }, 'rate') as RatePeriod)
    })
    delete (pr as Record<string, unknown>).interest_rate
    delete (pr as Record<string, unknown>).rate_type
    delete (pr as Record<string, unknown>).rate_binding_until
  }
  out.rate_periods = periods
}

// Concrete fallbacks for every NOT-NULL column, so an insert NEVER depends on
// the DB column default being present (a table created before the migration can
// be NOT NULL without the default). Values match the migration defaults AND the
// app's own normalizers (paid_by/owner → 'joint' via normPaidBy, rate_type →
// 'rörlig', text → '', numeric → 0, booleans → false), so a filled row shows
// exactly what the app renders for it. Columns absent here are nullable and are
// simply omitted when null. Keyed by column name — names are unambiguous across
// tables (date → '', note → '', amount → 0, …).
const NOT_NULL_DEFAULTS: Record<string, unknown> = {
  label: '', loan_number: '', start_balance: 0, start_date: '', archived: false,
  rate_type: 'rörlig',
  date: '', kind: 'payment', description: '', amount: 0, paid_by: 'joint', source: '', is_insats: false,
  value: 0, note: '', is_purchase: false,
  owner: 'joint',
}

// Plan 104 — columns that must be sent as an EXPLICIT null when null, not
// dropped. The sync UPDATE (`sync_apply_one_row`) only assigns the keys present
// in the payload, so an omitted key leaves the DB value untouched: a nullable
// column can be SET but never CLEARED unless its key is present as null. The
// bank profile lock must be clearable back to auto (year_basis_source → null),
// so these two columns opt into explicit-null. Scoped to just these columns to
// avoid changing the omit-null behaviour every other table relies on.
const NULLABLE_EXPLICIT: ReadonlySet<string> = new Set(['year_basis', 'year_basis_source', 'billing', 'billing_source'])

// A full insert row: id + created_at (client-stamped) + the data columns. A
// null/undefined value is replaced by its NOT_NULL_DEFAULTS fallback if the
// column is NOT NULL, sent as an explicit null if it opts into NULLABLE_EXPLICIT,
// else dropped (nullable → left untouched on update). This means a legacy row
// with, e.g., paid_by null inserts 'joint' rather than an explicit null, so it
// works regardless of whether the DB column carries the default.
function _row(obj: { id?: string; created_at?: string }, cols: readonly string[]): Record<string, unknown> {
  const rec = obj as Record<string, unknown>
  const out: Record<string, unknown> = {}
  if (rec.id != null) out.id = rec.id
  if (rec.created_at != null) out.created_at = rec.created_at
  for (const c of cols) {
    if (rec[c] != null) out[c] = rec[c]
    else if (c in NOT_NULL_DEFAULTS) out[c] = NOT_NULL_DEFAULTS[c]
    else if (NULLABLE_EXPLICIT.has(c)) out[c] = null
  }
  return out
}

// ── localStorage cache (offline fallback) ────────────────────────────────────
function _emptyEnvelope(): StoreEnvelope {
  return { version: VERSION, banks: [], mortgages: [], loan_parts: [], payments: [], valuations: [], rate_periods: [], contributions: [], settings: defaultSettings() }
}

function _envelope(raw: Record<string, unknown>, migrate: boolean): StoreEnvelope {
  const out: StoreEnvelope = {
    version: VERSION,
    banks: Array.isArray(raw.banks) ? (raw.banks as Bank[]) : [],
    mortgages: Array.isArray(raw.mortgages) ? (raw.mortgages as Mortgage[]) : [],
    loan_parts: Array.isArray(raw.loan_parts) ? (raw.loan_parts as LoanPart[]) : [],
    payments: Array.isArray(raw.payments) ? (raw.payments as Payment[]) : [],
    valuations: Array.isArray(raw.valuations) ? (raw.valuations as Valuation[]) : [],
    rate_periods: Array.isArray(raw.rate_periods) ? (raw.rate_periods as RatePeriod[]) : [],
    contributions: Array.isArray(raw.contributions) ? (raw.contributions as Contribution[]) : [],
    settings: { ...defaultSettings(), ...(raw.settings as Partial<MortgageSettings> || {}) },
  }
  if (migrate && (Number(raw.version) || 1) < 4) migrateToPeriods(out, raw)
  return out
}

function _readCache(): StoreEnvelope {
  return _readCacheFrom(syncCoordinator.captureScope())
}

function _readCacheFrom(scope: ReturnType<typeof syncCoordinator.captureScope>): StoreEnvelope {
  try {
    const raw = scope.read(CACHE_KEY)
    if (!raw) return _emptyEnvelope()
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object') return _emptyEnvelope()
    return _envelope(data, false) // cache is always current-shape
  } catch { return _emptyEnvelope() }
}

function _writeCache(env: StoreEnvelope): void {
  try { syncCoordinator.writeScoped(CACHE_KEY, JSON.stringify(env)) } catch { /* private mode / quota */ }
}

function _patchCache(fn: (e: StoreEnvelope) => void): void {
  const env = _readCache(); fn(env); _writeCache(env)
}

// Synchronous snapshot of the write-through cache, sorted to MATCH what the
// async list*() reads return, so a component can seed its initial React state
// on the first paint and avoid the empty-then-populated flash while the cloud
// refresh reconciles. Cold cache (first-ever visit) → the empty envelope, so
// callers still fall through to their genuine empty state.
export function cachedSnapshot(): StoreEnvelope {
  const scope = syncCoordinator.captureScope()
  const e = _readCacheFrom(scope)
  return {
    version: e.version,
    banks: withoutTombstones(e.banks, cachedTombstoneIds(scope, RESOURCES.banks)),
    mortgages: withoutTombstones(e.mortgages, cachedTombstoneIds(scope, RESOURCES.mortgages)),
    loan_parts: withoutTombstones(e.loan_parts, cachedTombstoneIds(scope, RESOURCES.parts)),
    payments: byDateDesc(withoutTombstones(e.payments, cachedTombstoneIds(scope, RESOURCES.payments))),
    valuations: byDateDesc(withoutTombstones(e.valuations, cachedTombstoneIds(scope, RESOURCES.valuations))),
    rate_periods: byStartDesc(withoutTombstones(e.rate_periods, cachedTombstoneIds(scope, RESOURCES.periods))),
    contributions: byDateDesc(withoutTombstones(e.contributions, cachedTombstoneIds(scope, RESOURCES.contributions))),
    settings: e.settings,
  }
}

// The pre-Supabase envelope from the legacy key — v<4-migrated in memory (no
// write-back, STORAGE_KEY stays read-only) with id/created_at guaranteed on
// every row, ready to upsert. null when there's no legacy data to import.
function _readLegacy(scope: ReturnType<typeof syncCoordinator.captureScope>): StoreEnvelope | null {
  const raw = scope.read(STORAGE_KEY)
  if (!raw) return null
  let data: unknown
  try {
    data = JSON.parse(raw)
    if (!data || typeof data !== 'object') return null
  } catch { return null }
  return materializeImport('mortgage-legacy', raw, () => {
    const env = _envelope(data as Record<string, unknown>, true)
    env.loan_parts = env.loan_parts.map(r => stamp(r, 'part') as LoanPart)
    env.payments = env.payments.map(r => stamp(r, 'pay') as Payment)
    env.valuations = env.valuations.map(r => stamp(r, 'val') as Valuation)
    env.rate_periods = env.rate_periods.map(r => stamp(r, 'rate') as RatePeriod)
    env.contributions = env.contributions.map(r => stamp(r, 'contrib') as Contribution)
    return env
  })
}

// ── First-login import (one-time, idempotent) ───────────────────────────────
// On the first authenticated load after the household exists, upsert the legacy
// localStorage data into the five tables (keyed on id, so re-running adds
// nothing) + seed the settings tool_state row only if none exists yet (so a
// partner's saved settings aren't clobbered).
const _importLocalOnce = makeImportOnce(() => syncCoordinator.scopedStorageKey(IMPORT_FLAG), async () => {
  const scope = syncCoordinator.captureScope()
  if (!legacyImportAssignedToActive() || !scope.isActive()) return true
  const legacy = _readLegacy(scope)
  if (!legacy) return true
  const operations: MutationInput[] = []
  const add = <T extends { id?: string }>(resource: string, rows: T[], projected: Record<string, unknown>[], applyLocal: () => void) => {
    const ids = rows.map((row) => row.id!)
    if (rows.length) operations.push({
      resource, operation: 'upsert', payload: { rows: projected, seed: true }, entityIds: ids,
      expectedRevisions: Object.fromEntries(ids.map((id) => [revisionKey(resource, id), null])), applyLocal,
    })
  }
  add(T.parts, legacy.loan_parts, legacy.loan_parts.map(r => _row(r, COLS.parts)), () => _patchCache(e => { const ids = new Set(legacy.loan_parts.map(r => r.id)); e.loan_parts = [...legacy.loan_parts, ...e.loan_parts.filter(r => !ids.has(r.id))] }))
  add(T.periods, legacy.rate_periods, legacy.rate_periods.map(r => _row(r, COLS.periods)), () => _patchCache(e => { const ids = new Set(legacy.rate_periods.map(r => r.id)); e.rate_periods = [...legacy.rate_periods, ...e.rate_periods.filter(r => !ids.has(r.id))] }))
  add(T.payments, legacy.payments, legacy.payments.map(r => _row(r, COLS.payments)), () => _patchCache(e => { const ids = new Set(legacy.payments.map(r => r.id)); e.payments = [...legacy.payments, ...e.payments.filter(r => !ids.has(r.id))] }))
  add(T.valuations, legacy.valuations, legacy.valuations.map(r => _row(r, COLS.valuations)), () => _patchCache(e => { const ids = new Set(legacy.valuations.map(r => r.id)); e.valuations = [...legacy.valuations, ...e.valuations.filter(r => !ids.has(r.id))] }))
  add(T.contributions, legacy.contributions, legacy.contributions.map(r => _row(r, COLS.contributions)), () => _patchCache(e => { const ids = new Set(legacy.contributions.map(r => r.id)); e.contributions = [...legacy.contributions, ...e.contributions.filter(r => !ids.has(r.id))] }))
  operations.push({
    resource: SETTINGS_RESOURCE, operation: 'upsert', payload: { data: legacy.settings, seed: true }, entityIds: [SETTINGS_TOOL],
    expectedRevisions: { [SETTINGS_RESOURCE]: null }, applyLocal: () => _patchCache(e => { e.settings = legacy.settings }),
  })
  if (!scope.isActive()) return false
  try { await syncCoordinator.mutateBatch(operations); return true } catch { return false }
})

for (const table of Object.values(T)) registerTableSync(table, table)
syncCoordinator.register(SETTINGS_RESOURCE, async (operation) => {
  const payload = operation.payload as { data?: unknown; seed?: unknown }
  const data = payload?.data
  if (!data || typeof data !== 'object') throw { status: 400, message: 'Malformed mortgage settings' }
  await rejectLegacyToolOperation(operation, SETTINGS_TOOL)
  const { data: result, error } = await receiptRpc('sync_apply_tool_state', {
    p_operation_id: operation.id,
    p_tool: SETTINGS_TOOL,
    p_data: data,
    p_expected_revision: operation.expectedRevisions?.[SETTINGS_RESOURCE] ?? null,
    p_seed: payload.seed === true,
  })
  if (error) throw error
  return syncRpcResult(result)
}, (operation) => {
  const payload = operation.payload as { data?: unknown; seed?: unknown }
  const data = payload?.data
  return operation.operation === 'upsert' && !!data && typeof data === 'object'
    && (payload.seed === undefined || typeof payload.seed === 'boolean')
    && operation.entityIds.length === 1 && operation.entityIds[0] === SETTINGS_TOOL
})
syncCoordinator.register(CASCADE_RESOURCE, async (operation) => {
  const id = (operation.payload as { id?: unknown })?.id
  if (operation.operation !== 'delete' || typeof id !== 'string' || !id) throw { status: 400, message: 'Malformed loan-part delete' }
  if (operation.expectedRevisions === undefined) {
    const [part, payments, periods] = await Promise.all([
      supabase.from(T.parts).select('id,revision').eq('id', id).maybeSingle(),
      supabase.from(T.payments).select('id,revision').eq('loan_part_id', id),
      supabase.from(T.periods).select('id,revision').eq('loan_part_id', id),
    ])
    if (part.error || payments.error || periods.error) throw part.error ?? payments.error ?? periods.error
    const current: Record<string, number | null> = { [revisionKey(T.parts, id)]: Number((part.data as { revision?: unknown } | null)?.revision) || null }
    for (const [resource, rows] of [[T.payments, payments.data], [T.periods, periods.data]] as const) {
      for (const row of (rows ?? []) as Array<{ id?: unknown; revision?: unknown }>) {
        if (typeof row.id === 'string') current[revisionKey(resource, row.id)] = Number(row.revision) || null
      }
    }
    throw { status: 409, message: 'legacy operation has no base revision', currentRevisions: current }
  }
  const { data, error } = await receiptRpc('sync_delete_mortgage_loan_part', {
    p_operation_id: operation.id,
    p_loan_part_id: id,
    p_expected_revisions: operation.expectedRevisions,
  })
  if (error) throw error
  return syncRpcResult(data)
}, (operation) => {
  const id = (operation.payload as { id?: unknown })?.id
  return operation.operation === 'delete' && typeof id === 'string' && !!id
    && operation.entityIds.length === 1 && operation.entityIds[0] === id
})

// ── Loan parts ───────────────────────────────────────────────────────────────
export interface MortgageSyncSnapshot {
  parts: LoanPart[]
  periods: RatePeriod[]
  payments: Payment[]
}

// Unlike the ordinary list functions, this all-or-nothing read never falls
// back to cache. Hushållsbudget must distinguish authoritative empty data
// (remove synced rows) from an unavailable live source (preserve stale rows).
export async function loadMortgageSyncSnapshot(): Promise<MortgageSyncSnapshot | null> {
  const scope = syncCoordinator.captureScope()
  const fallback = (): MortgageSyncSnapshot => {
    const cache = _readCacheFrom(scope)
    return {
      parts: withoutTombstones(cache.loan_parts, cachedTombstoneIds(scope, RESOURCES.parts)),
      periods: withoutTombstones(cache.rate_periods, cachedTombstoneIds(scope, RESOURCES.periods)),
      payments: withoutTombstones(cache.payments, cachedTombstoneIds(scope, RESOURCES.payments)),
    }
  }
  await _importLocalOnce()
  if (!scope.isActive() || [RESOURCES.parts, RESOURCES.periods, RESOURCES.payments, CASCADE_RESOURCE].some((resource) => syncCoordinator.isDirty(resource))) {
    return fallback()
  }
  const [partsResult, periodsResult, paymentsResult, partTombstones, periodTombstones, paymentTombstones] = await Promise.all([
    supabase.from(T.parts).select('*').order('created_at', { ascending: true }),
    supabase.from(T.periods).select('*'),
    supabase.from(T.payments).select('*'),
    loadTombstoneIds(scope, RESOURCES.parts),
    loadTombstoneIds(scope, RESOURCES.periods),
    loadTombstoneIds(scope, RESOURCES.payments),
  ])
  if (!scope.isActive() || [RESOURCES.parts, RESOURCES.periods, RESOURCES.payments, CASCADE_RESOURCE].some((resource) => syncCoordinator.isDirty(resource))) {
    return fallback()
  }
  if (partsResult.error || periodsResult.error || paymentsResult.error ||
      !partsResult.data || !periodsResult.data || !paymentsResult.data) return null
  rememberRowRevisions(RESOURCES.parts, partsResult.data as Record<string, unknown>[])
  rememberRowRevisions(RESOURCES.periods, periodsResult.data as Record<string, unknown>[])
  rememberRowRevisions(RESOURCES.payments, paymentsResult.data as Record<string, unknown>[])
  const snapshot: MortgageSyncSnapshot = {
    parts: withoutTombstones(partsResult.data as LoanPart[], partTombstones),
    periods: withoutTombstones(periodsResult.data as RatePeriod[], periodTombstones),
    payments: withoutTombstones(paymentsResult.data as Payment[], paymentTombstones),
  }
  const cache = _readCacheFrom(scope)
  {
    cache.loan_parts = snapshot.parts
    cache.rate_periods = snapshot.periods
    cache.payments = snapshot.payments
  }
  scope.write(CACHE_KEY, JSON.stringify(cache))
  return snapshot
}

export async function listLoanParts(): Promise<LoanPart[]> {
  const scope = syncCoordinator.captureScope()
  await _importLocalOnce()
  const fallback = () => withoutTombstones(_readCacheFrom(scope).loan_parts, cachedTombstoneIds(scope, RESOURCES.parts))
  if (!scope.isActive() || syncCoordinator.isDirty(RESOURCES.parts) || syncCoordinator.isDirty(CASCADE_RESOURCE)) return fallback()
  const [result, tombstones] = await Promise.all([
    supabase.from(T.parts).select('*').order('created_at', { ascending: true }), loadTombstoneIds(scope, RESOURCES.parts),
  ])
  if (!scope.isActive() || syncCoordinator.isDirty(RESOURCES.parts) || syncCoordinator.isDirty(CASCADE_RESOURCE)) return fallback()
  if (result.error || !result.data) return fallback()
  rememberRowRevisions(RESOURCES.parts, result.data as Record<string, unknown>[])
  const rows = withoutTombstones(result.data as LoanPart[], tombstones)
  const cache = _readCacheFrom(scope); cache.loan_parts = rows; scope.write(CACHE_KEY, JSON.stringify(cache))
  return rows.slice()
}

export async function addLoanPart(record: Omit<LoanPart, 'id' | 'created_at'>): Promise<LoanPart> {
  const saved = stamp(record, 'part') as LoanPart
  await queueTableUpsert(RESOURCES.parts, [_row(saved, COLS.parts)], [saved.id], () => _patchCache(e => { e.loan_parts.push(saved) }))
  return saved
}

export async function updateLoanPart(id: string, patch: Partial<LoanPart>): Promise<LoanPart | null> {
  const current = _readCache().loan_parts.find((part) => part.id === id)
  if (!current) return null
  const saved = { ...current, ...patch }
  await queueTableUpsert(RESOURCES.parts, [_row(saved, COLS.parts)], [id], () => {
    _patchCache(e => { e.loan_parts = e.loan_parts.map(p => p?.id === id ? saved : p) })
  })
  return saved
}

export async function removeLoanPart(id: string): Promise<number> {
  // Product decision (Plan 94): deleting a loan part permanently deletes its
  // linked payments and rate periods. The RPC performs that cascade in one
  // database transaction. Once the delete is durably queued, the cache hides
  // the parent and children while acknowledgement/retry remains explicit.
  const cache = _readCache()
  const affected = [
    revisionKey(RESOURCES.parts, id),
    ...cache.payments.filter((row) => row.loan_part_id === id).map((row) => revisionKey(RESOURCES.payments, row.id)),
    ...cache.rate_periods.filter((row) => row.loan_part_id === id).map((row) => revisionKey(RESOURCES.periods, row.id)),
  ]
  let n = 0
  await syncCoordinator.mutate({
    resource: CASCADE_RESOURCE, operation: 'delete', payload: { id }, entityIds: [id],
    expectedRevisions: Object.fromEntries(affected.map((key) => [key, syncCoordinator.getRevision(key)])),
    applyLocal: () => _patchCache(e => {
      e.loan_parts = e.loan_parts.filter(p => p?.id !== id)
      e.payments = e.payments.filter(p => !(p?.loan_part_id === id))
      e.rate_periods = e.rate_periods.filter(r => !(r?.loan_part_id === id))
      n = e.loan_parts.length
    }),
  })
  return n
}

// ── Banks (plan 103) ─────────────────────────────────────────────────────────
// Bank + mortgage rows sync through the same optimistic-concurrency outbox as
// the other mortgage tables (auto-registered from T at load, see registerTableSync
// loop above), so their CRUD mirrors the parts/valuations pattern exactly: reads
// fall back to the tombstone-filtered cache when the scope is inactive/dirty or
// the cloud errors; writes queue through queueTableUpsert/Delete with an optimistic
// cache patch.
export async function listBanks(): Promise<Bank[]> {
  const scope = syncCoordinator.captureScope()
  await _importLocalOnce()
  const fallback = () => withoutTombstones(_readCacheFrom(scope).banks, cachedTombstoneIds(scope, RESOURCES.banks))
  if (!scope.isActive() || syncCoordinator.isDirty(RESOURCES.banks)) return fallback()
  const [result, tombstones] = await Promise.all([
    supabase.from(T.banks).select('*').order('created_at', { ascending: true }), loadTombstoneIds(scope, RESOURCES.banks),
  ])
  if (!scope.isActive() || syncCoordinator.isDirty(RESOURCES.banks)) return fallback()
  if (result.error || !result.data) return fallback()
  rememberRowRevisions(RESOURCES.banks, result.data as Record<string, unknown>[])
  const rows = withoutTombstones(result.data as Bank[], tombstones)
  const cache = _readCacheFrom(scope); cache.banks = rows; scope.write(CACHE_KEY, JSON.stringify(cache))
  return rows.slice()
}

export async function addBank(record: Omit<Bank, 'id' | 'created_at'>): Promise<Bank> {
  const saved = stamp(record, 'bank') as Bank
  await queueTableUpsert(RESOURCES.banks, [_row(saved, COLS.banks)], [saved.id], () => _patchCache(e => { e.banks.push(saved) }))
  return saved
}

export async function updateBank(id: string, patch: Partial<Bank>): Promise<Bank | null> {
  const current = _readCache().banks.find((bank) => bank.id === id)
  if (!current) return null
  const saved = { ...current, ...patch }
  await queueTableUpsert(RESOURCES.banks, [_row(saved, COLS.banks)], [id], () => _patchCache(e => { e.banks = e.banks.map(b => b?.id === id ? saved : b) }))
  return saved
}

export async function removeBank(id: string): Promise<number> {
  let n = 0
  await queueTableDelete(RESOURCES.banks, [id], () => _patchCache(e => { e.banks = e.banks.filter(b => b?.id !== id); n = e.banks.length }))
  return n
}

// ── Mortgages (plan 103) ─────────────────────────────────────────────────────
export async function listMortgages(): Promise<Mortgage[]> {
  const scope = syncCoordinator.captureScope()
  await _importLocalOnce()
  const fallback = () => withoutTombstones(_readCacheFrom(scope).mortgages, cachedTombstoneIds(scope, RESOURCES.mortgages))
  if (!scope.isActive() || syncCoordinator.isDirty(RESOURCES.mortgages)) return fallback()
  const [result, tombstones] = await Promise.all([
    supabase.from(T.mortgages).select('*').order('created_at', { ascending: true }), loadTombstoneIds(scope, RESOURCES.mortgages),
  ])
  if (!scope.isActive() || syncCoordinator.isDirty(RESOURCES.mortgages)) return fallback()
  if (result.error || !result.data) return fallback()
  rememberRowRevisions(RESOURCES.mortgages, result.data as Record<string, unknown>[])
  const rows = withoutTombstones(result.data as Mortgage[], tombstones)
  const cache = _readCacheFrom(scope); cache.mortgages = rows; scope.write(CACHE_KEY, JSON.stringify(cache))
  return rows.slice()
}

export async function addMortgage(record: Omit<Mortgage, 'id' | 'created_at'>): Promise<Mortgage> {
  const saved = stamp(record, 'mort') as Mortgage
  await queueTableUpsert(RESOURCES.mortgages, [_row(saved, COLS.mortgages)], [saved.id], () => _patchCache(e => { e.mortgages.push(saved) }))
  return saved
}

export async function updateMortgage(id: string, patch: Partial<Mortgage>): Promise<Mortgage | null> {
  const current = _readCache().mortgages.find((mortgage) => mortgage.id === id)
  if (!current) return null
  const saved = { ...current, ...patch }
  await queueTableUpsert(RESOURCES.mortgages, [_row(saved, COLS.mortgages)], [id], () => _patchCache(e => { e.mortgages = e.mortgages.map(m => m?.id === id ? saved : m) }))
  return saved
}

export async function removeMortgage(id: string): Promise<number> {
  let n = 0
  await queueTableDelete(RESOURCES.mortgages, [id], () => _patchCache(e => { e.mortgages = e.mortgages.filter(m => m?.id !== id); n = e.mortgages.length }))
  return n
}

// ── Payments ─────────────────────────────────────────────────────────────────
export async function listPayments(): Promise<Payment[]> {
  const scope = syncCoordinator.captureScope()
  await _importLocalOnce()
  const fallback = () => byDateDesc(withoutTombstones(_readCacheFrom(scope).payments, cachedTombstoneIds(scope, RESOURCES.payments)))
  if (!scope.isActive() || syncCoordinator.isDirty(RESOURCES.payments) || syncCoordinator.isDirty(CASCADE_RESOURCE)) return fallback()
  const [result, tombstones] = await Promise.all([supabase.from(T.payments).select('*'), loadTombstoneIds(scope, RESOURCES.payments)])
  if (!scope.isActive() || syncCoordinator.isDirty(RESOURCES.payments) || syncCoordinator.isDirty(CASCADE_RESOURCE)) return fallback()
  if (result.error || !result.data) return fallback()
  rememberRowRevisions(RESOURCES.payments, result.data as Record<string, unknown>[])
  const rows = withoutTombstones(result.data as Payment[], tombstones)
  const cache = _readCacheFrom(scope); cache.payments = rows; scope.write(CACHE_KEY, JSON.stringify(cache))
  return byDateDesc(rows)
}

export async function addPayment(record: Omit<Payment, 'id' | 'created_at'>): Promise<Payment> {
  const saved = stamp(record, 'pay') as Payment
  await queueTableUpsert(RESOURCES.payments, [_row(saved, COLS.payments)], [saved.id], () => _patchCache(e => { e.payments.push(saved) }))
  return saved
}

export async function addPayments(records: Array<Omit<Payment, 'id' | 'created_at'>>): Promise<Payment[]> {
  const saved = records.map(r => stamp(r, 'pay') as Payment)
  await queueTableUpsert(RESOURCES.payments, saved.map(r => _row(r, COLS.payments)), saved.map((row) => row.id), () => _patchCache(e => { e.payments = e.payments.concat(saved) }))
  return saved
}

export async function updatePayment(id: string, patch: Partial<Payment>): Promise<Payment | null> {
  const current = _readCache().payments.find((payment) => payment.id === id)
  if (!current) return null
  const saved = { ...current, ...patch }
  await queueTableUpsert(RESOURCES.payments, [_row(saved, COLS.payments)], [id], () => _patchCache(e => { e.payments = e.payments.map(p => p?.id === id ? saved : p) }))
  return saved
}

export async function removePayment(id: string): Promise<number> {
  let n = 0
  await queueTableDelete(RESOURCES.payments, [id], () => _patchCache(e => { e.payments = e.payments.filter(p => p?.id !== id); n = e.payments.length }))
  return n
}

export async function removePayments(ids: string[]): Promise<number> {
  const drop = new Set(ids)
  let removed = 0
  await queueTableDelete(RESOURCES.payments, ids, () => _patchCache(e => { const before = e.payments.length; e.payments = e.payments.filter(p => !(p && drop.has(p.id))); removed = before - e.payments.length }))
  return removed
}

// ── Valuations ───────────────────────────────────────────────────────────────
export async function listValuations(): Promise<Valuation[]> {
  const scope = syncCoordinator.captureScope()
  await _importLocalOnce()
  const fallback = () => byDateDesc(withoutTombstones(_readCacheFrom(scope).valuations, cachedTombstoneIds(scope, RESOURCES.valuations)))
  if (!scope.isActive() || syncCoordinator.isDirty(RESOURCES.valuations)) return fallback()
  const [result, tombstones] = await Promise.all([supabase.from(T.valuations).select('*'), loadTombstoneIds(scope, RESOURCES.valuations)])
  if (!scope.isActive() || syncCoordinator.isDirty(RESOURCES.valuations)) return fallback()
  if (result.error || !result.data) return fallback()
  rememberRowRevisions(RESOURCES.valuations, result.data as Record<string, unknown>[])
  const rows = withoutTombstones(result.data as Valuation[], tombstones)
  const cache = _readCacheFrom(scope); cache.valuations = rows; scope.write(CACHE_KEY, JSON.stringify(cache))
  return byDateDesc(rows)
}

export async function addValuation(record: Omit<Valuation, 'id' | 'created_at'>): Promise<Valuation> {
  const saved = stamp(record, 'val') as Valuation
  await queueTableUpsert(RESOURCES.valuations, [_row(saved, COLS.valuations)], [saved.id], () => _patchCache(e => { e.valuations.push(saved) }))
  return saved
}

export async function updateValuation(id: string, patch: Partial<Valuation>): Promise<Valuation | null> {
  const current = _readCache().valuations.find((valuation) => valuation.id === id)
  if (!current) return null
  const saved = { ...current, ...patch }
  await queueTableUpsert(RESOURCES.valuations, [_row(saved, COLS.valuations)], [id], () => _patchCache(e => { e.valuations = e.valuations.map(v => v?.id === id ? saved : v) }))
  return saved
}

export async function removeValuation(id: string): Promise<number> {
  let n = 0
  await queueTableDelete(RESOURCES.valuations, [id], () => _patchCache(e => { e.valuations = e.valuations.filter(v => v?.id !== id); n = e.valuations.length }))
  return n
}

// ── Rate periods ─────────────────────────────────────────────────────────────
export async function listRatePeriods(): Promise<RatePeriod[]> {
  const scope = syncCoordinator.captureScope()
  await _importLocalOnce()
  const fallback = () => byStartDesc(withoutTombstones(_readCacheFrom(scope).rate_periods, cachedTombstoneIds(scope, RESOURCES.periods)))
  if (!scope.isActive() || syncCoordinator.isDirty(RESOURCES.periods) || syncCoordinator.isDirty(CASCADE_RESOURCE)) return fallback()
  const [result, tombstones] = await Promise.all([supabase.from(T.periods).select('*'), loadTombstoneIds(scope, RESOURCES.periods)])
  if (!scope.isActive() || syncCoordinator.isDirty(RESOURCES.periods) || syncCoordinator.isDirty(CASCADE_RESOURCE)) return fallback()
  if (result.error || !result.data) return fallback()
  rememberRowRevisions(RESOURCES.periods, result.data as Record<string, unknown>[])
  const rows = withoutTombstones(result.data as RatePeriod[], tombstones)
  const cache = _readCacheFrom(scope); cache.rate_periods = rows; scope.write(CACHE_KEY, JSON.stringify(cache))
  return byStartDesc(rows)
}

export async function addRatePeriod(record: Omit<RatePeriod, 'id' | 'created_at'>): Promise<RatePeriod> {
  const saved = stamp(record, 'rate') as RatePeriod
  await queueTableUpsert(RESOURCES.periods, [_row(saved, COLS.periods)], [saved.id], () => _patchCache(e => { e.rate_periods.push(saved) }))
  return saved
}

export async function updateRatePeriod(id: string, patch: Partial<RatePeriod>): Promise<RatePeriod | null> {
  const current = _readCache().rate_periods.find((period) => period.id === id)
  if (!current) return null
  const saved = { ...current, ...patch }
  await queueTableUpsert(RESOURCES.periods, [_row(saved, COLS.periods)], [id], () => _patchCache(e => { e.rate_periods = e.rate_periods.map(r => r?.id === id ? saved : r) }))
  return saved
}

export async function removeRatePeriod(id: string): Promise<number> {
  let n = 0
  await queueTableDelete(RESOURCES.periods, [id], () => _patchCache(e => { e.rate_periods = e.rate_periods.filter(r => r?.id !== id); n = e.rate_periods.length }))
  return n
}

// ── Contributions ────────────────────────────────────────────────────────────
export async function listContributions(): Promise<Contribution[]> {
  const scope = syncCoordinator.captureScope()
  await _importLocalOnce()
  const fallback = () => byDateDesc(withoutTombstones(_readCacheFrom(scope).contributions, cachedTombstoneIds(scope, RESOURCES.contributions)))
  if (!scope.isActive() || syncCoordinator.isDirty(RESOURCES.contributions)) return fallback()
  const [result, tombstones] = await Promise.all([supabase.from(T.contributions).select('*'), loadTombstoneIds(scope, RESOURCES.contributions)])
  if (!scope.isActive() || syncCoordinator.isDirty(RESOURCES.contributions)) return fallback()
  if (result.error || !result.data) return fallback()
  rememberRowRevisions(RESOURCES.contributions, result.data as Record<string, unknown>[])
  const rows = withoutTombstones(result.data as Contribution[], tombstones)
  const cache = _readCacheFrom(scope); cache.contributions = rows; scope.write(CACHE_KEY, JSON.stringify(cache))
  return byDateDesc(rows)
}

export async function addContribution(record: Omit<Contribution, 'id' | 'created_at'>): Promise<Contribution> {
  const saved = stamp(record, 'contrib') as Contribution
  await queueTableUpsert(RESOURCES.contributions, [_row(saved, COLS.contributions)], [saved.id], () => _patchCache(e => { e.contributions.push(saved) }))
  return saved
}

export async function updateContribution(id: string, patch: Partial<Contribution>): Promise<Contribution | null> {
  const current = _readCache().contributions.find((contribution) => contribution.id === id)
  if (!current) return null
  const saved = { ...current, ...patch }
  await queueTableUpsert(RESOURCES.contributions, [_row(saved, COLS.contributions)], [id], () => _patchCache(e => { e.contributions = e.contributions.map(c => c?.id === id ? saved : c) }))
  return saved
}

export async function removeContribution(id: string): Promise<number> {
  let n = 0
  await queueTableDelete(RESOURCES.contributions, [id], () => _patchCache(e => { e.contributions = e.contributions.filter(c => c?.id !== id); n = e.contributions.length }))
  return n
}

// ── Settings (tool_state blob) ───────────────────────────────────────────────
export async function getSettings(): Promise<MortgageSettings> {
  const scope = syncCoordinator.captureScope()
  await _importLocalOnce()
  if (!scope.isActive() || syncCoordinator.isDirty(SETTINGS_RESOURCE)) return { ...defaultSettings(), ..._readCacheFrom(scope).settings }
  const { data, error } = await supabase.from(STATE).select('data,revision').eq('tool', SETTINGS_TOOL).maybeSingle()
  if (!scope.isActive() || syncCoordinator.isDirty(SETTINGS_RESOURCE)) return { ...defaultSettings(), ..._readCacheFrom(scope).settings }
  if (error) return { ...defaultSettings(), ..._readCacheFrom(scope).settings }
  rememberToolRevision(SETTINGS_TOOL, data)
  const settings = { ...defaultSettings(), ...((data?.data as Partial<MortgageSettings>) || {}) }
  const cache = _readCacheFrom(scope); cache.settings = settings; scope.write(CACHE_KEY, JSON.stringify(cache))
  return settings
}

export async function saveSettings(patch: Partial<MortgageSettings>): Promise<MortgageSettings> {
  const scope = syncCoordinator.captureScope()
  const current = await getSettings()
  if (!scope.isActive()) throw new Error('Sync identity changed while saving settings')
  const merged = { ...defaultSettings(), ...current, ...patch }
  await syncCoordinator.mutate({
    resource: SETTINGS_RESOURCE, operation: 'upsert', payload: { data: merged }, entityIds: [SETTINGS_TOOL],
    expectedRevisions: { [SETTINGS_RESOURCE]: syncCoordinator.getRevision(SETTINGS_RESOURCE) },
    applyLocal: () => _patchCache(e => { e.settings = merged }),
  })
  return merged
}

// ── Backup / restore ─────────────────────────────────────────────────────────
export async function exportJSON(): Promise<string> {
  const [loan_parts, payments, valuations, rate_periods, contributions, settings] = await Promise.all([
    listLoanParts(), listPayments(), listValuations(), listRatePeriods(), listContributions(), getSettings(),
  ])
  return JSON.stringify({ version: VERSION, loan_parts, payments: byDateDesc(payments), valuations: byDateDesc(valuations), rate_periods, contributions: byDateDesc(contributions), settings }, null, 2)
}

// Insert only the rows whose id isn't already present in the cloud (deduped
// against `existing`), stamping id/created_at where missing. Returns the rows
// actually added so the caller can patch the matching cache slice.
function _mergeRows<T extends { id?: string }>(existing: T[], incoming: T[]): T[] {
  const seen = new Set(existing.map(r => r?.id).filter(Boolean))
  const toAdd: T[] = []
  for (const row of incoming) {
    if (seen.has(row.id)) continue
    seen.add(row.id); toAdd.push(row)
  }
  return toAdd
}

export async function importJSON(text: string): Promise<Record<string, number>> {
  let parsed: Record<string, unknown>
  try { parsed = JSON.parse(text) } catch { throw new Error("That file isn't valid JSON.") }
  if (!parsed || typeof parsed !== 'object') throw new Error('No Bolånekoll data found.')
  if (!parsed.loan_parts && !parsed.payments && !parsed.valuations && !parsed.rate_periods && !parsed.contributions) throw new Error('No Bolånekoll data found.')

  const scope = syncCoordinator.captureScope()
  const normalized = materializeImport('mortgage-backup', text, () => ({
    loan_parts: (Array.isArray(parsed.loan_parts) ? parsed.loan_parts : []).filter((r): r is LoanPart => !!r && typeof r === 'object').map(r => stamp({ ...r }, 'part') as LoanPart),
    payments: (Array.isArray(parsed.payments) ? parsed.payments : []).filter((r): r is Payment => !!r && typeof r === 'object').map(r => stamp({ ...r }, 'pay') as Payment),
    valuations: (Array.isArray(parsed.valuations) ? parsed.valuations : []).filter((r): r is Valuation => !!r && typeof r === 'object').map(r => stamp({ ...r }, 'val') as Valuation),
    rate_periods: (Array.isArray(parsed.rate_periods) ? parsed.rate_periods : []).filter((r): r is RatePeriod => !!r && typeof r === 'object').map(r => stamp({ ...r }, 'rate') as RatePeriod),
    contributions: (Array.isArray(parsed.contributions) ? parsed.contributions : []).filter((r): r is Contribution => !!r && typeof r === 'object').map(r => stamp({ ...r }, 'contrib') as Contribution),
  }))

  const [parts, pays, vals, rates, contribs, existingSettings] = await Promise.all([
    listLoanParts(), listPayments(), listValuations(), listRatePeriods(), listContributions(), getSettings(),
  ])
  if (!scope.isActive()) throw new Error('Sync identity changed during mortgage import')

  const newParts = _mergeRows(parts, normalized.loan_parts)
  const newPays = _mergeRows(pays, normalized.payments)
  const newVals = _mergeRows(vals, normalized.valuations)
  const newRates = _mergeRows(rates, normalized.rate_periods)
  const newContribs = _mergeRows(contribs, normalized.contributions)
  const operations: MutationInput[] = []
  const add = <T extends { id?: string }>(resource: string, rows: T[], projected: Record<string, unknown>[], applyLocal: () => void) => {
    const ids = rows.map(r => r.id!)
    if (rows.length) operations.push({
      resource, operation: 'upsert', payload: { rows: projected, seed: true }, entityIds: ids,
      expectedRevisions: Object.fromEntries(ids.map((id) => [revisionKey(resource, id), null])), applyLocal,
    })
  }
  add(T.parts, newParts, newParts.map(r => _row(r, COLS.parts)), () => _patchCache(e => { e.loan_parts = [...newParts, ...e.loan_parts.filter(r => !new Set(newParts.map(x => x.id)).has(r.id))] }))
  add(T.payments, newPays, newPays.map(r => _row(r, COLS.payments)), () => _patchCache(e => { e.payments = [...newPays, ...e.payments.filter(r => !new Set(newPays.map(x => x.id)).has(r.id))] }))
  add(T.valuations, newVals, newVals.map(r => _row(r, COLS.valuations)), () => _patchCache(e => { e.valuations = [...newVals, ...e.valuations.filter(r => !new Set(newVals.map(x => x.id)).has(r.id))] }))
  add(T.periods, newRates, newRates.map(r => _row(r, COLS.periods)), () => _patchCache(e => { e.rate_periods = [...newRates, ...e.rate_periods.filter(r => !new Set(newRates.map(x => x.id)).has(r.id))] }))
  add(T.contributions, newContribs, newContribs.map(r => _row(r, COLS.contributions)), () => _patchCache(e => { e.contributions = [...newContribs, ...e.contributions.filter(r => !new Set(newContribs.map(x => x.id)).has(r.id))] }))
  if (parsed.settings && typeof parsed.settings === 'object') {
    const merged = { ...defaultSettings(), ...existingSettings, ...(parsed.settings as Partial<MortgageSettings>) }
    operations.push({
      resource: SETTINGS_RESOURCE, operation: 'upsert', payload: { data: merged, seed: true }, entityIds: [SETTINGS_TOOL],
      expectedRevisions: { [SETTINGS_RESOURCE]: syncCoordinator.getRevision(SETTINGS_RESOURCE) },
      applyLocal: () => _patchCache(e => { e.settings = merged }),
    })
  }
  if (!scope.isActive()) throw new Error('Sync identity changed during mortgage import')
  await syncCoordinator.mutateBatch(operations)

  return {
    loan_parts: newParts.length, payments: newPays.length, valuations: newVals.length,
    rate_periods: newRates.length, contributions: newContribs.length,
  }
}

// ── Re-export types for callers that only import from the store ──────────────
export type { LoanPart, RatePeriod, Payment, Valuation, Contribution, MortgageSettings, ColNameMapping, Bank, Mortgage }
