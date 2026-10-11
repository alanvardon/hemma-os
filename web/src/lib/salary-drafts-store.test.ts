import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSupabaseMock } from './testSupabaseMock'

// See mortgage-store.test.ts for why this shape (vi.hoisted holder + a fresh
// module import + manual mock-state clearing) is needed every test.
// salary-drafts-store.ts has no localStorage cache — a read failure just
// means "no prefill today", reported via reportPersistenceWarning.
const holder = vi.hoisted(() => ({ current: undefined as unknown as ReturnType<typeof createSupabaseMock> }))
vi.mock('./supabase', () => {
  holder.current = createSupabaseMock()
  return { supabase: holder.current.supabase }
})
const mock = () => holder.current

// See manadsavslut-store.test.ts for why reportPersistenceWarning is spied
// this way: this file runs in the (default) node environment, which has no
// `window` to dispatch the real event on.
const warnHolder = vi.hoisted(() => ({ spy: vi.fn() }))
vi.mock('./persistence-error', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./persistence-error')>()
  return { ...actual, reportPersistenceWarning: (message: string) => warnHolder.spy(message) }
})
const warnSpy = () => warnHolder.spy

let store: typeof import('./salary-drafts-store')
beforeEach(async () => {
  warnSpy().mockClear()
  vi.resetModules()
  store = await import('./salary-drafts-store')
  Object.keys(mock().tables).forEach((k) => delete mock().tables[k])
  mock().control.fail = false
  mock().control.failing.clear()
  mock().control.rpcHandlers = {}
})

const TABLE = 'salary_submission_drafts'

describe('listDrafts', () => {
  it('returns the month’s drafts, parsed', async () => {
    mock().tables[TABLE] = [
      { household_id: 'h1', month: '2026-10', slot: 'a', income_items: [{ label: 'Lön', amount: 42000 }], note: 'bonus' },
      { household_id: 'h1', month: '2026-11', slot: 'b', income_items: [{ label: 'Lön', amount: 1 }], note: null },
    ]
    const drafts = await store.listDrafts('2026-10')
    expect(drafts).toEqual([{ slot: 'a', income_items: [{ label: 'Lön', amount: 42000 }], note: 'bonus' }])
  })

  it('skips a malformed row (bad slot) but keeps its valid sibling', async () => {
    mock().tables[TABLE] = [
      { household_id: 'h1', month: '2026-10', slot: 'c', income_items: [], note: null },
      { household_id: 'h1', month: '2026-10', slot: 'b', income_items: [{ label: 'Lön', amount: 38900 }], note: null },
    ]
    const drafts = await store.listDrafts('2026-10')
    expect(drafts.map((d) => d.slot)).toEqual(['b'])
  })

  it('skips a malformed income item (non-finite amount) but keeps the row and its other items', async () => {
    mock().tables[TABLE] = [{
      household_id: 'h1', month: '2026-10', slot: 'a',
      income_items: [{ label: 'Lön', amount: 42000 }, { label: 'Bad', amount: 'nope' }, { label: NaN, amount: 1 }],
      note: null,
    }]
    const drafts = await store.listDrafts('2026-10')
    expect(drafts).toEqual([{ slot: 'a', income_items: [{ label: 'Lön', amount: 42000 }], note: null }])
  })

  it('rejects a row whose income_items is not an array, without throwing', async () => {
    mock().tables[TABLE] = [{ household_id: 'h1', month: '2026-10', slot: 'a', income_items: 'not-an-array', note: null }]
    await expect(store.listDrafts('2026-10')).resolves.toEqual([])
  })

  it('on a read failure, reports a warning and resolves to an empty list', async () => {
    mock().control.failing.add(TABLE)
    const drafts = await store.listDrafts('2026-10')
    expect(drafts).toEqual([])
    expect(warnSpy()).toHaveBeenCalledTimes(1)
    expect(warnSpy().mock.calls[0][0]).toMatch(/salary entries submitted by email/i)
  })
})

describe('discardDrafts', () => {
  it('resolves on a successful rpc call', async () => {
    mock().control.rpcHandlers.discard_salary_drafts = () => null
    await expect(store.discardDrafts('2026-10')).resolves.toBeUndefined()
  })

  it('throws the backend error on failure', async () => {
    mock().control.failing.add('discard_salary_drafts')
    mock().control.errors.discard_salary_drafts = { message: 'not in a household', code: '42501' }
    await expect(store.discardDrafts('2026-10')).rejects.toMatchObject({ message: 'not in a household' })
  })
})
