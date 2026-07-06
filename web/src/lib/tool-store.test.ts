import { describe, it, expect, vi, beforeEach } from 'vitest'

// In-memory stand-in for a single-tool `tool_state` table. `fail` flips the
// mock into error mode so we can exercise the cache-fallback / retry paths.
const state = { row: null as { tool: string; data: unknown } | null, fail: false }
vi.mock('./supabase', () => {
  const makeQuery = () => {
    let selected = 'data'
    const q: Record<string, unknown> = {}
    Object.assign(q, {
      select: (cols: string) => { selected = cols; return q },
      eq: () => q,
      maybeSingle: () => {
        if (state.fail) return Promise.resolve({ data: null, error: { message: 'down' } })
        if (!state.row) return Promise.resolve({ data: null, error: null })
        // select('tool') → { tool }; select('data') → { data }
        return Promise.resolve({ data: selected === 'tool' ? { tool: state.row.tool } : { data: state.row.data }, error: null })
      },
      upsert: (r: { tool: string; data: unknown }) => {
        if (state.fail) return Promise.resolve({ data: null, error: { message: 'down' } })
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
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => { mem.set(k, v) },
    removeItem: (k: string) => { mem.delete(k) },
    clear: () => mem.clear(),
  })
})

import { createToolStateStore } from './tool-store'

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
    expect(JSON.parse(mem.get('cache')!)).toEqual({ a: 1, b: 2 })
  })

  it('load returns the merged cloud blob and refreshes the cache', async () => {
    state.row = { tool: 't', data: { a: 5, b: 9, junk: 'x' } }
    const loaded = await makeStore().load()
    expect(loaded).toEqual({ a: 5, b: 9 }) // junk dropped by merge
    expect(JSON.parse(mem.get('cache')!)).toEqual({ a: 5, b: 9 })
  })

  it('load falls back to the cache on a cloud error', async () => {
    mem.set('cache', JSON.stringify({ a: 7, b: 8 }))
    mem.set('flag', '1') // skip the import path so the select is what fails
    state.fail = true
    expect(await makeStore().load()).toEqual({ a: 7, b: 8 })
  })

  it('first-login import seeds the cloud from the legacy blob, once', async () => {
    mem.set('legacy', JSON.stringify({ a: 3, b: 4 }))
    await makeStore().load()
    expect(state.row).toEqual({ tool: 't', data: { a: 3, b: 4 } })
    expect(mem.get('flag')).toBe('1')
  })

  it('import does not clobber an existing cloud row', async () => {
    mem.set('legacy', JSON.stringify({ a: 3, b: 4 }))
    state.row = { tool: 't', data: { a: 99, b: 99 } }
    await makeStore().load()
    expect(state.row.data).toEqual({ a: 99, b: 99 }) // partner's row preserved
  })

  it('a failed import leaves the flag unset so it retries', async () => {
    mem.set('legacy', JSON.stringify({ a: 3, b: 4 }))
    state.fail = true
    await makeStore().load()
    expect(mem.get('flag')).toBeUndefined()
  })
})
