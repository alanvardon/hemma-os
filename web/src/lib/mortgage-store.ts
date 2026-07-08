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
import type { LoanPart, RatePeriod, Payment, Valuation, Contribution, MortgageSettings, ColNameMapping } from './mortgage'
import { supabase } from './supabase'
import { genId } from './id'

// Legacy pre-Supabase data — import source + backup. (Exported name kept for
// back-compat; it is no longer the write target.)
export const STORAGE_KEY = 'bostadskalkyl_mortgage_v1'
const CACHE_KEY = 'bostadskalkyl_mortgage_cache_v1'
const IMPORT_FLAG = 'bostadskalkyl_mortgage_supabase_imported'
const VERSION = 4
const STATE = 'tool_state'
const SETTINGS_TOOL = 'bolanekoll-settings'

const T = {
  parts: 'mortgage_loan_parts',
  periods: 'mortgage_rate_periods',
  payments: 'mortgage_payments',
  valuations: 'mortgage_valuations',
  contributions: 'mortgage_contributions',
} as const

// The writable data columns per table. `id` + `created_at` are added by `_row`;
// `household_id` (column default) + `updated_at` (trigger) are never sent. Field
// names already match column names 1:1 (both snake_case), so a plain pick works.
const COLS = {
  parts: ['label', 'loan_number', 'start_balance', 'start_date', 'archived'],
  periods: ['loan_part_id', 'start_date', 'end_date', 'rate', 'rate_type'],
  payments: ['loan_part_id', 'date', 'kind', 'description', 'amount', 'balance_after', 'paid_by', 'source', 'is_insats', 'paid_split'],
  valuations: ['date', 'value', 'note', 'is_purchase'],
  contributions: ['owner', 'date', 'amount', 'note'],
} as const

interface StoreEnvelope {
  version: number
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

function stamp<T extends object>(record: T, prefix: string): T & { id: string; created_at: string } {
  const r = record as Record<string, unknown>
  return { ...record, id: (r.id as string) || genId(prefix), created_at: (r.created_at as string) || new Date().toISOString() } as T & { id: string; created_at: string }
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

// ── Row projection ───────────────────────────────────────────────────────────
// Pick the given columns off any row/patch object. Accepts `object` (not
// Record<string, unknown>) so the concrete interface types — which have no
// implicit index signature — pass without a cast at every call site.
function _pick(obj: object, cols: readonly string[]): Record<string, unknown> {
  const rec = obj as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const c of cols) if (rec[c] !== undefined) out[c] = rec[c]
  return out
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

// A full insert row: id + created_at (client-stamped) + the data columns. A
// null/undefined value is replaced by its NOT_NULL_DEFAULTS fallback if the
// column is NOT NULL, else dropped (nullable → null). This means a legacy row
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
  }
  return out
}

// ── localStorage cache (offline fallback) ────────────────────────────────────
function _emptyEnvelope(): StoreEnvelope {
  return { version: VERSION, loan_parts: [], payments: [], valuations: [], rate_periods: [], contributions: [], settings: defaultSettings() }
}

function _envelope(raw: Record<string, unknown>, migrate: boolean): StoreEnvelope {
  const out: StoreEnvelope = {
    version: VERSION,
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
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return _emptyEnvelope()
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object') return _emptyEnvelope()
    return _envelope(data, false) // cache is always current-shape
  } catch { return _emptyEnvelope() }
}

function _writeCache(env: StoreEnvelope): void {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(env)) } catch { /* private mode / quota */ }
}

function _patchCache(fn: (e: StoreEnvelope) => void): void {
  const env = _readCache(); fn(env); _writeCache(env)
}

// The pre-Supabase envelope from the legacy key — v<4-migrated in memory (no
// write-back, STORAGE_KEY stays read-only) with id/created_at guaranteed on
// every row, ready to upsert. null when there's no legacy data to import.
function _readLegacy(): StoreEnvelope | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object') return null
    const env = _envelope(data, true)
    env.loan_parts = env.loan_parts.map(r => stamp(r, 'part') as LoanPart)
    env.payments = env.payments.map(r => stamp(r, 'pay') as Payment)
    env.valuations = env.valuations.map(r => stamp(r, 'val') as Valuation)
    env.rate_periods = env.rate_periods.map(r => stamp(r, 'rate') as RatePeriod)
    env.contributions = env.contributions.map(r => stamp(r, 'contrib') as Contribution)
    return env
  } catch { return null }
}

// ── First-login import (one-time, idempotent) ───────────────────────────────
// On the first authenticated load after the household exists, upsert the legacy
// localStorage data into the five tables (keyed on id, so re-running adds
// nothing) + seed the settings tool_state row only if none exists yet (so a
// partner's saved settings aren't clobbered), then set a flag. On any error
// (offline / RLS not ready) it does NOT set the flag and clears the in-memory
// guard, so it retries next call. `_importOnce` dedupes concurrent calls.
let _importOnce: Promise<void> | null = null
function _importLocalOnce(): Promise<void> {
  if (_importOnce) return _importOnce
  _importOnce = (async () => {
    let already = true
    try { already = localStorage.getItem(IMPORT_FLAG) === '1' } catch { already = false }
    if (already) return
    const legacy = _readLegacy()
    if (legacy) {
      const jobs: Array<[string, Record<string, unknown>[]]> = [
        [T.parts, legacy.loan_parts.map(r => _row(r, COLS.parts))],
        [T.periods, legacy.rate_periods.map(r => _row(r, COLS.periods))],
        [T.payments, legacy.payments.map(r => _row(r, COLS.payments))],
        [T.valuations, legacy.valuations.map(r => _row(r, COLS.valuations))],
        [T.contributions, legacy.contributions.map(r => _row(r, COLS.contributions))],
      ]
      for (const [table, rows] of jobs) {
        if (!rows.length) continue
        const { error } = await supabase.from(table).upsert(rows, { onConflict: 'id' })
        if (error) { _importOnce = null; return } // retry next call — don't mark done
      }
      const { data, error: selErr } = await supabase.from(STATE).select('tool').eq('tool', SETTINGS_TOOL).maybeSingle()
      if (selErr) { _importOnce = null; return }
      if (!data) {
        const { error } = await supabase.from(STATE).upsert({ tool: SETTINGS_TOOL, data: legacy.settings }, { onConflict: 'household_id,tool' })
        if (error) { _importOnce = null; return }
      }
    }
    try { localStorage.setItem(IMPORT_FLAG, '1') } catch { /* ignore */ }
  })()
  return _importOnce
}

// ── Loan parts ───────────────────────────────────────────────────────────────
export async function listLoanParts(): Promise<LoanPart[]> {
  await _importLocalOnce()
  const { data, error } = await supabase.from(T.parts).select('*').order('created_at', { ascending: true })
  if (error || !data) return _readCache().loan_parts.slice()
  const rows = data as LoanPart[]
  _patchCache(e => { e.loan_parts = rows })
  return rows.slice()
}

export async function addLoanPart(record: Omit<LoanPart, 'id' | 'created_at'>): Promise<LoanPart> {
  const saved = stamp(record, 'part') as LoanPart
  const { error } = await supabase.from(T.parts).insert(_row(saved, COLS.parts))
  if (error) throw error
  _patchCache(e => { e.loan_parts.push(saved) })
  return saved
}

export async function updateLoanPart(id: string, patch: Partial<LoanPart>): Promise<LoanPart | null> {
  const { error } = await supabase.from(T.parts).update(_pick(patch, COLS.parts)).eq('id', id)
  if (error) throw error
  let found: LoanPart | null = null
  _patchCache(e => { e.loan_parts = e.loan_parts.map(p => { if (p?.id === id) { found = { ...p, ...patch }; return found } return p }) })
  return found
}

export async function removeLoanPart(id: string): Promise<number> {
  const { error } = await supabase.from(T.parts).delete().eq('id', id)
  await supabase.from(T.payments).delete().eq('loan_part_id', id)
  await supabase.from(T.periods).delete().eq('loan_part_id', id)
  if (error) throw error
  let n = 0
  _patchCache(e => {
    e.loan_parts = e.loan_parts.filter(p => p?.id !== id)
    e.payments = e.payments.filter(p => !(p?.loan_part_id === id))
    e.rate_periods = e.rate_periods.filter(r => !(r?.loan_part_id === id))
    n = e.loan_parts.length
  })
  return n
}

// ── Payments ─────────────────────────────────────────────────────────────────
export async function listPayments(): Promise<Payment[]> {
  await _importLocalOnce()
  const { data, error } = await supabase.from(T.payments).select('*')
  if (error || !data) return byDateDesc(_readCache().payments)
  const rows = data as Payment[]
  _patchCache(e => { e.payments = rows })
  return byDateDesc(rows)
}

export async function addPayment(record: Omit<Payment, 'id' | 'created_at'>): Promise<Payment> {
  const saved = stamp(record, 'pay') as Payment
  const { error } = await supabase.from(T.payments).insert(_row(saved, COLS.payments))
  if (error) throw error
  _patchCache(e => { e.payments.push(saved) })
  return saved
}

export async function addPayments(records: Array<Omit<Payment, 'id' | 'created_at'>>): Promise<Payment[]> {
  const saved = records.map(r => stamp(r, 'pay') as Payment)
  const { error } = await supabase.from(T.payments).insert(saved.map(r => _row(r, COLS.payments)))
  if (error) throw error
  _patchCache(e => { e.payments = e.payments.concat(saved) })
  return saved
}

export async function updatePayment(id: string, patch: Partial<Payment>): Promise<Payment | null> {
  const { error } = await supabase.from(T.payments).update(_pick(patch, COLS.payments)).eq('id', id)
  if (error) throw error
  let found: Payment | null = null
  _patchCache(e => { e.payments = e.payments.map(p => { if (p?.id === id) { found = { ...p, ...patch }; return found } return p }) })
  return found
}

export async function removePayment(id: string): Promise<number> {
  const { error } = await supabase.from(T.payments).delete().eq('id', id)
  if (error) throw error
  let n = 0
  _patchCache(e => { e.payments = e.payments.filter(p => p?.id !== id); n = e.payments.length })
  return n
}

export async function removePayments(ids: string[]): Promise<number> {
  const { error } = await supabase.from(T.payments).delete().in('id', ids)
  if (error) throw error
  const drop = new Set(ids)
  let removed = 0
  _patchCache(e => { const before = e.payments.length; e.payments = e.payments.filter(p => !(p && drop.has(p.id))); removed = before - e.payments.length })
  return removed
}

// ── Valuations ───────────────────────────────────────────────────────────────
export async function listValuations(): Promise<Valuation[]> {
  await _importLocalOnce()
  const { data, error } = await supabase.from(T.valuations).select('*')
  if (error || !data) return byDateDesc(_readCache().valuations)
  const rows = data as Valuation[]
  _patchCache(e => { e.valuations = rows })
  return byDateDesc(rows)
}

export async function addValuation(record: Omit<Valuation, 'id' | 'created_at'>): Promise<Valuation> {
  const saved = stamp(record, 'val') as Valuation
  const { error } = await supabase.from(T.valuations).insert(_row(saved, COLS.valuations))
  if (error) throw error
  _patchCache(e => { e.valuations.push(saved) })
  return saved
}

export async function updateValuation(id: string, patch: Partial<Valuation>): Promise<Valuation | null> {
  const { error } = await supabase.from(T.valuations).update(_pick(patch, COLS.valuations)).eq('id', id)
  if (error) throw error
  let found: Valuation | null = null
  _patchCache(e => { e.valuations = e.valuations.map(v => { if (v?.id === id) { found = { ...v, ...patch }; return found } return v }) })
  return found
}

export async function removeValuation(id: string): Promise<number> {
  const { error } = await supabase.from(T.valuations).delete().eq('id', id)
  if (error) throw error
  let n = 0
  _patchCache(e => { e.valuations = e.valuations.filter(v => v?.id !== id); n = e.valuations.length })
  return n
}

// ── Rate periods ─────────────────────────────────────────────────────────────
export async function listRatePeriods(): Promise<RatePeriod[]> {
  await _importLocalOnce()
  const { data, error } = await supabase.from(T.periods).select('*')
  if (error || !data) return byStartDesc(_readCache().rate_periods)
  const rows = data as RatePeriod[]
  _patchCache(e => { e.rate_periods = rows })
  return byStartDesc(rows)
}

export async function addRatePeriod(record: Omit<RatePeriod, 'id' | 'created_at'>): Promise<RatePeriod> {
  const saved = stamp(record, 'rate') as RatePeriod
  const { error } = await supabase.from(T.periods).insert(_row(saved, COLS.periods))
  if (error) throw error
  _patchCache(e => { e.rate_periods.push(saved) })
  return saved
}

export async function updateRatePeriod(id: string, patch: Partial<RatePeriod>): Promise<RatePeriod | null> {
  const { error } = await supabase.from(T.periods).update(_pick(patch, COLS.periods)).eq('id', id)
  if (error) throw error
  let found: RatePeriod | null = null
  _patchCache(e => { e.rate_periods = e.rate_periods.map(r => { if (r?.id === id) { found = { ...r, ...patch }; return found } return r }) })
  return found
}

export async function removeRatePeriod(id: string): Promise<number> {
  const { error } = await supabase.from(T.periods).delete().eq('id', id)
  if (error) throw error
  let n = 0
  _patchCache(e => { e.rate_periods = e.rate_periods.filter(r => r?.id !== id); n = e.rate_periods.length })
  return n
}

// ── Contributions ────────────────────────────────────────────────────────────
export async function listContributions(): Promise<Contribution[]> {
  await _importLocalOnce()
  const { data, error } = await supabase.from(T.contributions).select('*')
  if (error || !data) return byDateDesc(_readCache().contributions)
  const rows = data as Contribution[]
  _patchCache(e => { e.contributions = rows })
  return byDateDesc(rows)
}

export async function addContribution(record: Omit<Contribution, 'id' | 'created_at'>): Promise<Contribution> {
  const saved = stamp(record, 'contrib') as Contribution
  const { error } = await supabase.from(T.contributions).insert(_row(saved, COLS.contributions))
  if (error) throw error
  _patchCache(e => { e.contributions.push(saved) })
  return saved
}

export async function updateContribution(id: string, patch: Partial<Contribution>): Promise<Contribution | null> {
  const { error } = await supabase.from(T.contributions).update(_pick(patch, COLS.contributions)).eq('id', id)
  if (error) throw error
  let found: Contribution | null = null
  _patchCache(e => { e.contributions = e.contributions.map(c => { if (c?.id === id) { found = { ...c, ...patch }; return found } return c }) })
  return found
}

export async function removeContribution(id: string): Promise<number> {
  const { error } = await supabase.from(T.contributions).delete().eq('id', id)
  if (error) throw error
  let n = 0
  _patchCache(e => { e.contributions = e.contributions.filter(c => c?.id !== id); n = e.contributions.length })
  return n
}

// ── Settings (tool_state blob) ───────────────────────────────────────────────
export async function getSettings(): Promise<MortgageSettings> {
  await _importLocalOnce()
  const { data, error } = await supabase.from(STATE).select('data').eq('tool', SETTINGS_TOOL).maybeSingle()
  if (error) return { ...defaultSettings(), ..._readCache().settings }
  const settings = { ...defaultSettings(), ...((data?.data as Partial<MortgageSettings>) || {}) }
  _patchCache(e => { e.settings = settings })
  return settings
}

export async function saveSettings(patch: Partial<MortgageSettings>): Promise<MortgageSettings> {
  const current = await getSettings()
  const merged = { ...defaultSettings(), ...current, ...patch }
  const { error } = await supabase.from(STATE).upsert({ tool: SETTINGS_TOOL, data: merged }, { onConflict: 'household_id,tool' })
  if (error) throw error
  _patchCache(e => { e.settings = merged })
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
async function _mergeInsert<T extends { id?: string; created_at?: string }>(table: string, existing: T[], incoming: unknown, prefix: string, cols: readonly string[]): Promise<T[]> {
  const seen = new Set(existing.map(r => r?.id).filter(Boolean))
  const toAdd: T[] = []
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    if (!raw || typeof raw !== 'object') continue
    const row = { ...(raw as T) }
    if (!row.id) row.id = genId(prefix) as T['id']
    if (seen.has(row.id)) continue
    if (!row.created_at) row.created_at = new Date().toISOString() as T['created_at']
    seen.add(row.id); toAdd.push(row)
  }
  if (toAdd.length) {
    const { error } = await supabase.from(table).insert(toAdd.map(r => _row(r, cols)))
    if (error) throw error
  }
  return toAdd
}

export async function importJSON(text: string): Promise<Record<string, number>> {
  let parsed: Record<string, unknown>
  try { parsed = JSON.parse(text) } catch { throw new Error("That file isn't valid JSON.") }
  if (!parsed || typeof parsed !== 'object') throw new Error('No Bolånekoll data found.')
  if (!parsed.loan_parts && !parsed.payments && !parsed.valuations && !parsed.rate_periods && !parsed.contributions) throw new Error('No Bolånekoll data found.')

  const [parts, pays, vals, rates, contribs] = await Promise.all([
    listLoanParts(), listPayments(), listValuations(), listRatePeriods(), listContributions(),
  ])

  const newParts = await _mergeInsert<LoanPart>(T.parts, parts, parsed.loan_parts, 'part', COLS.parts)
  _patchCache(e => { e.loan_parts = e.loan_parts.concat(newParts) })
  const newPays = await _mergeInsert<Payment>(T.payments, pays, parsed.payments, 'pay', COLS.payments)
  _patchCache(e => { e.payments = e.payments.concat(newPays) })
  const newVals = await _mergeInsert<Valuation>(T.valuations, vals, parsed.valuations, 'val', COLS.valuations)
  _patchCache(e => { e.valuations = e.valuations.concat(newVals) })
  const newRates = await _mergeInsert<RatePeriod>(T.periods, rates, parsed.rate_periods, 'rate', COLS.periods)
  _patchCache(e => { e.rate_periods = e.rate_periods.concat(newRates) })
  const newContribs = await _mergeInsert<Contribution>(T.contributions, contribs, parsed.contributions, 'contrib', COLS.contributions)
  _patchCache(e => { e.contributions = e.contributions.concat(newContribs) })

  if (parsed.settings && typeof parsed.settings === 'object')
    await saveSettings(parsed.settings as Partial<MortgageSettings>)

  return {
    loan_parts: newParts.length, payments: newPays.length, valuations: newVals.length,
    rate_periods: newRates.length, contributions: newContribs.length,
  }
}

// ── Re-export types for callers that only import from the store ──────────────
export type { LoanPart, RatePeriod, Payment, Valuation, Contribution, MortgageSettings, ColNameMapping }
