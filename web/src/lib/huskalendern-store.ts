// huskalendern-store.ts — persistence for Huskalendern. Reads and writes
// Supabase (cloud source-of-truth) — rows → `house_items` — with a localStorage
// write-through CACHE for offline. Row-store pattern à la manadsavslut-store:
// per-row insert/update/delete, NEVER delete-then-insert (plan 43), save errors
// surface via throw so the route can toast them (plan 44). No legacy pre-cloud
// key exists (new tool), so there is no first-login import step.
//
// supabase-js returns { data, error } (never throws) — reads fall back to the
// cache, writes surface via throw (toPersistenceError).

import type { HouseItem } from './huskalendern'
import { supabase } from './supabase'
import { toPersistenceError } from './persistence-error'
import { genId } from './id'
import { stamp } from './store-helpers'

const CACHE_KEY = 'bostadskalkyl_house_items_cache_v1'
const TABLE = 'house_items'
const VERSION = 1

interface Envelope { version: number; items: HouseItem[] }

// Coerce a loaded row (cloud or cache) into a well-formed HouseItem with safe
// defaults, so malformed/legacy JSON can't crash the timeline math. Idempotent.
export function normalizeItem(raw: unknown): HouseItem {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const type = r.type === 'contract' ? 'contract' : 'log'
  const num = (v: unknown): number | null => {
    if (v == null || v === '') return null
    const n = Number(v)
    return isFinite(n) ? n : null
  }
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
  return {
    id: typeof r.id === 'string' ? r.id : genId('house'),
    created_at: typeof r.created_at === 'string' ? r.created_at : new Date().toISOString(),
    type,
    title: typeof r.title === 'string' ? r.title : '',
    category: typeof r.category === 'string' && r.category ? r.category : 'övrigt',
    date: str(r.date),
    cost: num(r.cost),
    vendor: str(r.vendor),
    interval_years: type === 'log' ? num(r.interval_years) : null,
    remind_days: (() => { const n = Number(r.remind_days); return isFinite(n) && n > 0 ? n : 60 })(),
    notes: str(r.notes),
  }
}

// Ascending by milestone date is the timeline's job; the store keeps rows in a
// stable created_at order so the cache and cloud lists agree.
function sortedByDate<T extends { date: string | null; created_at: string }>(rows: T[]): T[] {
  return rows.slice().sort((a, b) =>
    String(a.date || '').localeCompare(String(b.date || '')) ||
    String(a.created_at || '').localeCompare(String(b.created_at || '')))
}

// ── Column projector — send exactly the table columns; OMIT household_id +
// updated_at so the column default (current_household()) and the moddatetime
// trigger fill them. The client must never send those.
function _row(it: HouseItem): Record<string, unknown> {
  return {
    id: it.id, created_at: it.created_at,
    type: it.type, title: it.title, category: it.category,
    date: it.date || null, cost: it.cost, vendor: it.vendor || null,
    interval_years: it.type === 'log' ? it.interval_years : null,
    remind_days: it.remind_days, notes: it.notes || null,
  }
}

// Project a partial patch to columns (defined keys only). Clears interval_years
// whenever the row is (re)typed as a contract, so a log→contract switch can't
// leave a stale interval on the DB row.
function _patch(patch: Partial<HouseItem>): Record<string, unknown> {
  const cols: (keyof HouseItem)[] = ['type', 'title', 'category', 'date', 'cost',
    'vendor', 'interval_years', 'remind_days', 'notes']
  const out: Record<string, unknown> = {}
  for (const c of cols) if (c in patch) out[c] = (patch as Record<string, unknown>)[c]
  if (patch.type === 'contract') out.interval_years = null
  if ('date' in patch) out.date = patch.date || null
  return out
}

// ── localStorage cache (offline fallback) ───────────────────────────────────
function _readCache(): Envelope {
  const empty: Envelope = { version: VERSION, items: [] }
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return empty
    const d = JSON.parse(raw) as Record<string, unknown>
    if (!d || typeof d !== 'object') return empty
    return { version: VERSION, items: Array.isArray(d.items) ? d.items.map(normalizeItem) : [] }
  } catch { return empty }
}

function _writeCache(env: Envelope): void {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ version: VERSION, items: env.items })) }
  catch { /* private mode / quota — cache is best-effort */ }
}

function _patchCache(fn: (env: Envelope) => void): void {
  const env = _readCache(); fn(env); _writeCache(env)
}

// Synchronous snapshot of the write-through cache, sorted to MATCH listItems(),
// so the hub can seed its Huskalendern stat on the first paint. Cold cache →
// empty array.
export function cachedSnapshot(): { items: HouseItem[] } {
  return { items: sortedByDate(_readCache().items) }
}

// ── Items ──────────────────────────────────────────────────────────────────
export async function listItems(): Promise<HouseItem[]> {
  const { data, error } = await supabase.from(TABLE).select('*').order('date', { ascending: true })
  if (error || !data) return sortedByDate(_readCache().items)
  const rows = (data as unknown[]).map(normalizeItem)
  _patchCache((e) => { e.items = rows })
  return sortedByDate(rows)
}

export async function addItem(record: Omit<HouseItem, 'id' | 'created_at'>): Promise<HouseItem> {
  const saved = normalizeItem(stamp(record, 'house'))
  const { error } = await supabase.from(TABLE).insert(_row(saved))
  if (error) throw toPersistenceError(error)
  _patchCache((e) => { e.items = [saved, ...e.items.filter((i) => i.id !== saved.id)] })
  return saved
}

export async function updateItem(id: string, patch: Partial<HouseItem>): Promise<HouseItem | null> {
  const { data, error } = await supabase.from(TABLE).update(_patch(patch)).eq('id', id).select().maybeSingle()
  if (error) throw toPersistenceError(error)
  if (!data) return null
  const saved = normalizeItem(data)
  _patchCache((e) => { e.items = e.items.map((i) => (i.id === id ? saved : i)) })
  return saved
}

export async function removeItem(id: string): Promise<number> {
  const { error } = await supabase.from(TABLE).delete().eq('id', id)
  if (error) throw toPersistenceError(error)
  let n = 0
  _patchCache((e) => { e.items = e.items.filter((i) => i.id !== id); n = e.items.length })
  return n
}
