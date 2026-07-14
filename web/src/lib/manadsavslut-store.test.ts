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

const PREFIX = 'hemma-sync-v1:test-user:test-house:'
const scoped = (key: string) => PREFIX + key
const CACHE_KEY = scoped('bostadskalkyl_monthend_cache_v1')
const IMPORT_FLAG = scoped('bostadskalkyl_monthend_supabase_imported')

const mem = new Map<string, string>()
let store: typeof import('./manadsavslut-store')
beforeEach(async () => {
  mem.clear()
  vi.stubGlobal('localStorage', {
    get length() { return mem.size },
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => { mem.set(k, v) },
    removeItem: (k: string) => { mem.delete(k) },
    clear: () => mem.clear(),
    key: (index: number) => [...mem.keys()][index] ?? null,
  })
  vi.resetModules()
  store = await import('./manadsavslut-store')
  const { activateSyncIdentity } = await import('./sync')
  activateSyncIdentity({ userId: 'test-user', householdId: 'test-house' })
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

  it('addItem: cloud error keeps the local row dirty for replay', async () => {
    mock().control.failing.add('monthend_items')
    await expect(store.addItem(itemDraft() as never)).rejects.toBeTruthy()
    expect((cache().items as unknown[] | undefined) || []).toHaveLength(1)
    const { syncCoordinator } = await import('./sync')
    expect(syncCoordinator.isDirty('monthend_items')).toBe(true)
  })

  // settle() is now one atomic `settle_items` RPC (plan 48); removePayment() the
  // `unsettle_payment` mirror. The mock has no SQL engine, so each test wires a
  // handler that records the args and returns success — cache patching is what
  // these assert on (the DB transaction is exercised by the migration itself).
  it('settle: one RPC records the payment and flips settled items to paid', async () => {
    mock().tables.monthend_items = [{ id: 'i1', created_at: 't1', ...itemDraft() }]
    // Seed the cache so the post-success patch has the item to flip.
    mem.set(CACHE_KEY, JSON.stringify({ version: 1, items: [{ id: 'i1', paid: false, payment_id: null, personal_items: [] }], payments: [], settings: {} }))
    let seen: Record<string, unknown> | null = null
    mock().control.rpcHandlers.settle_items = (raw) => { seen = raw as Record<string, unknown>; return null }
    const payment = await store.settle({ item_ids: ['i1'], from_person: 'b', to_person: 'a', amount: 100, period_label: '2024-01', note: '' })
    // Called with the stamped id + the settle payload mapped to p_* args.
    expect(seen).toMatchObject({ p_id: payment.id, p_item_ids: ['i1'], p_from: 'b', p_to: 'a', p_amount: 100, p_period_label: '2024-01', p_note: '' })
    // Cache patched after success: payment recorded, item flipped to paid.
    expect((cache().payments as { id: string }[])[0].id).toBe(payment.id)
    expect((cache().items as { paid: boolean; payment_id: string }[])[0]).toMatchObject({ paid: true, payment_id: payment.id })
  })

  it('settle: RPC failure keeps the settlement locally dirty', async () => {
    mock().tables.monthend_items = [{ id: 'i1', created_at: 't1', ...itemDraft() }]
    mock().control.failing.add('settle_items')
    await expect(store.settle({ item_ids: ['i1'], from_person: 'b', to_person: 'a', amount: 100, period_label: '2024-01', note: '' })).rejects.toBeTruthy()
    expect((cache().payments as unknown[] | undefined) || []).toHaveLength(1)
    const { syncCoordinator } = await import('./sync')
    expect(syncCoordinator.isDirty('monthend-settlements')).toBe(true)
  })

  it('settle: a lost response after commit is verified by stable payment id', async () => {
    mock().tables.monthend_payments = [{
      id: 'pay-lost', item_ids: [], from_person: 'a', to_person: 'b', amount: 10,
      period_label: 'Juli', note: '', created_at: '2026-07-14T12:00:00.000Z',
    }]
    mock().control.failing.add('settle_items')
    await expect(store.settle({
      id: 'pay-lost', item_ids: [], from_person: 'a', to_person: 'b', amount: 10,
      period_label: 'Juli', note: '', created_at: '2026-07-14T12:00:00.000Z',
    } as never)).resolves.toMatchObject({ id: 'pay-lost' })
    const { syncCoordinator } = await import('./sync')
    expect(syncCoordinator.isDirty('monthend-settlements')).toBe(false)
  })

  it('settle: an unrelated row with the same id does not acknowledge a lost response', async () => {
    mock().tables.monthend_payments = [{
      id: 'pay-collision', item_ids: [], from_person: 'a', to_person: 'b', amount: 999,
      period_label: 'Juli', note: '', created_at: '2026-07-14T12:00:00.000Z',
    }]
    mock().control.failing.add('settle_items')
    await expect(store.settle({
      id: 'pay-collision', item_ids: [], from_person: 'a', to_person: 'b', amount: 10,
      period_label: 'Juli', note: '', created_at: '2026-07-14T12:00:00.000Z',
    } as never)).rejects.toBeTruthy()
    const { syncCoordinator } = await import('./sync')
    expect(syncCoordinator.isDirty('monthend-settlements')).toBe(true)
  })

  it('removePayment: one RPC un-settles the items and deletes the payment', async () => {
    mock().tables.monthend_items = [{ id: 'i1', paid: true, payment_id: 'pay1', personal_items: [] }]
    mock().tables.monthend_payments = [{ id: 'pay1' }]
    // Seed the cache so the post-success patch has rows to mutate + count.
    mem.set(CACHE_KEY, JSON.stringify({ version: 1, items: [{ id: 'i1', paid: true, payment_id: 'pay1', personal_items: [] }], payments: [{ id: 'pay1' }], settings: {} }))
    let seenId: string | null = null
    mock().control.rpcHandlers.unsettle_payment = (raw) => { seenId = (raw as { p_id: string }).p_id; return null }
    const n = await store.removePayment('pay1')
    expect(seenId).toBe('pay1')
    expect(n).toBe(0) // no payments left in the cache
    expect((cache().payments as unknown[])).toHaveLength(0)
    expect((cache().items as { paid: boolean; payment_id: string | null }[])[0]).toMatchObject({ paid: false, payment_id: null })
  })

  it('removePayment: RPC failure throws', async () => {
    mock().control.failing.add('unsettle_payment')
    await expect(store.removePayment('pay1')).rejects.toBeTruthy()
  })

  it('does not expose household A envelope or outbox in household B', async () => {
    mock().control.failing.add('monthend_items')
    await expect(store.addItem(itemDraft() as never)).rejects.toBeTruthy()
    const sync = await import('./sync')
    sync.activateSyncIdentity({ userId: 'test-user', householdId: 'house-b' })
    expect(store.cachedSnapshot().items).toEqual([])
    expect(sync.syncCoordinator.getOutbox()).toEqual([])
  })
})

describe('one-time legacy import', () => {
  beforeEach(() => { mem.set(scoped('legacy-import-complete'), '1') })
  it('legacy items+payments+settings present: seeded once and the flag is set', async () => {
    mem.set(scoped(store.STORAGE_KEY), JSON.stringify({
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
    mem.set(scoped(store.STORAGE_KEY), JSON.stringify({
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
    mem.set(scoped(store.STORAGE_KEY), JSON.stringify({
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
