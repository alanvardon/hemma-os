// @vitest-environment jsdom
// Regression for audit H2 / PR #237 (plan 78). Every mutation handler in
// Bolanekoll.tsx shipped without a try/catch: mortgage-store.ts throws on write
// errors, and an uncaught throw meant a failed save showed no toast, left the
// optimistic cache patched as if it had succeeded, and surfaced an unhandled
// rejection. This test drives the real "add loan part" flow with the store
// scripted to reject and asserts the two user-visible guarantees the fix must
// keep: the error toast renders, and the dialog stays open (data not lost).
//
// The mock boundary is mortgage-store, not supabase — this proves the
// component *reacts* to what the store throws (plan 49 owns the store↔network
// layer below). defaultSettings comes from the real, unmocked ../lib/mortgage.
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Bolanekoll from './Bolanekoll'
import * as Store from '../lib/mortgage-store'
import { defaultSettings } from '../lib/mortgage'

vi.mock('../lib/mortgage-store')
vi.mock('../lib/hushallsbudget-store', () => ({ loadBudget: vi.fn(async () => null) }))
vi.mock('@number-flow/react', () => ({
  default: ({ value }: { value: number }) => <span>{value}</span>,
}))
// The Riksbank strip fetches via the local Supabase Edge Function — with the
// local stack running, live data reaches the test and renders a visx chart
// jsdom can't host (no ResizeObserver). Reject the fetch so the strip stays
// quietly absent and the test is deterministic with or without local services.
vi.mock('../lib/riksbank', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/riksbank')>(),
  fetchPolicyRate: vi.fn().mockRejectedValue(new Error('no network in tests')),
}))

// Bolanekoll reads useViewTransitionState (useToolPageActive), which needs a
// data router — mount it as the sole route of an in-memory one.
function renderBolanekoll() {
  const router = createMemoryRouter([{ path: '/', element: <Bolanekoll /> }], {
    initialEntries: ['/'],
  })
  return render(<RouterProvider router={router} />)
}

// The component seeds initial state from cachedSnapshot() (sync) and then hydrates
// from the async list*() reads on mount. With the whole module auto-mocked those
// return undefined by default, which would crash the mount — so give every read a
// benign empty result. Individual tests override the one write they care about.
beforeEach(() => {
  vi.stubGlobal('confirm', vi.fn(() => true))
  vi.mocked(Store.cachedSnapshot).mockReturnValue({
    version: 1,
    banks: [], mortgages: [],
    loan_parts: [], payments: [], valuations: [], rate_periods: [], contributions: [],
    settings: defaultSettings(),
  })
  vi.mocked(Store.listLoanParts).mockResolvedValue([])
  vi.mocked(Store.listPayments).mockResolvedValue([])
  vi.mocked(Store.listValuations).mockResolvedValue([])
  vi.mocked(Store.listRatePeriods).mockResolvedValue([])
  vi.mocked(Store.listContributions).mockResolvedValue([])
  vi.mocked(Store.getSettings).mockResolvedValue(defaultSettings())
  vi.mocked(Store.listBanks).mockResolvedValue([])
  vi.mocked(Store.listMortgages).mockResolvedValue([])
})

describe('Bolanekoll — save failures surface to the user (regression for audit H2 / PR #237)', () => {
  it('shows an error toast and keeps the dialog open when addLoanPart rejects', async () => {
    // supabase-js throws plain {message} objects (not Error instances); mirror
    // that so the test also pins the stable offline-category copy.
    vi.mocked(Store.addLoanPart).mockRejectedValueOnce({ message: 'Failed to fetch' })
    const user = userEvent.setup()
    renderBolanekoll()

    // Empty-hero CTA only appears once the (mocked) cloud read resolves `loaded`.
    await user.click(await screen.findByRole('button', { name: /Add loan part/i }))

    // Fill the label so the dialog has data that must NOT be lost on failure.
    const label = await screen.findByPlaceholderText('e.g. Lånedel 1 (rörlig)')
    await user.type(label, 'Lånedel 1')
    const dialog = label.closest('dialog')!
    await user.click(screen.getByRole('button', { name: 'Save' }))

    // (a) the error message renders somewhere in the DOM…
    expect(await screen.findByText('Ingen anslutning. Ändringen sparades inte i molnet.')).toBeInTheDocument()
    // (b) …and the dialog is STILL OPEN with the typed value intact — a
    // successful save would have closed it via setPartDlg({ open: false }).
    // The `open` attribute is the load-bearing check: DialogShell keeps the
    // form mounted either way, so asserting the input alone wouldn't prove it.
    expect(dialog.open).toBe(true)
    expect(label).toHaveValue('Lånedel 1')
    // The success toast must NOT have fired.
    expect(screen.queryByText('Loan part added.')).not.toBeInTheDocument()
    // (c) vitest fails the run on an unhandled rejection by default — the fact
    // that saveErr() caught the throw is itself asserted by the run staying green.
  })

  it('closes the dialog and confirms when addLoanPart resolves', async () => {
    // The mirror case, so the test above proves the try/catch, not merely that
    // the flow never completes. addLoanPart's return is only used for its side
    // effects here; refresh() re-reads via the list* mocks (still empty).
    vi.mocked(Store.addLoanPart).mockResolvedValueOnce({
      id: 'p1', created_at: '2026-01-01', label: 'Lånedel 1',
      loan_number: '', start_balance: 0, start_date: '2026-01-01',
    } as Awaited<ReturnType<typeof Store.addLoanPart>>)
    const user = userEvent.setup()
    renderBolanekoll()

    await user.click(await screen.findByRole('button', { name: /Add loan part/i }))
    const label = await screen.findByPlaceholderText('e.g. Lånedel 1 (rörlig)')
    await user.type(label, 'Lånedel 1')
    const dialog = label.closest('dialog')!
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Loan part added.')).toBeInTheDocument()
    // The mirror of the failure case: the dialog closes on success.
    expect(dialog.open).toBe(false)
    expect(screen.queryByText(/sparades inte i molnet/i)).not.toBeInTheDocument()
  })

  it('shows the failure and retains the loan part when atomic deletion rejects', async () => {
    const part = {
      id: 'p1', created_at: '2026-01-01', label: 'Lånedel 1', loan_number: '123',
      start_balance: 500000, start_date: '2026-01-01', archived: false,
    }
    vi.mocked(Store.cachedSnapshot).mockReturnValue({
      version: 4, banks: [], mortgages: [], loan_parts: [part], payments: [], valuations: [],
      rate_periods: [], contributions: [], settings: defaultSettings(),
    })
    vi.mocked(Store.listLoanParts).mockResolvedValue([part])
    vi.mocked(Store.removeLoanPart).mockRejectedValueOnce({ message: 'Failed to fetch' })
    const user = userEvent.setup()
    renderBolanekoll()

    await user.click(await screen.findByRole('button', { name: 'Ta bort' }))

    expect(confirm).toHaveBeenCalledWith(
      'Ta bort lånedelen och alla dess betalningar och ränteperioder? Det går inte att ångra.',
    )
    expect(Store.removeLoanPart).toHaveBeenCalledWith('p1')
    expect(await screen.findByText('Ingen anslutning. Ändringen sparades inte i molnet.')).toBeInTheDocument()
    expect(screen.getAllByText('Lånedel 1').length).toBeGreaterThan(0)
    expect(screen.queryByText('Loan part deleted.')).not.toBeInTheDocument()
  })
})
