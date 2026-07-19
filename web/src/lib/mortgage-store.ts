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

import { defaultSettings, legacyContributionPayment, makeRatePeriod, migrateOwnershipSettings } from './mortgage'
import type { LoanPart, RatePeriod, Payment, Valuation, Contribution, MortgageSettings, ColNameMapping, Bank, Mortgage, CatalogBank } from './mortgage'
import { supabase } from './supabase'
import { makeImportOnce, materializeImport, stamp } from './store-helpers'
import type { MutationInput } from './sync-coordinator'
import { syncCoordinator } from './sync'
import { cachedTombstoneIds, loadTombstoneIds, queueTableDelete, queueTableUpsert, registerTableSync, withoutTombstones } from './sync-table'
import { legacyImportAssignedToActive } from './legacy-data'
import { parseFiniteJson, parseMortgageEnvelope, parseISODate, parseLoanPartId, salvageMortgageEnvelope, salvageMortgageRows } from './persistence-schema'
import { PersistenceError, reportPersistenceWarning } from './persistence-error'
import {
  receiptRpc, rejectLegacyToolOperation, rememberRowRevisions,
  rememberToolRevision, revisionKey, syncRpcResult,
} from './sync-rpc'

// Legacy pre-Supabase data — import source + backup. (Exported name kept for
// back-compat; it is no longer the write target.)
export const STORAGE_KEY = 'bostadskalkyl_mortgage_v1'
const CACHE_KEY = 'bostadskalkyl_mortgage_cache_v1'
// The shared, read-only bank catalogue (plan 109a) is not household data, so it
// lives outside the household-scoped envelope in its own defensive cache: an
// offline load or a fetch failure returns the last-seen rows (or an empty list)
// rather than crashing the profile modal.
const CATALOG_CACHE_KEY = 'bostadskalkyl_mortgage_catalog_v1'
const IMPORT_FLAG = 'bostadskalkyl_mortgage_supabase_imported'
// v6 (plan 109a): banks gain catalog_id, mortgages gain end_date, payments gain
// mortgage_id — all nullable, so v4/v5 envelopes still load (the parsers treat
// an absent field as null; no destructive migration step exists or is needed).
const VERSION = 6
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
// Plan 109a — the two atomic bank-change RPCs get their own sync resources so
// their queued operations keep the ordinary outbox/dirty/replay semantics.
const BANK_CHANGE_RESOURCE = 'mortgage-bank-change'
const BANK_REVERT_RESOURCE = 'mortgage-bank-change-revert'
// Reads of mortgages/loan parts must fall back to the cache while a queued
// bank change or revert is still unacknowledged, or the cloud read would
// overwrite the optimistic archive/create with the pre-change state.
const AGREEMENT_RESOURCES = [BANK_CHANGE_RESOURCE, BANK_REVERT_RESOURCE]

// The writable data columns per table. `id` + `created_at` are added by `_row`;
// `household_id` (column default) + `updated_at` (trigger) are never sent. Field
// names already match column names 1:1 (both snake_case), so a plain pick works.
const COLS = {
  banks: ['label', 'year_basis', 'year_basis_source', 'billing', 'billing_source', 'catalog_id'],
  mortgages: ['bank_id', 'label', 'start_date', 'archived', 'end_date'],
  parts: ['label', 'loan_number', 'start_balance', 'start_date', 'archived', 'mortgage_id', 'original_balance', 'original_date', 'planned_amortization', 'planned_amortization_start', 'planned_amortization_end'],
  periods: ['loan_part_id', 'start_date', 'end_date', 'rate', 'rate_type'],
  payments: ['loan_part_id', 'date', 'kind', 'description', 'amount', 'balance_after', 'paid_by', 'source', 'is_insats', 'paid_split', 'mortgage_id'],
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

// Every settings object that enters memory goes through this merge: defaults
// first, then the given layers, then the plan 111 ownership migration — so a
// legacy `i_am` + `my_ownership_pct` blob (cache, cloud tool_state, import or
// pre-Supabase backup) is normalized to the explicit `owner_a_ownership_pct`
// representation without changing any A/B result. Idempotent by construction.
function mergedSettings(...layers: Array<Partial<MortgageSettings> | undefined>): MortgageSettings {
  const merged: MortgageSettings = Object.assign(defaultSettings(), ...layers)
  // The DEFAULT A share (50) must never shadow a legacy blob that only carries
  // i_am/my_ownership_pct: unless some layer actually contains the explicit
  // field, force the migration to derive the share from the legacy fields.
  if (!layers.some((layer) => layer !== undefined && 'owner_a_ownership_pct' in layer)) {
    merged.owner_a_ownership_pct = Number.NaN
  }
  return migrateOwnershipSettings(merged)
}

function warning(source: string): void {
  reportPersistenceWarning(`Några sparade bolåneuppgifter kunde inte läsas från ${source}. Övriga sparade uppgifter finns kvar.`)
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
    delete (pr as unknown as Record<string, unknown>).interest_rate
    delete (pr as unknown as Record<string, unknown>).rate_type
    delete (pr as unknown as Record<string, unknown>).rate_binding_until
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
// column can be SET but never CLEARED unless its key is present as null.
// Scoped per table (plan 109a) because column names repeat across tables:
// loan-part rows must KEEP omit-null for mortgage_id (an explicit null would
// clear a part's agreement link on any stale-cache edit), while payment rows
// need explicit null so the database trigger derives provenance from the part.
const NULLABLE_EXPLICIT: Partial<Record<keyof typeof COLS, ReadonlySet<string>>> = {
  // The bank profile locks must be clearable back to auto; the catalogue link
  // must be detachable back to a private custom bank.
  banks: new Set(['year_basis', 'year_basis_source', 'billing', 'billing_source', 'catalog_id']),
  // Un-archiving an agreement must clear end_date in the same write, or the
  // database consistency CHECK ((end_date is null) = (not archived)) rejects it.
  mortgages: new Set(['end_date']),
  periods: new Set(['loan_part_id']),
  // A payment can be reclassified as a kontantinsats. These values must then
  // be cleared in the cloud row rather than omitted from the UPDATE payload.
  // mortgage_id: explicit null lets the 109a trigger derive part-linked
  // provenance (a stale client value would otherwise be rejected as a mismatch).
  payments: new Set(['loan_part_id', 'balance_after', 'paid_split', 'mortgage_id']),
}

// A full insert row: id + created_at (client-stamped) + the data columns. A
// null/undefined value is replaced by its NOT_NULL_DEFAULTS fallback if the
// column is NOT NULL, sent as an explicit null if it opts into NULLABLE_EXPLICIT,
// else dropped (nullable → left untouched on update). This means a legacy row
// with, e.g., paid_by null inserts 'joint' rather than an explicit null, so it
// works regardless of whether the DB column carries the default.
function _row(obj: { id?: string; created_at?: string }, table: keyof typeof COLS): Record<string, unknown> {
  const rec = obj as unknown as Record<string, unknown>
  const explicit = NULLABLE_EXPLICIT[table]
  const out: Record<string, unknown> = {}
  if (rec.id != null) out.id = rec.id
  if (rec.created_at != null) out.created_at = rec.created_at
  for (const c of COLS[table]) {
    if (rec[c] != null) out[c] = rec[c]
    else if (c in NOT_NULL_DEFAULTS) out[c] = NOT_NULL_DEFAULTS[c]
    else if (explicit?.has(c)) out[c] = null
  }
  return out
}

// Payment rows never send a client-side agreement id alongside a loan part:
// the 109a database trigger derives part-linked provenance from the part row
// itself, and a client value could only agree with it or be stale (and be
// rejected as 'mortgage provenance mismatch'). Explicit null = "derive".
function _paymentRow(payment: { id?: string; created_at?: string }): Record<string, unknown> {
  const out = _row(payment, 'payments')
  if (out.loan_part_id != null) out.mortgage_id = null
  return out
}

// ── localStorage cache (offline fallback) ────────────────────────────────────
function _emptyEnvelope(): StoreEnvelope {
  return { version: VERSION, banks: [], mortgages: [], loan_parts: [], payments: [], valuations: [], rate_periods: [], contributions: [], settings: defaultSettings() }
}

function canonicalPayment(row: Payment): Payment {
  if (row.kind === 'payment' || row.kind === 'interest') return { ...row, paid_by: 'joint', paid_split: null }
  if (row.kind === 'down_payment') return { ...row, loan_part_id: null, is_insats: true }
  return row
}

function canonicalizeEnvelope(env: StoreEnvelope): { value: StoreEnvelope; rejectedContributions: number } {
  const payments = env.payments.map(canonicalPayment)
  const seen = new Set(payments.map((row) => row.id))
  let rejectedContributions = 0
  for (const contribution of env.contributions) {
    const payment = legacyContributionPayment(contribution)
    if (!payment) { rejectedContributions++; continue }
    if (!seen.has(payment.id)) { seen.add(payment.id); payments.push(payment) }
  }
  return { value: { ...env, version: VERSION, payments, contributions: [] }, rejectedContributions }
}

function contributionFromPayment(payment: Payment): Contribution {
  return {
    id: payment.id,
    created_at: payment.created_at,
    owner: payment.paid_by,
    date: payment.date,
    amount: payment.amount,
    note: payment.description,
  }
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
    settings: mergedSettings(raw.settings as Partial<MortgageSettings> || {}),
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
    if (!data || typeof data !== 'object') { warning('cachen'); return _emptyEnvelope() }
    if (!parseFiniteJson(data).ok) { warning('cachen'); return _emptyEnvelope() }
    const parsed = salvageMortgageEnvelope(data)
    const canonical = canonicalizeEnvelope(parsed.value)
    if (parsed.rejected.length || canonical.rejectedContributions) warning('cachen')
    return canonical.value
  } catch { warning('cachen'); return _emptyEnvelope() }
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
type LegacyRead = { status: 'absent' } | { status: 'invalid' } | { status: 'valid'; value: StoreEnvelope }

// The v<4 migration must not turn a numeric-looking string into a number. The
// old fields are still persisted input at this boundary, so validate them
// before migrateToPeriods calls Number().
function validLegacyRateFields(raw: Record<string, unknown>): boolean {
  if (typeof raw.version === 'number' && Number.isFinite(raw.version) && raw.version >= 4) return true
  if (raw.version !== undefined && (typeof raw.version !== 'number' || !Number.isFinite(raw.version))) return false
  if (raw.loan_parts !== undefined && !Array.isArray(raw.loan_parts)) return false
  for (const part of (raw.loan_parts ?? [])) {
    if (!part || typeof part !== 'object') return false
    const row = part as Record<string, unknown>
    if (row.interest_rate !== undefined && row.interest_rate !== null && (typeof row.interest_rate !== 'number' || !Number.isFinite(row.interest_rate))) return false
    if (row.rate_binding_until !== undefined && row.rate_binding_until !== null && row.rate_binding_until !== '' && !parseISODate(row.rate_binding_until).ok) return false
  }
  if (raw.rate_changes !== undefined && !Array.isArray(raw.rate_changes)) return false
  for (const change of (raw.rate_changes ?? [])) {
    if (!change || typeof change !== 'object') return false
    const row = change as Record<string, unknown>
    if (!parseLoanPartId(row.loan_part_id).ok || !parseISODate(row.date).ok || typeof row.rate !== 'number' || !Number.isFinite(row.rate)) return false
  }
  return true
}

function validLegacyEnvelopeShape(raw: Record<string, unknown>): boolean {
  for (const key of ['banks', 'mortgages', 'loan_parts', 'payments', 'valuations', 'rate_periods', 'contributions'] as const) {
    if (raw[key] !== undefined && (!Array.isArray(raw[key]) || raw[key].some((row) => !row || typeof row !== 'object' || Array.isArray(row)))) return false
  }
  return raw.settings === undefined || raw.settings === null || (typeof raw.settings === 'object' && !Array.isArray(raw.settings))
}

function _readLegacy(scope: ReturnType<typeof syncCoordinator.captureScope>): LegacyRead {
  const raw = scope.read(STORAGE_KEY)
  if (raw === null) return { status: 'absent' }
  let data: unknown
  try {
    data = JSON.parse(raw)
    if (!data || typeof data !== 'object' || !parseFiniteJson(data).ok || !validLegacyEnvelopeShape(data as Record<string, unknown>) || !validLegacyRateFields(data as Record<string, unknown>)) { warning('säkerhetskopian'); return { status: 'invalid' } }
  } catch { warning('säkerhetskopian'); return { status: 'invalid' } }
  const candidate = materializeImport('mortgage-legacy', raw, () => {
    const env = _envelope(data as unknown as Record<string, unknown>, true)
    env.banks = env.banks.map(r => stamp({ label: '', year_basis: null, year_basis_source: null, billing: null, billing_source: null, catalog_id: null, ...(r as unknown as Record<string, unknown>) }, 'bank') as Bank)
    env.mortgages = env.mortgages.map(r => stamp({ bank_id: null, label: '', start_date: null, archived: false, end_date: null, ...(r as unknown as Record<string, unknown>) }, 'mortgage') as Mortgage)
    env.loan_parts = env.loan_parts.map(r => stamp(r, 'part') as LoanPart)
    env.payments = env.payments.map(r => stamp(r, 'pay') as Payment)
    env.valuations = env.valuations.map(r => stamp(r, 'val') as Valuation)
    env.rate_periods = env.rate_periods.map(r => stamp(r, 'rate') as RatePeriod)
    env.contributions = env.contributions.map(r => stamp(r, 'contrib') as Contribution)
    const normalized = {
      ...env,
      loan_parts: env.loan_parts.map((r) => ({ label: '', loan_number: '', start_balance: 0, start_date: '', archived: false, mortgage_id: null, original_balance: null, original_date: null, planned_amortization: null, planned_amortization_start: null, planned_amortization_end: null, ...(r as unknown as Record<string, unknown>) })),
      payments: env.payments.map((r) => ({ loan_part_id: null, date: '', kind: 'payment', description: '', amount: 0, balance_after: null, paid_by: 'joint', source: '', is_insats: false, paid_split: null, mortgage_id: null, ...(r as unknown as Record<string, unknown>) })),
      valuations: env.valuations.map((r) => ({ date: '', value: 0, note: '', is_purchase: false, ...(r as unknown as Record<string, unknown>) })),
      rate_periods: env.rate_periods.map((r) => ({ loan_part_id: null, start_date: '', end_date: null, rate: null, rate_type: 'rörlig', ...(r as unknown as Record<string, unknown>) })),
      contributions: env.contributions,
      settings: mergedSettings(env.settings),
    }
    const canonical = canonicalizeEnvelope(normalized as StoreEnvelope)
    if (canonical.rejectedContributions) warning('säkerhetskopian')
    return canonical.value
  })
  const parsed = parseMortgageEnvelope(candidate)
  if (!parsed.ok) { warning('säkerhetskopian'); return { status: 'invalid' } }
  return { status: 'valid', value: parsed.value }
}

// ── First-login import (one-time, idempotent) ───────────────────────────────
// On the first authenticated load after the household exists, upsert the legacy
// localStorage data into the five tables (keyed on id, so re-running adds
// nothing) + seed the settings tool_state row only if none exists yet (so a
// partner's saved settings aren't clobbered).
const _importLocalOnce = makeImportOnce(() => syncCoordinator.scopedStorageKey(IMPORT_FLAG), async () => {
  const scope = syncCoordinator.captureScope()
  if (!legacyImportAssignedToActive() || !scope.isActive()) return true
  const legacyRead = _readLegacy(scope)
  if (legacyRead.status === 'absent') return true
  if (legacyRead.status === 'invalid') return false
  const legacy = legacyRead.value
  const operations: MutationInput[] = []
  const add = <T extends { id?: string }>(resource: string, rows: T[], projected: Record<string, unknown>[], applyLocal: () => void) => {
    const ids = rows.map((row) => row.id!)
    if (rows.length) operations.push({
      resource, operation: 'upsert', payload: { rows: projected, seed: true }, entityIds: ids,
      expectedRevisions: Object.fromEntries(ids.map((id) => [revisionKey(resource, id), null])), applyLocal,
    })
  }
  add(T.parts, legacy.loan_parts, legacy.loan_parts.map(r => _row(r, 'parts')), () => _patchCache(e => { const ids = new Set(legacy.loan_parts.map(r => r.id)); e.loan_parts = [...legacy.loan_parts, ...e.loan_parts.filter(r => !ids.has(r.id))] }))
  add(T.periods, legacy.rate_periods, legacy.rate_periods.map(r => _row(r, 'periods')), () => _patchCache(e => { const ids = new Set(legacy.rate_periods.map(r => r.id)); e.rate_periods = [...legacy.rate_periods, ...e.rate_periods.filter(r => !ids.has(r.id))] }))
  add(T.payments, legacy.payments, legacy.payments.map(r => _paymentRow(r)), () => _patchCache(e => { const ids = new Set(legacy.payments.map(r => r.id)); e.payments = [...legacy.payments, ...e.payments.filter(r => !ids.has(r.id))] }))
  add(T.valuations, legacy.valuations, legacy.valuations.map(r => _row(r, 'valuations')), () => _patchCache(e => { const ids = new Set(legacy.valuations.map(r => r.id)); e.valuations = [...legacy.valuations, ...e.valuations.filter(r => !ids.has(r.id))] }))
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

// ── Atomic bank change + revert (plan 109a; no UI until 109c) ────────────────
// One durable outbox operation per call, replayed through the receipt RPCs.
// The client-generated new-agreement id in the payload doubles as the server's
// idempotence key: a lost response replayed later returns the already-created
// payload as success instead of a spurious revision mismatch.
export interface MortgageBankChangePart {
  id: string
  label: string
  balance: number
  planned_amortization?: number | null
}

export interface MortgageBankChangePayload {
  old_mortgage_id: string
  mortgage: { id: string; label: string; bank_id: string }
  parts: MortgageBankChangePart[]
  effective_date: string
}

function validBankChangePart(part: unknown): part is MortgageBankChangePart {
  if (!part || typeof part !== 'object') return false
  const p = part as Record<string, unknown>
  return typeof p.id === 'string' && !!p.id
    && typeof p.label === 'string'
    && typeof p.balance === 'number' && Number.isFinite(p.balance) && p.balance >= 0
    && (p.planned_amortization === undefined || p.planned_amortization === null
      || (typeof p.planned_amortization === 'number' && Number.isFinite(p.planned_amortization) && p.planned_amortization >= 0))
}

function validBankChangePayload(payload: unknown): payload is MortgageBankChangePayload {
  if (!payload || typeof payload !== 'object') return false
  const p = payload as Record<string, unknown>
  const mortgage = p.mortgage as Record<string, unknown> | undefined
  if (typeof p.old_mortgage_id !== 'string' || !p.old_mortgage_id) return false
  if (!mortgage || typeof mortgage !== 'object'
    || typeof mortgage.id !== 'string' || !mortgage.id || mortgage.id === p.old_mortgage_id
    || typeof mortgage.label !== 'string'
    || typeof mortgage.bank_id !== 'string' || !mortgage.bank_id) return false
  if (!parseISODate(p.effective_date).ok) return false
  if (!Array.isArray(p.parts) || !p.parts.every(validBankChangePart)) return false
  const ids = new Set(p.parts.map((part) => (part as MortgageBankChangePart).id))
  return ids.size === p.parts.length && !ids.has(mortgage.id) && !ids.has(p.old_mortgage_id)
}

syncCoordinator.register(BANK_CHANGE_RESOURCE, async (operation) => {
  const payload = operation.payload as MortgageBankChangePayload
  if (!validBankChangePayload(payload)) throw { status: 400, message: 'Malformed bank change' }
  const key = revisionKey(RESOURCES.mortgages, payload.old_mortgage_id)
  const expected = operation.expectedRevisions?.[key]
  if (expected == null) {
    // No trusted base revision (the agreement was never loaded through the
    // sync layer). Read the current one and surface a recoverable conflict —
    // never guess a base for an archive-and-replace of financial history.
    const { data, error } = await supabase.from(T.mortgages).select('id,revision').eq('id', payload.old_mortgage_id).maybeSingle()
    if (error) throw error
    const revision = Number((data as { revision?: unknown } | null)?.revision)
    throw {
      status: 409, message: 'bank change has no base revision',
      currentRevisions: { [key]: Number.isSafeInteger(revision) && revision > 0 ? revision : null },
    }
  }
  const { data, error } = await receiptRpc('sync_change_mortgage_bank', {
    p_operation_id: operation.id,
    p_old_mortgage_id: payload.old_mortgage_id,
    p_expected_old_revision: expected,
    // Rebuild both payloads key-by-key: the RPC hard-rejects any extra key.
    p_new_mortgage: { id: payload.mortgage.id, label: payload.mortgage.label, bank_id: payload.mortgage.bank_id },
    p_new_parts: payload.parts.map((part) => ({
      id: part.id, label: part.label, balance: part.balance,
      ...(part.planned_amortization !== undefined ? { planned_amortization: part.planned_amortization } : {}),
    })),
    p_effective_date: payload.effective_date,
  })
  if (error) throw error
  return syncRpcResult(data)
}, (operation) => operation.operation === 'upsert' && validBankChangePayload(operation.payload)
  && operation.entityIds.length === 1
  && operation.entityIds[0] === (operation.payload as MortgageBankChangePayload).mortgage.id)

syncCoordinator.register(BANK_REVERT_RESOURCE, async (operation) => {
  const id = (operation.payload as { id?: unknown })?.id
  if (operation.operation !== 'delete' || typeof id !== 'string' || !id) throw { status: 400, message: 'Malformed bank change revert' }
  const { data, error } = await receiptRpc('sync_revert_mortgage_bank_change', {
    p_operation_id: operation.id,
    p_mortgage_id: id,
    p_expected_revisions: operation.expectedRevisions ?? {},
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
  if (!scope.isActive() || [RESOURCES.parts, RESOURCES.periods, RESOURCES.payments, CASCADE_RESOURCE, ...AGREEMENT_RESOURCES].some((resource) => syncCoordinator.isDirty(resource))) {
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
  if (!scope.isActive() || [RESOURCES.parts, RESOURCES.periods, RESOURCES.payments, CASCADE_RESOURCE, ...AGREEMENT_RESOURCES].some((resource) => syncCoordinator.isDirty(resource))) {
    return fallback()
  }
  if (partsResult.error || periodsResult.error || paymentsResult.error ||
      !partsResult.data || !periodsResult.data || !paymentsResult.data) return null
  rememberRowRevisions(RESOURCES.parts, partsResult.data as unknown as Record<string, unknown>[])
  rememberRowRevisions(RESOURCES.periods, periodsResult.data as unknown as Record<string, unknown>[])
  rememberRowRevisions(RESOURCES.payments, paymentsResult.data as unknown as Record<string, unknown>[])
  const parsedParts = salvageMortgageRows(partsResult.data, 'loan_parts')
  const parsedPeriods = salvageMortgageRows(periodsResult.data, 'rate_periods')
  const parsedPayments = salvageMortgageRows(paymentsResult.data, 'payments')
  if (parsedParts.rejected.length || parsedPeriods.rejected.length || parsedPayments.rejected.length) warning('molnet')
  const snapshot: MortgageSyncSnapshot = {
    parts: withoutTombstones(parsedParts.value as LoanPart[], partTombstones),
    periods: withoutTombstones(parsedPeriods.value as RatePeriod[], periodTombstones),
    payments: withoutTombstones(parsedPayments.value as Payment[], paymentTombstones).map(canonicalPayment),
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

// ── Active-agreement balance snapshot (plan 118) ─────────────────────────────
// Purpose-built all-or-nothing read for Bostadskalkyl's "pull current balance"
// action. Loads mortgages + loan parts + payments under one captured household
// scope and returns RAW scoped rows only — the caller computes the balance via
// activeAgreementBalance(). Periods are not needed for the balance.
//
// Like loadMortgageSyncSnapshot, `null` is reserved for an unavailable live
// source (query error / missing data); an inactive-or-dirty scope returns the
// tombstone-filtered cache, which is authoritative-from-cache exactly as the
// sibling list reads treat it. The pull must never mistake a failed cloud read
// for an authoritative 0 kr balance.
export interface ActiveMortgageBalanceSnapshot {
  mortgages: Mortgage[]
  parts: LoanPart[]
  payments: Payment[]
}

const BALANCE_RESOURCES = [RESOURCES.mortgages, RESOURCES.parts, RESOURCES.payments, CASCADE_RESOURCE, ...AGREEMENT_RESOURCES]

export async function loadMortgageBalanceSnapshot(): Promise<ActiveMortgageBalanceSnapshot | null> {
  const scope = syncCoordinator.captureScope()
  const fallback = (): ActiveMortgageBalanceSnapshot => {
    const cache = _readCacheFrom(scope)
    return {
      mortgages: withoutTombstones(cache.mortgages, cachedTombstoneIds(scope, RESOURCES.mortgages)),
      parts: withoutTombstones(cache.loan_parts, cachedTombstoneIds(scope, RESOURCES.parts)),
      payments: withoutTombstones(cache.payments, cachedTombstoneIds(scope, RESOURCES.payments)),
    }
  }
  await _importLocalOnce()
  if (!scope.isActive() || BALANCE_RESOURCES.some((resource) => syncCoordinator.isDirty(resource))) {
    return fallback()
  }
  const [mortgagesResult, partsResult, paymentsResult, mortgageTombstones, partTombstones, paymentTombstones] = await Promise.all([
    supabase.from(T.mortgages).select('*').order('created_at', { ascending: true }),
    supabase.from(T.parts).select('*').order('created_at', { ascending: true }),
    supabase.from(T.payments).select('*'),
    loadTombstoneIds(scope, RESOURCES.mortgages),
    loadTombstoneIds(scope, RESOURCES.parts),
    loadTombstoneIds(scope, RESOURCES.payments),
  ])
  if (!scope.isActive() || BALANCE_RESOURCES.some((resource) => syncCoordinator.isDirty(resource))) {
    return fallback()
  }
  if (mortgagesResult.error || partsResult.error || paymentsResult.error ||
      !mortgagesResult.data || !partsResult.data || !paymentsResult.data) return null
  rememberRowRevisions(RESOURCES.mortgages, mortgagesResult.data as unknown as Record<string, unknown>[])
  rememberRowRevisions(RESOURCES.parts, partsResult.data as unknown as Record<string, unknown>[])
  rememberRowRevisions(RESOURCES.payments, paymentsResult.data as unknown as Record<string, unknown>[])
  const parsedMortgages = salvageMortgageRows(mortgagesResult.data, 'mortgages')
  const parsedParts = salvageMortgageRows(partsResult.data, 'loan_parts')
  const parsedPayments = salvageMortgageRows(paymentsResult.data, 'payments')
  if (parsedMortgages.rejected.length || parsedParts.rejected.length || parsedPayments.rejected.length) warning('molnet')
  const snapshot: ActiveMortgageBalanceSnapshot = {
    mortgages: withoutTombstones(parsedMortgages.value as Mortgage[], mortgageTombstones),
    parts: withoutTombstones(parsedParts.value as LoanPart[], partTombstones),
    payments: withoutTombstones(parsedPayments.value as Payment[], paymentTombstones).map(canonicalPayment),
  }
  const cache = _readCacheFrom(scope)
  {
    cache.mortgages = snapshot.mortgages
    cache.loan_parts = snapshot.parts
    cache.payments = snapshot.payments
  }
  scope.write(CACHE_KEY, JSON.stringify(cache))
  return snapshot
}

export async function listLoanParts(): Promise<LoanPart[]> {
  const scope = syncCoordinator.captureScope()
  await _importLocalOnce()
  const fallback = () => withoutTombstones(_readCacheFrom(scope).loan_parts, cachedTombstoneIds(scope, RESOURCES.parts))
  if (!scope.isActive() || syncCoordinator.isDirty(RESOURCES.parts) || syncCoordinator.isDirty(CASCADE_RESOURCE) || AGREEMENT_RESOURCES.some((resource) => syncCoordinator.isDirty(resource))) return fallback()
  const [result, tombstones] = await Promise.all([
    supabase.from(T.parts).select('*').order('created_at', { ascending: true }), loadTombstoneIds(scope, RESOURCES.parts),
  ])
  if (!scope.isActive() || syncCoordinator.isDirty(RESOURCES.parts) || syncCoordinator.isDirty(CASCADE_RESOURCE) || AGREEMENT_RESOURCES.some((resource) => syncCoordinator.isDirty(resource))) return fallback()
  if (result.error || !result.data) return fallback()
  rememberRowRevisions(RESOURCES.parts, result.data as unknown as Record<string, unknown>[])
  const parsed = salvageMortgageRows(result.data, 'loan_parts'); if (parsed.rejected.length) warning('molnet')
  const rows = withoutTombstones(parsed.value as LoanPart[], tombstones)
  const cache = _readCacheFrom(scope); cache.loan_parts = rows; scope.write(CACHE_KEY, JSON.stringify(cache))
  return rows.slice()
}

export async function addLoanPart(record: Omit<LoanPart, 'id' | 'created_at'>): Promise<LoanPart> {
  const saved = stamp(record, 'part') as LoanPart
  await queueTableUpsert(RESOURCES.parts, [_row(saved, 'parts')], [saved.id], () => _patchCache(e => { e.loan_parts.push(saved) }))
  return saved
}

export async function updateLoanPart(id: string, patch: Partial<LoanPart>): Promise<LoanPart | null> {
  const current = _readCache().loan_parts.find((part) => part.id === id)
  if (!current) return null
  const saved = { ...current, ...patch }
  await queueTableUpsert(RESOURCES.parts, [_row(saved, 'parts')], [id], () => {
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
  rememberRowRevisions(RESOURCES.banks, result.data as unknown as Record<string, unknown>[])
  const parsed = salvageMortgageRows(result.data, 'banks'); if (parsed.rejected.length) warning('molnet')
  const rows = withoutTombstones(parsed.value as Bank[], tombstones)
  const cache = _readCacheFrom(scope); cache.banks = rows; scope.write(CACHE_KEY, JSON.stringify(cache))
  return rows.slice()
}

export async function addBank(record: Omit<Bank, 'id' | 'created_at'>): Promise<Bank> {
  const saved = stamp(record, 'bank') as Bank
  await queueTableUpsert(RESOURCES.banks, [_row(saved, 'banks')], [saved.id], () => _patchCache(e => { e.banks.push(saved) }))
  return saved
}

export async function updateBank(id: string, patch: Partial<Bank>): Promise<Bank | null> {
  const current = _readCache().banks.find((bank) => bank.id === id)
  if (!current) return null
  const saved = { ...current, ...patch }
  await queueTableUpsert(RESOURCES.banks, [_row(saved, 'banks')], [id], () => _patchCache(e => { e.banks = e.banks.map(b => b?.id === id ? saved : b) }))
  return saved
}

export async function removeBank(id: string): Promise<number> {
  let n = 0
  await queueTableDelete(RESOURCES.banks, [id], () => _patchCache(e => { e.banks = e.banks.filter(b => b?.id !== id); n = e.banks.length }))
  return n
}

// ── Shared bank catalogue (plan 109a; read-only) ─────────────────────────────
// Authenticated clients may SELECT `mortgage_bank_catalog` but never write it
// (writes go through reviewed migrations). It is not household-scoped, so it is
// a plain direct select — no outbox, no revisions — with a defensive cache so an
// offline load or a cloud error returns the last-seen rows instead of crashing.
function normalizeCatalogBank(row: unknown): CatalogBank | null {
  if (!row || typeof row !== 'object') return null
  const r = row as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id || typeof r.label !== 'string') return null
  const yb = Number(r.year_basis)
  return {
    id: r.id,
    slug: typeof r.slug === 'string' ? r.slug : undefined,
    label: r.label,
    year_basis: yb === 360 ? 360 : yb === 365 ? 365 : null,
    billing: r.billing === 'month-end' || r.billing === 'fixed' ? r.billing : null,
  }
}

function _readCatalogCache(scope: ReturnType<typeof syncCoordinator.captureScope>): CatalogBank[] {
  try {
    const raw = scope.read(CATALOG_CACHE_KEY)
    if (!raw) return []
    const data = JSON.parse(raw)
    return Array.isArray(data) ? data.map(normalizeCatalogBank).filter((b): b is CatalogBank => b != null) : []
  } catch { return [] }
}

export async function listCatalogBanks(): Promise<CatalogBank[]> {
  const scope = syncCoordinator.captureScope()
  if (!scope.isActive()) return _readCatalogCache(scope)
  const { data, error } = await supabase
    .from('mortgage_bank_catalog')
    .select('id,slug,label,year_basis,billing')
    .order('label', { ascending: true })
  if (!scope.isActive() || error || !data) return _readCatalogCache(scope)
  const rows = (data as unknown[]).map(normalizeCatalogBank).filter((b): b is CatalogBank => b != null)
  try { scope.write(CATALOG_CACHE_KEY, JSON.stringify(rows)) } catch { /* private mode / quota */ }
  return rows
}

// ── Mortgages (plan 103) ─────────────────────────────────────────────────────
export async function listMortgages(): Promise<Mortgage[]> {
  const scope = syncCoordinator.captureScope()
  await _importLocalOnce()
  const fallback = () => withoutTombstones(_readCacheFrom(scope).mortgages, cachedTombstoneIds(scope, RESOURCES.mortgages))
  if (!scope.isActive() || syncCoordinator.isDirty(RESOURCES.mortgages) || AGREEMENT_RESOURCES.some((resource) => syncCoordinator.isDirty(resource))) return fallback()
  const [result, tombstones] = await Promise.all([
    supabase.from(T.mortgages).select('*').order('created_at', { ascending: true }), loadTombstoneIds(scope, RESOURCES.mortgages),
  ])
  if (!scope.isActive() || syncCoordinator.isDirty(RESOURCES.mortgages) || AGREEMENT_RESOURCES.some((resource) => syncCoordinator.isDirty(resource))) return fallback()
  if (result.error || !result.data) return fallback()
  rememberRowRevisions(RESOURCES.mortgages, result.data as unknown as Record<string, unknown>[])
  const parsed = salvageMortgageRows(result.data, 'mortgages'); if (parsed.rejected.length) warning('molnet')
  const rows = withoutTombstones(parsed.value as Mortgage[], tombstones)
  const cache = _readCacheFrom(scope); cache.mortgages = rows; scope.write(CACHE_KEY, JSON.stringify(cache))
  return rows.slice()
}

export async function addMortgage(record: Omit<Mortgage, 'id' | 'created_at'>): Promise<Mortgage> {
  const saved = stamp(record, 'mort') as Mortgage
  await queueTableUpsert(RESOURCES.mortgages, [_row(saved, 'mortgages')], [saved.id], () => _patchCache(e => { e.mortgages.push(saved) }))
  return saved
}

export async function updateMortgage(id: string, patch: Partial<Mortgage>): Promise<Mortgage | null> {
  const current = _readCache().mortgages.find((mortgage) => mortgage.id === id)
  if (!current) return null
  const saved = { ...current, ...patch }
  await queueTableUpsert(RESOURCES.mortgages, [_row(saved, 'mortgages')], [id], () => _patchCache(e => { e.mortgages = e.mortgages.map(m => m?.id === id ? saved : m) }))
  return saved
}

export async function removeMortgage(id: string): Promise<number> {
  let n = 0
  await queueTableDelete(RESOURCES.mortgages, [id], () => _patchCache(e => { e.mortgages = e.mortgages.filter(m => m?.id !== id); n = e.mortgages.length }))
  return n
}

// ── Atomic bank change / Ångra bankbyte (plan 109a; exported, UI in 109c) ────

export interface MortgageBankChangeInput {
  /** The active agreement being closed. */
  old_mortgage_id: string
  /** The household's private bank profile the new agreement moves to. */
  bank_id: string
  /** Label for the new agreement ('' lets the UI render its fallback). */
  label: string
  /** Confirmed opening parts — drafts, not history (plan 109 decision 4). */
  parts: Array<{ label: string; balance: number; planned_amortization?: number | null }>
  /** ISO date; becomes the old agreement's end_date AND the new one's start_date. */
  effective_date: string
}

/**
 * Archive the active agreement and create its successor at the new bank, in
 * one database transaction (`sync_change_mortgage_bank`). Returns the
 * optimistically created rows (ids are client-generated up front — the new
 * agreement id is the server's idempotence key, so a replay after a lost
 * response can never produce two active agreements). A revision conflict
 * rejects with a PersistenceError('conflict') and leaves the operation in the
 * outbox with the server's current revisions attached for explicit resolution.
 */
export async function changeMortgageBank(input: MortgageBankChangeInput): Promise<{ mortgage: Mortgage; parts: LoanPart[] }> {
  const mortgage: Mortgage = stamp({
    bank_id: input.bank_id, label: input.label, start_date: input.effective_date, archived: false, end_date: null,
  }, 'mort') as Mortgage
  const parts: LoanPart[] = input.parts.map((part) => stamp({
    label: part.label, loan_number: '',
    start_balance: part.balance, start_date: input.effective_date, archived: false,
    mortgage_id: mortgage.id, original_balance: part.balance, original_date: input.effective_date,
    planned_amortization: part.planned_amortization ?? null,
    planned_amortization_start: part.planned_amortization != null ? input.effective_date : null,
    planned_amortization_end: null,
  }, 'part') as LoanPart)
  const payload: MortgageBankChangePayload = {
    old_mortgage_id: input.old_mortgage_id,
    mortgage: { id: mortgage.id, label: mortgage.label, bank_id: input.bank_id },
    parts: parts.map((part) => ({
      id: part.id, label: part.label, balance: part.start_balance,
      ...(part.planned_amortization != null ? { planned_amortization: part.planned_amortization } : {}),
    })),
    effective_date: input.effective_date,
  }
  const oldKey = revisionKey(RESOURCES.mortgages, input.old_mortgage_id)
  await syncCoordinator.mutate({
    resource: BANK_CHANGE_RESOURCE, operation: 'upsert', payload, entityIds: [mortgage.id],
    expectedRevisions: { [oldKey]: syncCoordinator.getRevision(oldKey) },
    // Mirrors the RPC's own writes so the cache agrees until the next cloud
    // read reconciles (server stamps created_at itself).
    applyLocal: () => _patchCache(e => {
      e.mortgages = e.mortgages
        .map(m => m?.id === input.old_mortgage_id ? { ...m, archived: true, end_date: input.effective_date } : m)
        .filter(m => m?.id !== mortgage.id)
      e.mortgages.push(mortgage)
      const partIds = new Set(parts.map((part) => part.id))
      e.loan_parts = [...e.loan_parts.filter(p => !(p && partIds.has(p.id))), ...parts]
    }),
  })
  return { mortgage, parts }
}

/**
 * Ångra bankbyte: delete the (pristine) new agreement and its parts and
 * reactivate the predecessor, atomically (`sync_revert_mortgage_bank_change`).
 * The server refuses (validation error) when any payment or rate period
 * references the new agreement or its parts — partial reverts are impossible.
 */
export async function revertMortgageBankChange(newMortgageId: string): Promise<void> {
  const cache = _readCache()
  const target = cache.mortgages.find(m => m?.id === newMortgageId)
  const partIds = cache.loan_parts.filter(p => p?.mortgage_id === newMortgageId).map(p => p.id)
  const previous = target
    ? cache.mortgages.find(m => m && m.id !== newMortgageId && m.archived && (m.end_date ?? null) === (target.start_date ?? null))
    : undefined
  // The RPC verifies the expected revisions of the target, its parts AND the
  // predecessor before touching anything; unknown entries stay null and simply
  // surface as a recoverable conflict rather than guessing.
  const keys = [
    revisionKey(RESOURCES.mortgages, newMortgageId),
    ...(previous ? [revisionKey(RESOURCES.mortgages, previous.id)] : []),
    ...partIds.map((id) => revisionKey(RESOURCES.parts, id)),
  ]
  await syncCoordinator.mutate({
    resource: BANK_REVERT_RESOURCE, operation: 'delete', payload: { id: newMortgageId }, entityIds: [newMortgageId],
    expectedRevisions: Object.fromEntries(keys.map((key) => [key, syncCoordinator.getRevision(key)])),
    applyLocal: () => _patchCache(e => {
      e.loan_parts = e.loan_parts.filter(p => p?.mortgage_id !== newMortgageId)
      e.mortgages = e.mortgages
        .filter(m => m?.id !== newMortgageId)
        .map(m => previous && m?.id === previous.id ? { ...m, archived: false, end_date: null } : m)
    }),
  })
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
  rememberRowRevisions(RESOURCES.payments, result.data as unknown as Record<string, unknown>[])
  const parsed = salvageMortgageRows(result.data, 'payments'); if (parsed.rejected.length) warning('molnet')
  const rows = withoutTombstones(parsed.value as Payment[], tombstones).map(canonicalPayment)
  const cache = _readCacheFrom(scope); cache.payments = rows; scope.write(CACHE_KEY, JSON.stringify(cache))
  return byDateDesc(rows)
}

// Plan 109a — a NEW partless down payment must carry its agreement id (the
// database trigger rejects the insert otherwise). Per the owner decision the
// store defaults it to the household's one active agreement; callers (109c's
// selector UI) may pass an explicit mortgage_id instead. Existing rows are
// never re-assigned here — legacy null provenance stays until repaired in 109c.
async function _activeMortgageId(): Promise<string> {
  const active = (await listMortgages()).find((mortgage) => mortgage && !mortgage.archived)
  if (!active) {
    // Surfaces through persistenceErrorMessage verbatim (toPersistenceError
    // returns an existing PersistenceError as-is), so the user sees why the
    // save was refused instead of the generic validation copy.
    throw Object.assign(new PersistenceError('validation'), {
      message: 'Kontantinsatsen kunde inte sparas: hushållet saknar ett aktivt bolåneavtal.',
    })
  }
  return active.id
}

async function _withDownPaymentProvenance(rows: Payment[]): Promise<Payment[]> {
  if (!rows.some((row) => row.kind === 'down_payment' && row.mortgage_id == null)) return rows
  const mortgageId = await _activeMortgageId()
  return rows.map((row) => row.kind === 'down_payment' && row.mortgage_id == null
    ? { ...row, mortgage_id: mortgageId }
    : row)
}

export async function addPayment(record: Omit<Payment, 'id' | 'created_at'>): Promise<Payment> {
  const [saved] = await _withDownPaymentProvenance([canonicalPayment(stamp(record, 'pay') as Payment)])
  await queueTableUpsert(RESOURCES.payments, [_paymentRow(saved)], [saved.id], () => _patchCache(e => { e.payments.push(saved) }))
  return saved
}

export async function addPayments(records: Array<Omit<Payment, 'id' | 'created_at'>>): Promise<Payment[]> {
  const saved = await _withDownPaymentProvenance(records.map(r => canonicalPayment(stamp(r, 'pay') as Payment)))
  await queueTableUpsert(RESOURCES.payments, saved.map(r => _paymentRow(r)), saved.map((row) => row.id), () => _patchCache(e => { e.payments = e.payments.concat(saved) }))
  return saved
}

export async function updatePayment(id: string, patch: Partial<Payment>): Promise<Payment | null> {
  const current = _readCache().payments.find((payment) => payment.id === id)
  if (!current) return null
  const saved = canonicalPayment({ ...current, ...patch })
  await queueTableUpsert(RESOURCES.payments, [_paymentRow(saved)], [id], () => _patchCache(e => { e.payments = e.payments.map(p => p?.id === id ? saved : p) }))
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
  rememberRowRevisions(RESOURCES.valuations, result.data as unknown as Record<string, unknown>[])
  const parsed = salvageMortgageRows(result.data, 'valuations'); if (parsed.rejected.length) warning('molnet')
  const rows = withoutTombstones(parsed.value as Valuation[], tombstones)
  const cache = _readCacheFrom(scope); cache.valuations = rows; scope.write(CACHE_KEY, JSON.stringify(cache))
  return byDateDesc(rows)
}

export async function addValuation(record: Omit<Valuation, 'id' | 'created_at'>): Promise<Valuation> {
  const saved = stamp(record, 'val') as Valuation
  await queueTableUpsert(RESOURCES.valuations, [_row(saved, 'valuations')], [saved.id], () => _patchCache(e => { e.valuations.push(saved) }))
  return saved
}

export async function updateValuation(id: string, patch: Partial<Valuation>): Promise<Valuation | null> {
  const current = _readCache().valuations.find((valuation) => valuation.id === id)
  if (!current) return null
  const saved = { ...current, ...patch }
  await queueTableUpsert(RESOURCES.valuations, [_row(saved, 'valuations')], [id], () => _patchCache(e => { e.valuations = e.valuations.map(v => v?.id === id ? saved : v) }))
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
  rememberRowRevisions(RESOURCES.periods, result.data as unknown as Record<string, unknown>[])
  const parsed = salvageMortgageRows(result.data, 'rate_periods'); if (parsed.rejected.length) warning('molnet')
  const rows = withoutTombstones(parsed.value as RatePeriod[], tombstones)
  const cache = _readCacheFrom(scope); cache.rate_periods = rows; scope.write(CACHE_KEY, JSON.stringify(cache))
  return byStartDesc(rows)
}

export async function addRatePeriod(record: Omit<RatePeriod, 'id' | 'created_at'>): Promise<RatePeriod> {
  const saved = stamp(record, 'rate') as RatePeriod
  await queueTableUpsert(RESOURCES.periods, [_row(saved, 'periods')], [saved.id], () => _patchCache(e => { e.rate_periods.push(saved) }))
  return saved
}

export async function updateRatePeriod(id: string, patch: Partial<RatePeriod>): Promise<RatePeriod | null> {
  const current = _readCache().rate_periods.find((period) => period.id === id)
  if (!current) return null
  const saved = { ...current, ...patch }
  await queueTableUpsert(RESOURCES.periods, [_row(saved, 'periods')], [id], () => _patchCache(e => { e.rate_periods = e.rate_periods.map(r => r?.id === id ? saved : r) }))
  return saved
}

export async function removeRatePeriod(id: string): Promise<number> {
  let n = 0
  await queueTableDelete(RESOURCES.periods, [id], () => _patchCache(e => { e.rate_periods = e.rate_periods.filter(r => r?.id !== id); n = e.rate_periods.length }))
  return n
}

// ── Contributions ────────────────────────────────────────────────────────────
export async function listContributions(): Promise<Contribution[]> {
  return byDateDesc((await listPayments()).filter((payment) => payment.kind === 'down_payment').map(contributionFromPayment))
}

export async function addContribution(record: Omit<Contribution, 'id' | 'created_at'>): Promise<Contribution> {
  const saved = await addPayment({
    loan_part_id: null, date: record.date, kind: 'down_payment', description: record.note,
    amount: record.amount, balance_after: null, paid_by: record.owner, source: 'manual', is_insats: true,
  })
  return contributionFromPayment(saved)
}

export async function updateContribution(id: string, patch: Partial<Contribution>): Promise<Contribution | null> {
  const saved = await updatePayment(id, {
    ...(patch.date !== undefined ? { date: patch.date } : {}),
    ...(patch.amount !== undefined ? { amount: patch.amount } : {}),
    ...(patch.owner !== undefined ? { paid_by: patch.owner } : {}),
    ...(patch.note !== undefined ? { description: patch.note } : {}),
    kind: 'down_payment', loan_part_id: null, is_insats: true,
  })
  return saved ? contributionFromPayment(saved) : null
}

export async function removeContribution(id: string): Promise<number> {
  return removePayment(id)
}

// ── Settings (tool_state blob) ───────────────────────────────────────────────
export async function getSettings(): Promise<MortgageSettings> {
  const scope = syncCoordinator.captureScope()
  await _importLocalOnce()
  if (!scope.isActive() || syncCoordinator.isDirty(SETTINGS_RESOURCE)) return mergedSettings(_readCacheFrom(scope).settings)
  const { data, error } = await supabase.from(STATE).select('data,revision').eq('tool', SETTINGS_TOOL).maybeSingle()
  if (!scope.isActive() || syncCoordinator.isDirty(SETTINGS_RESOURCE)) return mergedSettings(_readCacheFrom(scope).settings)
  if (error) return mergedSettings(_readCacheFrom(scope).settings)
  rememberToolRevision(SETTINGS_TOOL, data)
  const settings = mergedSettings((data?.data as Partial<MortgageSettings>) || {})
  const cache = _readCacheFrom(scope); cache.settings = settings; scope.write(CACHE_KEY, JSON.stringify(cache))
  return settings
}

export async function saveSettings(patch: Partial<MortgageSettings>): Promise<MortgageSettings> {
  const scope = syncCoordinator.captureScope()
  const current = await getSettings()
  if (!scope.isActive()) throw new Error('Sync identity changed while saving settings')
  const merged = mergedSettings(current, patch)
  await syncCoordinator.mutate({
    resource: SETTINGS_RESOURCE, operation: 'upsert', payload: { data: merged }, entityIds: [SETTINGS_TOOL],
    expectedRevisions: { [SETTINGS_RESOURCE]: syncCoordinator.getRevision(SETTINGS_RESOURCE) },
    applyLocal: () => _patchCache(e => { e.settings = merged }),
  })
  return merged
}

// ── Backup / restore ─────────────────────────────────────────────────────────
export async function exportJSON(): Promise<string> {
  const [banks, mortgages, loan_parts, payments, valuations, rate_periods, settings] = await Promise.all([
    listBanks(), listMortgages(), listLoanParts(), listPayments(), listValuations(), listRatePeriods(), getSettings(),
  ])
  return JSON.stringify({ version: VERSION, banks, mortgages, loan_parts, payments: byDateDesc(payments), valuations: byDateDesc(valuations), rate_periods, contributions: [], settings }, null, 2)
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
  // Contributions are the one retired legacy slice. Parse the rest strictly,
  // salvage valid contribution siblings, and convert them to canonical payments.
  const legacyContributions = salvageMortgageRows(parsed.contributions ?? [], 'contributions')
  const valid = parseMortgageEnvelope({ ...parsed, contributions: [] })
  if (!valid.ok) throw new Error('Bolånekoll-säkerhetskopian innehåller ogiltiga eller ofullständiga uppgifter.')
  if (!parsed.loan_parts && !parsed.payments && !parsed.valuations && !parsed.rate_periods && !parsed.contributions && !parsed.banks && !parsed.mortgages) throw new Error('No Bolånekoll data found.')

  const incomingPayments = valid.value.payments.map((row) => canonicalPayment(row as Payment))
  const incomingIds = new Set(incomingPayments.map((row) => row.id))
  let rejectedContributions = legacyContributions.rejected.length
  for (const contribution of legacyContributions.value as Contribution[]) {
    const payment = legacyContributionPayment(contribution)
    if (!payment) { rejectedContributions++; continue }
    if (!incomingIds.has(payment.id)) { incomingIds.add(payment.id); incomingPayments.push(payment) }
  }
  if (rejectedContributions) warning('säkerhetskopian')

  const scope = syncCoordinator.captureScope()
  const normalized = materializeImport('mortgage-backup', text, () => ({
    banks: valid.value.banks, mortgages: valid.value.mortgages,
    loan_parts: valid.value.loan_parts, payments: incomingPayments, valuations: valid.value.valuations,
    rate_periods: valid.value.rate_periods,
  }))

  const [banks, mortgages, parts, pays, vals, rates, existingSettings] = await Promise.all([
    listBanks(), listMortgages(), listLoanParts(), listPayments(), listValuations(), listRatePeriods(), getSettings(),
  ])
  if (!scope.isActive()) throw new Error('Sync identity changed during mortgage import')

  const newBanks = _mergeRows(banks, normalized.banks)
  const newMortgages = _mergeRows(mortgages, normalized.mortgages)
  const newParts = _mergeRows(parts, normalized.loan_parts)
  const newPays = _mergeRows(pays, normalized.payments)
  const newVals = _mergeRows(vals, normalized.valuations)
  const newRates = _mergeRows(rates, normalized.rate_periods)
  const operations: MutationInput[] = []
  const add = <T extends { id?: string }>(resource: string, rows: T[], projected: Record<string, unknown>[], applyLocal: () => void) => {
    const ids = rows.map(r => r.id!)
    if (rows.length) operations.push({
      resource, operation: 'upsert', payload: { rows: projected, seed: true }, entityIds: ids,
      expectedRevisions: Object.fromEntries(ids.map((id) => [revisionKey(resource, id), null])), applyLocal,
    })
  }
  add(T.banks, newBanks, newBanks.map(r => _row(r, 'banks')), () => _patchCache(e => { e.banks = [...newBanks, ...e.banks.filter(r => !new Set(newBanks.map(x => x.id)).has(r.id))] }))
  add(T.mortgages, newMortgages, newMortgages.map(r => _row(r, 'mortgages')), () => _patchCache(e => { e.mortgages = [...newMortgages, ...e.mortgages.filter(r => !new Set(newMortgages.map(x => x.id)).has(r.id))] }))
  add(T.parts, newParts, newParts.map(r => _row(r, 'parts')), () => _patchCache(e => { e.loan_parts = [...newParts, ...e.loan_parts.filter(r => !new Set(newParts.map(x => x.id)).has(r.id))] }))
  add(T.payments, newPays, newPays.map(r => _paymentRow(r)), () => _patchCache(e => { e.payments = [...newPays, ...e.payments.filter(r => !new Set(newPays.map(x => x.id)).has(r.id))] }))
  add(T.valuations, newVals, newVals.map(r => _row(r, 'valuations')), () => _patchCache(e => { e.valuations = [...newVals, ...e.valuations.filter(r => !new Set(newVals.map(x => x.id)).has(r.id))] }))
  add(T.periods, newRates, newRates.map(r => _row(r, 'periods')), () => _patchCache(e => { e.rate_periods = [...newRates, ...e.rate_periods.filter(r => !new Set(newRates.map(x => x.id)).has(r.id))] }))
  if (parsed.settings && typeof parsed.settings === 'object') {
    // Use the PARSED settings, not the raw import object: parseMortgageEnvelope
    // has validated them and already migrated a legacy `i_am`/`my_ownership_pct`
    // backup to the explicit `owner_a_ownership_pct` representation. Spreading
    // the raw legacy fields over an already-migrated `existingSettings` would
    // let the existing explicit A share silently win over the imported split.
    const merged = mergedSettings(existingSettings, valid.value.settings)
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
    rate_periods: newRates.length, contributions: 0,
  }
}

// ── Re-export types for callers that only import from the store ──────────────
export type { LoanPart, RatePeriod, Payment, Valuation, Contribution, MortgageSettings, ColNameMapping, Bank, Mortgage, CatalogBank }
