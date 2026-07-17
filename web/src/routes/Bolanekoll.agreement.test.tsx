// @vitest-environment jsdom
// Plan 109c Stage 1 — the Bolåneavtal agreement card and the Bankprofil modal.
// Mirrors Bolanekoll.test.tsx's harness (auto-mocked store, vi.hoisted-free
// because the store is the mock boundary, jsdom + RTL). Covers the four
// requirements the plan calls out for this stage:
//   1. the card renders the agreement header with nested parts and NO inline
//      Bankår/Avisering controls;
//   2. the drift badge appears exactly when effectiveBankProfile().drift is
//      non-empty, and opens the profile modal;
//   3. profile-save FAILURE keeps the modal open and shows the error (the user
//      must see it — a throwing store is not enough);
//   4. profile-save SUCCESS persists the lock (updateBank gets source 'declared').
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Bolanekoll from './Bolanekoll'
import * as Store from '../lib/mortgage-store'
import { defaultSettings } from '../lib/mortgage'
import type { Bank, LoanPart, Mortgage, Payment, RatePeriod } from '../lib/mortgage'

vi.mock('../lib/mortgage-store')
vi.mock('../lib/hushallsbudget-store', () => ({ loadBudget: vi.fn(async () => null) }))
vi.mock('@number-flow/react', () => ({
  default: ({ value }: { value: number }) => <span>{value}</span>,
}))
vi.mock('../lib/riksbank', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/riksbank')>(),
  fetchPolicyRate: vi.fn().mockRejectedValue(new Error('no network in tests')),
}))

function renderBolanekoll() {
  const router = createMemoryRouter([{ path: '/', element: <Bolanekoll /> }], { initialEntries: ['/'] })
  return render(<RouterProvider router={router} />)
}

const bank: Bank = {
  id: 'b1', created_at: '2026-01-01', label: 'Danske',
  year_basis: null, year_basis_source: null, billing: null, billing_source: null, catalog_id: 'catalog-danske',
}
const agreement: Mortgage = {
  id: 'm1', created_at: '2026-01-01', bank_id: 'b1', label: 'Vårt bolån',
  start_date: '2024-03-01', archived: false, end_date: null,
}
const part: LoanPart = {
  id: 'p1', created_at: '2026-01-01', label: 'Rörlig del', loan_number: '9021',
  start_balance: 1_000_000, original_balance: 1_000_000, start_date: '2024-03-01', archived: false,
  mortgage_id: 'm1',
}

beforeEach(() => {
  vi.stubGlobal('confirm', vi.fn(() => true))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })

  vi.mocked(Store.cachedSnapshot).mockReturnValue({
    version: 6, banks: [bank], mortgages: [agreement],
    loan_parts: [part], payments: [], valuations: [], rate_periods: [], contributions: [],
    settings: defaultSettings(),
  })
  vi.mocked(Store.listLoanParts).mockResolvedValue([part])
  vi.mocked(Store.listPayments).mockResolvedValue([])
  vi.mocked(Store.listValuations).mockResolvedValue([])
  vi.mocked(Store.listRatePeriods).mockResolvedValue([])
  vi.mocked(Store.listContributions).mockResolvedValue([])
  vi.mocked(Store.getSettings).mockResolvedValue(defaultSettings())
  vi.mocked(Store.listBanks).mockResolvedValue([bank])
  vi.mocked(Store.listMortgages).mockResolvedValue([agreement])
  vi.mocked(Store.listCatalogBanks).mockResolvedValue([
    { id: 'catalog-danske', slug: 'danske', label: 'Danske', year_basis: null, billing: null },
  ])
})

describe('Bolanekoll — agreement card (plan 109c Stage 1)', () => {
  it('renders the Bolåneavtal header with the bank, relationship start and nested parts, and no inline Bankår/Avisering controls', async () => {
    renderBolanekoll()

    // The renamed section header.
    expect(await screen.findByRole('heading', { name: /Bolåneavtal/ })).toBeInTheDocument()
    // Agreement summary: name · bank · "hos banken sedan …" (never binding copy).
    const summary = screen.getByText('Vårt bolån').closest('.agreement-summary')!
    expect(within(summary as HTMLElement).getByText('Danske')).toBeInTheDocument()
    expect(within(summary as HTMLElement).getByText(/hos banken sedan 2024-03-01/)).toBeInTheDocument()
    expect(within(summary as HTMLElement).getByText('Aktivt')).toBeInTheDocument()
    // The nested part is still listed beneath the agreement.
    expect(screen.getAllByText('Rörlig del').length).toBeGreaterThan(0)

    // The inline convention controls are GONE from the page — they moved into the
    // Bankprofil modal. None of their buttons/labels remain on the card.
    expect(screen.queryByRole('button', { name: 'Lås faktisk/360' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Lås 365' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Månadsslut' })).not.toBeInTheDocument()
    // The agreement actions ARE present.
    expect(screen.getByRole('button', { name: 'Bankprofil' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Byt bank' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Tidigare avtal' })).toBeInTheDocument()
  })

  it('does NOT show the drift badge when the effective profile has no drift', async () => {
    renderBolanekoll()
    await screen.findByRole('heading', { name: /Bolåneavtal/ })
    expect(screen.queryByRole('button', { name: /Villkor avviker/ })).not.toBeInTheDocument()
  })

  it('shows the drift badge when detection contradicts a locked value, and opens the profile modal', async () => {
    const lockedBank: Bank = { ...bank, year_basis: 365, year_basis_source: 'declared' }
    const periods: RatePeriod[] = [
      { id: 'r1', created_at: '2026-01-01', loan_part_id: 'p1', start_date: '2024-03-01', end_date: '2025-02-28', rate: 3.0, rate_type: 'bunden' },
      { id: 'r2', created_at: '2026-01-01', loan_part_id: 'p1', start_date: '2025-03-01', end_date: '2026-02-28', rate: 3.0, rate_type: 'bunden' },
    ]
    const dates = ['2024-04-30', '2024-05-31', '2024-06-30', '2025-04-30', '2025-05-31', '2025-06-30']
    const payments: Payment[] = dates.map((d, i) => ({
      id: 'int' + i, created_at: d, loan_part_id: 'p1', date: d, kind: 'interest',
      description: 'Ränta', amount: 2500, balance_after: null, paid_by: 'joint', source: 'import', is_insats: false,
    }))
    vi.mocked(Store.cachedSnapshot).mockReturnValue({
      version: 6, banks: [lockedBank], mortgages: [agreement],
      loan_parts: [part], payments, valuations: [], rate_periods: periods, contributions: [],
      settings: defaultSettings(),
    })
    vi.mocked(Store.listBanks).mockResolvedValue([lockedBank])
    vi.mocked(Store.listPayments).mockResolvedValue(payments)
    vi.mocked(Store.listRatePeriods).mockResolvedValue(periods)
    const user = userEvent.setup()
    renderBolanekoll()

    const badge = await screen.findByRole('button', { name: /Villkor avviker/ })
    await user.click(badge)
    // The modal opens with the full drift explanation.
    const dialog = screen.getByRole('dialog', { name: 'Bankprofil' })
    expect(within(dialog).getByRole('heading', { name: /Bankprofil/ })).toBeInTheDocument()
    expect(within(dialog).getByText(/tyder tydligt på/)).toBeInTheDocument()
  })
})

describe('Bolanekoll — bank profile modal save (plan 109c Stage 1)', () => {
  it('keeps the modal open and shows the error when the profile save fails', async () => {
    vi.mocked(Store.updateBank).mockRejectedValueOnce({ message: 'Failed to fetch' })
    const user = userEvent.setup()
    renderBolanekoll()

    await user.click(await screen.findByRole('button', { name: 'Bankprofil' }))
    const dialog = screen.getByRole('dialog', { name: 'Bankprofil' }) as HTMLDialogElement
    // Lock the year-basis to 365 so the save writes a declared lock.
    await user.click(within(dialog).getByRole('radio', { name: '365' }))
    await user.click(within(dialog).getByRole('button', { name: 'Spara' }))

    // The error is visible to the user AND the modal stays open — a throwing
    // store alone is not enough (plan write-semantics gate).
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Ingen anslutning. Ändringen sparades inte i molnet.')
    expect(dialog.open).toBe(true)
    expect(screen.queryByText('Bankprofil sparad.')).not.toBeInTheDocument()
  })

  it('persists a declared lock and closes the modal on a successful save', async () => {
    vi.mocked(Store.updateBank).mockResolvedValueOnce({ ...bank, year_basis: 365, year_basis_source: 'declared' })
    const user = userEvent.setup()
    renderBolanekoll()

    await user.click(await screen.findByRole('button', { name: 'Bankprofil' }))
    const dialog = screen.getByRole('dialog', { name: 'Bankprofil' }) as HTMLDialogElement
    await user.click(within(dialog).getByRole('radio', { name: '365' }))
    await user.click(within(dialog).getByRole('button', { name: 'Spara' }))

    expect(await screen.findByText('Bankprofil sparad.')).toBeInTheDocument()
    // The lock is persisted with source 'declared' (source shows the household lock).
    expect(Store.updateBank).toHaveBeenCalledWith('b1', expect.objectContaining({
      year_basis: 365, year_basis_source: 'declared',
    }))
    expect(dialog.open).toBe(false)
  })
})
