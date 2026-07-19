// @vitest-environment jsdom
// Plan 118 — Bostadskalkyl's "Hämta från Bolånekoll" pull. Drives the real
// route + store and asserts the AGENTS.md writes/failures gate for the two
// destinations (bound scenario vs scratch draft) plus the two do-not-overwrite
// guarantees (read failure and empty Bolånekoll data leave the field intact).
//
// The mock boundary is mortgage-store (loadMortgageBalanceSnapshot) and storage
// (the persistence adapter): this proves the component reacts to the store's
// result and routes the applied value through the existing setField/persist
// path — activeAgreementBalance itself stays REAL so the pulled number is the
// genuine authoritative balance, not a hand-fed constant.
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Bostadskalkyl from './Bostadskalkyl'
import { useStore } from '../store/useStore'
import { DEFAULT_INPUTS, DEFAULT_CONSTANTS } from '../lib/calc'
import * as MortgageStore from '../lib/mortgage-store'
import * as storage from '../lib/storage'
import type { Scenario } from '../lib/storage'
import type { LoanPart, Payment, Mortgage } from '../lib/mortgage'
import type { ActiveMortgageBalanceSnapshot } from '../lib/mortgage-store'

vi.mock('../lib/mortgage-store')
vi.mock('@number-flow/react', () => ({ default: ({ value }: { value: number }) => <span>{value}</span> }))

// Fully mock the persistence adapter so hydrate + auto-save run against
// controllable stubs (real storage would hit idb/localStorage jsdom lacks).
vi.mock('../lib/storage', () => ({
  runMigrations: vi.fn(),
  loadScenarios: vi.fn(async () => [] as Scenario[]),
  saveScenarios: vi.fn(async () => {}),
  deleteScenarios: vi.fn(async () => {}),
  loadDraft: vi.fn(async () => null),
  saveDraft: vi.fn(async () => {}),
  clearDraft: vi.fn(async () => {}),
  loadSession: vi.fn(async () => null),
  clearSession: vi.fn(async () => {}),
  loadDriftItems: vi.fn(async () => []),
  saveDriftItems: vi.fn(async () => {}),
  loadSavingsItems: vi.fn(async () => []),
  saveSavingsItems: vi.fn(async () => {}),
  loadDriftYearly: vi.fn(async () => false),
  saveDriftYearly: vi.fn(async () => {}),
  loadGlobalConstants: vi.fn(async () => null),
  saveGlobalConstants: vi.fn(async () => {}),
  loadDraftConstants: vi.fn(async () => null),
  saveDraftConstants: vi.fn(async () => {}),
  clearDraftConstants: vi.fn(async () => {}),
}))

// ── Snapshot fixtures (real activeAgreementBalance resolves the number) ───────
const mortgage = (over: Partial<Mortgage> = {}): Mortgage => ({ id: 'm1', created_at: '', bank_id: 'b1', label: 'Bolån', start_date: '2024-01-01', archived: false, end_date: null, ...over })
const part = (over: Partial<LoanPart> = {}): LoanPart => ({ id: 'p1', created_at: '', label: 'Del 1', loan_number: '', start_balance: 0, start_date: '2024-01-01', archived: false, mortgage_id: 'm1', original_balance: null, original_date: null, ...over })
const saldo = (loan_part_id: string, balance_after: number): Payment => ({ id: 's-' + loan_part_id, created_at: '', loan_part_id, date: '2026-05-31', kind: 'payment', description: '', amount: 0, balance_after, paid_by: 'joint', source: 'import' })

// One active agreement, one part with an explicit Saldo of 2 340 000 → the real
// selector resolves exactly 2 340 000.
const snapshotWithBalance = (): ActiveMortgageBalanceSnapshot => ({
  mortgages: [mortgage()],
  parts: [part()],
  payments: [saldo('p1', 2_340_000)],
})
const PULLED = 2_340_000
const emptySnapshot = (): ActiveMortgageBalanceSnapshot => ({ mortgages: [], parts: [], payments: [] })

function resetStore() {
  useStore.setState({
    inputs: DEFAULT_INPUTS,
    constants: DEFAULT_CONSTANTS,
    mode: 'draft',
    activeScenarioId: null,
    scenarios: [],
    draftInputs: null,
    draftConstants: null,
    hydrated: false,
    driftItems: [],
    savingsItems: [],
    driftYearly: false,
  })
}

function renderRoute(path: string) {
  const router = createMemoryRouter(
    [{ path: '/bostadskalkyl/:id', element: <Bostadskalkyl /> }, { path: '/bostadskalkyl/new', element: <Bostadskalkyl /> }, { path: '/bostadskalkyl', element: <Bostadskalkyl /> }],
    { initialEntries: [path] },
  )
  return render(<RouterProvider router={router} />)
}

const scenario = (over: Partial<Scenario> = {}): Scenario => ({
  id: 'sc1', name: 'Nuvarande bostad', savedAt: '2026-07-01T00:00:00.000Z',
  inputs: { ...DEFAULT_INPUTS, currentMortgage: 1_000_000 },
  constants: DEFAULT_CONSTANTS, ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  resetStore()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
})

describe('Bostadskalkyl — Hämta från Bolånekoll (plan 118)', () => {
  it('bound scenario: pull → Använd updates and PERSISTS the active scenario, creating none', async () => {
    vi.mocked(storage.loadScenarios).mockResolvedValue([scenario()])
    vi.mocked(MortgageStore.loadMortgageBalanceSnapshot).mockResolvedValue(snapshotWithBalance())
    const user = userEvent.setup()
    renderRoute('/bostadskalkyl/sc1')

    await screen.findByRole('button', { name: /Hämta från Bolånekoll/ })
    await user.click(screen.getByRole('button', { name: /Hämta från Bolånekoll/ }))
    // Preview appears with an explicit apply step — never auto-applied.
    const apply = await screen.findByRole('button', { name: /Använd/ })
    expect(useStore.getState().scenarios[0].inputs.currentMortgage).toBe(1_000_000) // still unchanged pre-apply

    await user.click(apply)
    await waitFor(() => expect(useStore.getState().scenarios[0].inputs.currentMortgage).toBe(PULLED))
    // Persisted through the existing setField path, no new scenario.
    expect(storage.saveScenarios).toHaveBeenCalled()
    const lastSaved = vi.mocked(storage.saveScenarios).mock.calls.at(-1)![0]
    expect(lastSaved).toHaveLength(1)
    expect(lastSaved[0].inputs.currentMortgage).toBe(PULLED)
    expect(useStore.getState().scenarios).toHaveLength(1)
  })

  it('/new draft: pull → Använd updates the scratch draft without creating a scenario', async () => {
    vi.mocked(storage.loadScenarios).mockResolvedValue([])
    vi.mocked(MortgageStore.loadMortgageBalanceSnapshot).mockResolvedValue(snapshotWithBalance())
    const user = userEvent.setup()
    renderRoute('/bostadskalkyl/new')

    await user.click(await screen.findByRole('button', { name: /Hämta från Bolånekoll/ }))
    await user.click(await screen.findByRole('button', { name: /Använd/ }))

    await waitFor(() => expect(useStore.getState().draftInputs?.currentMortgage).toBe(PULLED))
    expect(useStore.getState().inputs.currentMortgage).toBe(PULLED)
    expect(useStore.getState().scenarios).toHaveLength(0)
    expect(storage.saveDraft).toHaveBeenCalled()
    expect(storage.saveScenarios).not.toHaveBeenCalled()
  })

  it('unavailable source (snapshot null): shows a retryable error and leaves a manual value UNCHANGED', async () => {
    vi.mocked(storage.loadScenarios).mockResolvedValue([scenario()])
    vi.mocked(MortgageStore.loadMortgageBalanceSnapshot).mockResolvedValue(null)
    const user = userEvent.setup()
    renderRoute('/bostadskalkyl/sc1')

    await user.click(await screen.findByRole('button', { name: /Hämta från Bolånekoll/ }))
    await screen.findByText(/Kunde inte hämta/)
    expect(screen.queryByRole('button', { name: /^Använd/ })).toBeNull()
    expect(useStore.getState().scenarios[0].inputs.currentMortgage).toBe(1_000_000) // untouched
  })

  it('empty Bolånekoll (no active agreement): shows the empty note and leaves a manual value UNCHANGED', async () => {
    vi.mocked(storage.loadScenarios).mockResolvedValue([scenario()])
    vi.mocked(MortgageStore.loadMortgageBalanceSnapshot).mockResolvedValue(emptySnapshot())
    const user = userEvent.setup()
    renderRoute('/bostadskalkyl/sc1')

    await user.click(await screen.findByRole('button', { name: /Hämta från Bolånekoll/ }))
    await screen.findByText(/saknar aktuellt saldo/)
    expect(screen.queryByRole('button', { name: /^Använd/ })).toBeNull()
    expect(useStore.getState().scenarios[0].inputs.currentMortgage).toBe(1_000_000) // never overwritten with 0
  })
})
