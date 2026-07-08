// manadsavslut-store.ts — persistence for Månadsavslut. Phase 16c: reads and
// writes Supabase (cloud source-of-truth) — items → `monthend_items`, payments →
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

// Legacy pre-Supabase envelope — import source + backup (read-only after swap).
export const STORAGE_KEY = 'bostadskalkyl_monthend_v1'
const CACHE_KEY = 'bostadskalkyl_monthend_cache_v1'
const IMPORT_FLAG = 'bostadskalkyl_monthend_supabase_imported'
const ITEMS = 'monthend_items'
const PAYMENTS = 'monthend_payments'
const STATE = 'tool_state'
const SETTINGS_TOOL = 'manadsavslut-settings'
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

function stamp<T extends object>(record: T, prefix: string): T & { id: string; created_at: string } {
  const r = record as Record<string, unknown>
  return { ...record, id: (r.id as string) || genId(prefix), created_at: (r.created_at as string) || new Date().toISOString() } as T & { id: string; created_at: string }
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
  const empty: Envelope = { version: VERSION, items: [], payments: [], settings: defaultSettings() }
  try {
    const raw = localStorage.getItem(CACHE_KEY)
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
    localStorage.setItem(CACHE_KEY, JSON.stringify({ version: VERSION, items: env.items, payments: env.payments, settings: env.settings }))
  } catch { /* private mode / quota — cache is best-effort */ }
}

// Read-modify-write one slice of the cache envelope.
function _patchCache(fn: (env: Envelope) => void): void {
  const env = _readCache(); fn(env); _writeCache(env)
}

// ── First-login import (one-time, idempotent) ───────────────────────────────
// Read the pre-Supabase envelope from the legacy key — normalised, with
// id/created_at guaranteed — ready to upsert. Read-only: STORAGE_KEY is never
// written after the swap, so the original survives even if every upload fails.
function _readLegacy(): { items: Item[]; payments: Payment[]; settings: MonthEndSettings | null } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { items: [], payments: [], settings: null }
    const d = JSON.parse(raw) as Record<string, unknown>
    if (!d || typeof d !== 'object') return { items: [], payments: [], settings: null }
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
  } catch {
    return { items: [], payments: [], settings: null }
  }
}

// On the first authenticated load after the household exists, upsert the legacy
// localStorage envelope into the cloud (items + payments keyed on id — idempotent;
// settings only if no cloud row exists yet, so a partner's already-saved settings
// aren't clobbered) and set a flag. Runs before the read queries below, so
// imported rows appear in that same call. On any error it leaves the flag unset
// to retry; `_importOnce` dedupes concurrent calls within a session.
let _importOnce: Promise<void> | null = null
function _importLocalOnce(): Promise<void> {
  if (_importOnce) return _importOnce
  _importOnce = (async () => {
    let already = true
    try { already = localStorage.getItem(IMPORT_FLAG) === '1' } catch { already = false }
    if (already) return
    const legacy = _readLegacy()
    if (legacy.items.length) {
      const { error } = await supabase.from(ITEMS).upsert(legacy.items.map(_itemRow), { onConflict: 'id' })
      if (error) { _importOnce = null; return }
    }
    if (legacy.payments.length) {
      const { error } = await supabase.from(PAYMENTS).upsert(legacy.payments.map(_paymentRow), { onConflict: 'id' })
      if (error) { _importOnce = null; return }
    }
    if (legacy.settings) {
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

// ── Items ──────────────────────────────────────────────────────────────────
export async function listItems(): Promise<Item[]> {
  await _importLocalOnce()
  const { data, error } = await supabase.from(ITEMS).select('*').order('created_at', { ascending: false })
  if (error || !data) return sortedDesc(_readCache().items)
  const rows = (data as Item[]).map(normalizeItem)
  _patchCache((e) => { e.items = rows })
  return rows
}

export async function addItem(record: Omit<Item, 'id' | 'created_at'>): Promise<Item> {
  const saved = normalizeItem(stamp(record, 'item') as Item)
  const { error } = await supabase.from(ITEMS).insert(_itemRow(saved))
  if (error) throw error
  _patchCache((e) => { e.items = [saved, ...e.items.filter((i) => i.id !== saved.id)] })
  return saved
}

export async function addItems(records: Omit<Item, 'id' | 'created_at'>[]): Promise<Item[]> {
  const saved = (records || []).map((r) => normalizeItem(stamp(r, 'item') as Item))
  if (!saved.length) return []
  const { error } = await supabase.from(ITEMS).insert(saved.map(_itemRow))
  if (error) throw error
  _patchCache((e) => {
    const ids = new Set(saved.map((s) => s.id))
    e.items = [...saved, ...e.items.filter((i) => !ids.has(i.id))]
  })
  return saved
}

export async function updateItem(id: string, patch: Partial<Item>): Promise<Item | null> {
  const { data, error } = await supabase.from(ITEMS).update(_itemPatch(patch)).eq('id', id).select().maybeSingle()
  if (error) throw error
  if (!data) return null
  const saved = normalizeItem(data as Item)
  _patchCache((e) => { e.items = e.items.map((i) => (i.id === id ? saved : i)) })
  return saved
}

export async function removeItem(id: string): Promise<number> {
  const { error } = await supabase.from(ITEMS).delete().eq('id', id)
  if (error) throw error
  let n = 0
  _patchCache((e) => { e.items = e.items.filter((i) => i.id !== id); n = e.items.length })
  return n
}

export async function removeItems(ids: string[]): Promise<number> {
  if (!ids || !ids.length) return 0
  const { error } = await supabase.from(ITEMS).delete().in('id', ids)
  if (error) throw error
  let removed = 0
  _patchCache((e) => {
    const drop = new Set(ids)
    const before = e.items.length
    e.items = e.items.filter((i) => !drop.has(i.id))
    removed = before - e.items.length
  })
  return removed
}

// ── Payments (settlements) ───────────────────────────────────────────────────
export async function listPayments(): Promise<Payment[]> {
  await _importLocalOnce()
  const { data, error } = await supabase.from(PAYMENTS).select('*').order('created_at', { ascending: false })
  if (error || !data) return sortedDesc(_readCache().payments)
  const rows = data as Payment[]
  _patchCache((e) => { e.payments = rows })
  return rows
}

// Insert the payment AND flip its items to paid in ONE transaction, via the
// `settle_items` security-definer RPC (plan 48). The two writes commit or roll
// back together, so a crash/network drop can no longer leave a settlement whose
// items are half-flipped. Cache is patched only after the RPC succeeds (plan 47).
export async function settle(draft: Omit<Payment, 'id' | 'created_at'>): Promise<Payment> {
  const payment = stamp(draft || {}, 'pay') as Payment
  const itemIds = payment.item_ids || []
  const { error } = await supabase.rpc('settle_items', {
    p_id: payment.id,
    p_item_ids: itemIds,
    p_from: payment.from_person ?? null,
    p_to: payment.to_person ?? null,
    p_amount: payment.amount ?? 0,
    p_period_label: payment.period_label ?? '',
    p_note: payment.note ?? '',
    p_created_at: payment.created_at,
  })
  if (error) throw error
  _patchCache((e) => {
    e.payments = [payment, ...e.payments.filter((p) => p.id !== payment.id)]
    const ids = new Set(itemIds)
    e.items = e.items.map((it) => (ids.has(it.id) ? { ...it, paid: true, payment_id: payment.id } : it))
  })
  return payment
}

// Un-flip the items AND delete the payment in ONE transaction, via the
// `unsettle_payment` RPC — the atomic mirror of settle (plan 48).
export async function removePayment(id: string): Promise<number> {
  const { error } = await supabase.rpc('unsettle_payment', { p_id: id })
  if (error) throw error
  let n = 0
  _patchCache((e) => {
    e.payments = e.payments.filter((p) => p.id !== id); n = e.payments.length
    e.items = e.items.map((it) => (it.payment_id === id ? { ...it, paid: false, payment_id: null } : it))
  })
  return n
}

// ── Settings (tool_state blob) ───────────────────────────────────────────────
export async function getSettings(): Promise<MonthEndSettings> {
  await _importLocalOnce()
  const { data, error } = await supabase.from(STATE).select('data').eq('tool', SETTINGS_TOOL).maybeSingle()
  if (error) return { ...defaultSettings(), ..._readCache().settings }
  const settings = { ...defaultSettings(), ...((data?.data as Partial<MonthEndSettings>) || {}) }
  _patchCache((e) => { e.settings = settings })
  return settings
}

export async function saveSettings(patch: Partial<MonthEndSettings>): Promise<MonthEndSettings> {
  const current = await getSettings()
  const merged = { ...defaultSettings(), ...current, ...(patch || {}) }
  const { error } = await supabase.from(STATE).upsert({ tool: SETTINGS_TOOL, data: merged }, { onConflict: 'household_id,tool' })
  if (error) throw error
  _patchCache((e) => { e.settings = merged })
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

  const [existingItems, existingPays] = await Promise.all([listItems(), listPayments()])
  const itemSeen = new Set(existingItems.map((r) => r.id))
  const paySeen = new Set(existingPays.map((r) => r.id))

  const newItems: Item[] = []
  inItems.forEach((raw) => {
    if (!raw || typeof raw !== 'object') return
    const row = normalizeItem({ ...(raw as Item) })
    if (!row.id) row.id = genId('item')
    if (itemSeen.has(row.id)) return
    if (!row.created_at) row.created_at = new Date().toISOString()
    itemSeen.add(row.id); newItems.push(row)
  })
  const newPays: Payment[] = []
  inPays.forEach((raw) => {
    if (!raw || typeof raw !== 'object') return
    const row = { ...(raw as Payment) }
    if (!row.id) row.id = genId('pay')
    if (paySeen.has(row.id)) return
    if (!row.created_at) row.created_at = new Date().toISOString()
    paySeen.add(row.id); newPays.push(row)
  })

  if (newItems.length) {
    const { error } = await supabase.from(ITEMS).insert(newItems.map(_itemRow))
    if (error) throw error
  }
  if (newPays.length) {
    const { error } = await supabase.from(PAYMENTS).insert(newPays.map(_paymentRow))
    if (error) throw error
  }
  if (parsed.settings && typeof parsed.settings === 'object') {
    await saveSettings(parsed.settings as Partial<MonthEndSettings>)
  }
  _patchCache((e) => {
    const iids = new Set(newItems.map((i) => i.id))
    e.items = [...newItems, ...e.items.filter((i) => !iids.has(i.id))]
    const pids = new Set(newPays.map((p) => p.id))
    e.payments = [...newPays, ...e.payments.filter((p) => !pids.has(p.id))]
  })
  return { items: newItems.length, payments: newPays.length }
}
