// manadsavslut-store.ts — persistence for Månadsavslut. Phase 16c: reads and
// writes Supabase — items → `monthend_items`, payments →
// `monthend_payments`, settings → the shared `tool_state` blob — with a
// localStorage write-through CACHE for offline. Every exported signature is
// unchanged, so the call sites in Manadsavslut.tsx / Home.tsx don't change.
// supabase-js returns { data, error } (never throws) — reads fall back to the
// cache, writes surface via throw.
//
// Two localStorage keys, deliberately separate (mirrors salary-store 16b):
// - STORAGE_KEY — the PRE-Supabase envelope. Now the one-time import SOURCE +
//   a permanent backup; never written after the swap, so the cache write can't
//   clobber the original before it's uploaded. (The first-login import itself is
//   the next section of 16c — this swap just keeps the key safe for it.)
// - CACHE_KEY   — the write-through offline cache.

import { defaultSettings, normalizePersonalEntries, personalSums } from './manadsavslut'
import type { Item, Payment, MonthEndSettings, PersonalEntry } from './manadsavslut'
import { supabase } from './supabase'
import { genId } from './id'
import { makeImportOnce, materializeImport, stamp } from './store-helpers'
import { syncCoordinator } from './sync'
import { cachedTombstoneIds, loadTombstoneIds, queueTableDelete, queueTableUpsert, registerTableSync, withoutTombstones } from './sync-table'
import { legacyImportAssignedToActive } from './legacy-data'
import { normalizeMonthEndItemDate, parseFiniteJson, parseMonthEndEnvelope, salvageMonthEndEnvelope, salvageMonthEndRows } from './persistence-schema'
import type { RejectedRecord } from './persistence-schema'
import { reportPersistenceWarning } from './persistence-error'
import {
  receiptRpc, rejectLegacyToolOperation, rememberRowRevisions, rememberToolRevision,
  revisionKey, syncRpcResult,
} from './sync-rpc'

// Legacy pre-Supabase envelope — import source + backup (read-only after swap).
export const STORAGE_KEY = 'bostadskalkyl_monthend_v1'
const CACHE_KEY = 'bostadskalkyl_monthend_cache_v1'
const IMPORT_FLAG = 'bostadskalkyl_monthend_supabase_imported'
const ITEMS = 'monthend_items'
const PAYMENTS = 'monthend_payments'
const STATE = 'tool_state'
const SETTINGS_TOOL = 'manadsavslut-settings'
const ITEMS_RESOURCE = ITEMS
const PAYMENTS_RESOURCE = PAYMENTS
const SETTINGS_RESOURCE = `tool_state:${SETTINGS_TOOL}`
const SETTLEMENT_RESOURCE = 'monthend-settlements'
const VERSION = 1

interface Envelope { version: number; items: Item[]; payments: Payment[]; settings: MonthEndSettings }

function warning(source: string): void {
  reportPersistenceWarning(`Några sparade månadsavslut kunde inte läsas från ${source}. Övriga sparade uppgifter finns kvar.`)
}

// Normalize a loaded item so older localStorage data and JSON backups gain the
// personal carve-out fields with safe defaults (no migration script needed):
//  - pre-personal items (no fields)        → personal_items: []
//  - v1 items (personal_a/b + one note)    → synthesised into personal_items, the
//    single note riding the first entry
//  - current items (personal_items present)→ re-derive the cached sums (idempotent)
// Idempotent, so it is safe to run on cloud rows and cached rows alike.
export function normalizeItem(it: Item): Item {
  const raw = it as unknown as unknown as Record<string, unknown>
  let entries: PersonalEntry[] = normalizePersonalEntries(raw.personal_items)
  if (!entries.length) {
    const pa = Number(raw.personal_a) || 0, pb = Number(raw.personal_b) || 0
    const note = typeof raw.personal_note === 'string' ? raw.personal_note : ''
    const migrated: PersonalEntry[] = []
    if (pa > 0) migrated.push({ person: 'a', amount: pa, note })
    if (pb > 0) migrated.push({ person: 'b', amount: pb, note: pa > 0 ? '' : note })
    entries = migrated
  }
  const sums = personalSums(entries)
  return { ...it, personal_items: entries, personal_a: sums.a, personal_b: sums.b }
}

function sortedDesc<T extends { created_at?: string }>(rows: T[]): T[] {
  return rows.slice().sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
}

// ── Column projectors — send exactly the table columns; OMIT household_id +
// updated_at so the column default (current_household()) and the moddatetime
// trigger fill them. The client must never send those.
function _itemRow(it: Item): Record<string, unknown> {
  return {
    id: it.id, created_at: it.created_at,
    date_purchased: it.date_purchased ?? '', description: it.description ?? '',
    enter_amount: it.enter_amount ?? 0, split: it.split ?? true, amount: it.amount ?? 0,
    fronted_by: it.fronted_by ?? 'a', owed_by: it.owed_by ?? 'a',
    paid: it.paid ?? false, pending: it.pending ?? false, payment_id: it.payment_id ?? null,
    note: it.note ?? '', personal_items: it.personal_items ?? [],
    personal_a: it.personal_a ?? 0, personal_b: it.personal_b ?? 0,
  }
}

function _paymentRow(p: Payment): Record<string, unknown> {
  return {
    id: p.id, created_at: p.created_at, item_ids: p.item_ids ?? [],
    from_person: p.from_person ?? null, to_person: p.to_person ?? null,
    amount: p.amount ?? 0, period_label: p.period_label ?? '', note: p.note ?? '',
  }
}

// Project a partial item patch to columns (defined keys only). When the patch
// touches personal_items, recompute the cached personal_a/b so the DB row stays
// consistent (normalizeItem re-derives them on read too).
function _itemPatch(patch: Partial<Item>): Record<string, unknown> {
  const cols: (keyof Item)[] = ['date_purchased', 'description', 'enter_amount', 'split',
    'amount', 'fronted_by', 'owed_by', 'paid', 'pending', 'payment_id', 'note',
    'personal_items', 'personal_a', 'personal_b']
  const out: Record<string, unknown> = {}
  for (const c of cols) if (c in patch) out[c] = (patch as unknown as Record<string, unknown>)[c]
  if ('personal_items' in patch) {
    const sums = personalSums(normalizePersonalEntries((patch as unknown as Record<string, unknown>).personal_items))
    out.personal_a = sums.a; out.personal_b = sums.b
  }
  return out
}

// ── localStorage cache (offline fallback) ───────────────────────────────────
function _readCache(): Envelope {
  return _readCacheFrom(syncCoordinator.captureScope())
}

function _readCacheFrom(scope: ReturnType<typeof syncCoordinator.captureScope>): Envelope {
  const empty: Envelope = { version: VERSION, items: [], payments: [], settings: defaultSettings() }
  try {
    const raw = scope.read(CACHE_KEY)
    if (!raw) return empty
    const d = JSON.parse(raw) as unknown as Record<string, unknown>
    if (!d || typeof d !== 'object') { warning('cachen'); return empty }
    if (!parseFiniteJson(d).ok) { warning('cachen'); return empty }
    const parsed = salvageMonthEndEnvelope(d)
    if (parsed.rejected.length) warning('cachen')
    return { ...parsed.value, version: VERSION, items: parsed.value.items.map(normalizeItem) }
  } catch { warning('cachen'); return empty }
}

function _writeCache(env: Envelope): void {
  try {
    syncCoordinator.writeScoped(CACHE_KEY, JSON.stringify({ version: VERSION, items: env.items, payments: env.payments, settings: env.settings }))
  } catch { /* private mode / quota — cache is best-effort */ }
}

// Read-modify-write one slice of the cache envelope.
function _patchCache(fn: (env: Envelope) => void): void {
  const env = _readCache(); fn(env); _writeCache(env)
}

// Synchronous snapshot of the write-through cache, sorted to MATCH the async
// list*() reads, so the hub can seed its month-end stat on the first paint
// (no wide-card layout shift while the cloud refresh reconciles). Cold cache →
// empty arrays, so the caller still resolves to "no data".
export function cachedSnapshot(): { items: Item[]; payments: Payment[]; settings: MonthEndSettings } {
  const scope = syncCoordinator.captureScope()
  const e = _readCacheFrom(scope)
  return {
    items: sortedDesc(withoutTombstones(e.items, cachedTombstoneIds(scope, ITEMS_RESOURCE))),
    payments: sortedDesc(withoutTombstones(e.payments, cachedTombstoneIds(scope, PAYMENTS_RESOURCE))),
    settings: e.settings,
  }
}

// ── First-login import (one-time, idempotent) ───────────────────────────────
// Read the pre-Supabase envelope from the legacy key — normalised, with
// id/created_at guaranteed — ready to upsert. Read-only: STORAGE_KEY is never
// written after the swap, so the original survives even if every upload fails.
type LegacyRead = { status: 'absent' } | { status: 'invalid' } | { status: 'valid'; value: { items: Item[]; payments: Payment[]; settings: MonthEndSettings | null } }

function _readLegacy(scope: ReturnType<typeof syncCoordinator.captureScope>): LegacyRead {
  const raw = scope.read(STORAGE_KEY)
  if (raw === null) return { status: 'absent' }
  let d: Record<string, unknown>
  try {
    d = JSON.parse(raw) as unknown as Record<string, unknown>
    if (!d || typeof d !== 'object' || !parseFiniteJson(d).ok
      || (d.items !== undefined && !Array.isArray(d.items))
      || (d.payments !== undefined && !Array.isArray(d.payments))
      || (d.settings !== undefined && d.settings !== null && (typeof d.settings !== 'object' || Array.isArray(d.settings)))) { warning('säkerhetskopian'); return { status: 'invalid' } }
  } catch { warning('säkerhetskopian'); return { status: 'invalid' } }
  const candidate = materializeImport('monthend-legacy', raw, () => {
    const items = ((d.items as unknown[] | undefined) ?? []).map((r) => {
      if (!r || typeof r !== 'object' || Array.isArray(r)) return r
      const row = { ...(r as Record<string, unknown>) }
      if (!row.id) row.id = genId('item')
      if (!row.created_at) row.created_at = new Date().toISOString()
      return { date_purchased: '', description: '', enter_amount: 0, split: true, amount: 0, fronted_by: 'a' as const, owed_by: 'a' as const, paid: false, pending: false, payment_id: null, note: '', personal_items: [], personal_a: 0, personal_b: 0, source: 'manual', ...(row as unknown as Record<string, unknown>) }
    })
    const payments = ((d.payments as unknown[] | undefined) ?? []).map((r) => {
      if (!r || typeof r !== 'object' || Array.isArray(r)) return r
      const row = { ...(r as Record<string, unknown>) }
      if (!row.id) row.id = genId('pay')
      if (!row.created_at) row.created_at = new Date().toISOString()
      return { item_ids: [], from_person: null, to_person: null, amount: 0, period_label: '', note: '', ...(row as unknown as Record<string, unknown>) }
    })
    const settings = d.settings === undefined || d.settings === null ? defaultSettings() : { ...defaultSettings(), ...(d.settings as Partial<MonthEndSettings>) }
    return { version: d.version ?? VERSION, items, payments, settings }
  })
  const parsed = parseMonthEndEnvelope(candidate)
  if (!parsed.ok) { warning('säkerhetskopian'); return { status: 'invalid' } }
  return { status: 'valid', value: { ...parsed.value, items: parsed.value.items.map(normalizeItem) } }
}

// On the first authenticated load after the household exists, upsert the legacy
// localStorage envelope into the cloud (items + payments keyed on id — idempotent;
// settings only if no cloud row exists yet, so a partner's already-saved settings
// aren't clobbered). Runs before the read queries below, so imported rows appear
// in that same call.
const _importLocalOnce = makeImportOnce(() => syncCoordinator.scopedStorageKey(IMPORT_FLAG), async () => {
  const scope = syncCoordinator.captureScope()
  if (!legacyImportAssignedToActive() || !scope.isActive()) return true
  const legacyRead = _readLegacy(scope)
  if (legacyRead.status === 'absent') return true
  if (legacyRead.status === 'invalid') return false
  const legacy = legacyRead.value
  const operations = []
  if (legacy.items.length) operations.push({
    resource: ITEMS_RESOURCE, operation: 'upsert' as const, payload: { rows: legacy.items.map(_itemRow), seed: true },
    entityIds: legacy.items.map((row) => row.id),
    expectedRevisions: Object.fromEntries(legacy.items.map((row) => [revisionKey(ITEMS_RESOURCE, row.id), null])),
    applyLocal: () => _patchCache((e) => { const ids = new Set(legacy.items.map((row) => row.id)); e.items = [...legacy.items, ...e.items.filter((row) => !ids.has(row.id))] }),
  })
  if (legacy.payments.length) operations.push({
    resource: PAYMENTS_RESOURCE, operation: 'upsert' as const, payload: { rows: legacy.payments.map(_paymentRow), seed: true },
    entityIds: legacy.payments.map((row) => row.id),
    expectedRevisions: Object.fromEntries(legacy.payments.map((row) => [revisionKey(PAYMENTS_RESOURCE, row.id), null])),
    applyLocal: () => _patchCache((e) => { const ids = new Set(legacy.payments.map((row) => row.id)); e.payments = [...legacy.payments, ...e.payments.filter((row) => !ids.has(row.id))] }),
  })
  if (legacy.settings) operations.push({
    resource: SETTINGS_RESOURCE, operation: 'upsert' as const, payload: { data: legacy.settings, seed: true }, entityIds: [SETTINGS_TOOL],
    expectedRevisions: { [SETTINGS_RESOURCE]: null },
    applyLocal: () => _patchCache((e) => { e.settings = legacy.settings! }),
  })
  if (!scope.isActive()) return false
  try { await syncCoordinator.mutateBatch(operations); return true } catch { return false }
})

registerTableSync(ITEMS_RESOURCE, ITEMS)
registerTableSync(PAYMENTS_RESOURCE, PAYMENTS)
syncCoordinator.register(SETTINGS_RESOURCE, async (operation) => {
  const payload = operation.payload as { data?: unknown; seed?: unknown }
  const data = payload?.data
  if (!data || typeof data !== 'object') throw { status: 400, message: 'Malformed month-end settings' }
  await rejectLegacyToolOperation(operation, SETTINGS_TOOL)
  const { data: result, error } = await receiptRpc('sync_apply_tool_state', {
    p_operation_id: operation.id, p_tool: SETTINGS_TOOL, p_data: data,
    p_expected_revision: operation.expectedRevisions?.[SETTINGS_RESOURCE] ?? null,
    p_seed: payload.seed === true,
  })
  if (error) throw error
  return syncRpcResult(result)
}, (operation) => operation.operation === 'upsert'
  && !!(operation.payload as { data?: unknown })?.data
  && typeof (operation.payload as { data?: unknown }).data === 'object'
  && ((operation.payload as { seed?: unknown }).seed === undefined || typeof (operation.payload as { seed?: unknown }).seed === 'boolean')
  && operation.entityIds.length === 1 && operation.entityIds[0] === SETTINGS_TOOL)
syncCoordinator.register(SETTLEMENT_RESOURCE, async (operation) => {
  const payload = operation.payload as { kind?: unknown; payment?: unknown; id?: unknown }
  if (operation.expectedRevisions === undefined) {
    const current: Record<string, number | null> = {}
    if (payload.kind === 'settle' && payload.payment && typeof payload.payment === 'object') {
      const payment = payload.payment as { id?: unknown; item_ids?: unknown }
      if (typeof payment.id !== 'string' || !Array.isArray(payment.item_ids)) throw { status: 400, message: 'Malformed settlement operation' }
      const ids = payment.item_ids.filter((id): id is string => typeof id === 'string')
      current[revisionKey(PAYMENTS_RESOURCE, payment.id)] = null
      const { data, error } = await supabase.from(ITEMS).select('id,revision').in('id', ids)
      if (error) throw error
      for (const id of ids) current[revisionKey(ITEMS_RESOURCE, id)] = null
      for (const row of (data ?? []) as Array<{ id?: unknown; revision?: unknown }>) {
        if (typeof row.id === 'string') current[revisionKey(ITEMS_RESOURCE, row.id)] = Number(row.revision) || null
      }
    } else if (payload.kind === 'unsettle' && typeof payload.id === 'string') {
      const [payment, items] = await Promise.all([
        supabase.from(PAYMENTS).select('id,revision').eq('id', payload.id).maybeSingle(),
        supabase.from(ITEMS).select('id,revision').eq('payment_id', payload.id),
      ])
      if (payment.error || items.error) throw payment.error ?? items.error
      current[revisionKey(PAYMENTS_RESOURCE, payload.id)] = Number((payment.data as { revision?: unknown } | null)?.revision) || null
      for (const row of (items.data ?? []) as Array<{ id?: unknown; revision?: unknown }>) {
        if (typeof row.id === 'string') current[revisionKey(ITEMS_RESOURCE, row.id)] = Number(row.revision) || null
      }
    } else throw { status: 400, message: 'Malformed settlement operation' }
    throw { status: 409, message: 'legacy operation has no base revision', currentRevisions: current }
  }
  if (payload.kind === 'settle' && payload.payment && typeof payload.payment === 'object') {
    const { data, error } = await receiptRpc('sync_settle_items', {
      p_operation_id: operation.id, p_payment: payload.payment,
      p_expected_revisions: operation.expectedRevisions,
    })
    if (error) throw error
    return syncRpcResult(data)
  }
  if (payload.kind === 'unsettle' && typeof payload.id === 'string') {
    const { data, error } = await receiptRpc('sync_unsettle_payment', {
      p_operation_id: operation.id, p_id: payload.id,
      p_expected_revisions: operation.expectedRevisions,
    })
    if (error) throw error
    return syncRpcResult(data)
  }
  throw { status: 400, message: 'Malformed settlement operation' }
}, (operation) => {
  const payload = operation.payload as { kind?: unknown; payment?: unknown; id?: unknown }
  if (operation.operation === 'delete' && payload.kind === 'unsettle') {
    const id = payload.id
    return typeof id === 'string' && !!id && operation.entityIds.length === 1 && operation.entityIds[0] === id
  }
  if (operation.operation === 'upsert' && payload.kind === 'settle' && payload.payment && typeof payload.payment === 'object') {
    const payment = payload.payment as { id?: unknown; item_ids?: unknown }
    if (typeof payment.id !== 'string' || !payment.id || !Array.isArray(payment.item_ids)
      || !payment.item_ids.every((id) => typeof id === 'string' && !!id)) return false
    const expected = [payment.id, ...payment.item_ids]
    return expected.length === operation.entityIds.length && expected.every((id, index) => id === operation.entityIds[index])
  }
  return false
})

// ── Items ──────────────────────────────────────────────────────────────────
export type MonthEndItemReadSource = 'cloud' | 'cache' | 'unavailable'

export type MonthEndItemReadReasonCode =
  | 'invalid_array'
  | 'invalid_boolean'
  | 'invalid_date'
  | 'invalid_datetime'
  | 'invalid_number'
  | 'invalid_object'
  | 'invalid_reference'
  | 'invalid_string'
  | 'duplicate_id'
  | 'invalid_value'

export interface MonthEndItemReadDiagnostic {
  /** Structural row path only. Never contains ids or row values. */
  fieldPath: string
  code: MonthEndItemReadReasonCode
  /** Masked shape of the rejected value (digits→N, letters→A). Never the value itself. */
  shape?: string
}

export interface MonthEndItemReadResult {
  rows: Item[]
  source: MonthEndItemReadSource
  degraded: boolean
  rejectedRowCount: number
  diagnostics: MonthEndItemReadDiagnostic[]
  /** The cloud returned rows, but every row failed strict validation. */
  allCloudRowsRejected: boolean
}

function itemReadReasonCode(reason: string, path?: string): MonthEndItemReadReasonCode {
  if (reason.includes('finite number')) return 'invalid_number'
  if (path?.endsWith('.created_at') || reason.includes('date-time')) return 'invalid_datetime'
  if (reason.includes('ISO date') || reason.includes('calendar date')) return 'invalid_date'
  if (reason.includes('boolean')) return 'invalid_boolean'
  if (reason.includes('array')) return 'invalid_array'
  if (reason.includes('object')) return 'invalid_object'
  if (reason.includes('non-empty string') || reason.includes('string')) return 'invalid_string'
  if (reason.includes('duplicate')) return 'duplicate_id'
  if (reason.includes('references')) return 'invalid_reference'
  return 'invalid_value'
}

function itemReadDiagnostics(rejected: RejectedRecord[]): MonthEndItemReadDiagnostic[] {
  return rejected.map((entry) => {
    const match = /^items (\d+)$/.exec(entry.record)
    return {
      fieldPath: entry.path ?? (match ? `items[${Number(match[1]) - 1}]` : 'items'),
      code: itemReadReasonCode(entry.reason, entry.path),
      ...(entry.shape !== undefined ? { shape: entry.shape } : {}),
    }
  })
}

function inspectItemCache(scope: ReturnType<typeof syncCoordinator.captureScope>): {
  source: Extract<MonthEndItemReadSource, 'cache' | 'unavailable'>
  rejected: RejectedRecord[]
} {
  try {
    const raw = scope.read(CACHE_KEY)
    if (!raw) return { source: 'unavailable', rejected: [] }
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { source: 'unavailable', rejected: [] }
    }
    const rawItems = (value as Record<string, unknown>).items
    const parsedRows = salvageMonthEndRows(rawItems, 'items')
    const parsedEnvelope = salvageMonthEndEnvelope(value)
    const itemReferenceRejections = parsedEnvelope.rejected.filter((entry) =>
      entry.path === 'items' || entry.path?.startsWith('items['),
    )
    const rejected = [...parsedRows.rejected, ...itemReferenceRejections]
    const readable = parseFiniteJson(value).ok
      && Array.isArray(rawItems)
      && (rawItems.length === 0 || parsedEnvelope.value.items.length > 0)
    return {
      source: readable ? 'cache' : 'unavailable',
      rejected,
    }
  } catch {
    return { source: 'unavailable', rejected: [] }
  }
}

export async function listItemsDetailed(): Promise<MonthEndItemReadResult> {
  const scope = syncCoordinator.captureScope()
  await _importLocalOnce()
  const fallback = (
    rejected: RejectedRecord[] = [],
    allCloudRowsRejected = false,
  ): MonthEndItemReadResult => {
    const cache = inspectItemCache(scope)
    const diagnostics = rejected.length ? rejected : cache.rejected
    const rows = sortedDesc(withoutTombstones(_readCacheFrom(scope).items, cachedTombstoneIds(scope, ITEMS_RESOURCE)))
    return {
      rows,
      source: cache.source,
      degraded: true,
      rejectedRowCount: diagnostics.length,
      diagnostics: itemReadDiagnostics(diagnostics),
      allCloudRowsRejected,
    }
  }
  if (!scope.isActive() || syncCoordinator.isDirty(ITEMS_RESOURCE) || syncCoordinator.isDirty(SETTLEMENT_RESOURCE)) return fallback()
  const [result, tombstones] = await Promise.all([
    supabase.from(ITEMS).select('*').order('created_at', { ascending: false }),
    loadTombstoneIds(scope, ITEMS_RESOURCE),
  ])
  if (!scope.isActive() || syncCoordinator.isDirty(ITEMS_RESOURCE) || syncCoordinator.isDirty(SETTLEMENT_RESOURCE)) return fallback()
  if (result.error || !result.data) return fallback()
  rememberRowRevisions(ITEMS_RESOURCE, result.data as unknown as Record<string, unknown>[])
  const parsed = salvageMonthEndRows(result.data, 'items')
  if (parsed.rejected.length) warning('molnet')
  const rows = withoutTombstones((parsed.value as unknown as Item[]).map(normalizeItem), tombstones)
  const allCloudRowsRejected = result.data.length > 0 && parsed.value.length === 0 && parsed.rejected.length > 0
  if (allCloudRowsRejected) return fallback(parsed.rejected, true)
  if (scope.isActive()) {
    const cache = _readCacheFrom(scope); cache.items = rows; scope.write(CACHE_KEY, JSON.stringify(cache))
  }
  return {
    rows,
    source: 'cloud',
    degraded: parsed.rejected.length > 0,
    rejectedRowCount: parsed.rejected.length,
    diagnostics: itemReadDiagnostics(parsed.rejected),
    allCloudRowsRejected: false,
  }
}

/** Compatibility wrapper for background consumers that only need safe rows. */
export async function listItems(): Promise<Item[]> {
  return (await listItemsDetailed()).rows
}

function canonicalItemDate(value: unknown): string {
  const parsed = normalizeMonthEndItemDate(value)
  if (!parsed.ok) throw new Error('Invalid item date. Use YYYY-MM-DD or a day-first D/M/YYYY date.')
  return parsed.value
}

function canonicalItemDraft(record: Omit<Item, 'id' | 'created_at'>): Omit<Item, 'id' | 'created_at'> {
  return { ...record, date_purchased: canonicalItemDate(record.date_purchased) }
}

export async function addItem(record: Omit<Item, 'id' | 'created_at'>): Promise<Item> {
  const saved = normalizeItem(stamp(canonicalItemDraft(record), 'item') as Item)
  await queueTableUpsert(ITEMS_RESOURCE, [_itemRow(saved)], [saved.id], () => {
    _patchCache((e) => { e.items = [saved, ...e.items.filter((i) => i.id !== saved.id)] })
  })
  return saved
}

export async function addItems(records: Omit<Item, 'id' | 'created_at'>[]): Promise<Item[]> {
  const saved = (records || []).map((r) => normalizeItem(stamp(canonicalItemDraft(r), 'item') as Item))
  if (!saved.length) return []
  await queueTableUpsert(ITEMS_RESOURCE, saved.map(_itemRow), saved.map((item) => item.id), () => {
    _patchCache((e) => {
      const ids = new Set(saved.map((s) => s.id))
      e.items = [...saved, ...e.items.filter((i) => !ids.has(i.id))]
    })
  })
  return saved
}

export async function updateItem(id: string, patch: Partial<Item>): Promise<Item | null> {
  const current = _readCache().items.find((item) => item.id === id)
  if (!current) return null
  const canonicalPatch = 'date_purchased' in patch
    ? { ...patch, date_purchased: canonicalItemDate(patch.date_purchased) }
    : patch
  const saved = normalizeItem({ ...current, ..._itemPatch(canonicalPatch), id } as Item)
  await queueTableUpsert(ITEMS_RESOURCE, [_itemRow(saved)], [id], () => {
    _patchCache((e) => { e.items = e.items.map((i) => (i.id === id ? saved : i)) })
  })
  return saved
}

export async function removeItem(id: string): Promise<number> {
  let n = 0
  await queueTableDelete(ITEMS_RESOURCE, [id], () => {
    _patchCache((e) => { e.items = e.items.filter((i) => i.id !== id); n = e.items.length })
  })
  return n
}

export async function removeItems(ids: string[]): Promise<number> {
  if (!ids || !ids.length) return 0
  let removed = 0
  await queueTableDelete(ITEMS_RESOURCE, ids, () => {
    _patchCache((e) => {
      const drop = new Set(ids)
      const before = e.items.length
      e.items = e.items.filter((i) => !drop.has(i.id))
      removed = before - e.items.length
    })
  })
  return removed
}

// ── Payments (settlements) ───────────────────────────────────────────────────
export async function listPayments(): Promise<Payment[]> {
  const scope = syncCoordinator.captureScope()
  await _importLocalOnce()
  const fallback = () => sortedDesc(withoutTombstones(_readCacheFrom(scope).payments, cachedTombstoneIds(scope, PAYMENTS_RESOURCE)))
  if (!scope.isActive() || syncCoordinator.isDirty(PAYMENTS_RESOURCE) || syncCoordinator.isDirty(SETTLEMENT_RESOURCE)) return fallback()
  const [result, tombstones] = await Promise.all([
    supabase.from(PAYMENTS).select('*').order('created_at', { ascending: false }),
    loadTombstoneIds(scope, PAYMENTS_RESOURCE),
  ])
  if (!scope.isActive() || syncCoordinator.isDirty(PAYMENTS_RESOURCE) || syncCoordinator.isDirty(SETTLEMENT_RESOURCE)) return fallback()
  if (result.error || !result.data) return fallback()
  rememberRowRevisions(PAYMENTS_RESOURCE, result.data as unknown as Record<string, unknown>[])
  const parsed = salvageMonthEndRows(result.data, 'payments')
  if (parsed.rejected.length) warning('molnet')
  const rows = withoutTombstones(parsed.value as unknown as Payment[], tombstones)
  const cache = _readCacheFrom(scope); cache.payments = rows; scope.write(CACHE_KEY, JSON.stringify(cache))
  return rows
}

// Insert the payment AND flip its items to paid in ONE transaction, via the
// `sync_settle_items` security-definer RPC (plans 48/98). The writes commit or roll
// back together, so a crash/network drop can no longer leave a settlement whose
// items are half-flipped. Cache is patched only after the RPC succeeds (plan 47).
export async function settle(draft: Omit<Payment, 'id' | 'created_at'>): Promise<Payment> {
  const payment = stamp(draft || {}, 'pay') as Payment
  const itemIds = payment.item_ids || []
  const expected = {
    [revisionKey(PAYMENTS_RESOURCE, payment.id)]: null,
    ...Object.fromEntries(itemIds.map((id) => {
      const key = revisionKey(ITEMS_RESOURCE, id)
      return [key, syncCoordinator.getRevision(key)]
    })),
  }
  await syncCoordinator.mutate({
    resource: SETTLEMENT_RESOURCE, operation: 'upsert', payload: { kind: 'settle', payment: _paymentRow(payment) },
    entityIds: [payment.id, ...itemIds], expectedRevisions: expected,
    applyLocal: () => _patchCache((e) => {
      e.payments = [payment, ...e.payments.filter((p) => p.id !== payment.id)]
      const ids = new Set(itemIds)
      e.items = e.items.map((it) => (ids.has(it.id) ? { ...it, paid: true, payment_id: payment.id } : it))
    }),
  })
  return payment
}

// Un-flip the items AND delete the payment in ONE transaction, via the
// `sync_unsettle_payment` RPC — the revision-aware atomic mirror of settle.
export async function removePayment(id: string): Promise<number> {
  const cachedPayment = _readCache().payments.find((payment) => payment.id === id)
  const itemIds = cachedPayment?.item_ids ?? []
  const keys = [revisionKey(PAYMENTS_RESOURCE, id), ...itemIds.map((itemId) => revisionKey(ITEMS_RESOURCE, itemId))]
  let n = 0
  await syncCoordinator.mutate({
    resource: SETTLEMENT_RESOURCE, operation: 'delete', payload: { kind: 'unsettle', id }, entityIds: [id],
    expectedRevisions: Object.fromEntries(keys.map((key) => [key, syncCoordinator.getRevision(key)])),
    applyLocal: () => _patchCache((e) => {
      e.payments = e.payments.filter((p) => p.id !== id); n = e.payments.length
      e.items = e.items.map((it) => (it.payment_id === id ? { ...it, paid: false, payment_id: null } : it))
    }),
  })
  return n
}

// ── Settings (tool_state blob) ───────────────────────────────────────────────
export async function getSettings(): Promise<MonthEndSettings> {
  const scope = syncCoordinator.captureScope()
  await _importLocalOnce()
  if (!scope.isActive() || syncCoordinator.isDirty(SETTINGS_RESOURCE)) return { ...defaultSettings(), ..._readCacheFrom(scope).settings }
  const { data, error } = await supabase.from(STATE).select('data,revision').eq('tool', SETTINGS_TOOL).maybeSingle()
  if (!scope.isActive() || syncCoordinator.isDirty(SETTINGS_RESOURCE)) return { ...defaultSettings(), ..._readCacheFrom(scope).settings }
  if (error) return { ...defaultSettings(), ..._readCacheFrom(scope).settings }
  rememberToolRevision(SETTINGS_TOOL, data)
  const settings = { ...defaultSettings(), ...((data?.data as Partial<MonthEndSettings>) || {}) }
  const cache = _readCacheFrom(scope); cache.settings = settings; scope.write(CACHE_KEY, JSON.stringify(cache))
  return settings
}

export async function saveSettings(patch: Partial<MonthEndSettings>): Promise<MonthEndSettings> {
  const scope = syncCoordinator.captureScope()
  const current = await getSettings()
  if (!scope.isActive()) throw new Error('Sync identity changed while saving settings')
  const merged = { ...defaultSettings(), ...current, ...(patch || {}) }
  await syncCoordinator.mutate({
    resource: SETTINGS_RESOURCE, operation: 'upsert', payload: { data: merged }, entityIds: [SETTINGS_TOOL],
    expectedRevisions: { [SETTINGS_RESOURCE]: syncCoordinator.getRevision(SETTINGS_RESOURCE) },
    applyLocal: () => _patchCache((e) => { e.settings = merged }),
  })
  return merged
}

// ── Backup ───────────────────────────────────────────────────────────────────
export async function exportJSON(): Promise<string> {
  const [items, payments, settings] = await Promise.all([listItems(), listPayments(), getSettings()])
  return JSON.stringify({ version: VERSION, items: sortedDesc(items), payments: sortedDesc(payments), settings }, null, 2)
}

// Merge a previously-exported backup into the cloud. Deduped by id against what's
// already there (idempotent restore). Resolves { items, payments } added counts;
// rejects on unparseable / empty input.
export async function importJSON(text: string): Promise<{ items: number; payments: number }> {
  let parsed: Record<string, unknown>
  try { parsed = JSON.parse(text) } catch { throw new Error('That file isn’t valid JSON.') }
  if (!parsed || typeof parsed !== 'object') throw new Error('No Månadsavslut data found in that file.')
  const valid = parseMonthEndEnvelope(parsed)
  if (!valid.ok) throw new Error('Månadsavslutet innehåller ogiltiga eller ofullständiga uppgifter.')
  if (!parsed.items && !parsed.payments) throw new Error('No Månadsavslut data found in that file.')

  const scope = syncCoordinator.captureScope()
  const normalized = materializeImport('monthend-backup', text, () => ({
    items: valid.value.items.map(normalizeItem), payments: valid.value.payments,
  }))

  const [existingItems, existingPays, existingSettings] = await Promise.all([listItems(), listPayments(), getSettings()])
  if (!scope.isActive()) throw new Error('Sync identity changed during month-end import')
  const itemSeen = new Set(existingItems.map((r) => r.id))
  const paySeen = new Set(existingPays.map((r) => r.id))

  const newItems: Item[] = []
  normalized.items.forEach((row) => {
    if (itemSeen.has(row.id)) return
    itemSeen.add(row.id); newItems.push(row)
  })
  const newPays: Payment[] = []
  normalized.payments.forEach((row) => {
    if (paySeen.has(row.id)) return
    paySeen.add(row.id); newPays.push(row)
  })

  const operations = []
  if (newItems.length) operations.push({ resource: ITEMS_RESOURCE, operation: 'upsert' as const, payload: { rows: newItems.map(_itemRow), seed: true }, entityIds: newItems.map((row) => row.id), expectedRevisions: Object.fromEntries(newItems.map((row) => [revisionKey(ITEMS_RESOURCE, row.id), null])), applyLocal: () => _patchCache((e) => { const ids = new Set(newItems.map((row) => row.id)); e.items = [...newItems, ...e.items.filter((row) => !ids.has(row.id))] }) })
  if (newPays.length) operations.push({ resource: PAYMENTS_RESOURCE, operation: 'upsert' as const, payload: { rows: newPays.map(_paymentRow), seed: true }, entityIds: newPays.map((row) => row.id), expectedRevisions: Object.fromEntries(newPays.map((row) => [revisionKey(PAYMENTS_RESOURCE, row.id), null])), applyLocal: () => _patchCache((e) => { const ids = new Set(newPays.map((row) => row.id)); e.payments = [...newPays, ...e.payments.filter((row) => !ids.has(row.id))] }) })
  if (parsed.settings && typeof parsed.settings === 'object') {
    const merged = { ...defaultSettings(), ...existingSettings, ...(parsed.settings as Partial<MonthEndSettings>) }
    operations.push({ resource: SETTINGS_RESOURCE, operation: 'upsert' as const, payload: { data: merged, seed: true }, entityIds: [SETTINGS_TOOL], expectedRevisions: { [SETTINGS_RESOURCE]: syncCoordinator.getRevision(SETTINGS_RESOURCE) }, applyLocal: () => _patchCache((e) => { e.settings = merged }) })
  }
  if (!scope.isActive()) throw new Error('Sync identity changed during month-end import')
  await syncCoordinator.mutateBatch(operations)
  return { items: newItems.length, payments: newPays.length }
}
