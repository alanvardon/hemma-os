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

  it('marks an unpaired Betalning as estimated and keeps its source dialog open when saving fails', async () => {
    const part = {
      id: 'p1', created_at: '2026-01-01', label: 'Rörlig del', loan_number: '',
      start_balance: 1_000_000, original_balance: 1_000_000, start_date: '2026-01-01', archived: false,
    }
    const payment = {
      id: 'pay1', created_at: '2026-02-01', loan_part_id: 'p1', date: '2026-02-01',
      kind: 'payment' as const, description: '', amount: 6000, balance_after: null,
      paid_by: 'joint' as const, source: 'manual', is_insats: false,
    }
    vi.mocked(Store.cachedSnapshot).mockReturnValue({
      version: 4, banks: [], mortgages: [], loan_parts: [part], payments: [payment], valuations: [],
      rate_periods: [], contributions: [], settings: defaultSettings(),
    })
    vi.mocked(Store.listLoanParts).mockResolvedValue([part])
    vi.mocked(Store.listPayments).mockResolvedValue([payment])
    vi.mocked(Store.addPayment).mockRejectedValueOnce({ message: 'Failed to fetch' })
    const user = userEvent.setup()
    renderBolanekoll()

    expect(await screen.findByRole('alert')).toHaveTextContent('Ränta saknas för en eller flera betalningar')
    await user.click(screen.getByRole('button', { name: '+ Lägg till' }))
    const dialog = screen.getByRole('dialog', { name: 'Lägg till betalning' })
    // Betalning is joint by definition: there is an explanation, but no
    // individual payer/allocation control to accidentally attribute it.
    expect(screen.queryByLabelText('Betalad av')).not.toBeInTheDocument()
    expect(screen.getByText(/Gemensam post/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Belopp'), '6000')
    await user.click(screen.getByRole('button', { name: 'Spara' }))

    expect(await screen.findByText('Ingen anslutning. Ändringen sparades inte i molnet.')).toBeInTheDocument()
    expect((dialog as HTMLDialogElement).open).toBe(true)
    expect(screen.getByLabelText('Belopp')).toHaveValue('6000')
  })

  it('makes Kontantinsats and extra amortering explicit canonical payment actions', async () => {
    const part = {
      id: 'p1', created_at: '2026-01-01', label: 'Rörlig del', loan_number: '',
      start_balance: 1_000_000, start_date: '2026-01-01', archived: false,
    }
    vi.mocked(Store.cachedSnapshot).mockReturnValue({
      version: 4, banks: [], mortgages: [], loan_parts: [part], payments: [], valuations: [],
      rate_periods: [], contributions: [], settings: defaultSettings(),
    })
    vi.mocked(Store.listLoanParts).mockResolvedValue([part])
    const user = userEvent.setup()
    renderBolanekoll()

    await user.click(await screen.findByRole('button', { name: '+ Lägg till' }))
    const type = screen.getByLabelText('Typ')
    await user.selectOptions(type, 'down_payment')
    expect(screen.queryByLabelText('Lånedel')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Betalad av')).toBeInTheDocument()
    await user.selectOptions(type, 'extra_amortization')
    expect(screen.getByLabelText('Lånedel')).toBeInTheDocument()
    expect(screen.getByLabelText('Betalad av')).toBeInTheDocument()
  })

  it('clears the dashboard estimate when matching Ränta or a later Saldo makes the result observed', async () => {
    const part = {
      id: 'p1', created_at: '2026-01-01', label: 'Rörlig del', loan_number: '',
      start_balance: 1_000_000, original_balance: 1_000_000, start_date: '2026-01-01', archived: false,
    }
    const payment = {
      id: 'pay1', created_at: '2026-02-01', loan_part_id: 'p1', date: '2026-02-01',
      kind: 'payment' as const, description: '', amount: 6000, balance_after: null,
      paid_by: 'joint' as const, source: 'manual', is_insats: false,
    }
    const interest = { ...payment, id: 'interest1', kind: 'interest' as const, amount: 3000 }
    const laterSaldo = { ...payment, id: 'saldo1', date: '2026-03-01', kind: 'amortization' as const, amount: 3000, balance_after: 994000 }
    vi.mocked(Store.cachedSnapshot).mockReturnValue({
      version: 4, banks: [], mortgages: [], loan_parts: [part], payments: [payment, interest, laterSaldo], valuations: [],
      rate_periods: [], contributions: [], settings: defaultSettings(),
    })
    vi.mocked(Store.listLoanParts).mockResolvedValue([part])
    vi.mocked(Store.listPayments).mockResolvedValue([payment, interest, laterSaldo])
    renderBolanekoll()

    await screen.findByText('Betalningar')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText('ränta saknas · uppskattat')).not.toBeInTheDocument()
  })

  it('preserves and saves an explicit extra-amortering split, description, and source', async () => {
    const part = {
      id: 'p1', created_at: '2026-01-01', label: 'Rörlig del', loan_number: '',
      start_balance: 1_000_000, start_date: '2026-01-01', archived: false,
    }
    const insats = {
      id: 'insats1', created_at: '2026-02-01', loan_part_id: 'p1', date: '2026-02-01',
      kind: 'amortization' as const, description: 'Extra insättning från banken', amount: 20_000,
      balance_after: null, paid_by: 'joint' as const, paid_split: { a: 12_000, b: 8_000 }, source: 'import', is_insats: true,
    }
    vi.mocked(Store.cachedSnapshot).mockReturnValue({
      version: 4, banks: [], mortgages: [], loan_parts: [part], payments: [insats], valuations: [],
      rate_periods: [], contributions: [], settings: defaultSettings(),
    })
    vi.mocked(Store.listLoanParts).mockResolvedValue([part])
    vi.mocked(Store.listPayments).mockResolvedValue([insats])
    vi.mocked(Store.updatePayment).mockResolvedValue(insats)
    const user = userEvent.setup()
    renderBolanekoll()

    await user.click(await screen.findByRole('button', { name: 'Redigera i Betalningar' }))
    expect(screen.getByLabelText('Alex · fördelning')).toHaveValue('12000')
    expect(screen.getByLabelText('Sam · fördelning')).toHaveValue('8000')
    await user.click(screen.getByRole('button', { name: 'Spara' }))

    expect(await screen.findByText('Payment saved.')).toBeInTheDocument()
    expect(Store.updatePayment).toHaveBeenCalledWith('insats1', expect.objectContaining({
      kind: 'amortization', is_insats: true, paid_by: 'joint', paid_split: { a: 12000, b: 8000 },
      description: 'Extra insättning från banken', source: 'import',
    }))
  })

  it('normalizes edited Betalning and Ränta to joint records without a split', async () => {
    const part = {
      id: 'p1', created_at: '2026-01-01', label: 'Rörlig del', loan_number: '',
      start_balance: 1_000_000, start_date: '2026-01-01', archived: false,
    }
    const payment = {
      id: 'pay1', created_at: '2026-02-01', loan_part_id: 'p1', date: '2026-02-01',
      kind: 'payment' as const, description: 'Bankens dragning', amount: 6000, balance_after: 994000,
      paid_by: 'a' as const, paid_split: { a: 6000, b: 0 }, source: 'import', is_insats: false,
    }
    vi.mocked(Store.cachedSnapshot).mockReturnValue({
      version: 4, banks: [], mortgages: [], loan_parts: [part], payments: [payment], valuations: [],
      rate_periods: [], contributions: [], settings: defaultSettings(),
    })
    vi.mocked(Store.listLoanParts).mockResolvedValue([part])
    vi.mocked(Store.listPayments).mockResolvedValue([payment])
    vi.mocked(Store.updatePayment).mockResolvedValue(payment)
    const user = userEvent.setup()
    renderBolanekoll()

    await user.click(await screen.findAllByRole('button', { name: 'Edit' }).then(buttons => buttons.at(-1)!))
    expect(screen.queryByLabelText('Betalad av')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Alex · fördelning')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Spara' }))

    expect(await screen.findByText('Payment saved.')).toBeInTheDocument()
    expect(Store.updatePayment).toHaveBeenCalledWith('pay1', expect.objectContaining({
      kind: 'payment', balance_after: 994000, paid_by: 'joint', paid_split: null, description: 'Bankens dragning', source: 'import',
    }))

    await user.click((await screen.findAllByRole('button', { name: 'Edit' })).at(-1)!)
    await user.selectOptions(screen.getByLabelText('Typ'), 'interest')
    expect(screen.queryByLabelText('Betalad av')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Alex · fördelning')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Spara' }))
    expect(Store.updatePayment).toHaveBeenLastCalledWith('pay1', expect.objectContaining({
      kind: 'interest', balance_after: null, paid_by: 'joint', paid_split: null, description: 'Bankens dragning', source: 'import',
    }))
  })

  it('projects only down payments and flagged extra amorteringar outside Betalningar', async () => {
    const part = {
      id: 'p1', created_at: '2026-01-01', label: 'Rörlig del', loan_number: '',
      start_balance: 1_000_000, start_date: '2026-01-01', archived: false,
    }
    const base = { created_at: '2026-02-01', date: '2026-02-02', description: '', balance_after: null, paid_by: 'a' as const, source: 'manual' }
    const downPayment = { ...base, id: 'down', loan_part_id: null, kind: 'down_payment' as const, amount: 150_000, is_insats: true }
    const extra = { ...base, id: 'extra', loan_part_id: 'p1', kind: 'amortization' as const, amount: 20_000, is_insats: true }
    const ordinary = { ...base, id: 'ordinary', loan_part_id: 'p1', kind: 'amortization' as const, amount: 5_000, is_insats: false }
    const payments = [downPayment, extra, ordinary]
    vi.mocked(Store.cachedSnapshot).mockReturnValue({
      version: 4, banks: [], mortgages: [], loan_parts: [part], payments, valuations: [],
      rate_periods: [], contributions: [], settings: defaultSettings(),
    })
    vi.mocked(Store.listLoanParts).mockResolvedValue([part])
    vi.mocked(Store.listPayments).mockResolvedValue(payments)
    renderBolanekoll()

    await screen.findByText('Kontantinsatser')
    const deposits = document.querySelector('#kontantinsatser')!
    const extras = document.querySelector('#extra-amorteringar')!
    expect(deposits.querySelector('[data-source-payment-id="down"]')).toBeInTheDocument()
    expect(extras.querySelector('[data-source-payment-id="extra"]')).toBeInTheDocument()
    expect(deposits.querySelector('[data-source-payment-id="ordinary"]')).not.toBeInTheDocument()
    expect(extras.querySelector('[data-source-payment-id="ordinary"]')).not.toBeInTheDocument()
    const paymentTable = document.querySelector('.payments-table')!
    const depositLedgerRow = [...paymentTable.querySelectorAll('tbody > tr')].find(row => /150\s*000/.test(row.textContent || ''))!
    const extraLedgerRow = [...paymentTable.querySelectorAll('tbody > tr')].find(row => /20\s*000/.test(row.textContent || ''))!
    expect(depositLedgerRow).not.toHaveTextContent('extra amortering')
    expect(extraLedgerRow).toHaveTextContent('extra amortering')
    expect(document.querySelector('#betalningar')!.parentElement).toHaveTextContent(/5\s*000 kr/)
  })
})
