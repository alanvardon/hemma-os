import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSupabaseMock } from './testSupabaseMock'

// See mortgage-store.test.ts for why this shape (vi.hoisted holder + a fresh
// module import + manual mock-state clearing) is needed every test.
// salary-drafts-store.ts has no localStorage cache — a read failure just
// means "nothing pending shown", reported via reportPersistenceWarning, and a
// saveHalf failure always throws.
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
// Microsecond precision, exactly as PostgREST serialises a timestamptz.
const TS = '2026-10-03T08:15:42.123456+00:00'
const row = (over: Record<string, unknown> = {}) => ({
  household_id: 'h1', month: '2026-10', slot: 'a', income_items: [{ label: 'Lön', amount: 42000 }],
  note: null, submitted_via: 'email', updated_at: TS, ...over,
})

describe('listDrafts', () => {
  it('returns the month’s drafts, parsed, with the exact updated_at string', async () => {
    mock().tables[TABLE] = [
      row({ note: 'bonus' }),
      row({ month: '2026-11', slot: 'b', income_items: [{ label: 'Lön', amount: 1 }] }),
    ]
    const drafts = await store.listDrafts('2026-10')
    expect(drafts).toEqual([{
      month: '2026-10', slot: 'a', income_items: [{ label: 'Lön', amount: 42000 }], note: 'bonus',
      submitted_via: 'email', updated_at: TS,
    }])
  })

  it('with no month, returns every pending month', async () => {
    mock().tables[TABLE] = [
      row(),
      row({ month: '2026-09', slot: 'b', submitted_via: 'app' }),
      row({ month: '2026-11', slot: 'b' }),
    ]
    const drafts = await store.listDrafts()
    expect(drafts.map((d) => [d.month, d.slot, d.submitted_via])).toEqual([
      ['2026-10', 'a', 'email'], ['2026-09', 'b', 'app'], ['2026-11', 'b', 'email'],
    ])
  })

  it('skips a malformed row (bad slot) but keeps its valid sibling', async () => {
    mock().tables[TABLE] = [
      row({ slot: 'c', income_items: [] }),
      row({ slot: 'b', income_items: [{ label: 'Lön', amount: 38900 }] }),
    ]
    const drafts = await store.listDrafts('2026-10')
    expect(drafts.map((d) => d.slot)).toEqual(['b'])
  })

  it('skips rows missing or garbling month, submitted_via or updated_at', async () => {
    const missing = (key: string) => { const r: Record<string, unknown> = row({ slot: 'b' }); delete r[key]; return r }
    mock().tables[TABLE] = [
      missing('month'), missing('submitted_via'), missing('updated_at'),
      row({ month: '2026-13' }), row({ submitted_via: 'fax' }), row({ updated_at: '' }), row({ updated_at: 12345 }),
      row({ slot: 'a', note: 'ok' }),
    ]
    const drafts = await store.listDrafts()
    expect(drafts).toHaveLength(1)
    expect(drafts[0].note).toBe('ok')
  })

  it('skips a malformed income item (non-finite amount) but keeps the row and its other items', async () => {
    mock().tables[TABLE] = [row({
      income_items: [{ label: 'Lön', amount: 42000 }, { label: 'Bad', amount: 'nope' }, { label: NaN, amount: 1 }],
    })]
    const drafts = await store.listDrafts('2026-10')
    expect(drafts.map((d) => d.income_items)).toEqual([[{ label: 'Lön', amount: 42000 }]])
  })

  it('rejects a row whose income_items is not an array, without throwing', async () => {
    mock().tables[TABLE] = [row({ income_items: 'not-an-array' })]
    await expect(store.listDrafts('2026-10')).resolves.toEqual([])
  })

  it('on a read failure, reports a warning and resolves to an empty list', async () => {
    mock().control.failing.add(TABLE)
    const drafts = await store.listDrafts('2026-10')
    expect(drafts).toEqual([])
    expect(warnSpy()).toHaveBeenCalledTimes(1)
    expect(warnSpy().mock.calls[0][0]).toMatch(/salary entries submitted by email/i)
  })

  it('on a read failure with no month, also warns and resolves to an empty list', async () => {
    mock().control.failing.add(TABLE)
    await expect(store.listDrafts()).resolves.toEqual([])
    expect(warnSpy()).toHaveBeenCalledTimes(1)
  })
})

describe('saveHalf', () => {
  const ITEMS = [{ label: 'Lön', amount: 38450 }, { label: 'Barnbidrag', amount: 1250 }]

  it('creates a half: sends the RPC args and resolves the pending status + new updated_at', async () => {
    let seen: unknown
    mock().control.rpcHandlers.save_salary_half = (args) => { seen = args; return { status: 'pending', updated_at: TS } }
    await expect(store.saveHalf('2026-10', 'a', ITEMS, 'bonus', null)).resolves.toEqual({ status: 'pending', updated_at: TS })
    expect(seen).toEqual({
      p_month: '2026-10', p_slot: 'a', p_items: ITEMS, p_note: 'bonus', p_expected_updated_at: null,
    })
  })

  it('sends a listed draft’s microsecond updated_at back byte-for-byte (never via Date)', async () => {
    mock().tables[TABLE] = [row()]
    const [listed] = await store.listDrafts('2026-10')
    let sent: unknown
    mock().control.rpcHandlers.save_salary_half = (args) => {
      sent = (args as { p_expected_updated_at: unknown }).p_expected_updated_at
      return { status: 'pending', updated_at: '2026-10-03T08:20:00.654321+00:00' }
    }
    const result = await store.saveHalf(listed.month, listed.slot, listed.income_items, listed.note, listed.updated_at)
    expect(sent).toBe('2026-10-03T08:15:42.123456+00:00')
    expect(sent).not.toBe(new Date(TS).toISOString()) // the millisecond form would conflict server-side
    expect(result.updated_at).toBe('2026-10-03T08:20:00.654321+00:00')
  })

  it('strips extra item fields so only label/amount reach the RPC', async () => {
    let seen: { p_items?: unknown } = {}
    mock().control.rpcHandlers.save_salary_half = (args) => { seen = args as typeof seen; return { status: 'pending', updated_at: TS } }
    await store.saveHalf('2026-10', 'b', [{ label: 'Lön', amount: 1, id: 'x' } as never], null, null)
    expect(seen.p_items).toEqual([{ label: 'Lön', amount: 1 }])
  })

  it.each([
    [{ status: 'finalized', updated_at: null }, { status: 'finalized', updated_at: null }],
    [{ status: 'already_logged' }, { status: 'already_logged', updated_at: null }],
    [{ status: 'zero_total', updated_at: TS }, { status: 'zero_total', updated_at: TS }],
  ])('maps %j', async (data, expected) => {
    mock().control.rpcHandlers.save_salary_half = () => data
    await expect(store.saveHalf('2026-10', 'b', ITEMS, null, TS)).resolves.toEqual(expected)
  })

  it.each([
    null, 'pending', { status: 'weird', updated_at: TS }, { status: 'pending' }, { status: 'pending', updated_at: null },
    { status: 'finalized', updated_at: TS },
  ])('throws on a malformed response %j', async (data) => {
    mock().control.rpcHandlers.save_salary_half = () => data
    await expect(store.saveHalf('2026-10', 'a', ITEMS, null, null)).rejects.toThrow(/malformed/i)
  })

  it('a 40001 conflict throws SalaryHalfConflict', async () => {
    mock().control.failing.add('save_salary_half')
    mock().control.errors.save_salary_half = { message: 'salary half conflict', code: '40001' }
    const error = await store.saveHalf('2026-10', 'a', ITEMS, null, TS).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(store.SalaryHalfConflict)
    expect(error).not.toBeInstanceOf(store.SalaryHalfForbidden)
  })

  it.each(['not your salary', 'not in a household'])('a 42501 (%s) throws SalaryHalfForbidden', async (message) => {
    mock().control.failing.add('save_salary_half')
    mock().control.errors.save_salary_half = { message, code: '42501' }
    const error = await store.saveHalf('2026-10', 'b', ITEMS, null, null).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(store.SalaryHalfForbidden)
    expect((error as Error).message).toBe(message)
  })

  it('a network error throws the backend error (not a typed one)', async () => {
    mock().control.failing.add('save_salary_half')
    mock().control.errors.save_salary_half = { message: 'Failed to fetch', status: 0 }
    const error = await store.saveHalf('2026-10', 'a', ITEMS, null, null).catch((e: unknown) => e)
    expect(error).toMatchObject({ message: 'Failed to fetch' })
    expect(error).not.toBeInstanceOf(store.SalaryHalfConflict)
    expect(error).not.toBeInstanceOf(store.SalaryHalfForbidden)
  })

  it('an invalid-input error (22023) throws the backend error', async () => {
    mock().control.failing.add('save_salary_half')
    mock().control.errors.save_salary_half = { message: 'invalid salary items', code: '22023' }
    await expect(store.saveHalf('2026-10', 'a', ITEMS, null, null)).rejects.toMatchObject({ code: '22023' })
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
