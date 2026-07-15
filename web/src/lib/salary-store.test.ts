import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSupabaseMock } from './testSupabaseMock'
import { paymentId } from './persistence-schema'

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
const CACHE_KEY = scoped('bostadskalkyl_salary_cache_v1')
const IMPORT_FLAG = scoped('bostadskalkyl_salary_supabase_imported')
const TABLE = 'salary_submissions'

const mem = new Map<string, string>()
let store: typeof import('./salary-store')
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
  store = await import('./salary-store')
  const { activateSyncIdentity } = await import('./sync')
  activateSyncIdentity({ userId: 'test-user', householdId: 'test-house' })
  Object.keys(mock().tables).forEach((k) => delete mock().tables[k])
  mock().control.fail = false
  mock().control.failing.clear()
  mock().control.lostResponseOnce.clear()
})

function cache(): { submissions?: unknown[] } {
  return JSON.parse(mem.get(CACHE_KEY) || '{}')
}

const sub = (over: Partial<Record<string, unknown>> = {}) => ({
  month: '2024-01', income_a: 30000, income_b: 25000, person_a_name: 'A', person_b_name: 'B',
  transfer_amount: 0, transfer_from: 'a', transfer_to: 'b', equal_share: 0, note: null, ...over,
})

describe('read path', () => {
  it('parses a persisted salary month as YearMonth and rejects malformed months', () => {
    const parsed = store.parseSubmission(sub())
    expect(parsed?.month).toBe('2024-01')
    if (!parsed) return
    // @ts-expect-error A parsed salary month is not a payment id.
    const wrongMonth: typeof parsed.month = paymentId('payment-1')
    expect(wrongMonth).toBe('payment-1')
    expect(store.parseSubmission(sub({ month: '2024-13' }))).toBeNull()
  })

  it('cloud ok: list writes through to the cache', async () => {
    mem.set(IMPORT_FLAG, '1')
    mock().tables[TABLE] = [{ id: 's1', created_at: '2026-07-15T10:00:00.000Z', revision: 1, ...sub() }]
    const rows = await store.list()
    expect(rows).toHaveLength(1)
    expect((cache().submissions || [])).toHaveLength(1)
  })

  it('cloud error: list falls back to the cache', async () => {
    mem.set(IMPORT_FLAG, '1')
    mem.set(CACHE_KEY, JSON.stringify({ version: 2, submissions: [{ id: 'cached', ...sub(), income_items: [] }] }))
    mock().control.failing.add(TABLE)
    const rows = await store.list()
    expect(rows.map((r) => r.id)).toEqual(['cached'])
  })

  it('cloud read salvages a valid submission and excludes its malformed sibling', async () => {
    mem.set(IMPORT_FLAG, '1')
    mock().tables[TABLE] = [{ id: 'valid', created_at: '2026-07-15T10:00:00.000Z', ...sub() }, { id: 'bad', created_at: '2026-07-15T10:00:00.000Z', ...sub({ month: '2024-13' }) }]
    expect((await store.list()).map((row) => row.id)).toEqual(['valid'])
    expect((cache().submissions as { id: string }[]).map((row) => row.id)).toEqual(['valid'])
  })
})

describe('write path', () => {
  beforeEach(() => { mem.set(IMPORT_FLAG, '1') })

  it('add: success patches the cache and resolves the saved row', async () => {
    const saved = await store.add(sub() as never)
    expect(mock().tables[TABLE]).toHaveLength(1)
    expect((cache().submissions as { id: string }[])[0].id).toBe(saved.id)
  })

  it('add: cloud error throws', async () => {
    mock().control.failing.add(TABLE)
    await expect(store.add(sub() as never)).rejects.toBeTruthy()
  })

  it('add: cloud error keeps the local row dirty for replay', async () => {
    mock().control.failing.add(TABLE)
    await expect(store.add(sub() as never)).rejects.toBeTruthy()
    expect((cache().submissions || [])).toHaveLength(1)
    const { syncCoordinator } = await import('./sync')
    expect(syncCoordinator.isDirty(TABLE)).toBe(true)
  })

  it('add: a lost response reuses the durable receipt instead of inserting twice', async () => {
    mock().control.lostResponseOnce.add('sync_apply_rows')
    await expect(store.add(sub() as never)).resolves.toBeTruthy()
    expect(mock().tables[TABLE]).toHaveLength(1)
    const { syncCoordinator } = await import('./sync')
    expect(syncCoordinator.isDirty(TABLE)).toBe(false)
  })

  it('remove: success patches the cache', async () => {
    mock().tables[TABLE] = [{ id: 's1', created_at: '2026-07-15T10:00:00.000Z', revision: 1, ...sub() }]
    await store.list()
    const n = await store.remove('s1')
    expect(n).toBe(0)
    expect(mock().tables[TABLE]).toHaveLength(0)
  })

  it('remove: rejects a stale revision after another client changed the row', async () => {
    mock().tables[TABLE] = [{ id: 's1', created_at: '2026-07-15T10:00:00.000Z', revision: 1, ...sub() }]
    await store.list()
    mock().tables[TABLE][0].revision = 2

    await expect(store.remove('s1')).rejects.toMatchObject({ category: 'conflict' })
    expect(mock().tables[TABLE]).toHaveLength(1)
    const { syncCoordinator } = await import('./sync')
    expect(syncCoordinator.getConflicts()).toHaveLength(1)
  })

  it('remove: cloud error throws', async () => {
    mock().control.failing.add(TABLE)
    await expect(store.remove('s1')).rejects.toBeTruthy()
  })

  it('does not expose household A cache or outbox in household B', async () => {
    mock().control.failing.add(TABLE)
    await expect(store.add(sub() as never)).rejects.toBeTruthy()
    const sync = await import('./sync')
    sync.activateSyncIdentity({ userId: 'test-user', householdId: 'house-b' })
    expect(sync.syncCoordinator.readScoped('bostadskalkyl_salary_cache_v1')).toBeNull()
    expect(sync.syncCoordinator.getOutbox()).toEqual([])
  })
})

describe('one-time legacy import', () => {
  beforeEach(() => { mem.set(scoped('legacy-import-complete'), '1') })
  it('legacy present + no cloud row: seeded once and the flag is set', async () => {
    mem.set(scoped(store.STORAGE_KEY), JSON.stringify([{ id: 'legacy-1', ...sub() }]))
    await store.list()
    expect(mock().tables[TABLE].some((r) => r.id === 'legacy-1')).toBe(true)
    expect(mem.get(IMPORT_FLAG)).toBe('1')
  })

  it('import error: flag stays unset so it retries next call', async () => {
    mem.set(scoped(store.STORAGE_KEY), JSON.stringify([{ id: 'legacy-1', ...sub() }]))
    mock().control.failing.add(TABLE)
    await store.list()
    expect(mem.get(IMPORT_FLAG)).toBeUndefined()
  })

  it('invalid assigned legacy data neither mutates nor sets the flag, then retries after correction', async () => {
    const key = scoped(store.STORAGE_KEY)
    mem.set(key, JSON.stringify([{ id: 'legacy-1', ...sub({ month: '2024-13' }) }]))
    await store.list()
    expect(mock().tables[TABLE] || []).toHaveLength(0)
    expect(mem.get(IMPORT_FLAG)).toBeUndefined()

    mem.set(key, JSON.stringify([{ id: 'legacy-1', ...sub() }]))
    await store.list()
    expect(mock().tables[TABLE].some((row) => row.id === 'legacy-1')).toBe(true)
    expect(mem.get(IMPORT_FLAG)).toBe('1')
  })

  it('flag already set: legacy data is not re-imported', async () => {
    mem.set(IMPORT_FLAG, '1')
    mem.set(scoped(store.STORAGE_KEY), JSON.stringify([{ id: 'legacy-1', ...sub() }]))
    await store.list()
    expect(mock().tables[TABLE]).toHaveLength(0)
  })
})

describe('store-specific: v1 -> v2 migration (income_items synthesis)', () => {
  it('a v1 row (scalar income_a/income_b, no income_items) gets one item per person on read', async () => {
    mem.set(IMPORT_FLAG, '1')
    mock().tables[TABLE] = [{ id: 's1', created_at: '2026-07-15T10:00:00.000Z', ...sub({ income_a: 30000, income_b: 25000 }) }]
    delete (mock().tables[TABLE][0] as Record<string, unknown>).income_items
    const rows = await store.list()
    expect(rows[0].income_items).toEqual([
      { owner: 'a', label: 'Lön / Salary', amount: 30000 },
      { owner: 'b', label: 'Lön / Salary', amount: 25000 },
    ])
  })

  it('uses the domain-neutral submission defaults for missing legacy names', () => {
    expect(store.parseSubmission({ month: '2024-01', income_a: 1, income_b: 2 })?.person_a_name).toBe('')
    expect(store.parseSubmission({ month: '2024-01', income_a: 1, income_b: 2 })?.person_b_name).toBe('')
  })

  it('a v2 row (income_items already present) is returned untouched', async () => {
    mem.set(IMPORT_FLAG, '1')
    const items = [{ owner: 'a', label: 'Bonus', amount: 5000 }]
    mock().tables[TABLE] = [{ id: 's1', created_at: '2026-07-15T10:00:00.000Z', ...sub(), income_items: items }]
    const rows = await store.list()
    expect(rows[0].income_items).toEqual(items)
  })
})

describe('import validation boundary', () => {
  it('rejects a malformed backup before mutating Supabase', async () => {
    await expect(store.importJSON(JSON.stringify([{ ...sub(), id: '', created_at: 'not-a-timestamp' }]))).rejects.toThrow()
    expect(mock().tables[TABLE] || []).toHaveLength(0)
  })
})
