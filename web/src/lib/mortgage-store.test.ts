import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSupabaseMock } from './testSupabaseMock'
import type { LoanPart, Payment } from './mortgage'

// vi.mock factories run eagerly at the hoisted call site, before any of this
// file's own top-level statements — so the factory can't assign into a plain
// `let`/`const` declared below it (TDZ). `holder` is created via vi.hoisted,
// which Vitest guarantees runs before vi.mock, so the factory can safely
// populate `holder.current`. Every test also calls vi.resetModules() and
// re-imports the store fresh: mortgage-store.ts memoizes its one-time-import
// promise in a module-level `let`, so without a fresh module instance per
// test, only the FIRST test to call any list*/getSettings function would
// ever actually exercise the import path — every later test would silently
// hit the cached (already-resolved) promise instead.
const holder = vi.hoisted(() => ({ current: undefined as unknown as ReturnType<typeof createSupabaseMock> }))
vi.mock('./supabase', () => {
  holder.current = createSupabaseMock()
  return { supabase: holder.current.supabase }
})
const mock = () => holder.current

const CACHE_KEY = 'bostadskalkyl_mortgage_cache_v1'
const IMPORT_FLAG = 'bostadskalkyl_mortgage_supabase_imported'

const mem = new Map<string, string>()
let store: typeof import('./mortgage-store')
beforeEach(async () => {
  mem.clear()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => { mem.set(k, v) },
    removeItem: (k: string) => { mem.delete(k) },
    clear: () => mem.clear(),
  })
  vi.resetModules()
  store = await import('./mortgage-store')
  // The mocked './supabase' module (unlike plain modules) is NOT
  // re-evaluated by vi.resetModules() — it's the same mock instance for the
  // whole file, so its data/control state must be cleared by hand.
  Object.keys(mock().tables).forEach((k) => delete mock().tables[k])
  mock().control.fail = false
  mock().control.failing.clear()
})

function cache(): Record<string, unknown> {
  return JSON.parse(mem.get(CACHE_KEY) || '{}')
}

describe('read path', () => {
  it('cloud ok: list writes through to the cache', async () => {
    mem.set(IMPORT_FLAG, '1') // no legacy data — skip the import path
    mock().tables.mortgage_loan_parts = [{ id: 'p1', created_at: 't1', label: 'Bolån', loan_number: '123', start_balance: 100000, start_date: '2024-01-01', archived: false }]
    const rows = await store.listLoanParts()
    expect(rows).toHaveLength(1)
    expect((cache().loan_parts as unknown[])).toHaveLength(1)
  })

  it('cloud error: list falls back to the cache', async () => {
    mem.set(IMPORT_FLAG, '1')
    mem.set(CACHE_KEY, JSON.stringify({ version: 4, loan_parts: [{ id: 'cached', label: 'X' }], payments: [], valuations: [], rate_periods: [], contributions: [], settings: {} }))
    mock().control.failing.add('mortgage_loan_parts')
    const rows = await store.listLoanParts()
    expect(rows).toEqual([{ id: 'cached', label: 'X' }])
  })
})

describe('write path', () => {
  beforeEach(() => { mem.set(IMPORT_FLAG, '1') })

  it('addLoanPart: success patches the cache and resolves the saved row', async () => {
    const saved = await store.addLoanPart({ label: 'Bolån', loan_number: '1', start_balance: 500000, start_date: '2024-01-01', archived: false })
    expect(saved.id).toBeTruthy()
    expect(mock().tables.mortgage_loan_parts).toHaveLength(1)
    expect((cache().loan_parts as LoanPart[])[0].id).toBe(saved.id)
  })

  it('addLoanPart: cloud error throws', async () => {
    mock().control.failing.add('mortgage_loan_parts')
    await expect(store.addLoanPart({ label: 'Bolån', loan_number: '1', start_balance: 500000, start_date: '2024-01-01', archived: false })).rejects.toBeTruthy()
  })

  it('addLoanPart: cloud error leaves the cache untouched', async () => {
    mock().control.failing.add('mortgage_loan_parts')
    await expect(store.addLoanPart({ label: 'Bolån', loan_number: '1', start_balance: 500000, start_date: '2024-01-01', archived: false })).rejects.toBeTruthy()
    expect((cache().loan_parts as unknown[] | undefined) || []).toHaveLength(0)
  })

  it('addPayment: success patches the cache', async () => {
    const saved = await store.addPayment({ loan_part_id: 'p1', date: '2024-02-01', kind: 'amortization', description: '', amount: 1000, balance_after: null, paid_by: 'joint', source: '' })
    expect(mock().tables.mortgage_payments).toHaveLength(1)
    expect((cache().payments as Payment[])[0].id).toBe(saved.id)
  })

  it('addPayment: cloud error throws', async () => {
    mock().control.failing.add('mortgage_payments')
    await expect(store.addPayment({ loan_part_id: 'p1', date: '2024-02-01', kind: 'amortization', description: '', amount: 1000, balance_after: null, paid_by: 'joint', source: '' })).rejects.toBeTruthy()
  })
})

describe('one-time legacy import', () => {
  it('legacy present + no cloud row: seeded once and the flag is set', async () => {
    mem.set(store.STORAGE_KEY, JSON.stringify({
      version: 4,
      loan_parts: [{ id: 'legacy-1', label: 'Legacy', loan_number: '9', start_balance: 200000, start_date: '2020-01-01', archived: false }],
      payments: [], valuations: [], rate_periods: [], contributions: [], settings: {},
    }))
    await store.listLoanParts()
    expect(mock().tables.mortgage_loan_parts.some((r) => r.id === 'legacy-1')).toBe(true)
    expect(mem.get(IMPORT_FLAG)).toBe('1')
  })

  it('import error: flag stays unset so it retries next call', async () => {
    mem.set(store.STORAGE_KEY, JSON.stringify({
      version: 4,
      loan_parts: [{ id: 'legacy-1', label: 'Legacy', loan_number: '9', start_balance: 200000, start_date: '2020-01-01', archived: false }],
      payments: [], valuations: [], rate_periods: [], contributions: [], settings: {},
    }))
    mock().control.failing.add('mortgage_loan_parts')
    await store.listLoanParts()
    expect(mem.get(IMPORT_FLAG)).toBeUndefined()
  })

  it('flag already set: legacy data is not re-imported', async () => {
    mem.set(IMPORT_FLAG, '1')
    mem.set(store.STORAGE_KEY, JSON.stringify({
      version: 4,
      loan_parts: [{ id: 'legacy-1', label: 'Legacy', loan_number: '9', start_balance: 200000, start_date: '2020-01-01', archived: false }],
      payments: [], valuations: [], rate_periods: [], contributions: [], settings: {},
    }))
    await store.listLoanParts()
    expect(mock().tables.mortgage_loan_parts).toHaveLength(0)
  })
})

describe('store-specific: migrateToPeriods (v<4 forward migration)', () => {
  it('folds a legacy per-part interest_rate into a rate_period on import', async () => {
    mem.set(store.STORAGE_KEY, JSON.stringify({
      version: 1,
      loan_parts: [{ id: 'p1', label: 'Bolån', loan_number: '1', start_balance: 500000, start_date: '2020-06-01', archived: false, interest_rate: 2.5, rate_type: 'rörlig' }],
      payments: [], valuations: [], rate_periods: [], contributions: [], settings: {},
    }))
    await store.listLoanParts()
    const periods = await store.listRatePeriods()
    expect(periods).toHaveLength(1)
    expect(periods[0]).toMatchObject({ loan_part_id: 'p1', rate: 2.5, rate_type: 'rörlig', start_date: '2020-06-01' })
  })
})

describe('store-specific: _row NOT-NULL fallbacks', () => {
  beforeEach(() => { mem.set(IMPORT_FLAG, '1') })

  it('addLoanPart: an omitted NOT-NULL column gets its default, not undefined', async () => {
    const record = { label: 'Bolån', start_balance: 100000, start_date: '2024-01-01' } as unknown as Omit<LoanPart, 'id' | 'created_at'>
    await store.addLoanPart(record)
    const row = mock().tables.mortgage_loan_parts[0]
    expect(row.loan_number).toBe('')
    expect(row.archived).toBe(false)
  })

  it('addPayment: an omitted paid_by defaults to joint', async () => {
    const record = { loan_part_id: 'p1', date: '2024-02-01', kind: 'payment', description: '', amount: 100, balance_after: null, source: '' } as unknown as Omit<Payment, 'id' | 'created_at'>
    await store.addPayment(record)
    expect(mock().tables.mortgage_payments[0].paid_by).toBe('joint')
  })
})
