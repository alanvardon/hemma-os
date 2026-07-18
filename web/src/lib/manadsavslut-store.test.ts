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

const warnHolder = vi.hoisted(() => ({ spy: vi.fn() }))
vi.mock('./persistence-error', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./persistence-error')>()
  return { ...actual, reportPersistenceWarning: (message: string) => warnHolder.spy(message) }
})
const warnSpy = () => warnHolder.spy

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
  warnSpy().mockClear()
  vi.resetModules()
  store = await import('./manadsavslut-store')
  const { activateSyncIdentity } = await import('./sync')
  activateSyncIdentity({ userId: 'test-user', householdId: 'test-house' })
  Object.keys(mock().tables).forEach((k) => delete mock().tables[k])
  mock().control.fail = false
  mock().control.failing.clear()
  mock().control.lostResponseOnce.clear()
  Object.keys(mock().control.errors).forEach((key) => delete mock().control.errors[key])
  Object.keys(mock().control.rpcHandlers).forEach((key) => delete mock().control.rpcHandlers[key])
})

function cache(): Record<string, unknown> {
  return JSON.parse(mem.get(CACHE_KEY) || '{}')
}

const itemDraft = (over: Partial<Record<string, unknown>> = {}) => ({
  date_purchased: '2024-01-01', description: 'Ica', enter_amount: 100, split: true, amount: 100,
  fronted_by: 'a', owed_by: 'b', paid: false, pending: false, payment_id: null, note: '',
  personal_items: [], personal_a: 0, personal_b: 0, source: '', ...over,
})
const CREATED = '2026-07-15T10:00:00.000Z'
const itemRow = (id: string, over: Partial<Record<string, unknown>> = {}) => ({ id, created_at: CREATED, ...itemDraft(), ...over })
const paymentRow = (id: string, over: Partial<Record<string, unknown>> = {}) => ({ id, created_at: CREATED, item_ids: [], from_person: null, to_person: null, amount: 0, period_label: '', note: '', ...over })

describe('read path', () => {
  it('distinguishes an authoritative empty cloud result from unavailable data', async () => {
    mem.set(IMPORT_FLAG, '1')

    await expect(store.listItemsDetailed()).resolves.toEqual({
      rows: [],
      source: 'cloud',
      degraded: false,
      rejectedRowCount: 0,
      diagnostics: [],
      allCloudRowsRejected: false,
    })
  })

  it('cloud ok: listItems writes through to the cache', async () => {
    mem.set(IMPORT_FLAG, '1')
    mock().tables.monthend_items = [itemRow('i1')]
    const result = await store.listItemsDetailed()
    expect(result).toMatchObject({
      source: 'cloud',
      degraded: false,
      rejectedRowCount: 0,
      allCloudRowsRejected: false,
    })
    expect(result.rows).toHaveLength(1)
    expect((cache().items as unknown[])).toHaveLength(1)
  })

  it('normalizes an exact day-first legacy cloud date without passively mutating cloud', async () => {
    mem.set(IMPORT_FLAG, '1')
    const cloudRow = itemRow('legacy-date', { date_purchased: '01/02/2026' })
    mock().tables.monthend_items = [cloudRow]

    const result = await store.listItemsDetailed()

    expect(result).toMatchObject({
      source: 'cloud',
      degraded: false,
      rejectedRowCount: 0,
      allCloudRowsRejected: false,
      rows: [expect.objectContaining({ id: 'legacy-date', date_purchased: '2026-02-01' })],
    })
    expect((cache().items as { date_purchased: string }[])[0].date_purchased).toBe('2026-02-01')
    expect(mock().tables.monthend_items).toEqual([cloudRow])
  })

  it('cloud error with a populated cache returns explicitly degraded cached rows', async () => {
    mem.set(IMPORT_FLAG, '1')
    mem.set(CACHE_KEY, JSON.stringify({ version: 1, items: [itemRow('cached', { description: 'X' })], payments: [], settings: {} }))
    mock().control.failing.add('monthend_items')
    const result = await store.listItemsDetailed()
    expect(result).toMatchObject({
      source: 'cache',
      degraded: true,
      rejectedRowCount: 0,
      allCloudRowsRejected: false,
    })
    expect(result.rows.map((r) => r.id)).toEqual(['cached'])
  })

  it('normalizes an exact day-first legacy cache date while cloud is unavailable', async () => {
    mem.set(IMPORT_FLAG, '1')
    mem.set(CACHE_KEY, JSON.stringify({
      version: 1,
      items: [itemRow('cached-legacy', { date_purchased: '01/02/2026' })],
      payments: [],
      settings: {},
    }))
    mock().control.failing.add('monthend_items')

    await expect(store.listItemsDetailed()).resolves.toMatchObject({
      source: 'cache',
      degraded: true,
      rejectedRowCount: 0,
      rows: [expect.objectContaining({ id: 'cached-legacy', date_purchased: '2026-02-01' })],
    })
  })

  it('cloud error with a cold cache is unavailable rather than authoritative empty', async () => {
    mem.set(IMPORT_FLAG, '1')
    mock().control.failing.add('monthend_items')

    await expect(store.listItemsDetailed()).resolves.toMatchObject({
      rows: [],
      source: 'unavailable',
      degraded: true,
      rejectedRowCount: 0,
      allCloudRowsRejected: false,
    })
  })

  it('partial cloud salvage keeps the valid sibling and reports structural diagnostics', async () => {
    mem.set(IMPORT_FLAG, '1')
    mock().tables.monthend_items = [itemRow('valid'), itemRow('bad', { enter_amount: 'not-a-number' })]
    const result = await store.listItemsDetailed()

    expect(result).toMatchObject({
      source: 'cloud',
      degraded: true,
      rejectedRowCount: 1,
      diagnostics: [{ fieldPath: 'items[1].enter_amount', code: 'invalid_number' }],
      allCloudRowsRejected: false,
    })
    expect(result.rows.map((row) => row.id)).toEqual(['valid'])
    expect((cache().items as { id: string }[]).map((row) => row.id)).toEqual(['valid'])
  })

  it('distinguishes an invalid creation timestamp from an invalid purchase date', async () => {
    mem.set(IMPORT_FLAG, '1')
    mock().tables.monthend_items = [
      itemRow('bad-created', { created_at: 'not-a-timestamp' }),
      itemRow('bad-purchased', { date_purchased: '01/02/26' }),
    ]

    await expect(store.listItemsDetailed()).resolves.toMatchObject({
      source: 'unavailable',
      degraded: true,
      rejectedRowCount: 2,
      diagnostics: [
        { fieldPath: 'items[0].created_at', code: 'invalid_datetime', shape: 'AAA-A-AAAAAAAAA' },
        { fieldPath: 'items[1].date_purchased', code: 'invalid_date', shape: 'NN/NN/NN' },
      ],
      allCloudRowsRejected: true,
    })
  })

  it('all-rejected cloud rows preserve and return a populated last-known-good cache', async () => {
    mem.set(IMPORT_FLAG, '1')
    mem.set(CACHE_KEY, JSON.stringify({ version: 1, items: [itemRow('cached')], payments: [], settings: {} }))
    mock().tables.monthend_items = [itemRow('invalid', { date_purchased: '01/02/26' })]

    const result = await store.listItemsDetailed()

    expect(result).toMatchObject({
      source: 'cache',
      degraded: true,
      rejectedRowCount: 1,
      diagnostics: [{ fieldPath: 'items[0].date_purchased', code: 'invalid_date' }],
      allCloudRowsRejected: true,
    })
    expect(result.rows.map((row) => row.id)).toEqual(['cached'])
    expect((cache().items as { id: string }[]).map((row) => row.id)).toEqual(['cached'])
    expect(mock().tables.monthend_items).toEqual([itemRow('invalid', { date_purchased: '01/02/26' })])
  })

  it('all-rejected cloud rows with a cold cache return the safe unavailable state', async () => {
    mem.set(IMPORT_FLAG, '1')
    mock().tables.monthend_items = [itemRow('invalid', { enter_amount: '100' })]

    await expect(store.listItemsDetailed()).resolves.toMatchObject({
      rows: [],
      source: 'unavailable',
      degraded: true,
      rejectedRowCount: 1,
      diagnostics: [{ fieldPath: 'items[0].enter_amount', code: 'invalid_number' }],
      allCloudRowsRejected: true,
    })
    expect(mem.has(CACHE_KEY)).toBe(false)
  })

  it('cloud error with an all-invalid cache is unavailable and reports cache field paths', async () => {
    mem.set(IMPORT_FLAG, '1')
    mem.set(CACHE_KEY, JSON.stringify({
      version: 1,
      items: [itemRow('private-cache-id', { date_purchased: 'private-date-value' })],
      payments: [],
      settings: {},
    }))
    mock().control.failing.add('monthend_items')

    const result = await store.listItemsDetailed()

    expect(result).toMatchObject({
      rows: [],
      source: 'unavailable',
      degraded: true,
      rejectedRowCount: 1,
      diagnostics: [{ fieldPath: 'items[0].date_purchased', code: 'invalid_date' }],
      allCloudRowsRejected: false,
    })
    expect(JSON.stringify(result.diagnostics)).not.toContain('private-cache-id')
    expect(JSON.stringify(result.diagnostics)).not.toContain('private-date-value')
  })

  it('cloud error with only a missing-payment cache item is unavailable with a structural diagnostic', async () => {
    mem.set(IMPORT_FLAG, '1')
    mem.set(CACHE_KEY, JSON.stringify({
      version: 1,
      items: [itemRow('private-item-id', { payment_id: 'private-missing-payment-id' })],
      payments: [],
      settings: {},
    }))
    mock().control.failing.add('monthend_items')

    const result = await store.listItemsDetailed()

    expect(result).toMatchObject({
      rows: [],
      source: 'unavailable',
      degraded: true,
      rejectedRowCount: 1,
      diagnostics: [{ fieldPath: 'items[0].payment_id', code: 'invalid_reference' }],
      allCloudRowsRejected: false,
    })
    expect(JSON.stringify(result.diagnostics)).not.toContain('private-item-id')
    expect(JSON.stringify(result.diagnostics)).not.toContain('private-missing-payment-id')
  })

  it('cloud error with a partially readable cache keeps valid items and diagnoses rejected references', async () => {
    mem.set(IMPORT_FLAG, '1')
    mem.set(CACHE_KEY, JSON.stringify({
      version: 1,
      items: [
        itemRow('valid-cache-item'),
        itemRow('rejected-cache-item', { payment_id: 'missing-payment' }),
      ],
      payments: [],
      settings: {},
    }))
    mock().control.failing.add('monthend_items')

    await expect(store.listItemsDetailed()).resolves.toMatchObject({
      rows: [expect.objectContaining({ id: 'valid-cache-item' })],
      source: 'cache',
      degraded: true,
      rejectedRowCount: 1,
      diagnostics: [{ fieldPath: 'items[1].payment_id', code: 'invalid_reference' }],
      allCloudRowsRejected: false,
    })
  })

  it('does not surface unrelated cache payment or settings rejections as item diagnostics', async () => {
    mem.set(IMPORT_FLAG, '1')
    mem.set(CACHE_KEY, JSON.stringify({
      version: 1,
      items: [itemRow('valid-cache-item')],
      payments: [paymentRow('invalid-payment', { amount: 'invalid' })],
      settings: { person_a_name: 123 },
    }))
    mock().control.failing.add('monthend_items')

    await expect(store.listItemsDetailed()).resolves.toMatchObject({
      rows: [expect.objectContaining({ id: 'valid-cache-item' })],
      source: 'cache',
      degraded: true,
      rejectedRowCount: 0,
      diagnostics: [],
      allCloudRowsRejected: false,
    })
  })

  it('cloud error with a valid empty cache remains a degraded cache result', async () => {
    mem.set(IMPORT_FLAG, '1')
    mem.set(CACHE_KEY, JSON.stringify({ version: 1, items: [], payments: [], settings: {} }))
    mock().control.failing.add('monthend_items')

    await expect(store.listItemsDetailed()).resolves.toMatchObject({
      rows: [],
      source: 'cache',
      degraded: true,
      rejectedRowCount: 0,
      diagnostics: [],
      allCloudRowsRejected: false,
    })
  })

  it('retains listItems as a rows-only compatibility wrapper', async () => {
    mem.set(IMPORT_FLAG, '1')
    mock().tables.monthend_items = [itemRow('visible')]

    expect((await store.listItems()).map((row) => row.id)).toEqual(['visible'])
  })
})

describe('write path', () => {
  beforeEach(() => { mem.set(IMPORT_FLAG, '1') })

  it('addItem: success patches the cache and resolves the saved row', async () => {
    const saved = await store.addItem(itemDraft() as never)
    expect(mock().tables.monthend_items).toHaveLength(1)
    expect((cache().items as { id: string }[])[0].id).toBe(saved.id)
  })

  it('addItem canonicalizes an exact day-first date in the saved row, cloud and cache', async () => {
    const saved = await store.addItem(itemDraft({ date_purchased: '01/02/2026' }) as never)

    expect(saved.date_purchased).toBe('2026-02-01')
    expect(mock().tables.monthend_items[0].date_purchased).toBe('2026-02-01')
    expect((cache().items as { date_purchased: string }[])[0].date_purchased).toBe('2026-02-01')
  })

  it('addItems canonicalizes CSV-style day-first dates atomically', async () => {
    const saved = await store.addItems([
      itemDraft({ description: 'First', date_purchased: '01/02/2026' }),
      itemDraft({ description: 'Second', date_purchased: '29/02/2024' }),
    ] as never)

    expect(saved.map((row) => row.date_purchased)).toEqual(['2026-02-01', '2024-02-29'])
    expect(mock().tables.monthend_items.map((row) => row.date_purchased)).toEqual(['2026-02-01', '2024-02-29'])
    expect((cache().items as { date_purchased: string }[]).map((row) => row.date_purchased)).toEqual(['2026-02-01', '2024-02-29'])
  })

  it.each(['01/02/26', '13/6/26', '02-01-2026', '31/04/2026'])(
    'rejects unsupported or impossible future item date %s before cloud/cache mutation',
    async (date_purchased) => {
      await expect(store.addItem(itemDraft({ date_purchased }) as never)).rejects.toThrow('Invalid item date')
      expect(mock().tables.monthend_items || []).toHaveLength(0)
      expect((cache().items as unknown[] | undefined) || []).toHaveLength(0)
      const { syncCoordinator } = await import('./sync')
      expect(syncCoordinator.isDirty('monthend_items')).toBe(false)
    },
  )

  it('rejects an addItems batch atomically when one future date is unsupported', async () => {
    await expect(store.addItems([
      itemDraft({ date_purchased: '01/02/2026' }),
      itemDraft({ date_purchased: '01/02/26' }),
    ] as never)).rejects.toThrow('Invalid item date')

    expect(mock().tables.monthend_items || []).toHaveLength(0)
    expect((cache().items as unknown[] | undefined) || []).toHaveLength(0)
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

  // settle() is one atomic `sync_settle_items` RPC; removePayment() uses the
  // revision-aware `sync_unsettle_payment` mirror. The mock has no SQL engine, so each test wires a
  // handler that records the args and returns success — cache patching is what
  // these assert on (the DB transaction is exercised by the migration itself).
  it('settle: one RPC records the payment and flips settled items to paid', async () => {
    mock().tables.monthend_items = [itemRow('i1')]
    // Seed the cache so the post-success patch has the item to flip.
    mem.set(CACHE_KEY, JSON.stringify({ version: 1, items: [itemRow('i1')], payments: [], settings: {} }))
    await store.listItems()
    let seen: Record<string, unknown> | null = null
    mock().control.rpcHandlers.sync_settle_items = (raw) => {
      seen = raw as Record<string, unknown>
      const input = raw as { p_payment: { id: string }; p_expected_revisions: Record<string, number | null> }
      return { status: 'applied', revisions: Object.fromEntries(Object.keys(input.p_expected_revisions).map((key) => [key, key.startsWith('monthend_payments:') ? 1 : 2])) }
    }
    const payment = await store.settle({ item_ids: ['i1'], from_person: 'b', to_person: 'a', amount: 100, period_label: '2024-01', note: '' })
    // Called with the stamped id + the settle payload mapped to p_* args.
    expect(seen).toMatchObject({ p_payment: { id: payment.id, item_ids: ['i1'], from_person: 'b', to_person: 'a', amount: 100, period_label: '2024-01', note: '' } })
    // Cache patched after success: payment recorded, item flipped to paid.
    expect((cache().payments as { id: string }[])[0].id).toBe(payment.id)
    expect((cache().items as { paid: boolean; payment_id: string }[])[0]).toMatchObject({ paid: true, payment_id: payment.id })
  })

  it('settle: RPC failure keeps the settlement locally dirty', async () => {
    mock().tables.monthend_items = [itemRow('i1')]
    mock().control.failing.add('sync_settle_items')
    await expect(store.settle({ item_ids: ['i1'], from_person: 'b', to_person: 'a', amount: 100, period_label: '2024-01', note: '' })).rejects.toBeTruthy()
    expect((cache().payments as unknown[] | undefined) || []).toHaveLength(1)
    const { syncCoordinator } = await import('./sync')
    expect(syncCoordinator.isDirty('monthend-settlements')).toBe(true)
  })

  it('settle: a lost response after commit is verified by stable payment id', async () => {
    mock().control.lostResponseOnce.add('sync_settle_items')
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
    await expect(store.settle({
      id: 'pay-collision', item_ids: [], from_person: 'a', to_person: 'b', amount: 10,
      period_label: 'Juli', note: '', created_at: '2026-07-14T12:00:00.000Z',
    } as never)).rejects.toBeTruthy()
    const { syncCoordinator } = await import('./sync')
    expect(syncCoordinator.isDirty('monthend-settlements')).toBe(true)
  })

  it('removePayment: one RPC un-settles the items and deletes the payment', async () => {
    mock().tables.monthend_items = [itemRow('i1', { paid: true, payment_id: 'pay1' })]
    mock().tables.monthend_payments = [paymentRow('pay1', { item_ids: ['i1'] })]
    // Seed the cache so the post-success patch has rows to mutate + count.
    mem.set(CACHE_KEY, JSON.stringify({ version: 1, items: [itemRow('i1', { paid: true, payment_id: 'pay1' })], payments: [paymentRow('pay1', { item_ids: ['i1'] })], settings: {} }))
    await Promise.all([store.listItems(), store.listPayments()])
    let seenId: string | null = null
    mock().control.rpcHandlers.sync_unsettle_payment = (raw) => {
      const input = raw as { p_id: string; p_expected_revisions: Record<string, number | null> }
      seenId = input.p_id
      return { status: 'applied', revisions: Object.fromEntries(Object.keys(input.p_expected_revisions).map((key) => [key, key.startsWith('monthend_payments:') ? null : 2])) }
    }
    const n = await store.removePayment('pay1')
    expect(seenId).toBe('pay1')
    expect(n).toBe(0) // no payments left in the cache
    expect((cache().payments as unknown[])).toHaveLength(0)
    expect((cache().items as { paid: boolean; payment_id: string | null }[])[0]).toMatchObject({ paid: false, payment_id: null })
  })

  it('removePayment: RPC failure throws', async () => {
    mock().control.failing.add('sync_unsettle_payment')
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

  it('rejects numeric strings in personal_a and personal_b before normalization, then imports corrected assigned data', async () => {
    const key = scoped(store.STORAGE_KEY)
    const envelope = (personal: Record<string, unknown>) => JSON.stringify({ version: 1, items: [{ id: 'item-1', description: 'Legacy', date_purchased: '2020-01-01', enter_amount: 50, split: true, amount: 50, fronted_by: 'a', owed_by: 'b', paid: false, pending: false, payment_id: null, note: '', ...personal }], payments: [], settings: {} })
    mem.set(key, envelope({ personal_a: '12' }))
    await store.listItems()
    expect(mock().tables.monthend_items || []).toHaveLength(0)
    expect(mem.get(IMPORT_FLAG)).toBeUndefined()

    mem.set(key, envelope({ personal_b: '5' }))
    await store.listItems()
    expect(mock().tables.monthend_items || []).toHaveLength(0)
    expect(mem.get(IMPORT_FLAG)).toBeUndefined()

    mem.set(key, envelope({ personal_a: 12, personal_b: 5 }))
    await store.listItems()
    expect(mock().tables.monthend_items.some((row) => row.id === 'item-1')).toBe(true)
    expect(mem.get(IMPORT_FLAG)).toBe('1')
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

describe('import validation boundary', () => {
  it('rejects a malformed backup before mutating Supabase', async () => {
    await expect(store.importJSON(JSON.stringify({ version: 1, items: [{ id: 'bad', created_at: CREATED, date_purchased: '', description: '', enter_amount: '100' }], payments: [] }))).rejects.toThrow()
    expect(mock().tables.monthend_items || []).toHaveLength(0)
  })
})

describe('cache cross-reference warning', () => {
  const CACHE_MSG = 'Några sparade månadsavslut kunde inte läsas från cachen. Övriga sparade uppgifter finns kvar.'

  it('does not warn when the cache mirrors a cloud cross-reference gap (settlement points at an absent item)', () => {
    // Faithful mirror of the real incident: one item survives, a settlement still
    // references items that are no longer present. The cache is not corrupt — it
    // reflects the cloud verbatim — so no per-load "cache read failed" warning.
    mem.set(CACHE_KEY, JSON.stringify({
      version: 1,
      items: [itemRow('i1')],
      payments: [paymentRow('p1', { item_ids: ['gone-1', 'gone-2'] })],
      settings: {},
    }))
    const snap = store.cachedSnapshot()
    expect(snap.items).toHaveLength(1)
    expect(warnSpy()).not.toHaveBeenCalledWith(CACHE_MSG)
  })

  it('still warns when the cache holds a genuinely malformed row', () => {
    mem.set(CACHE_KEY, JSON.stringify({
      version: 1,
      items: [itemRow('i1'), { id: 'bad', created_at: 'not-a-datetime' }],
      payments: [],
      settings: {},
    }))
    store.cachedSnapshot()
    expect(warnSpy()).toHaveBeenCalledWith(CACHE_MSG)
  })
})

describe('cache slice writes preserve sibling slices', () => {
  // Regression: the three cloud readers each rewrite one slice of the shared
  // cache envelope. Rebasing those writes on the SALVAGED envelope amputated
  // settled items whenever the payments slice was transiently absent (the
  // salvage drops any item whose payment_id has no matching payment), and the
  // amputated envelope then re-derived itself on every subsequent load.
  const settled = () => itemRow('s1', { paid: true, payment_id: 'p1' })
  const payment = () => paymentRow('p1', { item_ids: ['s1'], amount: 100 })

  it('an items-then-payments refresh keeps settled items in the cache', async () => {
    mem.set(IMPORT_FLAG, '1')
    mock().tables.monthend_items = [settled(), itemRow('o1')]
    mock().tables.monthend_payments = [payment()]

    await store.listItemsDetailed() // writes items while payments slice is still empty
    await store.listPayments()      // must NOT rebase on a salvaged (amputated) envelope

    const c = cache()
    expect((c.items as { id: string }[]).map((r) => r.id).sort()).toEqual(['o1', 's1'])
    expect((c.payments as { id: string }[]).map((r) => r.id)).toEqual(['p1'])
  })

  it('heals a stuck cache (open item + dangling settlement) on a full refresh', async () => {
    mem.set(IMPORT_FLAG, '1')
    // The observed production state: only the open item survived locally while
    // the settlement kept referencing the amputated settled item.
    mem.set(CACHE_KEY, JSON.stringify({ version: 1, items: [itemRow('o1')], payments: [payment()], settings: {} }))
    mock().tables.monthend_items = [settled(), itemRow('o1')]
    mock().tables.monthend_payments = [payment()]

    await store.listItemsDetailed()
    await store.listPayments()

    const c = cache()
    expect((c.items as { id: string }[]).map((r) => r.id).sort()).toEqual(['o1', 's1'])
    expect((c.payments as { id: string }[]).map((r) => r.id)).toEqual(['p1'])
    // Healed envelope is internally consistent, so the snapshot serves it whole.
    const snap = store.cachedSnapshot()
    expect(snap.items.map((r) => r.id).sort()).toEqual(['o1', 's1'])
    expect(snap.payments.map((r) => r.id)).toEqual(['p1'])
  })

  it('a mutation patch does not drop settled items while the payments slice is empty', async () => {
    mem.set(IMPORT_FLAG, '1')
    // Envelope mid-refresh: items written, payments not yet.
    mem.set(CACHE_KEY, JSON.stringify({ version: 1, items: [settled(), itemRow('o1')], payments: [], settings: {} }))

    await store.addItem(itemDraft({ description: 'Ny' }) as never)

    const ids = (cache().items as { id: string }[]).map((r) => r.id)
    expect(ids).toContain('s1')
    expect(ids).toContain('o1')
    expect(ids).toHaveLength(3)
  })
})
