// manadsavslut-store.ts — localStorage persistence for Månadsavslut.
// TypeScript port of manadsavslut-store.js; reads/writes the same key so data
// from the vanilla app migrates automatically. Rows are shaped 1:1 with the
// future Supabase tables (snake_case) and every method returns a Promise, so the
// Supabase swap is a one-file change here.

import { defaultSettings } from './manadsavslut'
import type { Item, Payment, MonthEndSettings } from './manadsavslut'

export const STORAGE_KEY = 'bostadskalkyl_monthend_v1'
const VERSION = 1

interface Envelope { version: number; items: Item[]; payments: Payment[]; settings: MonthEndSettings }

function genId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof (crypto as Crypto).randomUUID === 'function')
    return (crypto as Crypto).randomUUID()
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

function read(): Envelope {
  const empty: Envelope = { version: VERSION, items: [], payments: [], settings: defaultSettings() }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return empty
    const data = JSON.parse(raw) as Record<string, unknown>
    if (!data || typeof data !== 'object') return empty
    return {
      version: VERSION,
      items: Array.isArray(data.items) ? (data.items as Item[]) : [],
      payments: Array.isArray(data.payments) ? (data.payments as Payment[]) : [],
      settings: { ...defaultSettings(), ...((data.settings as Partial<MonthEndSettings>) || {}) },
    }
  } catch { return empty }
}

function write(data: Envelope): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, items: data.items, payments: data.payments, settings: data.settings })) } catch { /* quota */ }
}

function sortedDesc<T extends { created_at?: string }>(rows: T[]): T[] {
  return rows.slice().sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
}

function stamp<T extends object>(record: T, prefix: string): T & { id: string; created_at: string } {
  const r = record as Record<string, unknown>
  return { ...record, id: (r.id as string) || genId(prefix), created_at: (r.created_at as string) || new Date().toISOString() } as T & { id: string; created_at: string }
}

// ── Items ──────────────────────────────────────────────────────────────────
export function listItems(): Promise<Item[]> { return Promise.resolve(sortedDesc(read().items)) }

export function addItem(record: Omit<Item, 'id' | 'created_at'>): Promise<Item> {
  const saved = stamp(record, 'item') as Item
  const data = read(); data.items.push(saved); write(data)
  return Promise.resolve(saved)
}

export function addItems(records: Omit<Item, 'id' | 'created_at'>[]): Promise<Item[]> {
  const data = read()
  const saved = (records || []).map(r => stamp(r, 'item') as Item)
  data.items = data.items.concat(saved); write(data)
  return Promise.resolve(saved)
}

export function updateItem(id: string, patch: Partial<Item>): Promise<Item | null> {
  const data = read()
  let found: Item | null = null
  data.items = data.items.map(it => {
    if (it && it.id === id) { found = { ...it, ...patch }; return found }
    return it
  })
  write(data)
  return Promise.resolve(found)
}

export function removeItem(id: string): Promise<number> {
  const data = read()
  data.items = data.items.filter(it => it && it.id !== id); write(data)
  return Promise.resolve(data.items.length)
}

export function removeItems(ids: string[]): Promise<number> {
  const drop: Record<string, boolean> = {}
  ;(ids || []).forEach(id => { drop[id] = true })
  const data = read()
  const before = data.items.length
  data.items = data.items.filter(it => !(it && drop[it.id])); write(data)
  return Promise.resolve(before - data.items.length)
}

// ── Payments (settlements) ───────────────────────────────────────────────────
export function listPayments(): Promise<Payment[]> { return Promise.resolve(sortedDesc(read().payments)) }

export function settle(draft: Omit<Payment, 'id' | 'created_at'>): Promise<Payment> {
  const data = read()
  const payment = stamp(draft || {}, 'pay') as Payment
  const ids: Record<string, boolean> = {}
  ;(payment.item_ids || []).forEach(id => { ids[id] = true })
  data.items = data.items.map(it => (it && ids[it.id]) ? { ...it, paid: true, payment_id: payment.id } : it)
  data.payments.push(payment); write(data)
  return Promise.resolve(payment)
}

export function removePayment(id: string): Promise<number> {
  const data = read()
  data.payments = data.payments.filter(p => p && p.id !== id)
  data.items = data.items.map(it => (it && it.payment_id === id) ? { ...it, paid: false, payment_id: null } : it)
  write(data)
  return Promise.resolve(data.payments.length)
}

// ── Settings ─────────────────────────────────────────────────────────────────
export function getSettings(): Promise<MonthEndSettings> { return Promise.resolve(read().settings) }

export function saveSettings(patch: Partial<MonthEndSettings>): Promise<MonthEndSettings> {
  const data = read()
  data.settings = { ...defaultSettings(), ...data.settings, ...(patch || {}) }
  write(data)
  return Promise.resolve(data.settings)
}

// ── Backup ───────────────────────────────────────────────────────────────────
export function exportJSON(): Promise<string> {
  const data = read()
  return Promise.resolve(JSON.stringify({ version: VERSION, items: sortedDesc(data.items), payments: sortedDesc(data.payments), settings: data.settings }, null, 2))
}

export function importJSON(text: string): Promise<{ items: number; payments: number }> {
  return new Promise((resolve, reject) => {
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(text) } catch { reject(new Error('That file isn’t valid JSON.')); return }
    if (!parsed || typeof parsed !== 'object') { reject(new Error('No Månadsavslut data found in that file.')); return }
    const inItems = Array.isArray(parsed.items) ? (parsed.items as Item[]) : []
    const inPays = Array.isArray(parsed.payments) ? (parsed.payments as Payment[]) : []
    if (!parsed.items && !parsed.payments) { reject(new Error('No Månadsavslut data found in that file.')); return }

    const data = read()
    const added = { items: 0, payments: 0 }
    function merge<T extends { id?: string; created_at?: string }>(collection: T[], incoming: T[], prefix: string): number {
      const seen: Record<string, boolean> = {}
      collection.forEach(r => { if (r && r.id) seen[r.id] = true })
      let n = 0
      incoming.forEach(raw => {
        if (!raw || typeof raw !== 'object') return
        const row = { ...raw } as T
        if (!row.id) row.id = genId(prefix)
        if (seen[row.id!]) return
        if (!row.created_at) row.created_at = new Date().toISOString()
        seen[row.id!] = true
        collection.push(row); n++
      })
      return n
    }
    added.items = merge(data.items, inItems, 'item')
    added.payments = merge(data.payments, inPays, 'pay')
    if (parsed.settings && typeof parsed.settings === 'object') {
      data.settings = { ...defaultSettings(), ...data.settings, ...(parsed.settings as Partial<MonthEndSettings>) }
    }
    write(data)
    resolve(added)
  })
}
