import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSupabaseMock } from './testSupabaseMock'
import type { LoanPart, Payment, Bank, Mortgage } from './mortgage'

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

const PREFIX = 'hemma-sync-v1:test-user:test-house:'
const scoped = (key: string) => PREFIX + key
const CACHE_KEY = scoped('bostadskalkyl_mortgage_cache_v1')
const IMPORT_FLAG = scoped('bostadskalkyl_mortgage_supabase_imported')

const mem = new Map<string, string>()
let store: typeof import('./mortgage-store')
let sync: typeof import('./sync')
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
  store = await import('./mortgage-store')
  sync = await import('./sync')
  sync.activateSyncIdentity({ userId: 'test-user', householdId: 'test-house' })
  // The mocked './supabase' module (unlike plain modules) is NOT
  // re-evaluated by vi.resetModules() — it's the same mock instance for the
  // whole file, so its data/control state must be cleared by hand.
  Object.keys(mock().tables).forEach((k) => delete mock().tables[k])
  mock().control.fail = false
  mock().control.failing.clear()
  mock().control.lostResponseOnce.clear()
  Object.keys(mock().control.errors).forEach((key) => delete mock().control.errors[key])
  Object.keys(mock().control.rpcHandlers).forEach((k) => delete mock().control.rpcHandlers[k])
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

  it('sync snapshot reports failure instead of presenting cached rows as live data', async () => {
    mem.set(IMPORT_FLAG, '1')
    mem.set(CACHE_KEY, JSON.stringify({ version: 4, loan_parts: [{ id: 'cached', label: 'X' }], payments: [], valuations: [], rate_periods: [], contributions: [], settings: {} }))
    mock().control.failing.add('mortgage_rate_periods')

    expect(await store.loadMortgageSyncSnapshot()).toBeNull()
  })

  it('sync snapshot returns all three live mortgage inputs together', async () => {
    mem.set(IMPORT_FLAG, '1')
    mock().tables.mortgage_loan_parts = [{ id: 'p1' }]
    mock().tables.mortgage_rate_periods = [{ id: 'r1' }]
    mock().tables.mortgage_payments = [{ id: 'pay1' }]

    expect(await store.loadMortgageSyncSnapshot()).toEqual({
      parts: [{ id: 'p1' }], periods: [{ id: 'r1' }], payments: [{ id: 'pay1' }],
    })
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

  it('addLoanPart: cloud error keeps the row dirty for reload and replay', async () => {
    mock().control.failing.add('mortgage_loan_parts')
    await expect(store.addLoanPart({ label: 'Bolån', loan_number: '1', start_balance: 500000, start_date: '2024-01-01', archived: false })).rejects.toBeTruthy()
    expect((cache().loan_parts as unknown[] | undefined) || []).toHaveLength(1)
    expect(await store.listLoanParts()).toHaveLength(1)
    mock().control.failing.delete('mortgage_loan_parts')
    await sync.syncCoordinator.replay()
    expect(mock().tables.mortgage_loan_parts).toHaveLength(1)
    expect(sync.syncCoordinator.isDirty('mortgage_loan_parts')).toBe(false)
  })

  // Plan 105 — the declared amortering columns must round-trip through the
  // COLS.parts allowlist (a field missing there is silently dropped and never
  // persists). Save success + failure per the AGENTS.md writes-and-failures rule.
  it('addLoanPart: persists a declared amortering to the row and round-trips via list', async () => {
    const saved = await store.addLoanPart({
      label: 'Bolån', loan_number: '1', start_balance: 500000, start_date: '2024-01-01', archived: false,
      planned_amortization: 8000, planned_amortization_start: '2026-09-01', planned_amortization_end: null,
    })
    const row = mock().tables.mortgage_loan_parts[0]
    expect(row.planned_amortization).toBe(8000)              // reached the DB column, not dropped by COLS.parts
    expect(row.planned_amortization_start).toBe('2026-09-01')
    const listed = await store.listLoanParts()
    expect(listed[0].planned_amortization).toBe(8000)        // read back out of the cloud
    expect((cache().loan_parts as LoanPart[])[0].planned_amortization).toBe(8000)
    expect(saved.planned_amortization).toBe(8000)
  })

  it('updateLoanPart: patches the declared amortering on the row and cache', async () => {
    mock().tables.mortgage_loan_parts = [{ id: 'p1', created_at: 't', label: 'Bolån', loan_number: '1', start_balance: 500000, start_date: '2024-01-01', archived: false, revision: 1 }]
    // Load through the sync layer first so the optimistic-concurrency revision
    // for p1 is registered — an update against an unknown revision conflicts.
    await store.listLoanParts()
    const updated = await store.updateLoanPart('p1', { planned_amortization: 5000, planned_amortization_start: '2026-09-01' })
    expect(updated?.planned_amortization).toBe(5000)
    expect(mock().tables.mortgage_loan_parts[0].planned_amortization).toBe(5000)
    expect((cache().loan_parts as LoanPart[])[0].planned_amortization).toBe(5000)
  })

  it('addLoanPart: a cloud error keeps the declared amortering dirty for replay', async () => {
    mock().control.failing.add('mortgage_loan_parts')
    await expect(store.addLoanPart({
      label: 'Bolån', loan_number: '1', start_balance: 500000, start_date: '2024-01-01', archived: false, planned_amortization: 8000,
    })).rejects.toBeTruthy()
    // Durable sync keeps the optimistic row cached + dirty for replay rather than
    // dropping it; the declared amortering must survive to reach the DB on replay.
    expect((cache().loan_parts as LoanPart[])[0].planned_amortization).toBe(8000)
    mock().control.failing.delete('mortgage_loan_parts')
    await sync.syncCoordinator.replay()
    expect(mock().tables.mortgage_loan_parts[0].planned_amortization).toBe(8000)
    expect(sync.syncCoordinator.isDirty('mortgage_loan_parts')).toBe(false)
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

  it('removeLoanPart: one RPC removes the part and all linked history before patching the cache', async () => {
    const envelope = {
      version: 4,
      loan_parts: [{ id: 'p1' }, { id: 'p2' }],
      payments: [{ id: 'pay1', loan_part_id: 'p1' }, { id: 'pay2', loan_part_id: 'p2' }],
      valuations: [],
      rate_periods: [{ id: 'rate1', loan_part_id: 'p1' }, { id: 'rate2', loan_part_id: 'p2' }],
      contributions: [], settings: {},
    }
    mem.set(CACHE_KEY, JSON.stringify(envelope))
    mock().tables.mortgage_loan_parts = envelope.loan_parts.map((row) => ({ ...row }))
    mock().tables.mortgage_payments = envelope.payments.map((row) => ({ ...row }))
    mock().tables.mortgage_rate_periods = envelope.rate_periods.map((row) => ({ ...row }))
    await Promise.all([store.listLoanParts(), store.listPayments(), store.listRatePeriods()])
    const calls: unknown[] = []
    mock().control.rpcHandlers.sync_delete_mortgage_loan_part = (args) => {
      calls.push(args)
      const input = args as { p_loan_part_id: string; p_expected_revisions: Record<string, number | null> }
      const id = input.p_loan_part_id
      mock().tables.mortgage_payments = mock().tables.mortgage_payments.filter((row) => row.loan_part_id !== id)
      mock().tables.mortgage_rate_periods = mock().tables.mortgage_rate_periods.filter((row) => row.loan_part_id !== id)
      mock().tables.mortgage_loan_parts = mock().tables.mortgage_loan_parts.filter((row) => row.id !== id)
      return { status: 'applied', revisions: Object.fromEntries(Object.keys(input.p_expected_revisions).map((key) => [key, null])) }
    }

    await expect(store.removeLoanPart('p1')).resolves.toBe(1)

    expect(calls[0]).toMatchObject({ p_loan_part_id: 'p1' })
    expect(mock().tables.mortgage_loan_parts).toEqual([{ id: 'p2' }])
    expect(mock().tables.mortgage_payments).toEqual([{ id: 'pay2', loan_part_id: 'p2' }])
    expect(mock().tables.mortgage_rate_periods).toEqual([{ id: 'rate2', loan_part_id: 'p2' }])
    expect(cache()).toMatchObject({
      loan_parts: [{ id: 'p2' }],
      payments: [{ id: 'pay2', loan_part_id: 'p2' }],
      rate_periods: [{ id: 'rate2', loan_part_id: 'p2' }],
    })
  })

  it('removeLoanPart: RPC failure keeps parent and children hidden behind a durable tombstone', async () => {
    const envelope = {
      version: 4,
      loan_parts: [{ id: 'p1' }], payments: [{ id: 'pay1', loan_part_id: 'p1' }],
      valuations: [], rate_periods: [{ id: 'rate1', loan_part_id: 'p1' }],
      contributions: [], settings: {},
    }
    mem.set(CACHE_KEY, JSON.stringify(envelope))
    mock().tables.mortgage_loan_parts = envelope.loan_parts.map((row) => ({ ...row }))
    mock().tables.mortgage_payments = envelope.payments.map((row) => ({ ...row }))
    mock().tables.mortgage_rate_periods = envelope.rate_periods.map((row) => ({ ...row }))
    await Promise.all([store.listLoanParts(), store.listPayments(), store.listRatePeriods()])
    mock().control.failing.add('sync_delete_mortgage_loan_part')
    await expect(store.removeLoanPart('p1')).rejects.toBeTruthy()

    expect(cache()).toMatchObject({ loan_parts: [], payments: [], rate_periods: [] })
    expect(await store.listLoanParts()).toEqual([])
    expect(await store.listPayments()).toEqual([])
    expect(await store.listRatePeriods()).toEqual([])
    expect(mock().tables.mortgage_loan_parts).toEqual([{ id: 'p1' }])
    expect(mock().tables.mortgage_payments).toEqual([{ id: 'pay1', loan_part_id: 'p1' }])
    expect(mock().tables.mortgage_rate_periods).toEqual([{ id: 'rate1', loan_part_id: 'p1' }])
    expect(sync.syncCoordinator.isDirty('mortgage-loan-part-cascade')).toBe(true)

    mock().control.failing.delete('sync_delete_mortgage_loan_part')
    mock().control.rpcHandlers.sync_delete_mortgage_loan_part = (args) => {
      const input = args as { p_loan_part_id: string; p_expected_revisions: Record<string, number | null> }
      const id = input.p_loan_part_id
      mock().tables.mortgage_payments = mock().tables.mortgage_payments.filter((row) => row.loan_part_id !== id)
      mock().tables.mortgage_rate_periods = mock().tables.mortgage_rate_periods.filter((row) => row.loan_part_id !== id)
      mock().tables.mortgage_loan_parts = mock().tables.mortgage_loan_parts.filter((row) => row.id !== id)
      return { status: 'applied', revisions: Object.fromEntries(Object.keys(input.p_expected_revisions).map((key) => [key, null])) }
    }
    await sync.syncCoordinator.replay()
    expect(sync.syncCoordinator.isDirty('mortgage-loan-part-cascade')).toBe(false)
    expect(mock().tables.mortgage_loan_parts).toEqual([])
  })

  it('keeps cascade-delete intent after an authorization failure', async () => {
    mem.set(CACHE_KEY, JSON.stringify({
      version: 4, loan_parts: [{ id: 'p1' }], payments: [], valuations: [],
      rate_periods: [], contributions: [], settings: {},
    }))
    mock().tables.mortgage_loan_parts = [{ id: 'p1' }]
    await store.listLoanParts()
    mock().control.failing.add('sync_delete_mortgage_loan_part')
    mock().control.errors.sync_delete_mortgage_loan_part = { status: 403, message: 'JWT household membership denied' }

    await expect(store.removeLoanPart('p1')).rejects.toMatchObject({ category: 'auth' })
    expect(cache()).toMatchObject({ loan_parts: [] })
    expect(sync.syncCoordinator.getOutbox()).toMatchObject([{
      resource: 'mortgage-loan-part-cascade', operation: 'delete', state: 'pending', entityIds: ['p1'],
    }])
  })

  it('does not expose household A mortgage cache or outbox in household B', async () => {
    mock().control.failing.add('mortgage_loan_parts')
    await expect(store.addLoanPart({ label: 'A', loan_number: '1', start_balance: 1, start_date: '2026-01-01', archived: false })).rejects.toBeTruthy()
    sync.activateSyncIdentity({ userId: 'test-user', householdId: 'house-b' })
    expect(store.cachedSnapshot().loan_parts).toEqual([])
    expect(sync.syncCoordinator.getOutbox()).toEqual([])
  })
})

describe('one-time legacy import', () => {
  beforeEach(() => { mem.set(scoped('legacy-import-complete'), '1') })
  it('legacy present + no cloud row: seeded once and the flag is set', async () => {
    mem.set(scoped(store.STORAGE_KEY), JSON.stringify({
      version: 4,
      loan_parts: [{ id: 'legacy-1', label: 'Legacy', loan_number: '9', start_balance: 200000, start_date: '2020-01-01', archived: false }],
      payments: [], valuations: [], rate_periods: [], contributions: [], settings: {},
    }))
    await store.listLoanParts()
    expect(mock().tables.mortgage_loan_parts.some((r) => r.id === 'legacy-1')).toBe(true)
    expect(mem.get(IMPORT_FLAG)).toBe('1')
  })

  it('import error: flag stays unset so it retries next call', async () => {
    mem.set(scoped(store.STORAGE_KEY), JSON.stringify({
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
    mem.set(scoped(store.STORAGE_KEY), JSON.stringify({
      version: 4,
      loan_parts: [{ id: 'legacy-1', label: 'Legacy', loan_number: '9', start_balance: 200000, start_date: '2020-01-01', archived: false }],
      payments: [], valuations: [], rate_periods: [], contributions: [], settings: {},
    }))
    await store.listLoanParts()
    expect(mock().tables.mortgage_loan_parts).toHaveLength(0)
  })
})

describe('store-specific: migrateToPeriods (v<4 forward migration)', () => {
  beforeEach(() => { mem.set(scoped('legacy-import-complete'), '1') })
  it('folds a legacy per-part interest_rate into a rate_period on import', async () => {
    mem.set(scoped(store.STORAGE_KEY), JSON.stringify({
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

describe('banks & mortgages CRUD (plan 103)', () => {
  beforeEach(() => { mem.set(IMPORT_FLAG, '1') })

  it('addBank: success patches the cache and cloud', async () => {
    const saved = await store.addBank({ label: 'Danske' })
    expect(saved.id).toBeTruthy()
    expect(mock().tables.mortgage_banks).toHaveLength(1)
    expect((cache().banks as Bank[])[0].label).toBe('Danske')
  })

  it('addBank: cloud error keeps the row dirty for replay', async () => {
    mock().control.failing.add('mortgage_banks')
    await expect(store.addBank({ label: 'Danske' })).rejects.toBeTruthy()
    // Durable sync keeps the optimistic row cached + dirty rather than dropping it.
    expect((cache().banks as Bank[])[0].label).toBe('Danske')
    mock().control.failing.delete('mortgage_banks')
    await sync.syncCoordinator.replay()
    expect(mock().tables.mortgage_banks).toHaveLength(1)
    expect(sync.syncCoordinator.isDirty('mortgage_banks')).toBe(false)
  })

  it('addMortgage: success links the bank and patches both layers', async () => {
    const bank = await store.addBank({ label: 'Danske' })
    const saved = await store.addMortgage({ bank_id: bank.id, label: 'Bolån', start_date: null, archived: false })
    expect(mock().tables.mortgages).toHaveLength(1)
    expect(mock().tables.mortgages[0].bank_id).toBe(bank.id)
    expect((cache().mortgages as Mortgage[])[0].id).toBe(saved.id)
  })

  it('addMortgage: cloud error throws', async () => {
    mock().control.failing.add('mortgages')
    await expect(store.addMortgage({ bank_id: 'b1', label: 'Bolån', start_date: null, archived: false })).rejects.toBeTruthy()
  })

  it('listBanks/listMortgages: cloud ok writes through, cloud error falls back to cache', async () => {
    mock().tables.mortgage_banks = [{ id: 'b1', created_at: 't', label: 'Danske' }]
    mock().tables.mortgages = [{ id: 'm1', created_at: 't', bank_id: 'b1', label: 'Bolån', start_date: null, archived: false }]
    expect(await store.listBanks()).toHaveLength(1)
    expect(await store.listMortgages()).toHaveLength(1)
    expect((cache().banks as unknown[])).toHaveLength(1)

    mock().control.failing.add('mortgage_banks')
    // Cache still holds the written-through row → fallback returns it.
    expect(await store.listBanks()).toHaveLength(1)
  })

  it('updateLoanPart: patches mortgage_id + original anchor on the part', async () => {
    mock().tables.mortgage_loan_parts = [{ id: 'p1', created_at: 't', label: 'Bolån', loan_number: '', start_balance: 1000000, start_date: '2020-01-01', archived: false, revision: 1 }]
    // Register p1's revision through the sync layer before the optimistic update.
    await store.listLoanParts()
    await store.updateLoanPart('p1', { mortgage_id: 'm1', original_balance: 1200000, original_date: '2020-01-01' })
    const row = mock().tables.mortgage_loan_parts[0]
    expect(row.mortgage_id).toBe('m1')
    expect(row.original_balance).toBe(1200000)
    expect(row.original_date).toBe('2020-01-01')
  })

  it('addLoanPart: sends the new nullable columns through _row without inventing defaults', async () => {
    const saved = await store.addLoanPart({ label: 'Bolån', loan_number: '', start_balance: 500000, start_date: '2024-01-01', archived: false, mortgage_id: 'm1', original_balance: 500000, original_date: '2024-01-01' })
    const row = mock().tables.mortgage_loan_parts.find(r => r.id === saved.id)!
    expect(row.mortgage_id).toBe('m1')
    expect(row.original_balance).toBe(500000)
  })

  // Plan 104 — the bank year-basis profile columns must round-trip through the
  // COLS.banks allowlist (a field missing there is silently dropped and never
  // persists — and the mock never enforces the server-side allowlist, so this
  // is the only guard against that). Success + failure per the writes-and-
  // failures rule.
  it('addBank: persists year_basis + year_basis_source and round-trips via list', async () => {
    const saved = await store.addBank({ label: 'Danske', year_basis: 360, year_basis_source: 'declared' })
    const row = mock().tables.mortgage_banks[0]
    expect(row.year_basis).toBe(360)                      // reached the DB column, not dropped by COLS.banks
    expect(row.year_basis_source).toBe('declared')
    const listed = await store.listBanks()
    expect(listed[0].year_basis).toBe(360)                // read back out of the cloud
    expect(listed[0].year_basis_source).toBe('declared')
    expect((cache().banks as Bank[])[0].year_basis).toBe(360)
    expect(saved.year_basis).toBe(360)
  })

  it('updateBank: patches the year-basis lock on the row and cache', async () => {
    mock().tables.mortgage_banks = [{ id: 'b1', created_at: 't', label: 'Danske', revision: 1 }]
    // Load through the sync layer first so b1's optimistic-concurrency revision
    // is registered — an update against an unknown revision conflicts.
    await store.listBanks()
    const updated = await store.updateBank('b1', { year_basis: 360, year_basis_source: 'declared' })
    expect(updated?.year_basis).toBe(360)
    expect(mock().tables.mortgage_banks[0].year_basis).toBe(360)
    expect(mock().tables.mortgage_banks[0].year_basis_source).toBe('declared')
    expect((cache().banks as Bank[])[0].year_basis).toBe(360)
  })

  it('updateBank: can clear the lock back to auto (source → null)', async () => {
    mock().tables.mortgage_banks = [{ id: 'b1', created_at: 't', label: 'Danske', year_basis: 360, year_basis_source: 'declared', revision: 1 }]
    await store.listBanks()
    const updated = await store.updateBank('b1', { year_basis: null, year_basis_source: null })
    expect(updated?.year_basis_source).toBeNull()
    // These two columns opt into explicit-null (NULLABLE_EXPLICIT) so the UPDATE
    // actually clears them — a plain nullable column would stay 'declared'.
    expect(mock().tables.mortgage_banks[0].year_basis_source).toBeNull()
    expect(mock().tables.mortgage_banks[0].year_basis).toBeNull()
  })

  it('addBank: persists the billing pin (plan 104 phase 2) and round-trips via list', async () => {
    await store.addBank({ label: 'Danske', billing: 'month-end', billing_source: 'declared' })
    const row = mock().tables.mortgage_banks[0]
    expect(row.billing).toBe('month-end')                 // reached the DB column, not dropped by COLS.banks
    expect(row.billing_source).toBe('declared')
    const listed = await store.listBanks()
    expect(listed[0].billing).toBe('month-end')
    expect(listed[0].billing_source).toBe('declared')
  })

  it('updateBank: can clear the billing pin back to auto (NULLABLE_EXPLICIT)', async () => {
    mock().tables.mortgage_banks = [{ id: 'b1', created_at: 't', label: 'Danske', billing: 'month-end', billing_source: 'declared', revision: 1 }]
    await store.listBanks()
    await store.updateBank('b1', { billing: null, billing_source: null })
    expect(mock().tables.mortgage_banks[0].billing).toBeNull()
    expect(mock().tables.mortgage_banks[0].billing_source).toBeNull()
  })

  it('addBank: a cloud error keeps the year-basis lock dirty for replay', async () => {
    mock().control.failing.add('mortgage_banks')
    await expect(store.addBank({ label: 'Danske', year_basis: 360, year_basis_source: 'declared' })).rejects.toBeTruthy()
    // Durable sync keeps the optimistic row cached + dirty; the lock must survive to reach the DB on replay.
    expect((cache().banks as Bank[])[0].year_basis).toBe(360)
    mock().control.failing.delete('mortgage_banks')
    await sync.syncCoordinator.replay()
    expect(mock().tables.mortgage_banks[0].year_basis).toBe(360)
    expect(mock().tables.mortgage_banks[0].year_basis_source).toBe('declared')
    expect(sync.syncCoordinator.isDirty('mortgage_banks')).toBe(false)
  })

  it('listBanks: a bank row lacking the profile columns falls back to detection without crashing', async () => {
    // Legacy row (plan 103, no profile columns) — must load cleanly with the
    // fields simply absent, so the forecast falls back to detection.
    mock().tables.mortgage_banks = [{ id: 'b1', created_at: 't', label: 'Danske' }]
    const [bank] = await store.listBanks()
    expect(bank.label).toBe('Danske')
    expect(bank.year_basis).toBeUndefined()
    expect(bank.year_basis_source).toBeUndefined()
  })

  it('removeMortgage/removeBank: success prunes the cache', async () => {
    const bank = await store.addBank({ label: 'Danske' })
    const m = await store.addMortgage({ bank_id: bank.id, label: 'Bolån', start_date: null, archived: false })
    await store.removeMortgage(m.id)
    await store.removeBank(bank.id)
    expect(mock().tables.mortgages).toHaveLength(0)
    expect(mock().tables.mortgage_banks).toHaveLength(0)
    expect((cache().mortgages as unknown[])).toHaveLength(0)
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
