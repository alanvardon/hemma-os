import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DEFAULT_INPUTS } from './calc'

// In-memory stand-in for the `scenarios` table, capturing what the facade
// writes so we can assert the casing mapping (savedAt ↔ saved_at) and the
// upsert-all-then-delete-missing save model.
const rows: Record<string, unknown>[] = []
vi.mock('./supabase', () => {
  const makeQuery = () => {
    const q: Record<string, unknown> = {}
    Object.assign(q, {
      select: () => q,
      eq: () => q,
      order: () => Promise.resolve({ data: rows.slice(), error: null }),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      upsert: (r: Record<string, unknown> | Record<string, unknown>[]) => {
        for (const x of Array.isArray(r) ? r : [r]) {
          const i = rows.findIndex((y) => y.id === x.id)
          if (i >= 0) rows[i] = x; else rows.push(x)
        }
        return Promise.resolve({ data: null, error: null })
      },
      delete: () => ({
        not: (_col: string, op: string, val: string) => {
          if (op === 'in') {
            const keep = new Set(val.replace(/^\(|\)$/g, '').split(',').filter(Boolean))
            for (let i = rows.length - 1; i >= 0; i--) if (!keep.has(String(rows[i].id))) rows.splice(i, 1)
          } else {
            rows.length = 0 // ('id','is',null) → clear all
          }
          return Promise.resolve({ data: null, error: null })
        },
      }),
    })
    return q
  }
  return { supabase: { from: () => makeQuery() } }
})

import { loadScenarios, saveScenarios } from './storage'

// Tests run in the `node` env (no localStorage); storage's internal cache/flag
// localStorage use safely no-ops there, so we only reset the mocked table.
beforeEach(() => { rows.length = 0 })

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

  it('upserts the whole list and deletes rows no longer present', async () => {
    await saveScenarios([
      { id: 'a', name: 'A', savedAt: '2026-01-01', inputs: DEFAULT_INPUTS },
      { id: 'b', name: 'B', savedAt: '2026-03-01', inputs: DEFAULT_INPUTS },
    ])
    expect(rows).toHaveLength(2)

    await saveScenarios([{ id: 'b', name: 'B', savedAt: '2026-03-01', inputs: DEFAULT_INPUTS }])
    expect(rows.map((r) => r.id)).toEqual(['b'])
  })

  it('clearing the list to empty removes all rows', async () => {
    await saveScenarios([{ id: 'a', name: 'A', savedAt: '2026-01-01', inputs: DEFAULT_INPUTS }])
    await saveScenarios([])
    expect(rows).toHaveLength(0)
  })
})
