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
import type { Bank, LoanPart, Mortgage, Payment, RatePeriod, Valuation } from '../lib/mortgage'

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
    // Plan 128 — drift is raised by the REPLAY fitter, not the old threshold
    // learner, so the ledger has to actually reproduce a /360 bank: 1 000 000 kr
    // at 3,60 % is exactly 100 kr/day under /360 (98,63 under /365), and the
    // five month-end charges below replay to a 0 kr residual over 4 intervals —
    // the fitter's proof — while the lock says 365.
    const periods: RatePeriod[] = [
      { id: 'r1', created_at: '2026-01-01', loan_part_id: 'p1', start_date: '2024-03-01', end_date: '2025-02-28', rate: 3.6, rate_type: 'bunden' },
      { id: 'r2', created_at: '2026-01-01', loan_part_id: 'p1', start_date: '2025-03-01', end_date: '2026-02-28', rate: 3.6, rate_type: 'bunden' },
    ]
    const charges: Array<[string, number]> = [
      ['2024-04-30', 3000],                     // no preceding row — not replayed
      ['2024-05-31', 3100], ['2024-06-30', 3000], // 31 d · 30 d
      ['2024-07-31', 3100], ['2024-08-31', 3100], // 31 d · 31 d
    ]
    const payments: Payment[] = charges.map(([d, amount], i) => ({
      id: 'int' + i, created_at: d, loan_part_id: 'p1', date: d, kind: 'interest',
      description: 'Ränta', amount, balance_after: 1_000_000, paid_by: 'joint', source: 'import', is_insats: false,
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
    // Plan 128 Stage 5 — the replay evidence behind the drift is visible in the
    // same modal, wired all the way from Bolanekoll.tsx's fitBankProfile memo.
    expect(within(dialog).getByText(/Modellen återskapar bankens 4 senaste debiteringar inom 0 kr\./)).toBeInTheDocument()
  })
})

describe('Bolanekoll — create-agreement bank picker placeholder (plan 109c bug fix)', () => {
  it('shows a disabled placeholder and keeps Skapa disabled until a bank is actively chosen when only catalogue banks exist', async () => {
    // No household banks and no agreement — the picker offers only a catalogue
    // bank (Danske). Regression: the native <select> used to render Danske as if
    // it were chosen while the state was still empty, so Skapa stayed disabled
    // with no hint why.
    vi.mocked(Store.cachedSnapshot).mockReturnValue({
      version: 6, banks: [], mortgages: [],
      loan_parts: [], payments: [], valuations: [], rate_periods: [], contributions: [],
      settings: defaultSettings(),
    })
    vi.mocked(Store.listBanks).mockResolvedValue([])
    vi.mocked(Store.listMortgages).mockResolvedValue([])
    vi.mocked(Store.listLoanParts).mockResolvedValue([])
    const user = userEvent.setup()
    renderBolanekoll()

    await user.click(await screen.findByRole('button', { name: 'Skapa bolåneavtal' }))
    const dialog = await screen.findByRole('dialog', { name: 'Skapa bolåneavtal' })

    // The picker reads as unchosen — the placeholder is the selected option, not
    // the first catalogue bank (the visual state must not lie).
    const select = within(dialog).getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('')
    const placeholder = within(dialog).getByRole('option', { name: 'Välj bank…' }) as HTMLOptionElement
    expect(placeholder.selected).toBe(true)
    expect(placeholder.disabled).toBe(true)

    // Every visible field LOOKS filled (name optional, date defaults to today),
    // yet Skapa stays disabled precisely because no bank is chosen.
    const skapa = within(dialog).getByRole('button', { name: 'Skapa' })
    expect(skapa).toBeDisabled()

    // Actively picking the catalogue bank commits it to state and enables Skapa.
    await user.selectOptions(select, 'catalog:catalog-danske')
    expect(skapa).toBeEnabled()
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

  it('submits a charge_basis lock alongside the other conventions when saving', async () => {
    // Plan 128 Stage 5 — the third control writes 'declared' exactly like
    // year_basis/billing, through the same submit payload.
    vi.mocked(Store.updateBank).mockResolvedValueOnce({ ...bank, charge_basis: 'monthly', charge_basis_source: 'declared' })
    const user = userEvent.setup()
    renderBolanekoll()

    await user.click(await screen.findByRole('button', { name: 'Bankprofil' }))
    const dialog = screen.getByRole('dialog', { name: 'Bankprofil' }) as HTMLDialogElement
    await user.click(within(dialog).getByRole('radio', { name: 'Fast månadsränta' }))
    await user.click(within(dialog).getByRole('button', { name: 'Spara' }))

    expect(await screen.findByText('Bankprofil sparad.')).toBeInTheDocument()
    expect(Store.updateBank).toHaveBeenCalledWith('b1', expect.objectContaining({
      charge_basis: 'monthly', charge_basis_source: 'declared',
    }))
    expect(dialog.open).toBe(false)
  })
})

// ── Plan 109c — active-agreement scoping after a bank change (decision 6) ─────
// The bank-change RPC archives the AGREEMENT, never the old agreement's loan
// parts, so the ACTIVE ledger must scope by the mortgage link — not by a part's
// own `archived` flag (which stays false on the old parts). This proves the fix
// for the "2 parts, 580 000 kr merged after a switch" bug: the active view shows
// ONLY the active agreement's parts/debt, an unlinked legacy part stays visible
// in a repair state, and the old agreement's down payment still counts for
// ownership (it is full-history, not scoped down).
describe('Bolanekoll — active view scopes to the active agreement (plan 109c)', () => {
  const oldAgreement: Mortgage = {
    id: 'm0', created_at: '2023-01-01', bank_id: 'b1', label: 'Gammalt bolån',
    start_date: '2020-01-01', archived: true, end_date: '2024-03-01',
  }
  // The old agreement's loan part — NEVER archived at the part level (the RPC
  // archives only the agreement), linked to the closed agreement m0.
  const oldPart: LoanPart = {
    id: 'p0', created_at: '2023-01-01', label: 'Gammal del', loan_number: '1111',
    start_balance: 300_000, original_balance: 300_000, start_date: '2020-01-01', archived: false,
    mortgage_id: 'm0',
  }
  // A legacy part with no agreement link (possible via old JSON import) — must
  // stay VISIBLE in the active ledger with a repair indicator, not disappear.
  const unlinkedPart: LoanPart = {
    id: 'pX', created_at: '2021-01-01', label: 'Legacy del', loan_number: '9999',
    start_balance: 100_000, original_balance: 100_000, start_date: '2021-01-01', archived: false,
    mortgage_id: null,
  }
  // The old agreement's kontantinsats — retains its (archived) agreement but
  // must still show in the ownership view (Kontantinsatser), full history.
  const oldDownPayment: Payment = {
    id: 'dp0', created_at: '2020-01-01', loan_part_id: null, date: '2020-01-01',
    kind: 'down_payment', description: 'Kontantinsats', amount: 200_000, balance_after: null,
    paid_by: 'joint', source: 'manual', is_insats: false, mortgage_id: 'm0',
  }

  beforeEach(() => {
    const allParts = [part, oldPart, unlinkedPart]
    const allMortgages = [agreement, oldAgreement]
    const allPayments = [oldDownPayment]
    vi.mocked(Store.cachedSnapshot).mockReturnValue({
      version: 6, banks: [bank], mortgages: allMortgages,
      loan_parts: allParts, payments: allPayments, valuations: [], rate_periods: [], contributions: [],
      settings: defaultSettings(),
    })
    vi.mocked(Store.listLoanParts).mockResolvedValue(allParts)
    vi.mocked(Store.listMortgages).mockResolvedValue(allMortgages)
    vi.mocked(Store.listPayments).mockResolvedValue(allPayments)
  })

  it('shows only the active + unlinked parts and their combined debt, not the old agreement', async () => {
    const { container } = renderBolanekoll()
    await screen.findByRole('heading', { name: /Bolåneavtal/ })

    // Active debt = active part (1 000 000) + unlinked part (100 000) = 1 100 000.
    // The old agreement's 300 000 is NOT merged in (the bug would give 1 400 000).
    expect(container.querySelector('[data-current-debt="1100000"]')).not.toBeNull()
    expect(container.querySelector('[data-current-debt="1400000"]')).toBeNull()

    // The loan-part ledger lists the active and unlinked parts, never the old one.
    const ledger = container.querySelector('.lanedelar-table') as HTMLElement
    expect(within(ledger).getByText('Rörlig del')).toBeInTheDocument()
    expect(within(ledger).getByText('Legacy del')).toBeInTheDocument()
    expect(within(ledger).queryByText('Gammal del')).not.toBeInTheDocument()

    // The Bolåneavtal count-pill counts the active-view parts (2), not all 3.
    const agreementCard = ledger.closest('.card') as HTMLElement
    expect(within(agreementCard).getByText('2', { selector: '.count-pill' })).toBeInTheDocument()
  })

  it('keeps the unlinked legacy part visible with an "ej kopplad" repair indicator', async () => {
    const { container } = renderBolanekoll()
    await screen.findByRole('heading', { name: /Bolåneavtal/ })

    const ledger = container.querySelector('.lanedelar-table') as HTMLElement
    const legacyRow = within(ledger).getByText('Legacy del').closest('tr') as HTMLElement
    expect(within(legacyRow).getByText(/ej kopplad/)).toBeInTheDocument()
    // The linked active part carries no repair flag.
    const activeRow = within(ledger).getByText('Rörlig del').closest('tr') as HTMLElement
    expect(within(activeRow).queryByText(/ej kopplad/)).not.toBeInTheDocument()
  })

  it('still counts the old agreement’s down payment for ownership (full history, not scoped)', async () => {
    const { container } = renderBolanekoll()
    await screen.findByRole('heading', { name: /Bolåneavtal/ })

    // The pre-refinance kontantinsats survives the bank change: it is retained
    // in the Kontantinsatser (ownership) view even though its agreement closed.
    const insatsCard = container.querySelector('#kontantinsatser') as HTMLElement
    expect(insatsCard.querySelector('[data-source-payment-id="dp0"]')).not.toBeNull()
    expect(within(insatsCard).getByText('1', { selector: '.count-pill' })).toBeInTheDocument()
  })
})

// ── Share column measured against the köpeskilling ───────────────────────────
// When a purchase price is recorded, each loan part's Share is a fraction of the
// köpeskilling (not of the loan alone), so the parts sum to loan/price and the
// remainder up to 100 % is Insatt kapital (balance + costBasisEq ≡ price). With
// no köpeskilling the column falls back to the loan-only basis and still reads
// 100 %, with no Insatt kapital row.
describe('Bolanekoll — Share reconciles to the köpeskilling', () => {
  const purchase: Valuation = {
    id: 'v-buy', created_at: '2024-03-01', date: '2024-03-01',
    value: 2_000_000, note: 'Köpeskilling', is_purchase: true,
  }

  it('measures Share against the price and adds an Insatt kapital remainder row', async () => {
    // One part at 1 000 000 against a 2 000 000 köpeskilling: the part is 50 % of
    // the price and Insatt kapital (2 000 000 − 1 000 000) is the other 50 %.
    vi.mocked(Store.cachedSnapshot).mockReturnValue({
      version: 6, banks: [bank], mortgages: [agreement],
      loan_parts: [part], payments: [], valuations: [purchase], rate_periods: [], contributions: [],
      settings: defaultSettings(),
    })
    vi.mocked(Store.listValuations).mockResolvedValue([purchase])

    const { container } = renderBolanekoll()
    await screen.findByRole('heading', { name: /Bolåneavtal/ })

    const ledger = container.querySelector('.lanedelar-table') as HTMLElement
    const insattRow = ledger.querySelector('tr.ld-insatt') as HTMLElement
    expect(insattRow).not.toBeNull()
    expect(within(insattRow).getByText('Insatt kapital')).toBeInTheDocument()
    expect(insattRow).toHaveTextContent('50,00 %')

    // The single loan-part group also reads 50 % — not the loan-only 100 %.
    const groupRow = within(ledger).getByText('Rörlig del').closest('tr') as HTMLElement
    expect(groupRow).toHaveTextContent('50,00 %')
    expect(groupRow).not.toHaveTextContent('100,00 %')
  })

  it('falls back to the loan-only basis (100 %, no Insatt row) when no köpeskilling is recorded', async () => {
    const { container } = renderBolanekoll()
    await screen.findByRole('heading', { name: /Bolåneavtal/ })

    const ledger = container.querySelector('.lanedelar-table') as HTMLElement
    expect(ledger.querySelector('tr.ld-insatt')).toBeNull()
    const groupRow = within(ledger).getByText('Rörlig del').closest('tr') as HTMLElement
    expect(groupRow).toHaveTextContent('100,00 %')
  })
})
