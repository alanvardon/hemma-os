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

const CACHE_KEY = 'bostadskalkyl_salary_cache_v1'
const IMPORT_FLAG = 'bostadskalkyl_salary_supabase_imported'
const TABLE = 'salary_submissions'

const mem = new Map<string, string>()
let store: typeof import('./salary-store')
beforeEach(async () => {
  mem.clear()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => { mem.set(k, v) },
    removeItem: (k: string) => { mem.delete(k) },
    clear: () => mem.clear(),
  })
  vi.resetModules()
  store = await import('./salary-store')
  Object.keys(mock().tables).forEach((k) => delete mock().tables[k])
  mock().control.fail = false
  mock().control.failing.clear()
})

function cache(): { submissions?: unknown[] } {
  return JSON.parse(mem.get(CACHE_KEY) || '{}')
}

const sub = (over: Partial<Record<string, unknown>> = {}) => ({
  month: '2024-01', income_a: 30000, income_b: 25000, person_a_name: 'A', person_b_name: 'B',
  transfer_amount: 0, transfer_from: 'a', transfer_to: 'b', equal_share: 0, note: null, ...over,
})

describe('read path', () => {
  it('cloud ok: list writes through to the cache', async () => {
    mem.set(IMPORT_FLAG, '1')
    mock().tables[TABLE] = [{ id: 's1', created_at: 't1', ...sub() }]
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

  it('add: cloud error leaves the cache untouched', async () => {
    mock().control.failing.add(TABLE)
    await expect(store.add(sub() as never)).rejects.toBeTruthy()
    expect((cache().submissions || [])).toHaveLength(0)
  })

  it('remove: success patches the cache', async () => {
    mock().tables[TABLE] = [{ id: 's1', created_at: 't1', ...sub() }]
    const n = await store.remove('s1')
    expect(n).toBe(0)
    expect(mock().tables[TABLE]).toHaveLength(0)
  })

  it('remove: cloud error throws', async () => {
    mock().control.failing.add(TABLE)
    await expect(store.remove('s1')).rejects.toBeTruthy()
  })
})

describe('one-time legacy import', () => {
  it('legacy present + no cloud row: seeded once and the flag is set', async () => {
    mem.set(store.STORAGE_KEY, JSON.stringify([{ id: 'legacy-1', ...sub() }]))
    await store.list()
    expect(mock().tables[TABLE].some((r) => r.id === 'legacy-1')).toBe(true)
    expect(mem.get(IMPORT_FLAG)).toBe('1')
  })

  it('import error: flag stays unset so it retries next call', async () => {
    mem.set(store.STORAGE_KEY, JSON.stringify([{ id: 'legacy-1', ...sub() }]))
    mock().control.failing.add(TABLE)
    await store.list()
    expect(mem.get(IMPORT_FLAG)).toBeUndefined()
  })

  it('flag already set: legacy data is not re-imported', async () => {
    mem.set(IMPORT_FLAG, '1')
    mem.set(store.STORAGE_KEY, JSON.stringify([{ id: 'legacy-1', ...sub() }]))
    await store.list()
    expect(mock().tables[TABLE]).toHaveLength(0)
  })
})

describe('store-specific: v1 -> v2 migration (income_items synthesis)', () => {
  it('a v1 row (scalar income_a/income_b, no income_items) gets one item per person on read', async () => {
    mem.set(IMPORT_FLAG, '1')
    mock().tables[TABLE] = [{ id: 's1', created_at: 't1', ...sub({ income_a: 30000, income_b: 25000 }) }]
    delete (mock().tables[TABLE][0] as Record<string, unknown>).income_items
    const rows = await store.list()
    expect(rows[0].income_items).toEqual([
      { owner: 'a', label: 'Lön / Salary', amount: 30000 },
      { owner: 'b', label: 'Lön / Salary', amount: 25000 },
    ])
  })

  it('a v2 row (income_items already present) is returned untouched', async () => {
    mem.set(IMPORT_FLAG, '1')
    const items = [{ owner: 'a', label: 'Bonus', amount: 5000 }]
    mock().tables[TABLE] = [{ id: 's1', created_at: 't1', ...sub(), income_items: items }]
    const rows = await store.list()
    expect(rows[0].income_items).toEqual(items)
  })
})
