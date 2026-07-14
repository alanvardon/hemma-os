import { describe, it, expect, vi, beforeEach } from 'vitest'

// In-memory stand-in for a single-tool `tool_state` table. `fail` flips the
// mock into error mode so we can exercise the cache-fallback / retry paths.
const state = {
  row: null as { tool: string; data: unknown } | null,
  fail: false,
  readGate: null as Promise<void> | null,
}
vi.mock('./supabase', () => {
  const makeQuery = () => {
    let selected = 'data'
    const q: Record<string, unknown> = {}
    Object.assign(q, {
      select: (cols: string) => { selected = cols; return q },
      eq: () => q,
      maybeSingle: () => {
        const result = state.fail
          ? { data: null, error: { message: 'down' } }
          : !state.row
            ? { data: null, error: null }
        // select('tool') → { tool }; select('data') → { data }
            : { data: selected === 'tool' ? { tool: state.row.tool } : { data: state.row.data }, error: null }
        return state.readGate ? state.readGate.then(() => result) : Promise.resolve(result)
      },
      upsert: (r: { tool: string; data: unknown }) => {
        if (state.fail) return Promise.resolve({ data: null, error: { message: 'down' } })
        state.row = { tool: r.tool, data: r.data }
        return Promise.resolve({ data: null, error: null })
      },
      insert: (r: { tool: string; data: unknown }) => {
        if (state.fail) return Promise.resolve({ data: null, error: { message: 'down' } })
        if (state.row) return Promise.resolve({ data: null, error: { message: 'duplicate', code: '23505' } })
        state.row = { tool: r.tool, data: r.data }
        return Promise.resolve({ data: null, error: null })
      },
    })
    return q
  }
  return { supabase: { from: () => makeQuery() } }
})

// Map-backed localStorage (the node test env has none); lets us assert the
// write-through cache and one-time import flag.
const mem = new Map<string, string>()
beforeEach(() => {
  mem.clear()
  state.row = null
  state.fail = false
  state.readGate = null
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => { mem.set(k, v) },
    removeItem: (k: string) => { mem.delete(k) },
    clear: () => mem.clear(),
  })
  activateSyncIdentity({ userId: 'u1', householdId: 'h1' })
})

import { createToolStateStore } from './tool-store'
import { activateSyncIdentity, syncCoordinator } from './sync'

interface Inputs { a: number; b: number }
const defaults = (): Inputs => ({ a: 0, b: 0 })
// Only merge finite numbers over fresh defaults — mirrors the real stores.
const merge = (raw: unknown): Inputs | null => {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  const d = defaults()
  for (const k of ['a', 'b'] as (keyof Inputs)[]) if (typeof s[k] === 'number' && isFinite(s[k] as number)) d[k] = s[k] as number
  return d
}
const makeStore = () => createToolStateStore<Inputs>({
  tool: 't', storageKey: 'legacy', cacheKey: 'cache', importFlag: 'flag', merge,
})

describe('createToolStateStore', () => {
  it('load returns null when nothing is stored', async () => {
    expect(await makeStore().load()).toBeNull()
  })

  it('save upserts the blob and writes the cache', async () => {
    await makeStore().save({ a: 1, b: 2 })
    expect(state.row).toEqual({ tool: 't', data: { a: 1, b: 2 } })
    expect(JSON.parse(syncCoordinator.readScoped('cache')!)).toEqual({ a: 1, b: 2 })
  })

  it('reports an upsert that resolves with an error as a failed save', async () => {
    state.fail = true
    const saved = { a: 1, b: 2 }

    await expect(makeStore().save(saved)).rejects.toMatchObject({
      name: 'PersistenceError',
      category: 'unknown',
      message: 'Kunde inte spara ändringen. Försök igen.',
    })
    expect(JSON.parse(syncCoordinator.readScoped('cache')!)).toEqual(saved)
    expect(syncCoordinator.isDirty('tool_state:t')).toBe(true)
  })

  it('load returns the merged cloud blob and refreshes the cache', async () => {
    state.row = { tool: 't', data: { a: 5, b: 9, junk: 'x' } }
    const loaded = await makeStore().load()
    expect(loaded).toEqual({ a: 5, b: 9 }) // junk dropped by merge
    expect(JSON.parse(syncCoordinator.readScoped('cache')!)).toEqual({ a: 5, b: 9 })
  })

  it('load falls back to the cache on a cloud error', async () => {
    syncCoordinator.writeScoped('cache', JSON.stringify({ a: 7, b: 8 }))
    state.fail = true
    expect(await makeStore().load()).toEqual({ a: 7, b: 8 })
  })

  it('does not claim an unscoped legacy blob for the active identity', async () => {
    mem.set('legacy', JSON.stringify({ a: 3, b: 4 }))
    expect(await makeStore().load()).toBeNull()
    expect(state.row).toBeNull()
    expect(mem.get('legacy')).toBe(JSON.stringify({ a: 3, b: 4 }))
  })

  it('imports a legacy blob only after it has been assigned to the active scope', async () => {
    syncCoordinator.writeScoped('legacy-import-complete', '1')
    syncCoordinator.writeScoped('legacy', JSON.stringify({ a: 3, b: 4 }))
    expect(await makeStore().load()).toEqual({ a: 3, b: 4 })
    expect(state.row).toEqual({ tool: 't', data: { a: 3, b: 4 } })
    expect(syncCoordinator.readScoped('flag')).toBe('1')
  })

  it('prefers an explicitly assigned newer cache over an older backup blob', async () => {
    syncCoordinator.writeScoped('legacy-import-complete', '1')
    syncCoordinator.writeScoped('legacy', JSON.stringify({ a: 1, b: 1 }))
    syncCoordinator.writeScoped('cache', JSON.stringify({ a: 8, b: 9 }))
    expect(await makeStore().load()).toEqual({ a: 8, b: 9 })
    expect(state.row?.data).toEqual({ a: 8, b: 9 })
  })

  it('a cloud read cannot overwrite a newer dirty local blob', async () => {
    state.row = { tool: 't', data: { a: 1, b: 1 } }
    state.fail = true
    await expect(makeStore().save({ a: 8, b: 9 })).rejects.toBeTruthy()
    state.fail = false
    expect(await makeStore().load()).toEqual({ a: 8, b: 9 })
    expect(state.row.data).toEqual({ a: 1, b: 1 })
  })

  it('retries a dirty blob and clears it after cloud acknowledgement', async () => {
    state.fail = true
    await expect(makeStore().save({ a: 8, b: 9 })).rejects.toBeTruthy()
    state.fail = false
    await syncCoordinator.replay()
    expect(state.row?.data).toEqual({ a: 8, b: 9 })
    expect(syncCoordinator.isDirty('tool_state:t')).toBe(false)
  })

  it('does not let an in-flight cloud read overwrite a new dirty mutation', async () => {
    state.row = { tool: 't', data: { a: 1, b: 1 } }
    let release!: () => void
    state.readGate = new Promise<void>((resolve) => { release = resolve })
    const loading = makeStore().load()
    await Promise.resolve()
    state.readGate = null
    state.fail = true
    await expect(makeStore().save({ a: 9, b: 9 })).rejects.toBeTruthy()
    release()
    expect(await loading).toEqual({ a: 9, b: 9 })
  })

  it('returns only household A captured cache when identity switches during a read', async () => {
    syncCoordinator.writeScoped('cache', JSON.stringify({ a: 4, b: 4 }))
    state.row = { tool: 't', data: { a: 1, b: 1 } }
    let release!: () => void
    state.readGate = new Promise<void>((resolve) => { release = resolve })
    const loading = makeStore().load()
    await Promise.resolve()
    activateSyncIdentity({ userId: 'u2', householdId: 'h2' })
    syncCoordinator.writeScoped('cache', JSON.stringify({ a: 7, b: 7 }))
    release()
    expect(await loading).toEqual({ a: 4, b: 4 })
    expect(JSON.parse(syncCoordinator.readScoped('cache')!)).toEqual({ a: 7, b: 7 })
  })
})
