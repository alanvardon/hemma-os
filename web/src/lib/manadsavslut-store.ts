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

// Normalize a loaded item so older localStorage data and JSON backups gain the
// personal carve-out fields with safe defaults (no migration script needed):
//  - pre-personal items (no fields)        → personal_items: []
//  - v1 items (personal_a/b + one note)    → synthesised into personal_items, the
//    single note riding the first entry
//  - current items (personal_items present)→ re-derive the cached sums (idempotent)
// Idempotent, so it is safe to run on cloud rows and cached rows alike.
export function normalizeItem(it: Item): Item {
  const raw = it as unknown as Record<string, unknown>
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
  for (const c of cols) if (c in patch) out[c] = (patch as Record<string, unknown>)[c]
  if ('personal_items' in patch) {
    const sums = personalSums(normalizePersonalEntries((patch as Record<string, unknown>).personal_items))
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
    const d = JSON.parse(raw) as Record<string, unknown>
    if (!d || typeof d !== 'object') return empty
    return {
      version: VERSION,
      items: Array.isArray(d.items) ? (d.items as Item[]).map(normalizeItem) : [],
      payments: Array.isArray(d.payments) ? (d.payments as Payment[]) : [],
      settings: { ...defaultSettings(), ...((d.settings as Partial<MonthEndSettings>) || {}) },
    }
  } catch { return empty }
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
function _readLegacy(scope: ReturnType<typeof syncCoordinator.captureScope>): { items: Item[]; payments: Payment[]; settings: MonthEndSettings | null } {
  const raw = scope.read(STORAGE_KEY)
  if (!raw) return { items: [], payments: [], settings: null }
  let d: Record<string, unknown>
  try {
    d = JSON.parse(raw) as Record<string, unknown>
    if (!d || typeof d !== 'object') return { items: [], payments: [], settings: null }
  } catch { return { items: [], payments: [], settings: null } }
  return materializeImport('monthend-legacy', raw, () => {
    const items = Array.isArray(d.items) ? (d.items as Item[]).map((r) => {
      const row = normalizeItem({ ...r })
      if (!row.id) row.id = genId('item')
      if (!row.created_at) row.created_at = new Date().toISOString()
      return row
    }) : []
    const payments = Array.isArray(d.payments) ? (d.payments as Payment[]).map((r) => {
      const row = { ...r }
      if (!row.id) row.id = genId('pay')
      if (!row.created_at) row.created_at = new Date().toISOString()
      return row
    }) : []
    const settings = (d.settings && typeof d.settings === 'object')
      ? { ...defaultSettings(), ...(d.settings as Partial<MonthEndSettings>) } : null
    return { items, payments, settings }
  })
}

// On the first authenticated load after the household exists, upsert the legacy
// localStorage envelope into the cloud (items + payments keyed on id — idempotent;
// settings only if no cloud row exists yet, so a partner's already-saved settings
// aren't clobbered). Runs before the read queries below, so imported rows appear
// in that same call.
const _importLocalOnce = makeImportOnce(() => syncCoordinator.scopedStorageKey(IMPORT_FLAG), async () => {
  const scope = syncCoordinator.captureScope()
  if (!legacyImportAssignedToActive() || !scope.isActive()) return true
  const legacy = _readLegacy(scope)
  const operations = []
  if (legacy.items.length) operations.push({
    resource: ITEMS_RESOURCE, operation: 'upsert' as const, payload: { rows: legacy.items.map(_itemRow), seed: true },
    entityIds: legacy.items.map((row) => row.id),
    applyLocal: () => _patchCache((e) => { const ids = new Set(legacy.items.map((row) => row.id)); e.items = [...legacy.items, ...e.items.filter((row) => !ids.has(row.id))] }),
  })
  if (legacy.payments.length) operations.push({
    resource: PAYMENTS_RESOURCE, operation: 'upsert' as const, payload: { rows: legacy.payments.map(_paymentRow), seed: true },
    entityIds: legacy.payments.map((row) => row.id),
    applyLocal: () => _patchCache((e) => { const ids = new Set(legacy.payments.map((row) => row.id)); e.payments = [...legacy.payments, ...e.payments.filter((row) => !ids.has(row.id))] }),
  })
  if (legacy.settings) operations.push({
    resource: SETTINGS_RESOURCE, operation: 'upsert' as const, payload: { data: legacy.settings, seed: true }, entityIds: [SETTINGS_TOOL],
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
  const { error } = payload.seed === true
    ? await supabase.from(STATE).insert({ tool: SETTINGS_TOOL, data })
    : await supabase.from(STATE).upsert({ tool: SETTINGS_TOOL, data }, { onConflict: 'household_id,tool' })
  if (payload.seed === true && (error as { code?: string } | null)?.code === '23505') return
  if (error) throw error
}, (operation) => operation.operation === 'upsert'
  && !!(operation.payload as { data?: unknown })?.data
  && typeof (operation.payload as { data?: unknown }).data === 'object'
  && ((operation.payload as { seed?: unknown }).seed === undefined || typeof (operation.payload as { seed?: unknown }).seed === 'boolean')
  && operation.entityIds.length === 1 && operation.entityIds[0] === SETTINGS_TOOL)
syncCoordinator.register(SETTLEMENT_RESOURCE, async (operation) => {
  const payload = operation.payload as { rpc?: unknown; args?: unknown }
  if (payload.rpc !== 'settle_items' && payload.rpc !== 'unsettle_payment') {
    throw { status: 400, message: 'Malformed settlement operation' }
  }
  const { error } = await supabase.rpc(payload.rpc, payload.args)
  if (error && payload.rpc === 'settle_items') {
    const args = payload.args as {
      p_id?: unknown; p_item_ids?: unknown; p_from?: unknown; p_to?: unknown;
      p_amount?: unknown; p_period_label?: unknown; p_note?: unknown; p_created_at?: unknown
    }
    const id = args?.p_id
    if (typeof id === 'string') {
      const { data, error: verifyError } = await supabase.from(PAYMENTS).select('*').eq('id', id).maybeSingle()
      // A response can be lost after the transaction committed. The stable
      // payment id plus exact payload make that replay observable as success;
      // an unrelated row with the same id must remain a conflict.
      const row = data as Record<string, unknown> | null
      if (!verifyError && row
        && JSON.stringify(row.item_ids ?? []) === JSON.stringify(args.p_item_ids ?? [])
        && (row.from_person ?? null) === (args.p_from ?? null)
        && (row.to_person ?? null) === (args.p_to ?? null)
        && Number(row.amount ?? 0) === Number(args.p_amount ?? 0)
        && String(row.period_label ?? '') === String(args.p_period_label ?? '')
        && String(row.note ?? '') === String(args.p_note ?? '')
        && new Date(String(row.created_at)).toISOString() === new Date(String(args.p_created_at)).toISOString()) return
    }
  }
  if (error) throw error
}, (operation) => {
  const payload = operation.payload as { rpc?: unknown; args?: unknown }
  if (!payload?.args || typeof payload.args !== 'object') return false
  if (operation.operation === 'delete' && payload.rpc === 'unsettle_payment') {
    const id = (payload.args as { p_id?: unknown }).p_id
    return typeof id === 'string' && !!id && operation.entityIds.length === 1 && operation.entityIds[0] === id
  }
  if (operation.operation === 'upsert' && payload.rpc === 'settle_items') {
    const args = payload.args as { p_id?: unknown; p_item_ids?: unknown }
    if (typeof args.p_id !== 'string' || !args.p_id || !Array.isArray(args.p_item_ids)
      || !args.p_item_ids.every((id) => typeof id === 'string' && !!id)) return false
    const expected = [args.p_id, ...args.p_item_ids]
    return expected.length === operation.entityIds.length && expected.every((id, index) => id === operation.entityIds[index])
  }
  return false
})

// ── Items ──────────────────────────────────────────────────────────────────
export async function listItems(): Promise<Item[]> {
  const scope = syncCoordinator.captureScope()
  await _importLocalOnce()
  const fallback = () => sortedDesc(withoutTombstones(_readCacheFrom(scope).items, cachedTombstoneIds(scope, ITEMS_RESOURCE)))
  if (!scope.isActive() || syncCoordinator.isDirty(ITEMS_RESOURCE) || syncCoordinator.isDirty(SETTLEMENT_RESOURCE)) return fallback()
  const [result, tombstones] = await Promise.all([
    supabase.from(ITEMS).select('*').order('created_at', { ascending: false }),
    loadTombstoneIds(scope, ITEMS_RESOURCE),
  ])
  if (!scope.isActive() || syncCoordinator.isDirty(ITEMS_RESOURCE) || syncCoordinator.isDirty(SETTLEMENT_RESOURCE)) return fallback()
  if (result.error || !result.data) return fallback()
  const rows = withoutTombstones((result.data as Item[]).map(normalizeItem), tombstones)
  if (scope.isActive()) {
    const cache = _readCacheFrom(scope); cache.items = rows; scope.write(CACHE_KEY, JSON.stringify(cache))
  }
  return rows
}

export async function addItem(record: Omit<Item, 'id' | 'created_at'>): Promise<Item> {
  const saved = normalizeItem(stamp(record, 'item') as Item)
  await queueTableUpsert(ITEMS_RESOURCE, [_itemRow(saved)], [saved.id], () => {
    _patchCache((e) => { e.items = [saved, ...e.items.filter((i) => i.id !== saved.id)] })
  })
  return saved
}

export async function addItems(records: Omit<Item, 'id' | 'created_at'>[]): Promise<Item[]> {
  const saved = (records || []).map((r) => normalizeItem(stamp(r, 'item') as Item))
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
  const saved = normalizeItem({ ...current, ..._itemPatch(patch), id } as Item)
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
  const rows = withoutTombstones(result.data as Payment[], tombstones)
  const cache = _readCacheFrom(scope); cache.payments = rows; scope.write(CACHE_KEY, JSON.stringify(cache))
  return rows
}

// Insert the payment AND flip its items to paid in ONE transaction, via the
// `settle_items` security-definer RPC (plan 48). The two writes commit or roll
// back together, so a crash/network drop can no longer leave a settlement whose
// items are half-flipped. Cache is patched only after the RPC succeeds (plan 47).
export async function settle(draft: Omit<Payment, 'id' | 'created_at'>): Promise<Payment> {
  const payment = stamp(draft || {}, 'pay') as Payment
  const itemIds = payment.item_ids || []
  const args = {
    p_id: payment.id,
    p_item_ids: itemIds,
    p_from: payment.from_person ?? null,
    p_to: payment.to_person ?? null,
    p_amount: payment.amount ?? 0,
    p_period_label: payment.period_label ?? '',
    p_note: payment.note ?? '',
    p_created_at: payment.created_at,
  }
  await syncCoordinator.mutate({
    resource: SETTLEMENT_RESOURCE, operation: 'upsert', payload: { rpc: 'settle_items', args }, entityIds: [payment.id, ...itemIds],
    applyLocal: () => _patchCache((e) => {
      e.payments = [payment, ...e.payments.filter((p) => p.id !== payment.id)]
      const ids = new Set(itemIds)
      e.items = e.items.map((it) => (ids.has(it.id) ? { ...it, paid: true, payment_id: payment.id } : it))
    }),
  })
  return payment
}

// Un-flip the items AND delete the payment in ONE transaction, via the
// `unsettle_payment` RPC — the atomic mirror of settle (plan 48).
export async function removePayment(id: string): Promise<number> {
  let n = 0
  await syncCoordinator.mutate({
    resource: SETTLEMENT_RESOURCE, operation: 'delete', payload: { rpc: 'unsettle_payment', args: { p_id: id } }, entityIds: [id],
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
  const { data, error } = await supabase.from(STATE).select('data').eq('tool', SETTINGS_TOOL).maybeSingle()
  if (!scope.isActive() || syncCoordinator.isDirty(SETTINGS_RESOURCE)) return { ...defaultSettings(), ..._readCacheFrom(scope).settings }
  if (error) return { ...defaultSettings(), ..._readCacheFrom(scope).settings }
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
  const inItems = Array.isArray(parsed.items) ? (parsed.items as Item[]) : []
  const inPays = Array.isArray(parsed.payments) ? (parsed.payments as Payment[]) : []
  if (!parsed.items && !parsed.payments) throw new Error('No Månadsavslut data found in that file.')

  const scope = syncCoordinator.captureScope()
  const normalized = materializeImport('monthend-backup', text, () => ({
    items: inItems.filter((raw) => !!raw && typeof raw === 'object').map((raw) => {
      const row = normalizeItem({ ...raw }); if (!row.id) row.id = genId('item'); if (!row.created_at) row.created_at = new Date().toISOString(); return row
    }),
    payments: inPays.filter((raw) => !!raw && typeof raw === 'object').map((raw) => {
      const row = { ...raw }; if (!row.id) row.id = genId('pay'); if (!row.created_at) row.created_at = new Date().toISOString(); return row
    }),
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
  if (newItems.length) operations.push({ resource: ITEMS_RESOURCE, operation: 'upsert' as const, payload: { rows: newItems.map(_itemRow), seed: true }, entityIds: newItems.map((row) => row.id), applyLocal: () => _patchCache((e) => { const ids = new Set(newItems.map((row) => row.id)); e.items = [...newItems, ...e.items.filter((row) => !ids.has(row.id))] }) })
  if (newPays.length) operations.push({ resource: PAYMENTS_RESOURCE, operation: 'upsert' as const, payload: { rows: newPays.map(_paymentRow), seed: true }, entityIds: newPays.map((row) => row.id), applyLocal: () => _patchCache((e) => { const ids = new Set(newPays.map((row) => row.id)); e.payments = [...newPays, ...e.payments.filter((row) => !ids.has(row.id))] }) })
  if (parsed.settings && typeof parsed.settings === 'object') {
    const merged = { ...defaultSettings(), ...existingSettings, ...(parsed.settings as Partial<MonthEndSettings>) }
    operations.push({ resource: SETTINGS_RESOURCE, operation: 'upsert' as const, payload: { data: merged, seed: true }, entityIds: [SETTINGS_TOOL], applyLocal: () => _patchCache((e) => { e.settings = merged }) })
  }
  if (!scope.isActive()) throw new Error('Sync identity changed during month-end import')
  await syncCoordinator.mutateBatch(operations)
  return { items: newItems.length, payments: newPays.length }
}
