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

const CREATED = '2026-07-15T10:00:00.000Z'
const loanPart = (id: string, over: Record<string, unknown> = {}) => ({ id, created_at: CREATED, label: 'Bolån', loan_number: '1', start_balance: 500_000, start_date: '2024-01-01', archived: false, ...over })
const mortgagePayment = (id: string, loan_part_id: string | null = null, over: Record<string, unknown> = {}) => ({ id, created_at: CREATED, loan_part_id, date: '2024-02-01', kind: 'payment', description: '', amount: 0, balance_after: null, paid_by: 'joint', source: '', is_insats: false, paid_split: null, ...over })
const ratePeriod = (id: string, loan_part_id: string | null = null, over: Record<string, unknown> = {}) => ({ id, created_at: CREATED, loan_part_id, start_date: '2024-01-01', end_date: null, rate: null, rate_type: 'rörlig', ...over })
const bankRow = (id: string, over: Record<string, unknown> = {}) => ({ id, created_at: CREATED, label: 'Danske', ...over })
const mortgageRow = (id: string, over: Record<string, unknown> = {}) => ({ id, created_at: CREATED, bank_id: 'b1', label: 'Bolån', start_date: '2024-01-01', archived: false, end_date: null, revision: 1, ...over })

describe('read path', () => {
  it('cloud ok: list writes through to the cache', async () => {
    mem.set(IMPORT_FLAG, '1') // no legacy data — skip the import path
    mock().tables.mortgage_loan_parts = [loanPart('p1', { loan_number: '123', start_balance: 100000 })]
    const rows = await store.listLoanParts()
    expect(rows).toHaveLength(1)
    expect((cache().loan_parts as unknown[])).toHaveLength(1)
  })

  it('cloud error: list falls back to the cache', async () => {
    mem.set(IMPORT_FLAG, '1')
    mem.set(CACHE_KEY, JSON.stringify({ version: 4, banks: [], mortgages: [], loan_parts: [loanPart('cached', { label: 'X' })], payments: [], valuations: [], rate_periods: [], contributions: [], settings: {} }))
    mock().control.failing.add('mortgage_loan_parts')
    const rows = await store.listLoanParts()
    expect(rows).toMatchObject([{ id: 'cached', label: 'X' }])
  })

  it('cloud read salvages a valid loan part and excludes its malformed sibling', async () => {
    mem.set(IMPORT_FLAG, '1')
    mock().tables.mortgage_loan_parts = [loanPart('valid'), loanPart('bad', { start_balance: 'not-a-number' })]
    expect((await store.listLoanParts()).map((row) => row.id)).toEqual(['valid'])
    expect((cache().loan_parts as { id: string }[]).map((row) => row.id)).toEqual(['valid'])
  })

  it('sync snapshot reports failure instead of presenting cached rows as live data', async () => {
    mem.set(IMPORT_FLAG, '1')
    mem.set(CACHE_KEY, JSON.stringify({ version: 4, banks: [], mortgages: [], loan_parts: [loanPart('cached', { label: 'X' })], payments: [], valuations: [], rate_periods: [], contributions: [], settings: {} }))
    mock().control.failing.add('mortgage_rate_periods')

    expect(await store.loadMortgageSyncSnapshot()).toBeNull()
  })

  it('sync snapshot returns all three live mortgage inputs together', async () => {
    mem.set(IMPORT_FLAG, '1')
    mock().tables.mortgage_loan_parts = [loanPart('p1')]
    mock().tables.mortgage_rate_periods = [ratePeriod('r1', 'p1')]
    mock().tables.mortgage_payments = [mortgagePayment('pay1', 'p1')]

    expect(await store.loadMortgageSyncSnapshot()).toMatchObject({
      parts: [loanPart('p1')], periods: [ratePeriod('r1', 'p1')], payments: [mortgagePayment('pay1', 'p1')],
    })
  })
})

// Plan 118 — the purpose-built all-or-nothing read behind Bostadskalkyl's
// "pull current balance". It must never present a failed live read as an
// authoritative empty (0 kr) balance, and must fall back to the authoritative
// cache when the scope is inactive/dirty — exactly like loadMortgageSyncSnapshot.
describe('loadMortgageBalanceSnapshot (plan 118)', () => {
  it('unavailable live source (query error) returns null — never an empty 0-balance snapshot', () => {
    mem.set(IMPORT_FLAG, '1')
    mem.set(CACHE_KEY, JSON.stringify({ version: 6, banks: [], mortgages: [mortgageRow('mC')], loan_parts: [loanPart('pC', { mortgage_id: 'mC' })], payments: [], valuations: [], rate_periods: [], contributions: [], settings: {} }))
    mock().control.failing.add('mortgage_payments')
    return expect(store.loadMortgageBalanceSnapshot()).resolves.toBeNull()
  })

  it('authoritative data present returns the live mortgages, parts and payments together', async () => {
    mem.set(IMPORT_FLAG, '1')
    mock().tables.mortgages = [mortgageRow('m1')]
    mock().tables.mortgage_loan_parts = [loanPart('p1', { mortgage_id: 'm1' })]
    mock().tables.mortgage_payments = [mortgagePayment('pay1', 'p1', { balance_after: 400_000 })]
    const snap = await store.loadMortgageBalanceSnapshot()
    expect(snap?.mortgages.map(m => m.id)).toEqual(['m1'])
    expect(snap?.parts.map(p => p.id)).toEqual(['p1'])
    expect(snap?.payments.map(p => p.id)).toEqual(['pay1'])
    // Wrote the live rows through to the cache (same contract as the sibling).
    expect((cache().mortgages as { id: string }[]).map(m => m.id)).toEqual(['m1'])
  })

  it('an inactive/dirty scope returns the authoritative cache fallback, not a live 0', async () => {
    mem.set(IMPORT_FLAG, '1')
    // Cache holds the household's real debt; the live tables are EMPTY, so a
    // live read (the wrong path) would fabricate a 0 kr balance.
    mem.set(CACHE_KEY, JSON.stringify({
      version: 6, banks: [bankRow('b1')],
      mortgages: [mortgageRow('mCache', { bank_id: 'b1' })],
      loan_parts: [loanPart('pCache', { mortgage_id: 'mCache' })],
      payments: [mortgagePayment('payCache', 'pCache', { balance_after: 750_000 })],
      valuations: [], rate_periods: [], contributions: [], settings: {},
    }))
    // Dirty the mortgages resource with a failed write; the read must then serve
    // the cache instead of the empty live tables.
    mock().control.failing.add('mortgages')
    await expect(store.addMortgage({ bank_id: 'b1', label: 'X', start_date: '2026-01-01', archived: true, end_date: null })).rejects.toBeTruthy()
    expect(sync.syncCoordinator.isDirty('mortgages')).toBe(true)

    const snap = await store.loadMortgageBalanceSnapshot()
    // Parts and payments come straight from the authoritative cache — not the
    // empty live tables — proving the read never mistakes unavailability for 0.
    expect(snap?.parts.map(p => p.id)).toEqual(['pCache'])
    expect(snap?.payments.map(p => p.id)).toEqual(['payCache'])
    expect(snap?.parts).not.toHaveLength(0)
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
    mock().tables.mortgage_loan_parts = [loanPart('p1', { revision: 1 })]
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

  it('canonical down payment saves, edits and deletes through mortgage_payments', async () => {
    // Plan 109a: a NEW partless down payment must carry the active agreement.
    mock().tables.mortgages = [mortgageRow('m1')]
    const saved = await store.addPayment({
      loan_part_id: 'must-be-cleared', date: '2024-02-01', kind: 'down_payment', description: 'Kontantinsats',
      amount: 250_000, balance_after: null, paid_by: 'a', source: 'manual', is_insats: false,
    })
    expect(saved).toMatchObject({ loan_part_id: null, kind: 'down_payment', paid_by: 'a', is_insats: true, mortgage_id: 'm1' })
    expect(mock().tables.mortgage_payments[0]).toMatchObject({ id: saved.id, loan_part_id: null, kind: 'down_payment', is_insats: true, mortgage_id: 'm1' })
    expect(mock().tables.mortgage_contributions || []).toHaveLength(0)

    const updated = await store.updatePayment(saved.id, { amount: 300_000, paid_by: 'b', loan_part_id: 'still-cleared', is_insats: false })
    expect(updated).toMatchObject({ amount: 300_000, paid_by: 'b', loan_part_id: null, is_insats: true })
    expect((cache().payments as Payment[])[0]).toMatchObject({ amount: 300_000, paid_by: 'b' })

    await store.removePayment(saved.id)
    expect(mock().tables.mortgage_payments).toHaveLength(0)
    expect(cache().payments).toEqual([])
  })

  it('failed canonical payment save stays dirty and retries without writing the legacy table', async () => {
    mock().tables.mortgages = [mortgageRow('m1')]
    mock().control.failing.add('mortgage_payments')
    await expect(store.addPayment({
      loan_part_id: null, date: '2024-02-01', kind: 'down_payment', description: 'Kontantinsats',
      amount: 250_000, balance_after: null, paid_by: 'a', source: 'manual', is_insats: true,
    })).rejects.toBeTruthy()
    expect((cache().payments as Payment[])[0]).toMatchObject({ kind: 'down_payment', amount: 250_000 })
    expect(mock().tables.mortgage_contributions || []).toHaveLength(0)
    expect(sync.syncCoordinator.isDirty('mortgage_payments')).toBe(true)

    mock().control.failing.delete('mortgage_payments')
    await sync.syncCoordinator.replay()
    expect(mock().tables.mortgage_payments).toHaveLength(1)
    expect(sync.syncCoordinator.isDirty('mortgage_payments')).toBe(false)
  })

  it('removeLoanPart: one RPC removes the part and all linked history before patching the cache', async () => {
    const envelope = {
      version: 4,
      loan_parts: [loanPart('p1'), loanPart('p2')],
      payments: [mortgagePayment('pay1', 'p1'), mortgagePayment('pay2', 'p2')],
      valuations: [],
      rate_periods: [ratePeriod('rate1', 'p1'), ratePeriod('rate2', 'p2')],
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
    expect(mock().tables.mortgage_loan_parts).toMatchObject([{ id: 'p2' }])
    expect(mock().tables.mortgage_payments).toMatchObject([{ id: 'pay2', loan_part_id: 'p2' }])
    expect(mock().tables.mortgage_rate_periods).toMatchObject([{ id: 'rate2', loan_part_id: 'p2' }])
    expect(cache()).toMatchObject({
      loan_parts: [{ id: 'p2' }],
      payments: [{ id: 'pay2', loan_part_id: 'p2' }],
      rate_periods: [{ id: 'rate2', loan_part_id: 'p2' }],
    })
  })

  it('removeLoanPart: RPC failure keeps parent and children hidden behind a durable tombstone', async () => {
    const envelope = {
      version: 4,
      loan_parts: [loanPart('p1')], payments: [mortgagePayment('pay1', 'p1')],
      valuations: [], rate_periods: [ratePeriod('rate1', 'p1')],
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
    expect(mock().tables.mortgage_loan_parts).toMatchObject([{ id: 'p1' }])
    expect(mock().tables.mortgage_payments).toMatchObject([{ id: 'pay1', loan_part_id: 'p1' }])
    expect(mock().tables.mortgage_rate_periods).toMatchObject([{ id: 'rate1', loan_part_id: 'p1' }])
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
      version: 4, banks: [], mortgages: [], loan_parts: [loanPart('p1')], payments: [], valuations: [],
      rate_periods: [], contributions: [], settings: {},
    }))
    mock().tables.mortgage_loan_parts = [loanPart('p1')]
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

describe('scenario-rate settings persistence (plan 117)', () => {
  beforeEach(() => { mem.set(IMPORT_FLAG, '1') })

  it('persists a scenario rate through cache, export, and import', async () => {
    await store.saveSettings({ what_if_rate_pct: 3.45 })
    expect((cache().settings as { what_if_rate_pct: number | null }).what_if_rate_pct).toBe(3.45)
    expect((await store.getSettings()).what_if_rate_pct).toBe(3.45)

    const exported = JSON.parse(await store.exportJSON()) as { settings: { what_if_rate_pct: number | null } }
    expect(exported.settings.what_if_rate_pct).toBe(3.45)

    const backup = JSON.stringify({
      version: 6,
      banks: [], mortgages: [], loan_parts: [], payments: [], valuations: [], rate_periods: [], contributions: [],
      settings: { what_if_rate_pct: 2.75 },
    })
    await store.importJSON(backup)
    expect(store.cachedSnapshot().settings.what_if_rate_pct).toBe(2.75)
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

  it('invalid assigned legacy data neither mutates nor sets the flag, then retries after correction', async () => {
    const key = scoped(store.STORAGE_KEY)
    mem.set(key, JSON.stringify({ version: 1, loan_parts: [{ id: 'p1', label: 'Legacy', loan_number: '1', start_balance: 100, start_date: '2024-01-01', archived: false, interest_rate: '2.5' }], payments: [], valuations: [], rate_periods: [], contributions: [], settings: {} }))
    await store.listLoanParts()
    expect(mock().tables.mortgage_loan_parts || []).toHaveLength(0)
    expect(mock().tables.mortgage_rate_periods || []).toHaveLength(0)
    expect(mem.get(IMPORT_FLAG)).toBeUndefined()

    mem.set(key, JSON.stringify({ version: 1, loan_parts: [{ id: 'p1', label: 'Legacy', loan_number: '1', start_balance: 100, start_date: '2024-01-01', archived: false, interest_rate: 2.5 }], payments: [], valuations: [], rate_periods: [], contributions: [], settings: {} }))
    await store.listLoanParts()
    expect(mock().tables.mortgage_loan_parts.some((row) => row.id === 'p1')).toBe(true)
    expect(mem.get(IMPORT_FLAG)).toBe('1')
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

  it('converts legacy contributions into deterministic payments and never rewrites the legacy table', async () => {
    mem.set(scoped(store.STORAGE_KEY), JSON.stringify({
      version: 4, loan_parts: [], payments: [], valuations: [], rate_periods: [],
      contributions: [{ id: 'deposit-a', created_at: CREATED, owner: 'a', date: '2024-01-01', amount: 200_000, note: 'Kontantinsats' }],
      settings: {},
    }))
    await store.listPayments()
    expect(mock().tables.mortgage_payments).toMatchObject([{
      id: 'legacy-contribution:deposit-a', created_at: CREATED, loan_part_id: null,
      kind: 'down_payment', paid_by: 'a', amount: 200_000, is_insats: true,
      source: 'legacy-contribution:deposit-a',
    }])
    expect(mock().tables.mortgage_contributions || []).toHaveLength(0)
    expect(cache()).toMatchObject({ contributions: [], payments: [{ id: 'legacy-contribution:deposit-a' }] })
  })
})

describe('canonical legacy contribution envelopes', () => {
  beforeEach(() => { mem.set(IMPORT_FLAG, '1') })

  const legacyContribution = (over: Record<string, unknown> = {}) => ({
    id: 'deposit-a', created_at: CREATED, owner: 'a', date: '2024-01-01', amount: 200_000, note: 'Kontantinsats', ...over,
  })
  const canonicalDeposit = () => ({
    id: 'legacy-contribution:deposit-a', created_at: CREATED, loan_part_id: null, date: '2024-01-01',
    kind: 'down_payment', description: 'Kontantinsats', amount: 200_000, balance_after: null,
    paid_by: 'a', source: 'legacy-contribution:deposit-a', is_insats: true, paid_split: null,
  })

  it('canonicalizes cache rows once and discards malformed legacy financial rows', () => {
    mem.set(CACHE_KEY, JSON.stringify({
      version: 4, banks: [], mortgages: [], loan_parts: [], payments: [canonicalDeposit()], valuations: [], rate_periods: [],
      contributions: [legacyContribution(), legacyContribution({ id: 'zero', amount: 0 }), legacyContribution({ id: 'ownerless', owner: undefined })], settings: {},
    }))
    expect(store.cachedSnapshot()).toMatchObject({
      version: 6, contributions: [], payments: [{ id: 'legacy-contribution:deposit-a' }],
    })
  })

  it('dedupes a migrated cloud row against the same legacy cached contribution', async () => {
    mem.set(CACHE_KEY, JSON.stringify({
      version: 4, banks: [], mortgages: [], loan_parts: [], payments: [], valuations: [], rate_periods: [],
      contributions: [legacyContribution()], settings: {},
    }))
    mock().tables.mortgage_payments = [canonicalDeposit()]
    expect(await store.listPayments()).toMatchObject([{ id: 'legacy-contribution:deposit-a' }])
    expect((cache().payments as Payment[])).toHaveLength(1)
    expect(cache().contributions).toEqual([])
  })

  it('imports a legacy backup once as a canonical payment and accepts reruns', async () => {
    const backup = JSON.stringify({ version: 4, contributions: [legacyContribution()], settings: {} })
    await expect(store.importJSON(backup)).resolves.toMatchObject({ payments: 1, contributions: 0 })
    await expect(store.importJSON(backup)).resolves.toMatchObject({ payments: 0, contributions: 0 })
    expect(mock().tables.mortgage_payments).toMatchObject([{ id: 'legacy-contribution:deposit-a', kind: 'down_payment' }])
    expect(mock().tables.mortgage_contributions || []).toHaveLength(0)
  })

  it('does not duplicate a backup that already contains the canonical payment', async () => {
    const backup = JSON.stringify({ version: 5, payments: [canonicalDeposit()], contributions: [legacyContribution()], settings: {} })
    await expect(store.importJSON(backup)).resolves.toMatchObject({ payments: 1, contributions: 0 })
    expect(mock().tables.mortgage_payments).toHaveLength(1)
  })

  it('does not invent payments for zero or missing-owner legacy rows', async () => {
    const backup = JSON.stringify({
      version: 4,
      contributions: [legacyContribution({ id: 'zero', amount: 0 }), legacyContribution({ id: 'ownerless', owner: undefined })],
      settings: {},
    })
    await expect(store.importJSON(backup)).resolves.toMatchObject({ payments: 0, contributions: 0 })
    expect(mock().tables.mortgage_payments || []).toHaveLength(0)
  })

  it('exports canonical payments once and leaves the retired contribution slice empty', async () => {
    mock().tables.mortgage_payments = [canonicalDeposit()]
    const backup = JSON.parse(await store.exportJSON()) as { version: number; payments: Payment[]; contributions: unknown[] }
    expect(backup.version).toBe(6)
    expect(backup.payments).toMatchObject([{ id: 'legacy-contribution:deposit-a', kind: 'down_payment' }])
    expect(backup.contributions).toEqual([])
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
    mock().tables.mortgage_banks = [bankRow('b1')]
    mock().tables.mortgages = [{ id: 'm1', created_at: CREATED, bank_id: 'b1', label: 'Bolån', start_date: null, archived: false }]
    expect(await store.listBanks()).toHaveLength(1)
    expect(await store.listMortgages()).toHaveLength(1)
    expect((cache().banks as unknown[])).toHaveLength(1)

    mock().control.failing.add('mortgage_banks')
    // Cache still holds the written-through row → fallback returns it.
    expect(await store.listBanks()).toHaveLength(1)
  })

  it('updateLoanPart: patches mortgage_id + original anchor on the part', async () => {
    mock().tables.mortgage_loan_parts = [loanPart('p1', { loan_number: '', start_balance: 1000000, start_date: '2020-01-01', revision: 1 })]
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
    mock().tables.mortgage_banks = [bankRow('b1', { revision: 1 })]
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
    mock().tables.mortgage_banks = [bankRow('b1', { year_basis: 360, year_basis_source: 'declared', revision: 1 })]
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
    mock().tables.mortgage_banks = [{ id: 'b1', created_at: '2026-07-15T10:00:00.000Z', label: 'Danske', billing: 'month-end', billing_source: 'declared', revision: 1 }]
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
    mock().tables.mortgage_banks = [bankRow('b1')]
    const [bank] = await store.listBanks()
    expect(bank.label).toBe('Danske')
    expect(bank.year_basis).toBeNull()
    expect(bank.year_basis_source).toBeNull()
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

describe('import validation boundary', () => {
  it('rejects a malformed backup before mutating Supabase', async () => {
    await expect(store.importJSON(JSON.stringify({ version: 4, loan_parts: [{ id: 'bad', created_at: CREATED, label: 'x', loan_number: '', start_balance: Number.NaN }] }))).rejects.toThrow()
    expect(mock().tables.mortgage_loan_parts || []).toHaveLength(0)
  })
})

// ── Plan 109a ────────────────────────────────────────────────────────────────

describe('down payment agreement provenance (plan 109a)', () => {
  beforeEach(() => { mem.set(IMPORT_FLAG, '1') })

  const downPayment = (over: Record<string, unknown> = {}) => ({
    loan_part_id: null, date: '2024-02-01', kind: 'down_payment' as const, description: 'Kontantinsats',
    amount: 250_000, balance_after: null, paid_by: 'a' as const, source: 'manual', is_insats: true, ...over,
  })

  it('addPayment attaches the ACTIVE agreement id to a new down payment', async () => {
    mock().tables.mortgages = [
      mortgageRow('m-old', { archived: true, end_date: '2023-12-31', start_date: '2020-01-01' }),
      mortgageRow('m-active', { start_date: '2024-01-01' }),
    ]
    const saved = await store.addPayment(downPayment() as Omit<Payment, 'id' | 'created_at'>)
    expect(saved.mortgage_id).toBe('m-active')
    expect(mock().tables.mortgage_payments[0]).toMatchObject({ id: saved.id, mortgage_id: 'm-active' })
    expect((cache().payments as Payment[])[0].mortgage_id).toBe('m-active')
  })

  it('addPayment respects an explicitly supplied mortgage_id', async () => {
    mock().tables.mortgages = [mortgageRow('m-active')]
    const saved = await store.addPayment(downPayment({ mortgage_id: 'm-chosen' }) as Omit<Payment, 'id' | 'created_at'>)
    expect(saved.mortgage_id).toBe('m-chosen')
    expect(mock().tables.mortgage_payments[0].mortgage_id).toBe('m-chosen')
  })

  it('addContribution carries the active agreement id', async () => {
    mock().tables.mortgages = [mortgageRow('m1')]
    await store.addContribution({ owner: 'a', date: '2024-01-01', amount: 100_000, note: 'Insats' })
    expect(mock().tables.mortgage_payments[0]).toMatchObject({ kind: 'down_payment', mortgage_id: 'm1' })
  })

  it('zero agreements: down payment save rejects with a clear error and queues nothing', async () => {
    await expect(store.addPayment(downPayment() as Omit<Payment, 'id' | 'created_at'>))
      .rejects.toMatchObject({ category: 'validation', message: expect.stringContaining('bolåneavtal') })
    expect(mock().tables.mortgage_payments || []).toHaveLength(0)
    expect((cache().payments as unknown[] | undefined) ?? []).toHaveLength(0)
    expect(sync.syncCoordinator.getOutbox()).toEqual([])
  })

  it('an archived-only agreement set is treated as zero active agreements', async () => {
    mock().tables.mortgages = [mortgageRow('m-old', { archived: true, end_date: '2023-12-31' })]
    await expect(store.addPayment(downPayment() as Omit<Payment, 'id' | 'created_at'>))
      .rejects.toMatchObject({ category: 'validation' })
    expect(mock().tables.mortgage_payments || []).toHaveLength(0)
  })

  it('a part-linked payment sends explicit-null provenance so the database derives it', async () => {
    const saved = await store.addPayment({
      loan_part_id: 'p1', date: '2024-02-01', kind: 'amortization', description: '', amount: 1000,
      balance_after: null, paid_by: 'joint', source: '', mortgage_id: 'stale-agreement',
    } as Omit<Payment, 'id' | 'created_at'>)
    const row = mock().tables.mortgage_payments.find((r) => r.id === saved.id)!
    expect(row).toHaveProperty('mortgage_id', null)
  })

  it('a legacy null-provenance down payment stays editable without inventing an assignment', async () => {
    mock().tables.mortgage_payments = [mortgagePayment('legacy-dp', null, { kind: 'down_payment', is_insats: true, amount: 100_000, mortgage_id: null, revision: 1 })]
    await store.listPayments()
    const updated = await store.updatePayment('legacy-dp', { amount: 120_000 })
    expect(updated?.amount).toBe(120_000)
    expect(mock().tables.mortgage_payments[0]).toMatchObject({ amount: 120_000, mortgage_id: null })
  })

  it('the mock enforces the trigger: a partless non-legacy down payment insert without mortgage_id fails', async () => {
    const { data, error } = await mock().supabase.rpc('sync_apply_rows', {
      p_operation_id: 'op-guard', p_resource: 'mortgage_payments',
      p_rows: [mortgagePayment('dp-1', null, { kind: 'down_payment' })],
      p_expected_revisions: { 'mortgage_payments:dp-1': null },
    }) as { data: unknown; error: { message?: string; code?: string } | null }
    expect(data).toBeNull()
    expect(error).toMatchObject({ code: '22023', message: 'down payment requires a mortgage agreement' })
  })
})

describe('bank change and revert (plan 109a)', () => {
  beforeEach(() => { mem.set(IMPORT_FLAG, '1') })

  async function seedActiveAgreement() {
    mock().tables.mortgage_banks = [bankRow('b1'), bankRow('b2', { label: 'Nordea' })]
    mock().tables.mortgages = [mortgageRow('m1', { start_date: '2024-01-01' })]
    mock().tables.mortgage_loan_parts = [loanPart('p1', { mortgage_id: 'm1', revision: 1 })]
    // Register server revisions through the sync layer, like the app does.
    await Promise.all([store.listBanks(), store.listMortgages(), store.listLoanParts()])
  }

  const changeInput = () => ({
    old_mortgage_id: 'm1', bank_id: 'b2', label: 'Nordea bolån',
    parts: [{ label: 'Del 1', balance: 1_000_000, planned_amortization: 3000 }, { label: 'Del 2', balance: 500_000 }],
    effective_date: '2026-08-01',
  })

  it('success: archives the old agreement, creates the new one with clean origination anchors, patches cache and revisions', async () => {
    await seedActiveAgreement()
    const { mortgage, parts } = await store.changeMortgageBank(changeInput())

    const cloudOld = mock().tables.mortgages.find((row) => row.id === 'm1')!
    const cloudNew = mock().tables.mortgages.find((row) => row.id === mortgage.id)!
    expect(cloudOld).toMatchObject({ archived: true, end_date: '2026-08-01' })
    expect(cloudNew).toMatchObject({ bank_id: 'b2', label: 'Nordea bolån', start_date: '2026-08-01', archived: false, end_date: null })
    const newParts = mock().tables.mortgage_loan_parts.filter((row) => row.mortgage_id === mortgage.id)
    expect(newParts).toHaveLength(2)
    expect(newParts.find((row) => row.label === 'Del 1')).toMatchObject({
      loan_number: '', start_balance: 1_000_000, start_date: '2026-08-01',
      original_balance: 1_000_000, original_date: '2026-08-01',
      planned_amortization: 3000, planned_amortization_start: '2026-08-01', planned_amortization_end: null,
    })
    expect(parts.map((part) => part.id).sort()).toEqual(newParts.map((row) => String(row.id)).sort())
    // Old part is untouched — history stays with the old agreement.
    expect(mock().tables.mortgage_loan_parts.find((row) => row.id === 'p1')).toMatchObject({ mortgage_id: 'm1' })
    expect(cache()).toMatchObject({ mortgages: [{ id: 'm1', archived: true, end_date: '2026-08-01' }, { id: mortgage.id, archived: false }] })
    expect(sync.syncCoordinator.isDirty('mortgage-bank-change')).toBe(false)
    // Acknowledged revisions are recorded for later optimistic writes.
    expect(sync.syncCoordinator.getRevision(`mortgages:${mortgage.id}`)).toBe(1)
    expect(sync.syncCoordinator.getRevision('mortgages:m1')).toBe(2)
  })

  it('failure: keeps the optimistic state dirty, reads fall back to cache, replay applies exactly once', async () => {
    await seedActiveAgreement()
    mock().control.failing.add('sync_change_mortgage_bank')
    await expect(store.changeMortgageBank(changeInput())).rejects.toBeTruthy()

    // Cache/cloud disagreement: cloud still has the pre-change state…
    expect(mock().tables.mortgages).toHaveLength(1)
    // …but reads must serve the queued optimistic state, not overwrite it.
    expect(sync.syncCoordinator.isDirty('mortgage-bank-change')).toBe(true)
    const mortgages = await store.listMortgages()
    expect(mortgages).toHaveLength(2)
    expect(mortgages.find((row) => row.id === 'm1')).toMatchObject({ archived: true, end_date: '2026-08-01' })
    expect(await store.listLoanParts()).toHaveLength(3)

    mock().control.failing.delete('sync_change_mortgage_bank')
    await sync.syncCoordinator.replay()
    expect(sync.syncCoordinator.isDirty('mortgage-bank-change')).toBe(false)
    expect(mock().tables.mortgages).toHaveLength(2)
    expect(mock().tables.mortgage_loan_parts).toHaveLength(3)
  })

  it('lost response: the receipt makes the immediate retry a read — no duplicate agreements', async () => {
    await seedActiveAgreement()
    mock().control.lostResponseOnce.add('sync_change_mortgage_bank')
    const { mortgage } = await store.changeMortgageBank(changeInput())
    expect(mock().tables.mortgages.filter((row) => row.id === mortgage.id)).toHaveLength(1)
    expect(mock().tables.mortgages).toHaveLength(2)
    expect(mock().tables.mortgage_loan_parts).toHaveLength(3)
    expect(sync.syncCoordinator.isDirty('mortgage-bank-change')).toBe(false)
  })

  it('idempotent replay under a NEW operation id returns the created payload as success', async () => {
    await seedActiveAgreement()
    const rpcArgs = {
      p_old_mortgage_id: 'm1', p_expected_old_revision: 1,
      p_new_mortgage: { id: 'm-new', label: 'Nordea bolån', bank_id: 'b2' },
      p_new_parts: [{ id: 'p-new', label: 'Del 1', balance: 1_000_000 }],
      p_effective_date: '2026-08-01',
    }
    const first = await mock().supabase.rpc('sync_change_mortgage_bank', { p_operation_id: 'op-1', ...rpcArgs }) as { data: { status: string } }
    expect(first.data).toMatchObject({ status: 'applied' })
    const replay = await mock().supabase.rpc('sync_change_mortgage_bank', { p_operation_id: 'op-2', ...rpcArgs }) as { data: { status: string; mortgage: { id: string } }; error: unknown }
    expect(replay.error).toBeNull()
    expect(replay.data).toMatchObject({ status: 'applied', mortgage: { id: 'm-new' } })
    expect(mock().tables.mortgages.filter((row) => row.id === 'm-new')).toHaveLength(1)
    expect(mock().tables.mortgage_loan_parts.filter((row) => row.mortgage_id === 'm-new')).toHaveLength(1)
    // A replay whose payload does NOT match what was created is refused loudly.
    const mismatch = await mock().supabase.rpc('sync_change_mortgage_bank', { p_operation_id: 'op-3', ...rpcArgs, p_effective_date: '2026-09-01' }) as { error: { message?: string; code?: string } | null }
    expect(mismatch.error).toMatchObject({ code: '22023', message: 'bank change replay mismatch' })
  })

  it('conflict: no throw from the RPC, the operation keeps the current server revisions, keepConflict retries onto them', async () => {
    await seedActiveAgreement()
    // Another device bumped the agreement after our last read.
    mock().tables.mortgages[0].revision = 5
    await expect(store.changeMortgageBank(changeInput())).rejects.toMatchObject({ category: 'conflict' })
    expect(mock().tables.mortgages[0]).toMatchObject({ archived: false }) // nothing applied
    const conflicts = sync.syncCoordinator.getConflicts()
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].conflictRevisions).toEqual({ 'mortgages:m1': 5 })

    await sync.syncCoordinator.keepConflict(conflicts[0].id)
    expect(sync.syncCoordinator.getConflicts()).toEqual([])
    expect(mock().tables.mortgages.find((row) => row.id === 'm1')).toMatchObject({ archived: true, end_date: '2026-08-01' })
    expect(mock().tables.mortgages).toHaveLength(2)
  })

  it('validation refusal (unknown bank) fails permanently with the SQL error category', async () => {
    await seedActiveAgreement()
    await expect(store.changeMortgageBank({ ...changeInput(), bank_id: 'not-a-bank' }))
      .rejects.toMatchObject({ category: 'validation' })
    expect(mock().tables.mortgages).toHaveLength(1)
    expect(sync.syncCoordinator.getOutbox()).toMatchObject([{ resource: 'mortgage-bank-change', state: 'failed' }])
  })

  it('revert: deletes the pristine new agreement, reactivates the predecessor, clears revisions', async () => {
    await seedActiveAgreement()
    const { mortgage } = await store.changeMortgageBank(changeInput())
    await store.revertMortgageBankChange(mortgage.id)

    expect(mock().tables.mortgages).toHaveLength(1)
    expect(mock().tables.mortgages[0]).toMatchObject({ id: 'm1', archived: false, end_date: null })
    expect(mock().tables.mortgage_loan_parts.map((row) => row.id)).toEqual(['p1'])
    expect(cache()).toMatchObject({ mortgages: [{ id: 'm1', archived: false, end_date: null }] })
    expect((cache().loan_parts as LoanPart[]).map((row) => row.id)).toEqual(['p1'])
    expect(sync.syncCoordinator.getRevision(`mortgages:${mortgage.id}`)).toBeNull()
    expect(sync.syncCoordinator.isDirty('mortgage-bank-change-revert')).toBe(false)
  })

  it('revert refuses once any transaction references the new agreement or its parts', async () => {
    await seedActiveAgreement()
    const { mortgage, parts } = await store.changeMortgageBank(changeInput())
    await store.addPayment({
      loan_part_id: parts[0].id, date: '2026-08-15', kind: 'amortization', description: '',
      amount: 3000, balance_after: null, paid_by: 'joint', source: '',
    })
    await expect(store.revertMortgageBankChange(mortgage.id)).rejects.toMatchObject({ category: 'validation' })
    // Nothing was deleted or reactivated — partial reverts are impossible.
    expect(mock().tables.mortgages).toHaveLength(2)
    expect(mock().tables.mortgages.find((row) => row.id === 'm1')).toMatchObject({ archived: true })
    expect(mock().tables.mortgage_loan_parts.filter((row) => row.mortgage_id === mortgage.id)).toHaveLength(2)
  })

  it('revert conflict: a stale revision map returns the current revisions without deleting anything', async () => {
    await seedActiveAgreement()
    const { mortgage } = await store.changeMortgageBank(changeInput())
    // Another device edited the new agreement after our last read.
    mock().tables.mortgages.find((row) => row.id === mortgage.id)!.revision = 9
    await expect(store.revertMortgageBankChange(mortgage.id)).rejects.toMatchObject({ category: 'conflict' })
    expect(mock().tables.mortgages).toHaveLength(2)
    const conflicts = sync.syncCoordinator.getConflicts()
    expect(conflicts[0].conflictRevisions).toMatchObject({ [`mortgages:${mortgage.id}`]: 9 })
  })
})

describe('109a envelope compatibility and round-trips', () => {
  beforeEach(() => { mem.set(IMPORT_FLAG, '1') })

  it('an old v4 cache envelope without the 109a fields still loads', () => {
    mem.set(CACHE_KEY, JSON.stringify({
      version: 4,
      banks: [bankRow('b1')],
      mortgages: [{ id: 'm1', created_at: CREATED, bank_id: 'b1', label: 'Bolån', start_date: '2024-01-01', archived: false }],
      loan_parts: [loanPart('p1')],
      payments: [mortgagePayment('pay1', 'p1')],
      valuations: [], rate_periods: [], contributions: [], settings: {},
    }))
    const snapshot = store.cachedSnapshot()
    expect(snapshot.version).toBe(6)
    expect(snapshot.banks).toMatchObject([{ id: 'b1' }])
    expect(snapshot.mortgages).toMatchObject([{ id: 'm1' }])
    expect(snapshot.payments).toMatchObject([{ id: 'pay1' }])
  })

  it('the new fields survive cloud → cache → export', async () => {
    mock().tables.mortgage_banks = [bankRow('b1', { catalog_id: 'catalog-danske' })]
    mock().tables.mortgages = [
      mortgageRow('m-old', { archived: true, end_date: '2026-07-31', start_date: '2020-01-01' }),
      mortgageRow('m1', { start_date: '2026-08-01' }),
    ]
    mock().tables.mortgage_payments = [mortgagePayment('dp1', null, { kind: 'down_payment', is_insats: true, mortgage_id: 'm1' })]

    expect((await store.listBanks())[0].catalog_id).toBe('catalog-danske')
    expect((await store.listMortgages()).find((row) => row.id === 'm-old')?.end_date).toBe('2026-07-31')
    expect((await store.listPayments())[0].mortgage_id).toBe('m1')
    expect((cache().banks as Bank[])[0].catalog_id).toBe('catalog-danske')

    const backup = JSON.parse(await store.exportJSON()) as { banks: Bank[]; mortgages: Mortgage[]; payments: Payment[] }
    expect(backup.banks[0].catalog_id).toBe('catalog-danske')
    expect(backup.mortgages.find((row) => row.id === 'm-old')?.end_date).toBe('2026-07-31')
    expect(backup.payments[0].mortgage_id).toBe('m1')
  })

  it('imports a backup carrying the new fields and retains every historical row exactly once on rerun', async () => {
    const backup = JSON.stringify({
      version: 6,
      banks: [bankRow('b1', { catalog_id: 'catalog-danske', year_basis: null, year_basis_source: null, billing: null, billing_source: null })],
      mortgages: [
        mortgageRow('m-old', { archived: true, end_date: '2026-07-31', start_date: '2020-01-01', revision: undefined }),
        mortgageRow('m1', { start_date: '2026-08-01', revision: undefined }),
      ],
      loan_parts: [loanPart('p1', { mortgage_id: 'm1' })],
      payments: [
        mortgagePayment('pay1', 'p1', { kind: 'amortization', amount: 1000 }),
        mortgagePayment('dp1', null, { kind: 'down_payment', is_insats: true, amount: 100_000, mortgage_id: 'm1' }),
      ],
      valuations: [], rate_periods: [], contributions: [], settings: {},
    })
    await expect(store.importJSON(backup)).resolves.toMatchObject({ loan_parts: 1, payments: 2 })
    expect(mock().tables.mortgage_banks[0]).toMatchObject({ catalog_id: 'catalog-danske' })
    expect(mock().tables.mortgages.find((row) => row.id === 'm-old')).toMatchObject({ archived: true, end_date: '2026-07-31' })
    expect(mock().tables.mortgage_payments.find((row) => row.id === 'dp1')).toMatchObject({ mortgage_id: 'm1' })
    // Part-linked provenance is re-derived by the database, never client-asserted.
    expect(mock().tables.mortgage_payments.find((row) => row.id === 'pay1')).toHaveProperty('mortgage_id', null)

    // Re-running the same import adds nothing and duplicates nothing.
    await expect(store.importJSON(backup)).resolves.toMatchObject({ loan_parts: 0, payments: 0 })
    expect(mock().tables.mortgages).toHaveLength(2)
    expect(mock().tables.mortgage_payments).toHaveLength(2)
    expect(mock().tables.mortgage_loan_parts).toHaveLength(1)
  })

  it('imports an OLD backup without the new fields (defensive nullable migration)', async () => {
    const backup = JSON.stringify({
      version: 5,
      banks: [{ id: 'b1', created_at: CREATED, label: 'Danske' }],
      mortgages: [{ id: 'm1', created_at: CREATED, bank_id: 'b1', label: 'Bolån', start_date: '2024-01-01', archived: false }],
      loan_parts: [loanPart('p1', { mortgage_id: 'm1' })],
      payments: [mortgagePayment('pay1', 'p1', { kind: 'interest', amount: 900 })],
      valuations: [], rate_periods: [], contributions: [], settings: {},
    })
    await expect(store.importJSON(backup)).resolves.toMatchObject({ loan_parts: 1, payments: 1 })
    expect(mock().tables.mortgages).toHaveLength(1)
    expect(mock().tables.mortgage_payments).toHaveLength(1)
  })
})
