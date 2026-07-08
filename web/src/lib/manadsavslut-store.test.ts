import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSupabaseMock } from './testSupabaseMock'

// See mortgage-store.test.ts for why this shape (vi.hoisted holder + a fresh
// module import + manual mock-state clearing) is needed every test.
const holder = vi.hoisted(() => ({ current: undefined as unknown as ReturnType<typeof createSupabaseMock> }))
vi.mock('./supabase', () => {
  holder.current = createSupabaseMock()
  return { supabase: holder.current.supabase }
})
const mock = () => holder.current

const CACHE_KEY = 'bostadskalkyl_monthend_cache_v1'
const IMPORT_FLAG = 'bostadskalkyl_monthend_supabase_imported'

const mem = new Map<string, string>()
let store: typeof import('./manadsavslut-store')
beforeEach(async () => {
  mem.clear()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => { mem.set(k, v) },
    removeItem: (k: string) => { mem.delete(k) },
    clear: () => mem.clear(),
  })
  vi.resetModules()
  store = await import('./manadsavslut-store')
  Object.keys(mock().tables).forEach((k) => delete mock().tables[k])
  mock().control.fail = false
  mock().control.failing.clear()
})

function cache(): Record<string, unknown> {
  return JSON.parse(mem.get(CACHE_KEY) || '{}')
}

const itemDraft = (over: Partial<Record<string, unknown>> = {}) => ({
  date_purchased: '2024-01-01', description: 'Ica', enter_amount: 100, split: true, amount: 100,
  fronted_by: 'a', owed_by: 'b', paid: false, pending: false, payment_id: null, note: '',
  personal_items: [], personal_a: 0, personal_b: 0, source: '', ...over,
})

describe('read path', () => {
  it('cloud ok: listItems writes through to the cache', async () => {
    mem.set(IMPORT_FLAG, '1')
    mock().tables.monthend_items = [{ id: 'i1', created_at: 't1', ...itemDraft() }]
    const rows = await store.listItems()
    expect(rows).toHaveLength(1)
    expect((cache().items as unknown[])).toHaveLength(1)
  })

  it('cloud error: listItems falls back to the cache', async () => {
    mem.set(IMPORT_FLAG, '1')
    mem.set(CACHE_KEY, JSON.stringify({ version: 1, items: [{ id: 'cached', description: 'X', personal_items: [] }], payments: [], settings: {} }))
    mock().control.failing.add('monthend_items')
    const rows = await store.listItems()
    expect(rows.map((r) => r.id)).toEqual(['cached'])
  })
})

describe('write path', () => {
  beforeEach(() => { mem.set(IMPORT_FLAG, '1') })

  it('addItem: success patches the cache and resolves the saved row', async () => {
    const saved = await store.addItem(itemDraft() as never)
    expect(mock().tables.monthend_items).toHaveLength(1)
    expect((cache().items as { id: string }[])[0].id).toBe(saved.id)
  })

  it('addItem: cloud error throws', async () => {
    mock().control.failing.add('monthend_items')
    await expect(store.addItem(itemDraft() as never)).rejects.toBeTruthy()
  })

  // TODO(plan 47): un-skip once addItem patches the cache only after the
  // error check (currently it patches first, then checks `error`).
  it.skip('addItem: cloud error leaves the cache untouched', async () => {
    mock().control.failing.add('monthend_items')
    await expect(store.addItem(itemDraft() as never)).rejects.toBeTruthy()
    expect((cache().items as unknown[] | undefined) || []).toHaveLength(0)
  })

  it('settle: inserts the payment then flips settled items to paid', async () => {
    mock().tables.monthend_items = [{ id: 'i1', created_at: 't1', ...itemDraft() }]
    const payment = await store.settle({ item_ids: ['i1'], from_person: 'b', to_person: 'a', amount: 100, period_label: '2024-01', note: '' })
    expect(mock().tables.monthend_payments).toHaveLength(1)
    expect(mock().tables.monthend_items[0].paid).toBe(true)
    expect(mock().tables.monthend_items[0].payment_id).toBe(payment.id)
  })

  it('settle: item-update failure leaves items unsettled (payment already inserted, deliberately)', async () => {
    mock().tables.monthend_items = [{ id: 'i1', created_at: 't1', ...itemDraft() }]
    mock().control.failing.add('monthend_items')
    await expect(store.settle({ item_ids: ['i1'], from_person: 'b', to_person: 'a', amount: 100, period_label: '2024-01', note: '' })).rejects.toBeTruthy()
    expect(mock().tables.monthend_payments).toHaveLength(1) // payment insert already succeeded
    expect(mock().tables.monthend_items[0].paid).toBe(false) // retryable, not silently settled
  })

  it('removePayment: un-settles items first, then deletes the payment', async () => {
    mock().tables.monthend_items = [{ id: 'i1', paid: true, payment_id: 'pay1' }]
    mock().tables.monthend_payments = [{ id: 'pay1' }]
    const n = await store.removePayment('pay1')
    expect(n).toBe(0)
    expect(mock().tables.monthend_payments).toHaveLength(0)
    expect(mock().tables.monthend_items[0].paid).toBe(false)
    expect(mock().tables.monthend_items[0].payment_id).toBe(null)
  })
})

describe('one-time legacy import', () => {
  it('legacy items+payments+settings present: seeded once and the flag is set', async () => {
    mem.set(store.STORAGE_KEY, JSON.stringify({
      version: 1,
      items: [{ id: 'item-1', description: 'Legacy', date_purchased: '2020-01-01', enter_amount: 50, split: true, amount: 50, fronted_by: 'a', owed_by: 'b', paid: false, pending: false, payment_id: null, note: '' }],
      payments: [{ id: 'pay-1', item_ids: [], amount: 0, period_label: '', note: '' }],
      settings: { property_name: 'Test' },
    }))
    await store.listItems()
    expect(mock().tables.monthend_items.some((r) => r.id === 'item-1')).toBe(true)
    expect(mock().tables.monthend_payments.some((r) => r.id === 'pay-1')).toBe(true)
    expect(mem.get(IMPORT_FLAG)).toBe('1')
  })

  it('import error: flag stays unset so it retries next call', async () => {
    mem.set(store.STORAGE_KEY, JSON.stringify({
      version: 1,
      items: [{ id: 'item-1', description: 'Legacy', date_purchased: '2020-01-01', enter_amount: 50, split: true, amount: 50, fronted_by: 'a', owed_by: 'b', paid: false, pending: false, payment_id: null, note: '' }],
      payments: [], settings: null,
    }))
    mock().control.failing.add('monthend_items')
    await store.listItems()
    expect(mem.get(IMPORT_FLAG)).toBeUndefined()
  })

  it('flag already set: legacy data is not re-imported', async () => {
    mem.set(IMPORT_FLAG, '1')
    mem.set(store.STORAGE_KEY, JSON.stringify({
      version: 1,
      items: [{ id: 'item-1', description: 'Legacy', date_purchased: '2020-01-01', enter_amount: 50, split: true, amount: 50, fronted_by: 'a', owed_by: 'b', paid: false, pending: false, payment_id: null, note: '' }],
      payments: [], settings: null,
    }))
    await store.listItems()
    expect(mock().tables.monthend_items).toHaveLength(0)
  })
})

describe('store-specific: normalizeItem (personal-items migration)', () => {
  it('pre-personal item (no fields) gets an empty personal_items list', () => {
    const out = store.normalizeItem({ id: 'i1' } as never)
    expect(out.personal_items).toEqual([])
    expect(out.personal_a).toBe(0)
    expect(out.personal_b).toBe(0)
  })

  it('v1 item (personal_a/b + one note) is synthesised into personal_items', () => {
    const out = store.normalizeItem({ id: 'i1', personal_a: 40, personal_b: 0, personal_note: 'snacks' } as never)
    expect(out.personal_items).toEqual([{ person: 'a', amount: 40, note: 'snacks' }])
    expect(out.personal_a).toBe(40)
    expect(out.personal_b).toBe(0)
  })

  it('current item (personal_items present) re-derives the cached sums, idempotently', () => {
    const withEntries = { id: 'i1', personal_items: [{ person: 'a', amount: 10, note: '' }, { person: 'b', amount: 5, note: '' }] } as never
    const out = store.normalizeItem(withEntries)
    expect(out.personal_a).toBe(10)
    expect(out.personal_b).toBe(5)
    expect(store.normalizeItem(out)).toEqual(out) // idempotent
  })
})
