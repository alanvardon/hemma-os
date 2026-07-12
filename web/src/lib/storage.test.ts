import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DEFAULT_INPUTS } from './calc'

// In-memory stand-in for the `scenarios` table, capturing what the facade
// writes so we can assert the casing mapping (savedAt ↔ saved_at) and the
// upsert-only save model (plan 43 — saves never delete; deletions are explicit).
const rows: Record<string, unknown>[] = []
// Records how delete().in() was called, so a test can assert it passes an ARRAY
// of ids (supabase-js quotes them) rather than an interpolated string filter.
let lastDeleteIn: { col: string; ids: unknown } | null = null
let mutationError: { message: string; code?: string } | null = null
vi.mock('./supabase', () => {
  const makeQuery = () => {
    const q: Record<string, unknown> = {}
    Object.assign(q, {
      select: () => q,
      eq: () => q,
      order: () => Promise.resolve({ data: rows.slice(), error: null }),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      upsert: (r: Record<string, unknown> | Record<string, unknown>[]) => {
        if (mutationError) return Promise.resolve({ data: null, error: mutationError })
        for (const x of Array.isArray(r) ? r : [r]) {
          const i = rows.findIndex((y) => y.id === x.id)
          if (i >= 0) rows[i] = x; else rows.push(x)
        }
        return Promise.resolve({ data: null, error: null })
      },
      delete: () => ({
        in: (col: string, ids: string[]) => {
          lastDeleteIn = { col, ids }
          if (mutationError) return Promise.resolve({ data: null, error: mutationError })
          const drop = new Set(ids.map(String))
          for (let i = rows.length - 1; i >= 0; i--) if (drop.has(String(rows[i].id))) rows.splice(i, 1)
          return Promise.resolve({ data: null, error: null })
        },
      }),
    })
    return q
  }
  return { supabase: { from: () => makeQuery() } }
})

import { loadScenarios, saveScenarios, deleteScenarios, saveGlobalConstants } from './storage'

// Tests run in the `node` env (no localStorage); storage's internal cache/flag
// localStorage use safely no-ops there, so we only reset the mocked table.
beforeEach(() => { rows.length = 0; lastDeleteIn = null; mutationError = null })

describe('scenarios cloud mapping (savedAt ↔ saved_at)', () => {
  it('writes saved_at (snake) and reads back savedAt (camel)', async () => {
    await saveScenarios([{ id: 'x1', name: 'Test', savedAt: '2026-01-02T00:00:00.000Z', inputs: DEFAULT_INPUTS }])
    expect(rows[0].saved_at).toBe('2026-01-02T00:00:00.000Z')
    expect(rows[0].savedAt).toBeUndefined()

    const loaded = await loadScenarios()
    expect(loaded[0].savedAt).toBe('2026-01-02T00:00:00.000Z')
    expect((loaded[0] as unknown as Record<string, unknown>).saved_at).toBeUndefined()
    expect(loaded[0].inputs).toEqual(DEFAULT_INPUTS)
  })
})

describe('saveScenarios is upsert-only (plan 43 — never deletes)', () => {
  it('upserts the whole list', async () => {
    await saveScenarios([
      { id: 'a', name: 'A', savedAt: '2026-01-01', inputs: DEFAULT_INPUTS },
      { id: 'b', name: 'B', savedAt: '2026-03-01', inputs: DEFAULT_INPUTS },
    ])
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b'])
  })

  it('rejects when an upsert resolves with an error', async () => {
    mutationError = { message: 'new row violates check constraint private_raw_text', code: '23514' }
    await expect(saveScenarios([
      { id: 'a', name: 'A', savedAt: '2026-01-01', inputs: DEFAULT_INPUTS },
    ])).rejects.toMatchObject({ category: 'validation' })
  })

  it('saving a shorter list does NOT delete the omitted rows', async () => {
    await saveScenarios([
      { id: 'a', name: 'A', savedAt: '2026-01-01', inputs: DEFAULT_INPUTS },
      { id: 'b', name: 'B', savedAt: '2026-03-01', inputs: DEFAULT_INPUTS },
    ])
    await saveScenarios([{ id: 'b', name: 'B', savedAt: '2026-03-01', inputs: DEFAULT_INPUTS }])
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b'])
  })

  it('saving an empty list leaves cloud rows untouched', async () => {
    await saveScenarios([{ id: 'a', name: 'A', savedAt: '2026-01-01', inputs: DEFAULT_INPUTS }])
    await saveScenarios([])
    expect(rows.map((r) => r.id)).toEqual(['a'])
  })

  // The exact data-loss scenario the plan targets: fresh device, hydrate read
  // failed → in-memory list is empty → one scenario saved. Pre-existing cloud
  // rows must survive.
  it('an empty-cache device saving one scenario preserves the household rows', async () => {
    // Simulate the household already having rows in the cloud.
    rows.push({ id: 'a', name: 'A', saved_at: '2026-01-01', inputs: {}, constants: null })
    rows.push({ id: 'b', name: 'B', saved_at: '2026-02-01', inputs: {}, constants: null })
    // The empty-cache device saves its single new scenario.
    await saveScenarios([{ id: 'c', name: 'C', savedAt: '2026-03-01', inputs: DEFAULT_INPUTS }])
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('deleteScenarios (the only path that removes cloud rows)', () => {
  it('removes exactly the given ids', async () => {
    await saveScenarios([
      { id: 'a', name: 'A', savedAt: '2026-01-01', inputs: DEFAULT_INPUTS },
      { id: 'b', name: 'B', savedAt: '2026-03-01', inputs: DEFAULT_INPUTS },
    ])
    await deleteScenarios(['a'])
    expect(rows.map((r) => r.id)).toEqual(['b'])
  })

  it('rejects when a delete resolves with an error', async () => {
    mutationError = { message: 'delete denied' }
    await expect(deleteScenarios(['a'])).rejects.toMatchObject({
      category: 'unknown',
      message: 'Kunde inte spara ändringen. Försök igen.',
    })
  })

  it('passes an array to .in() (no interpolated string filter)', async () => {
    await deleteScenarios(['id,with)chars', 'plain'])
    expect(lastDeleteIn?.col).toBe('id')
    expect(lastDeleteIn?.ids).toEqual(['id,with)chars', 'plain'])
  })

  it('no-ops on an empty id list (never issues a delete)', async () => {
    await saveScenarios([{ id: 'a', name: 'A', savedAt: '2026-01-01', inputs: DEFAULT_INPUTS }])
    await deleteScenarios([])
    expect(lastDeleteIn).toBeNull()
    expect(rows.map((r) => r.id)).toEqual(['a'])
  })
})

describe('prefs cloud writes', () => {
  it('rejects when the prefs upsert resolves with an error', async () => {
    mutationError = { message: 'Failed to fetch' }
    await expect(saveGlobalConstants({} as Parameters<typeof saveGlobalConstants>[0]))
      .rejects.toMatchObject({ category: 'offline' })
  })
})
