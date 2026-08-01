// @vitest-environment jsdom
// Plan 126 §7 — the Bolånekoll → Hushållsbudget sync, at the component level.
//
// Merely OPENING this page persists the budget, so the sync is a data-mutation
// path: getting it wrong writes a wrong financial figure with no user action at
// all. AGENTS.md ("Writes, failures, and cache/cloud disagreement") therefore
// requires more than a pure-function test. These specs assert on the actual
// saveBudget calls and on what the user sees:
//
//   ok                   → saves TODAY's figures, never a future period's.
//   empty                → saves the removal of obsolete synced rows.
//   missing-current-rate → saves NOTHING, keeps the previous rows, and warns.
//   load failure         → saves NOTHING, keeps the previous rows, no warning
//                          (unchanged behaviour).
//
// The pure arithmetic is pinned in lib/mortgage-whatif.test.ts; the mock
// boundary here is hushallsbudget-store + mortgage-store.
import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultState, money } from '../lib/hushallsbudget'
import type { BudgetState, Row } from '../lib/hushallsbudget'
import type { LoanPart, Payment, RatePeriod } from '../lib/mortgage'
import * as budgetStore from '../lib/hushallsbudget-store'
import * as mortgageStore from '../lib/mortgage-store'
import * as salaryStore from '../lib/salary-store'
import { usePersonIdentity } from '../components/usePersonIdentity'
import type { PersonIdentityView } from '../components/usePersonIdentity'
import Hushallsbudget from './Hushallsbudget'

const TODAY = '2026-03-15'

vi.mock('../lib/hushallsbudget-store')
vi.mock('../lib/mortgage-store')
vi.mock('../lib/salary-store')
vi.mock('../components/usePersonIdentity')
// visx charts need a real ResizeObserver (absent in jsdom) — stub the donut.
vi.mock('../components/charts/BudgetDonutChart', () => ({ default: () => null }))
// NumberFlow's getSnapshotBeforeUpdate needs browser layout APIs jsdom lacks,
// and a synced budget re-renders every summary figure. Swap the animated
// numbers for plain spans — these specs assert persistence, not animation.
vi.mock('../components/AnimatedNumber', () => ({
  Money: ({ value }: { value: number }) => <span>{Math.round(value)}</span>,
  Percent: ({ value }: { value: number }) => <span>{value}</span>,
  Num: ({ value }: { value: number }) => <span>{value}</span>,
  MoneyCompact: ({ value }: { value: number }) => <span>{Math.round(value)}</span>,
}))
// Freeze the clock the page captures, so "today's rate" is a fixed assertion
// rather than whatever day CI happens to run on.
vi.mock('../lib/date', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/date')>(),
  todayISO: () => TODAY,
}))

// ── Fixture ledger ──────────────────────────────────────────────────────────
// One 3 000 000 kr part, saldo 3 003 000 (2026-01-31) → 3 000 000 (2026-02-28).
// Amortering reads 3 000 kr/mån off that timeline.
const PART: LoanPart = {
  id: 'part-1', created_at: '', label: 'Lånedel 1', loan_number: '1',
  start_balance: 3_003_000, start_date: '2026-01-01', archived: false,
}
function amortRow(id: string, date: string, balance_after: number): Payment {
  return {
    id, created_at: '', loan_part_id: 'part-1', date, kind: 'amortization',
    description: 'Amortering', amount: 3_000, balance_after, paid_by: 'joint', source: '',
  }
}
const LEDGER = [amortRow('pay-1', '2026-01-31', 3_003_000), amortRow('pay-2', '2026-02-28', 3_000_000)]

function ratePeriod(over: Partial<RatePeriod> = {}): RatePeriod {
  return {
    id: 'rate-1', created_at: '', loan_part_id: 'part-1',
    start_date: '2026-01-01', end_date: null, rate: 3.42, rate_type: 'rörlig', ...over,
  }
}
// The reported defect: a successor beginning TOMORROW must not price today.
// Today 3,42 % → 8 550 kr/mån; the successor's 5,00 % would read 12 500 kr/mån.
const CURRENT_THEN_FUTURE = [
  ratePeriod({ id: 'now', start_date: '2026-01-01', end_date: TODAY, rate: 3.42 }),
  ratePeriod({ id: 'next', start_date: '2026-03-16', end_date: null, rate: 5 }),
]
// Only a period starting tomorrow: nothing covers today.
const FUTURE_ONLY = [ratePeriod({ id: 'next', start_date: '2026-03-16', end_date: null, rate: 5 })]

// Previously synced rows already in the persisted budget, carrying stale
// figures. These are what "retained" means in the no-write specs.
const RETAINED: Row[] = [
  { id: 'r-bolan-ranta', label: 'Bolån — ränta', amount: 9_125, owner: 'joint', source: 'bolanekoll' },
  { id: 'r-bolan-amort', label: 'Bolån — amortering', amount: 2_500, owner: 'joint', source: 'bolanekoll' },
]

function budgetWith(bolanRows: Row[]): BudgetState {
  const base = defaultState()
  return { ...base, costs: [...bolanRows, ...base.costs.filter((row) => row.source !== 'bolanekoll')] }
}

const IDENTITY: PersonIdentityView = {
  status: 'ready', identity: null, configured: false, people: [], myPerson: null,
  personFor: () => null, isMe: () => false, myToolSlot: () => null, refresh: async () => {},
}

function renderRoute() {
  const router = createMemoryRouter([
    { path: '/hushallsbudget', element: <Hushallsbudget /> },
    { path: '/', element: <div>Home</div> },
  ], { initialEntries: ['/hushallsbudget'] })
  return render(<RouterProvider router={router} />)
}

// The save is debounced by 250 ms. Give it comfortably longer than that before
// concluding "nothing was written" — otherwise the assertion would pass simply
// by running early.
async function settleBeyondSaveDebounce() {
  await new Promise((resolve) => setTimeout(resolve, 500))
}

function bolanRowsInLastSave(): Row[] {
  const calls = vi.mocked(budgetStore.saveBudget).mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return (calls.at(-1)![0] as BudgetState).costs.filter((row) => row.source === 'bolanekoll')
}

// The synced rows as the user reads them: label + amount, inside the Bolån card.
function renderedBolanRows(): Array<[string, string]> {
  return Array.from(document.querySelectorAll('.bolan-row')).map((row) => [
    row.querySelector('.b-label-static')!.textContent!,
    row.querySelector('.b-amount-static')!.textContent!,
  ])
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(usePersonIdentity).mockReturnValue(IDENTITY)
  vi.mocked(salaryStore.list).mockResolvedValue([])
  vi.mocked(budgetStore.saveBudget).mockResolvedValue(undefined)
  vi.mocked(budgetStore.loadBudget).mockResolvedValue(budgetWith(RETAINED))
  vi.mocked(mortgageStore.loadMortgageSyncSnapshot).mockResolvedValue({
    parts: [PART], periods: CURRENT_THEN_FUTURE, payments: LEDGER,
  })
})

describe('Hushållsbudget — dated Bolånekoll sync', () => {
  it('ok: persists TODAY’s rate, not the period starting tomorrow', async () => {
    renderRoute()
    // 3 000 000 × 3,42 % / 12 = 8 550 kr/mån. The successor's 5,00 % would be
    // 12 500 kr/mån — the figure the undated lookup used to write.
    await waitFor(() => expect(bolanRowsInLastSave()).toEqual([
      { id: 'r-bolan-ranta', label: 'Bolån — ränta', amount: 8_550, owner: 'joint', source: 'bolanekoll' },
      { id: 'r-bolan-amort', label: 'Bolån — amortering', amount: 3_000, owner: 'joint', source: 'bolanekoll' },
    ]))
    expect(renderedBolanRows()).toEqual([
      ['Bolån — ränta', money(8_550)],
      ['Bolån — amortering', money(3_000)],
    ])
    expect(screen.queryByText(/Bolånesiffrorna kunde inte uppdateras/)).not.toBeInTheDocument()
  })

  it('empty: a settled mortgage removes the obsolete synced rows', async () => {
    // No positive balance anywhere → nothing to sync. This is the control that
    // proves the harness DOES observe a write when one is meant to happen.
    vi.mocked(mortgageStore.loadMortgageSyncSnapshot).mockResolvedValue({
      parts: [PART], periods: CURRENT_THEN_FUTURE,
      payments: [...LEDGER, amortRow('pay-3', '2026-03-01', 0)],
    })
    renderRoute()
    await waitFor(() => expect(bolanRowsInLastSave()).toEqual([]))
    expect(renderedBolanRows()).toEqual([])
  })

  it('missing-current-rate: writes nothing, keeps the previous rows, and warns', async () => {
    vi.mocked(mortgageStore.loadMortgageSyncSnapshot).mockResolvedValue({
      parts: [PART], periods: FUTURE_ONLY, payments: LEDGER,
    })
    renderRoute()

    // The user is told, in Swedish, that the figures below are the old ones.
    const warning = await screen.findByText(/Bolånesiffrorna kunde inte uppdateras/)
    const banner = warning.closest('.bolan-warn') as HTMLElement
    expect(banner).not.toBeNull()
    expect(banner.getAttribute('role')).toBe('status')
    expect(banner.textContent).toContain('En lånedel saknar räntevillkor för idag')
    expect(banner.textContent).toContain('tidigare värden behålls')

    // The retained rows are still on screen with their previous amounts…
    expect(renderedBolanRows()).toEqual([
      ['Bolån — ränta', money(9_125)],
      ['Bolån — amortering', money(2_500)],
    ])
    // …and nothing at all was persisted, even after the debounce window.
    await settleBeyondSaveDebounce()
    expect(budgetStore.saveBudget).not.toHaveBeenCalled()
  })

  it('missing-current-rate: names the count when several lånedelar are uncovered', async () => {
    const second: LoanPart = { ...PART, id: 'part-2', label: 'Lånedel 2' }
    vi.mocked(mortgageStore.loadMortgageSyncSnapshot).mockResolvedValue({
      parts: [PART, second], periods: FUTURE_ONLY, payments: LEDGER,
    })
    renderRoute()
    const warning = await screen.findByText(/Bolånesiffrorna kunde inte uppdateras/)
    expect(warning.closest('.bolan-warn')!.textContent).toContain('2 lånedelar saknar räntevillkor för idag')
    await settleBeyondSaveDebounce()
    expect(budgetStore.saveBudget).not.toHaveBeenCalled()
  })

  it('load failure: keeps the previous rows, writes nothing, shows no warning', async () => {
    // A failed live read is NOT evidence that the mortgage changed — unchanged
    // behaviour, asserted so the new no-write branch cannot swallow it.
    vi.mocked(mortgageStore.loadMortgageSyncSnapshot).mockRejectedValue(new Error('offline'))
    renderRoute()
    await waitFor(() => expect(renderedBolanRows()).toEqual([
      ['Bolån — ränta', money(9_125)],
      ['Bolån — amortering', money(2_500)],
    ]))
    expect(screen.queryByText(/Bolånesiffrorna kunde inte uppdateras/)).not.toBeInTheDocument()
    await settleBeyondSaveDebounce()
    expect(budgetStore.saveBudget).not.toHaveBeenCalled()
  })
})
