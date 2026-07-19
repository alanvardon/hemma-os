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
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Bolanekoll from './Bolanekoll'
import { ConfirmProvider } from '../components/useConfirm'
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
  return render(<ConfirmProvider><RouterProvider router={router} /></ConfirmProvider>)
}

// The component seeds initial state from cachedSnapshot() (sync) and then hydrates
// from the async list*() reads on mount. With the whole module auto-mocked those
// return undefined by default, which would crash the mount — so give every read a
// benign empty result. Individual tests override the one write they care about.
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('ResizeObserver', class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  })
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
  vi.mocked(Store.listCatalogBanks).mockResolvedValue([])
})

// Plan 109c makes the mortgage agreement the parent of loan parts, so adding a
// part requires an active agreement. Seed one (no parts) so the empty-hero shows
// the "+ Lägg till lånedel" CTA instead of "Skapa bolåneavtal".
const agreement = {
  id: 'm1', created_at: '2026-01-01', bank_id: 'b1', label: 'Bolån',
  start_date: '2026-01-01', archived: false, end_date: null,
}
const bank = {
  id: 'b1', created_at: '2026-01-01', label: 'Min bank',
  year_basis: null, year_basis_source: null, billing: null, billing_source: null, catalog_id: null,
}
function seedAgreement() {
  vi.mocked(Store.listMortgages).mockResolvedValue([agreement])
  vi.mocked(Store.listBanks).mockResolvedValue([bank])
  vi.mocked(Store.cachedSnapshot).mockReturnValue({
    version: 6, banks: [bank], mortgages: [agreement],
    loan_parts: [], payments: [], valuations: [], rate_periods: [], contributions: [],
    settings: defaultSettings(),
  })
}

function seedScenarioCard(settings = defaultSettings()) {
  const part = {
    id: 'scenario-part', created_at: '2026-01-01', label: 'Rörlig del', loan_number: '',
    start_balance: 1_000_000, start_date: '2026-01-01', archived: false,
  }
  const period = {
    id: 'scenario-rate', created_at: '2026-01-01', loan_part_id: 'scenario-part', start_date: '2026-01-01',
    end_date: null, rate: 2.5, rate_type: 'rörlig' as const,
  }
  vi.mocked(Store.cachedSnapshot).mockReturnValue({
    version: 6, banks: [], mortgages: [], loan_parts: [part], payments: [], valuations: [], rate_periods: [period], contributions: [], settings,
  })
  vi.mocked(Store.listLoanParts).mockResolvedValue([part])
  vi.mocked(Store.listRatePeriods).mockResolvedValue([period])
  vi.mocked(Store.getSettings).mockResolvedValue(settings)
}

describe('Bolanekoll — save failures surface to the user (regression for audit H2 / PR #237)', () => {
  it('shows an error toast and keeps the dialog open when addLoanPart rejects', async () => {
    // supabase-js throws plain {message} objects (not Error instances); mirror
    // that so the test also pins the stable offline-category copy.
    seedAgreement()
    vi.mocked(Store.addLoanPart).mockRejectedValueOnce({ message: 'Failed to fetch' })
    const user = userEvent.setup()
    renderBolanekoll()

    // Empty-hero CTA only appears once the (mocked) cloud read resolves `loaded`.
    await user.click(await screen.findByRole('button', { name: /Lägg till lånedel/i }))

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
    seedAgreement()
    vi.mocked(Store.addLoanPart).mockResolvedValueOnce({
      id: 'p1', created_at: '2026-01-01', label: 'Lånedel 1',
      loan_number: '', start_balance: 0, start_date: '2026-01-01',
    } as Awaited<ReturnType<typeof Store.addLoanPart>>)
    const user = userEvent.setup()
    renderBolanekoll()

    await user.click(await screen.findByRole('button', { name: /Lägg till lånedel/i }))
    const label = await screen.findByPlaceholderText('e.g. Lånedel 1 (rörlig)')
    await user.type(label, 'Lånedel 1')
    const dialog = label.closest('dialog')!
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Loan part added.')).toBeInTheDocument()
    // The mirror of the failure case: the dialog closes on success.
    expect(dialog.open).toBe(false)
    expect(screen.queryByText(/sparades inte i molnet/i)).not.toBeInTheDocument()
  })

  it('keeps an untouched scenario rate tied to the asynchronously loaded blended rate without writing', async () => {
    const part = {
      id: 'p1', created_at: '2026-01-01', label: 'Rörlig del', loan_number: '',
      start_balance: 1_000_000, start_date: '2026-01-01', archived: false,
    }
    const period = {
      id: 'r1', created_at: '2026-01-01', loan_part_id: 'p1', start_date: '2026-01-01',
      end_date: null, rate: 2.34, rate_type: 'rörlig' as const,
    }
    vi.mocked(Store.cachedSnapshot).mockReturnValue({
      version: 6, banks: [], mortgages: [], loan_parts: [], payments: [], valuations: [], rate_periods: [], contributions: [], settings: defaultSettings(),
    })
    vi.mocked(Store.listLoanParts).mockResolvedValue([part])
    vi.mocked(Store.listRatePeriods).mockResolvedValue([period])
    renderBolanekoll()

    expect(await screen.findByLabelText('Ränta i scenariot / %')).toHaveValue('2.34')
    expect(Store.saveSettings).not.toHaveBeenCalled()
  })

  it('persists comma-decimal scenario rates on blur, Enter, and both steppers', async () => {
    seedScenarioCard()
    const user = userEvent.setup()
    renderBolanekoll()
    const input = await screen.findByLabelText('Ränta i scenariot / %')

    await user.clear(input)
    await user.type(input, '3,45')
    await user.tab()
    expect(Store.saveSettings).toHaveBeenLastCalledWith({ what_if_rate_pct: 3.45 })

    await user.clear(input)
    await user.type(input, '3.50')
    await user.keyboard('{Enter}')
    expect(Store.saveSettings).toHaveBeenLastCalledWith({ what_if_rate_pct: 3.5 })

    await user.click(screen.getByRole('button', { name: '+0,01 procentenheter' }))
    expect(Store.saveSettings).toHaveBeenLastCalledWith({ what_if_rate_pct: 3.51 })
    await user.click(screen.getByRole('button', { name: '−0,01 procentenheter' }))
    expect(Store.saveSettings).toHaveBeenLastCalledWith({ what_if_rate_pct: 3.5 })
  })

  it('saves a comma-decimal rate once, confirms it once, and remounts the persisted value', async () => {
    let savedSettings = defaultSettings()
    seedScenarioCard(savedSettings)
    vi.mocked(Store.saveSettings).mockImplementation(async (patch) => {
      savedSettings = { ...savedSettings, ...patch }
      vi.mocked(Store.getSettings).mockResolvedValue(savedSettings)
      return savedSettings
    })
    const user = userEvent.setup()
    const first = renderBolanekoll()
    const input = await screen.findByLabelText('Ränta i scenariot / %')
    await user.clear(input)
    await user.type(input, '3,45')
    await user.keyboard('{Enter}')
    await user.click(screen.getByRole('heading', { name: /Prognos/i }))

    expect(Store.saveSettings).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Settings saved.')).toBeInTheDocument()
    expect(screen.getAllByText('Settings saved.')).toHaveLength(1)

    first.unmount()
    seedScenarioCard(savedSettings)
    renderBolanekoll()
    expect(await screen.findByLabelText('Ränta i scenariot / %')).toHaveValue('3.45')
  })

  it('changes only the what-if figures, not observed mortgage, forecast, or ledger displays', async () => {
    const part = {
      id: 'p-rate', created_at: '2026-01-01', label: 'Rörlig del', loan_number: '',
      start_balance: 1_000_000, start_date: '2026-01-01', archived: false,
    }
    const period = {
      id: 'r-rate', created_at: '2026-01-01', loan_part_id: 'p-rate', start_date: '2026-01-01',
      end_date: null, rate: 2.5, rate_type: 'rörlig' as const,
    }
    const payment = {
      id: 'pay-rate', created_at: '2026-06-27', loan_part_id: 'p-rate', date: '2026-06-27',
      kind: 'payment' as const, description: 'Bevarad betalningsrad', amount: 6_000, balance_after: 994_000,
      paid_by: 'joint' as const, source: 'manual', is_insats: false,
    }
    vi.mocked(Store.cachedSnapshot).mockReturnValue({
      version: 6, banks: [], mortgages: [], loan_parts: [part], payments: [payment], valuations: [], rate_periods: [period], contributions: [], settings: defaultSettings(),
    })
    vi.mocked(Store.listLoanParts).mockResolvedValue([part])
    vi.mocked(Store.listRatePeriods).mockResolvedValue([period])
    vi.mocked(Store.listPayments).mockResolvedValue([payment])
    const user = userEvent.setup()
    renderBolanekoll()

    const input = await screen.findByLabelText('Ränta i scenariot / %')
    const observedRate = screen.getByText('Nu (2,50 %)')
    const debt = document.querySelector('[data-current-debt]')!.getAttribute('data-current-debt')
    const forecast = screen.getByText(/ränta över 12 mån/).textContent
    const ledgerRow = document.querySelector('.payments-table tbody tr')!
    const ledger = ledgerRow.textContent
    const beforeScenario = screen.getByText('Vid 2,50 %').closest('.metric-chip')!.textContent

    await user.clear(input)
    await user.type(input, '3,45')
    await user.tab()

    expect(screen.getByText('Vid 3,45 %').closest('.metric-chip')!.textContent).not.toBe(beforeScenario)
    expect(screen.getByText('Nu (2,50 %)')).toBe(observedRate)
    expect(document.querySelector('[data-current-debt]')).toHaveAttribute('data-current-debt', debt!)
    expect(screen.getByText(/ränta över 12 mån/).textContent?.replace(/\s/g, ' ')).toBe(forecast?.replace(/\s/g, ' '))
    expect(document.querySelector('.payments-table tbody tr')?.textContent?.replace(/\s/g, ' ')).toBe(ledger?.replace(/\s/g, ' '))
  })

  it('does not turn incomplete scenario-rate text into 0 %', async () => {
    seedScenarioCard()
    const user = userEvent.setup()
    renderBolanekoll()
    const input = await screen.findByLabelText('Ränta i scenariot / %')
    await user.clear(input)
    await user.type(input, '2,')
    await user.tab()

    expect(Store.saveSettings).not.toHaveBeenCalled()
    expect(await screen.findByText('Ange en giltig ränta på 0 % eller mer.')).toBeInTheDocument()
    expect(input).toHaveValue('2,')
  })

  it('keeps a rejected scenario-rate draft visible, surfaces the failure, and does not show success', async () => {
    const savedSettings = { ...defaultSettings(), what_if_rate_pct: 2.5 }
    seedScenarioCard(savedSettings)
    vi.mocked(Store.saveSettings).mockRejectedValueOnce({ message: 'Failed to fetch' })
    const user = userEvent.setup()
    const first = renderBolanekoll()
    const input = await screen.findByLabelText('Ränta i scenariot / %')
    await user.clear(input)
    await user.type(input, '4,25')
    await user.tab()

    expect(await screen.findByText('Ingen anslutning. Ändringen sparades inte i molnet.')).toBeInTheDocument()
    expect(await screen.findByText('Kunde inte spara räntan. Försök igen.')).toBeInTheDocument()
    expect(input).toHaveValue('4,25')
    expect(screen.queryByText('Settings saved.')).not.toBeInTheDocument()

    first.unmount()
    renderBolanekoll()
    expect(await screen.findByLabelText('Ränta i scenariot / %')).toHaveValue('2.50')
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

    // The delete guard is now a themed ConfirmDialog (plan 91), not native
    // confirm(): the dialog appears, and confirming drives the store delete.
    const dialog = await screen.findByRole('dialog', { name: 'Ta bort lånedelen?' })
    await user.click(within(dialog).getByRole('button', { name: 'Ta bort' }))

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
    expect(screen.queryByLabelText('Saldo efteråt (valfritt)')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Betalad av')).toBeInTheDocument()
    await user.selectOptions(type, 'extra_amortization')
    expect(screen.getByLabelText('Lånedel')).toBeInTheDocument()
    expect(screen.getByLabelText('Saldo efteråt (valfritt)')).toBeInTheDocument()
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
      balance_after: 980_000, paid_by: 'joint' as const, paid_split: { a: 12_000, b: 8_000 }, source: 'import', is_insats: true,
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
    expect(screen.getByLabelText('Saldo efteråt (valfritt)')).toHaveValue('980000')
    await user.click(screen.getByRole('button', { name: 'Spara' }))

    expect(await screen.findByText('Payment saved.')).toBeInTheDocument()
    expect(Store.updatePayment).toHaveBeenCalledWith('insats1', expect.objectContaining({
      kind: 'amortization', is_insats: true, paid_by: 'joint', paid_split: { a: 12000, b: 8000 },
      description: 'Extra insättning från banken', source: 'import', balance_after: 980000,
    }))
  })

  it('prefills a new extra amortering split 50/50 from ownership and freezes it once edited (plan 116)', async () => {
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
    await user.selectOptions(screen.getByLabelText('Typ'), 'extra_amortization')
    await user.type(screen.getByLabelText('Belopp'), '10000')

    expect(await screen.findByLabelText('Alex · fördelning')).toHaveValue('5000')
    expect(screen.getByLabelText('Sam · fördelning')).toHaveValue('5000')

    // The owner reviews and edits Alex's share directly — from this point the
    // pair is "touched" and must not be silently recomputed.
    await user.clear(screen.getByLabelText('Alex · fördelning'))
    await user.type(screen.getByLabelText('Alex · fördelning'), '6000')
    expect(screen.getByLabelText('Sam · fördelning')).toHaveValue('5000')

    // A later amount edit must not overwrite the reviewed values.
    await user.clear(screen.getByLabelText('Belopp'))
    await user.type(screen.getByLabelText('Belopp'), '12000')
    expect(screen.getByLabelText('Alex · fördelning')).toHaveValue('6000')
    expect(screen.getByLabelText('Sam · fördelning')).toHaveValue('5000')
  })

  it('blocks Save for a missing, negative, or total-mismatched extra-amortering allocation (plan 116)', async () => {
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
    await user.selectOptions(screen.getByLabelText('Typ'), 'extra_amortization')
    await user.type(screen.getByLabelText('Belopp'), '10000')
    const saveBtn = await screen.findByRole('button', { name: 'Spara' })
    // A freshly prefilled, valid 50/50 split leaves Save enabled.
    expect(saveBtn).toBeEnabled()

    // Negative allocation.
    await user.clear(screen.getByLabelText('Alex · fördelning'))
    await user.type(screen.getByLabelText('Alex · fördelning'), '-500')
    expect(saveBtn).toBeDisabled()

    // Total mismatch (8 000 vs the 10 000 amount).
    await user.clear(screen.getByLabelText('Alex · fördelning'))
    await user.type(screen.getByLabelText('Alex · fördelning'), '4000')
    await user.clear(screen.getByLabelText('Sam · fördelning'))
    await user.type(screen.getByLabelText('Sam · fördelning'), '4000')
    expect(saveBtn).toBeDisabled()

    // Missing allocation.
    await user.clear(screen.getByLabelText('Sam · fördelning'))
    expect(saveBtn).toBeDisabled()

    await user.click(saveBtn)
    expect(Store.addPayment).not.toHaveBeenCalled()
  })

  it('keeps a reviewed two-person allocation intact when a single payer is selected (plan 116)', async () => {
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
    await user.selectOptions(screen.getByLabelText('Typ'), 'extra_amortization')
    await user.type(screen.getByLabelText('Belopp'), '10000')
    await screen.findByLabelText('Alex · fördelning')
    await user.clear(screen.getByLabelText('Alex · fördelning'))
    await user.type(screen.getByLabelText('Alex · fördelning'), '6000')
    await user.clear(screen.getByLabelText('Sam · fördelning'))
    await user.type(screen.getByLabelText('Sam · fördelning'), '4000')
    // Alex made the bank transfer, but the reviewed 6 000/4 000 allocation
    // must survive untouched — selecting a single payer must not collapse it
    // to paid_by: 'joint' or rewrite the split to match the payer alone.
    await user.selectOptions(screen.getByLabelText('Betalad av'), 'a')
    await user.click(screen.getByRole('button', { name: 'Spara' }))

    expect(await screen.findByText('Payment saved.')).toBeInTheDocument()
    expect(Store.addPayment).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'amortization', is_insats: true, paid_by: 'a', paid_split: { a: 6000, b: 4000 },
    }))
  })

  it('opens a legacy unsplit extra amortering with a derived split and a beräknad notice (plan 116)', async () => {
    const part = {
      id: 'p1', created_at: '2026-01-01', label: 'Rörlig del', loan_number: '',
      start_balance: 1_000_000, start_date: '2026-01-01', archived: false,
    }
    const legacy = {
      id: 'legacy1', created_at: '2026-02-01', loan_part_id: 'p1', date: '2026-02-01',
      kind: 'amortization' as const, description: '', amount: 10_000, balance_after: null,
      paid_by: 'a' as const, paid_split: null, source: 'import', is_insats: true,
    }
    vi.mocked(Store.cachedSnapshot).mockReturnValue({
      version: 4, banks: [], mortgages: [], loan_parts: [part], payments: [legacy], valuations: [],
      rate_periods: [], contributions: [], settings: defaultSettings(),
    })
    vi.mocked(Store.listLoanParts).mockResolvedValue([part])
    vi.mocked(Store.listPayments).mockResolvedValue([legacy])
    vi.mocked(Store.updatePayment).mockResolvedValue(legacy)
    const user = userEvent.setup()
    renderBolanekoll()

    await user.click(await screen.findByRole('button', { name: 'Redigera i Betalningar' }))
    // Default ownership is 50/50, so the legacy row derives an even split.
    expect(screen.getByLabelText('Alex · fördelning')).toHaveValue('5000')
    expect(screen.getByLabelText('Sam · fördelning')).toHaveValue('5000')
    expect(screen.getByText('Beräknad från ägarfördelningen — granska innan du sparar.')).toBeInTheDocument()
    // Hydration never writes on its own.
    expect(Store.updatePayment).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Spara' }))
    expect(await screen.findByText('Payment saved.')).toBeInTheDocument()
    expect(Store.updatePayment).toHaveBeenCalledWith('legacy1', expect.objectContaining({
      paid_by: 'a', paid_split: { a: 5000, b: 5000 },
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

  it('drops the Lånedel column from Kontantinsatser and keeps the unlinked-agreement warning on the row (plan 116)', async () => {
    const part = {
      id: 'p1', created_at: '2026-01-01', label: 'Rörlig del', loan_number: '',
      start_balance: 1_000_000, start_date: '2026-01-01', archived: false,
    }
    const base = { created_at: '2026-02-01', date: '2026-02-02', description: '', balance_after: null, paid_by: 'joint' as const, source: 'manual', loan_part_id: null, kind: 'down_payment' as const, is_insats: true }
    const linked = { ...base, id: 'linked', amount: 100_000, mortgage_id: 'm1' }
    const unlinked = { ...base, id: 'unlinked', amount: 50_000, mortgage_id: null }
    const payments = [linked, unlinked]
    vi.mocked(Store.cachedSnapshot).mockReturnValue({
      version: 4, banks: [], mortgages: [], loan_parts: [part], payments, valuations: [],
      rate_periods: [], contributions: [], settings: defaultSettings(),
    })
    vi.mocked(Store.listLoanParts).mockResolvedValue([part])
    vi.mocked(Store.listPayments).mockResolvedValue(payments)
    renderBolanekoll()

    await screen.findByText('Kontantinsatser')
    const table = document.querySelector('.kontantinsats-table') as HTMLElement
    expect(table).toBeInTheDocument()
    expect(within(table).queryByText('Lånedel')).not.toBeInTheDocument()

    const linkedRow = table.querySelector('[data-source-payment-id="linked"]') as HTMLElement
    const unlinkedRow = table.querySelector('[data-source-payment-id="unlinked"]') as HTMLElement
    expect(within(linkedRow).queryByText('⚠ ej kopplad')).not.toBeInTheDocument()
    expect(within(unlinkedRow).getByText('⚠ ej kopplad')).toBeInTheDocument()
    // The row stays editable via the Betalningar dialog despite losing its own column.
    expect(within(unlinkedRow).getByRole('button', { name: 'Redigera i Betalningar' })).toBeInTheDocument()
  })

  it('adds an unsplit legacy extra amortering to debt and total equity, splitting it by the ownership share (plan 116)', async () => {
    const part = {
      id: 'p1', created_at: '2026-01-01', label: 'Rörlig del', loan_number: '',
      start_balance: 958_000, original_balance: 958_000, start_date: '2026-01-01', archived: false,
    }
    const base = { created_at: '2026-01-01', description: '', source: 'manual' }
    const payments = [
      { ...base, id: 'saldo', loan_part_id: 'p1', date: '2026-01-31', kind: 'payment' as const, amount: 0, balance_after: 958_000, paid_by: 'joint' as const, is_insats: false },
      { ...base, id: 'deposit-a', loan_part_id: null, date: '2026-01-01', kind: 'down_payment' as const, amount: 521_000, balance_after: null, paid_by: 'a' as const, is_insats: true },
      { ...base, id: 'deposit-b', loan_part_id: null, date: '2026-01-01', kind: 'down_payment' as const, amount: 521_000, balance_after: null, paid_by: 'b' as const, is_insats: true },
      { ...base, id: 'extra-a', loan_part_id: 'p1', date: '2026-02-01', kind: 'amortization' as const, amount: 8_000, balance_after: null, paid_by: 'a' as const, is_insats: true },
    ]
    const valuations = [
      { id: 'purchase', created_at: '2026-01-01', date: '2026-01-01', value: 2_000_000, note: '', is_purchase: true },
      { id: 'current', created_at: '2026-02-01', date: '2026-02-01', value: 2_000_000, note: '', is_purchase: false },
    ]
    const tracked = { ...defaultSettings(), track_contributions: true }
    vi.mocked(Store.cachedSnapshot).mockReturnValue({
      version: 5, banks: [], mortgages: [], loan_parts: [part], payments, valuations,
      rate_periods: [], contributions: [], settings: tracked,
    })
    vi.mocked(Store.listLoanParts).mockResolvedValue([part])
    vi.mocked(Store.listPayments).mockResolvedValue(payments)
    vi.mocked(Store.listValuations).mockResolvedValue(valuations)
    vi.mocked(Store.getSettings).mockResolvedValue(tracked)
    renderBolanekoll()

    await screen.findByText('Eget kapital · Marknadsvärde minus skuld')
    expect(document.querySelector('[data-current-debt]')).toHaveAttribute('data-current-debt', '950000')
    expect(document.querySelector('[data-market-equity]')).toHaveAttribute('data-market-equity', '1050000')
    // Legacy row has no paid_split: the 8 000 extra amortering is now split 50/50
    // by the ownership share (plan 116), not credited in full to its payer A.
    expect(document.querySelector('[data-owner-market-capital="a"]')).toHaveTextContent('525000')
    expect(document.querySelector('[data-owner-market-capital="b"]')).toHaveTextContent('525000')
    expect(document.querySelector('[data-owner-cost-capital="a"]')).toHaveTextContent('525000')
    expect(document.querySelector('[data-owner-cost-capital="b"]')).toHaveTextContent('525000')
  })

  it('updates every debt-derived hero value from predicted principal plus an extra amortering and opens Betalningar', async () => {
    const part = {
      id: 'p1', created_at: '2024-01-01', label: 'Bolån', loan_number: '',
      start_balance: 4_800_000, original_balance: 4_800_000,
      start_date: '2024-01-01', original_date: '2024-01-01', archived: false,
    }
    const base = { created_at: '2026-07-15T08:00:00Z', description: '', source: 'manual' }
    const payments = [
      {
        ...base, id: 'saldo', loan_part_id: 'p1', date: '2026-07-15',
        kind: 'payment' as const, amount: 0, balance_after: 4_616_000,
        paid_by: 'joint' as const, is_insats: false,
      },
      {
        ...base, id: 'extra', created_at: '2026-07-15T09:00:00Z', loan_part_id: 'p1', date: '2026-07-15',
        kind: 'amortization' as const, amount: 8_000, balance_after: null,
        paid_by: 'a' as const, is_insats: true,
      },
      {
        ...base, id: 'predicted-interest', loan_part_id: 'p1', date: '2026-07-31',
        kind: 'interest' as const, amount: 3_438, balance_after: 4_608_000,
        paid_by: 'joint' as const, source: 'predicted', is_insats: false,
      },
      {
        ...base, id: 'predicted-payment', loan_part_id: 'p1', date: '2026-07-31',
        kind: 'payment' as const, amount: 11_438, balance_after: 4_608_000,
        paid_by: 'joint' as const, source: 'predicted', is_insats: false,
      },
    ]
    const valuations = [
      {
        id: 'purchase', created_at: '2024-01-01', date: '2024-01-01',
        value: 5_650_000, note: '', is_purchase: true,
      },
    ]
    vi.mocked(Store.cachedSnapshot).mockReturnValue({
      version: 5, banks: [], mortgages: [], loan_parts: [part], payments, valuations,
      rate_periods: [], contributions: [], settings: defaultSettings(),
    })
    vi.mocked(Store.listLoanParts).mockResolvedValue([part])
    vi.mocked(Store.listPayments).mockResolvedValue(payments)
    vi.mocked(Store.listValuations).mockResolvedValue(valuations)
    const user = userEvent.setup()
    renderBolanekoll()

    await screen.findByText('Eget kapital · Marknadsvärde minus skuld')
    expect(document.querySelector('[data-current-debt]')).toHaveAttribute('data-current-debt', '4600000')
    expect(document.querySelector('[data-market-equity]')).toHaveAttribute('data-market-equity', '1050000')
    // NumberFlow is mocked as its raw numeric value in this component suite;
    // formatter/locale behaviour is covered by AnimatedNumber's own tests.
    expect(screen.getByText(/Remaining debt/).parentElement).toHaveTextContent('4600000')
    expect(screen.getByText(/Loan-to-value/).parentElement).toHaveTextContent('81.42')
    expect(screen.getByText('Insatt kapital · Cost-basis equity').parentElement).toHaveTextContent('1050000')
    expect(screen.getByText(/of the köpeskilling/)).toHaveTextContent('18.58')

    const openPayments = screen.getAllByRole('button', { name: 'Öppna Betalningar' })
    await user.click(openPayments[0])
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled()
    expect(document.activeElement).toBe(document.getElementById('betalningar'))
  })
})

// Plan 115 — Betalningar discloses one populated calendar month at a time
// instead of a fixed 20-row page. These regressions pin the visibility
// contract: the store already delivers payments newest-first (date desc, then
// created_at desc), and the component only GROUPS them into month buckets — it
// must never re-sort, split a month by row count, or drop an undated row.
describe('Bolanekoll — Betalningar month disclosure (plan 115)', () => {
  const part1 = { id: 'p1', created_at: '2026-01-01', label: 'Del A', loan_number: '', start_balance: 1_000_000, start_date: '2026-01-01', archived: false }
  const part2 = { id: 'p2', created_at: '2026-01-01', label: 'Del B', loan_number: '', start_balance: 500_000, start_date: '2026-01-01', archived: false }

  // A ledger row. `date: ''` models a legacy undated row. Callers pass rows
  // already newest-first, exactly as the store's byDateDesc would deliver them.
  function pay(id: string, date: string, amount: number, opts: {
    loan_part_id?: string | null; created_at?: string; is_insats?: boolean
    source?: string; kind?: 'payment' | 'amortization'; paid_by?: 'a' | 'b' | 'joint'
  } = {}) {
    return {
      id, created_at: opts.created_at ?? (date || '2000') + 'T09:00:00',
      loan_part_id: opts.loan_part_id === undefined ? 'p1' : opts.loan_part_id, date,
      kind: opts.kind ?? ('payment' as const), description: '',
      amount, balance_after: null, paid_by: opts.paid_by ?? ('a' as const),
      source: opts.source ?? 'manual', is_insats: opts.is_insats ?? false,
    }
  }

  function seed(payments: ReturnType<typeof pay>[], parts = [part1]) {
    vi.mocked(Store.cachedSnapshot).mockReturnValue({
      version: 6, banks: [], mortgages: [], loan_parts: parts, payments,
      valuations: [], rate_periods: [], contributions: [], settings: defaultSettings(),
    })
    vi.mocked(Store.listLoanParts).mockResolvedValue(parts)
    vi.mocked(Store.listPayments).mockResolvedValue(payments)
  }

  async function renderLedger() {
    renderBolanekoll()
    await screen.findByRole('heading', { name: /Betalningar/ })
  }

  function ledgerRows() {
    return [...document.querySelectorAll('.payments-table tbody tr')]
  }
  const rowsText = () => ledgerRows().map(r => r.textContent || '')

  it('shows every row of the newest month initially — including more than 20 — and no older row', async () => {
    // 22 rows in June (over the old PAY_PAGE), then one in May.
    const june = Array.from({ length: 22 }, (_, i) =>
      pay('jun-' + i, `2026-06-${String(22 - i).padStart(2, '0')}`, 6000 + i))
    seed([...june, pay('may-1', '2026-05-15', 5999)])
    await renderLedger()

    const rows = ledgerRows()
    expect(rows).toHaveLength(22)
    expect(rows.some(r => /5\s*999/.test(r.textContent || ''))).toBe(false)
    // The count pill still reports the full ledger, not the visible slice.
    expect(document.querySelector('#betalningar .count-pill')?.textContent).toBe('23')
    expect(screen.getByRole('button', { name: /Visa en månad till/ })).toBeInTheDocument()
  })

  it('reveals exactly the next populated month per click and skips empty-month gaps', async () => {
    // June + March populated; April and May are empty calendar gaps.
    seed([
      pay('jun-1', '2026-06-10', 6001),
      pay('mar-1', '2026-03-10', 3001),
      pay('mar-2', '2026-03-05', 3002),
    ])
    const user = userEvent.setup()
    await renderLedger()
    expect(ledgerRows()).toHaveLength(1)

    // One click jumps straight to March — the empty April/May never cost a click.
    await user.click(screen.getByRole('button', { name: /Visa en månad till/ }))
    const texts = rowsText()
    expect(texts).toHaveLength(3)
    expect(texts.some(t => /3\s*001/.test(t))).toBe(true)
    expect(texts.some(t => /3\s*002/.test(t))).toBe(true)
    // No more months left → the expansion controls disappear, collapse remains.
    expect(screen.queryByRole('button', { name: /Visa en månad till/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Visa alla månader' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Visa senaste månaden' })).toBeInTheDocument()
  })

  it('reveals the full ledger through repeated one-month expansion', async () => {
    seed([
      pay('jun-1', '2026-06-10', 6001),
      pay('may-1', '2026-05-10', 5001),
      pay('apr-1', '2026-04-10', 4001),
    ])
    const user = userEvent.setup()
    await renderLedger()
    expect(ledgerRows()).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: /Visa en månad till/ }))
    expect(ledgerRows()).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: /Visa en månad till/ }))
    expect(ledgerRows()).toHaveLength(3)
    expect(screen.queryByRole('button', { name: /Visa en månad till/ })).not.toBeInTheDocument()
  })

  it('reveals every remaining row at once with Visa alla månader', async () => {
    seed([
      pay('jun-1', '2026-06-10', 6001),
      pay('may-1', '2026-05-10', 5001),
      pay('mar-1', '2026-03-10', 3001),
    ])
    const user = userEvent.setup()
    await renderLedger()

    await user.click(screen.getByRole('button', { name: 'Visa alla månader' }))
    expect(ledgerRows()).toHaveLength(3)
    expect(screen.queryByRole('button', { name: /Visa en månad till/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Visa senaste månaden' })).toBeInTheDocument()
  })

  it('collapses back to the newest month from both incremental and full expansion', async () => {
    seed([
      pay('jun-1', '2026-06-10', 6001),
      pay('may-1', '2026-05-10', 5001),
      pay('mar-1', '2026-03-10', 3001),
    ])
    const user = userEvent.setup()
    await renderLedger()

    await user.click(screen.getByRole('button', { name: 'Visa alla månader' }))
    expect(ledgerRows()).toHaveLength(3)
    await user.click(screen.getByRole('button', { name: 'Visa senaste månaden' }))
    expect(ledgerRows()).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Visa senaste månaden' })).not.toBeInTheDocument()

    // Same collapse after a single incremental reveal.
    await user.click(screen.getByRole('button', { name: /Visa en månad till/ }))
    expect(ledgerRows()).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: 'Visa senaste månaden' }))
    expect(ledgerRows()).toHaveLength(1)
  })

  it('renders no disclosure controls for a single-month ledger', async () => {
    seed([pay('jun-1', '2026-06-10', 6001), pay('jun-2', '2026-06-05', 6002)])
    await renderLedger()

    expect(ledgerRows()).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /Visa en månad till/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Visa alla månader' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Visa senaste månaden' })).not.toBeInTheDocument()
  })

  it('keeps independent month buckets per loan part and resets depth when the filter changes', async () => {
    // p1: June + May (two buckets). p2: June only (one bucket).
    seed([
      pay('jun-a', '2026-06-10', 6001, { loan_part_id: 'p1' }),
      pay('jun-b', '2026-06-09', 6002, { loan_part_id: 'p2' }),
      pay('may-a', '2026-05-10', 5001, { loan_part_id: 'p1' }),
    ], [part1, part2])
    const user = userEvent.setup()
    await renderLedger()

    // 'All' filter: two buckets. Expand to reveal May.
    await user.click(screen.getByRole('button', { name: /Visa en månad till/ }))
    expect(ledgerRows()).toHaveLength(3)

    // Filtering to Del B (June only) resets depth to one month AND that part's
    // ledger has a single bucket, so no disclosure controls remain.
    await user.click(screen.getByRole('radio', { name: 'Del B' }))
    expect(ledgerRows().map(r => r.textContent || '').some(t => /6\s*002/.test(t))).toBe(true)
    expect(ledgerRows()).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /Visa en månad till/ })).not.toBeInTheDocument()

    // Back to Del A: depth is reset to one month (only June), May hidden again.
    await user.click(screen.getByRole('radio', { name: 'Del A' }))
    expect(ledgerRows()).toHaveLength(1)
    expect(ledgerRows()[0].textContent).toMatch(/6\s*001/)
    expect(screen.getByRole('button', { name: /Visa en månad till/ })).toBeInTheDocument()
  })

  it('leads with the newest month even when rows arrive oldest-first', async () => {
    // Defensive: the store delivers newest-first, but the disclosure must not
    // depend on it — feed ascending order and the newest month still leads.
    seed([
      pay('mar-1', '2026-03-10', 3001),
      pay('may-1', '2026-05-10', 5001),
      pay('jul-1', '2026-07-10', 7001),
    ])
    await renderLedger()
    const texts = rowsText()
    expect(texts).toHaveLength(1)
    expect(texts[0]).toMatch(/7\s*001/)
  })

  it('preserves the deterministic order of same-date rows within a bucket', async () => {
    // Two June-10 rows delivered newest created_at first — the store's tie-break.
    seed([
      pay('late', '2026-06-10', 6001, { created_at: '2026-06-10T12:00:00' }),
      pay('early', '2026-06-10', 6002, { created_at: '2026-06-10T08:00:00' }),
    ])
    await renderLedger()
    const texts = rowsText()
    expect(texts.findIndex(t => /6\s*001/.test(t))).toBeLessThan(texts.findIndex(t => /6\s*002/.test(t)))
  })

  it('keeps an undated legacy row reachable, and shows it initially when it is the only bucket', async () => {
    // Undated-only ledger: one fallback bucket, visible immediately, no controls.
    seed([pay('u1', '', 4200, { created_at: '2026-01-02' }), pay('u2', '', 4300, { created_at: '2026-01-01' })])
    await renderLedger()
    expect(rowsText().some(t => /4\s*200/.test(t))).toBe(true)
    expect(screen.queryByRole('button', { name: /Visa en månad till/ })).not.toBeInTheDocument()
  })

  it('buckets undated rows after every dated month, reachable through the same controls', async () => {
    seed([
      pay('jun-1', '2026-06-10', 6001),
      pay('u1', '', 4200, { created_at: '2026-01-01' }),
    ])
    const user = userEvent.setup()
    await renderLedger()
    // June shows first; the undated bucket is hidden until revealed.
    expect(rowsText().some(t => /4\s*200/.test(t))).toBe(false)
    await user.click(screen.getByRole('button', { name: /Visa en månad till/ }))
    expect(rowsText().some(t => /4\s*200/.test(t))).toBe(true)
  })

  it('shows a newest-month predicted row with its godkänd prognos marker', async () => {
    seed([
      pay('pred', '2026-06-20', 6001, { source: 'predicted' }),
      pay('may-1', '2026-05-10', 5001),
    ])
    await renderLedger()
    expect(ledgerRows()).toHaveLength(1)
    expect(screen.getByText('godkänd prognos')).toBeInTheDocument()
  })

  it('keeps allocation disclosure and row actions working after an older month is revealed', async () => {
    seed([
      pay('jun-1', '2026-06-10', 6001),
      // Older insats row with a split — its allocation expands on demand.
      pay('may-insats', '2026-05-10', 5001, { kind: 'amortization', is_insats: true }),
    ])
    const user = userEvent.setup()
    await renderLedger()

    await user.click(screen.getByRole('button', { name: /Visa en månad till/ }))
    const insatsRow = ledgerRows().find(r => /5\s*001/.test(r.textContent || ''))!
    // Edit action is present on the revealed row.
    expect(insatsRow.querySelector('button[aria-label="Edit"]')).toBeInTheDocument()
    // Allocation chevron toggles the detail row open.
    await user.click(insatsRow.querySelector('button.expand-btn')!)
    expect(document.querySelector('.pay-detail')).toBeInTheDocument()
  })
})
