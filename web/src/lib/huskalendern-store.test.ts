import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseMock } from './testSupabaseMock'

const holder = vi.hoisted(() => ({ current: undefined as unknown as ReturnType<typeof createSupabaseMock> }))
vi.mock('./supabase', () => {
  holder.current = createSupabaseMock()
  return { supabase: holder.current.supabase }
})
const mock = () => holder.current

const mem = new Map<string, string>()
let store: typeof import('./huskalendern-store')
let sync: typeof import('./sync')

const draft = {
  type: 'log' as const,
  title: 'Nytt tak',
  category: 'underhåll',
  date: '2026-07-13',
  cost: 125_000,
  vendor: 'Tak AB',
  interval_years: 30,
  remind_days: 60,
  notes: null,
}

beforeEach(async () => {
  mem.clear()
  vi.stubGlobal('localStorage', {
    get length() { return mem.size },
    getItem: (key: string) => mem.get(key) ?? null,
    setItem: (key: string, value: string) => { mem.set(key, value) },
    removeItem: (key: string) => { mem.delete(key) },
    key: (index: number) => [...mem.keys()][index] ?? null,
    clear: () => mem.clear(),
  })
  vi.resetModules()
  store = await import('./huskalendern-store')
  sync = await import('./sync')
  sync.activateSyncIdentity({ userId: 'user-a', householdId: 'house-a' })
  Object.keys(mock().tables).forEach((key) => delete mock().tables[key])
  mock().control.fail = false
  mock().control.failing.clear()
})

describe('house items durable persistence', () => {
  it('upserts successfully and patches the scoped cache', async () => {
    const saved = await store.addItem(draft)
    expect(mock().tables.house_items).toMatchObject([{ id: saved.id, title: 'Nytt tak' }])
    expect(store.cachedSnapshot().items).toMatchObject([{ id: saved.id, title: 'Nytt tak' }])
    expect(sync.syncCoordinator.isDirty('house_items')).toBe(false)
  })

  it('keeps a resolved cloud error dirty across reload, then replays it', async () => {
    mock().control.failing.add('house_items')
    const promise = store.addItem(draft)
    await expect(promise).rejects.toBeTruthy()
    const local = store.cachedSnapshot().items[0]
    expect(local.title).toBe('Nytt tak')
    expect(sync.syncCoordinator.isDirty('house_items')).toBe(true)

    mock().control.failing.delete('house_items')
    expect(await store.listItems()).toMatchObject([{ id: local.id, title: 'Nytt tak' }])
    expect(mock().tables.house_items ?? []).toEqual([])
    await sync.syncCoordinator.replay()
    expect(mock().tables.house_items).toMatchObject([{ id: local.id }])
    expect(sync.syncCoordinator.isDirty('house_items')).toBe(false)
  })

  it('keeps a failed delete tombstone until replay succeeds', async () => {
    const saved = await store.addItem(draft)
    mock().control.failing.add('house_items')
    await expect(store.removeItem(saved.id)).rejects.toBeTruthy()
    expect(store.cachedSnapshot().items).toEqual([])
    expect(mock().tables.house_items).toHaveLength(1)
    expect(await store.listItems()).toEqual([])

    mock().control.failing.delete('house_items')
    await sync.syncCoordinator.replay()
    expect(mock().tables.house_items).toEqual([])
  })

  it('does not expose household A cache after activating household B', async () => {
    mock().control.failing.add('house_items')
    await expect(store.addItem(draft)).rejects.toBeTruthy()
    sync.activateSyncIdentity({ userId: 'user-b', householdId: 'house-b' })
    expect(store.cachedSnapshot().items).toEqual([])
    expect(sync.syncCoordinator.getOutbox()).toEqual([])
  })
})
