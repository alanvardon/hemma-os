// @vitest-environment jsdom
// Plan 109c Stage 2 — the change-bank wizard, the Tidigare avtal history modal
// and Ångra bankbyte. Mirrors Bolanekoll.agreement.test.tsx's harness (whole
// store auto-mocked, jsdom + RTL). Covers the plan's Stage-2 requirements:
//   1. wizard previews the copied fields, supports add/remove/edit drafts;
//   2. a total mismatch requires an explicit acknowledgement before confirm;
//   3. an RPC failure keeps the wizard open with a visible error (no partial
//      switch — a throwing store is not enough);
//   4. a successful change surfaces the Lägg till räntevillkor prompt;
//   5. history renders the archived agreement as Avslutat with rows scoped to it;
//   6. Ångra bankbyte shows only while the new agreement is transaction-free,
//      and a revert failure shows a visible error.
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
vi.mock('@number-flow/react', () => ({ default: ({ value }: { value: number }) => <span>{value}</span> }))
vi.mock('../lib/riksbank', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/riksbank')>(),
  fetchPolicyRate: vi.fn().mockRejectedValue(new Error('no network in tests')),
}))

function renderBolanekoll() {
  const router = createMemoryRouter([{ path: '/', element: <Bolanekoll /> }], { initialEntries: ['/'] })
  return render(<RouterProvider router={router} />)
}

const b1: Bank = { id: 'b1', created_at: '2026-01-01', label: 'Danske', year_basis: null, year_basis_source: null, billing: null, billing_source: null, catalog_id: null }
const b2: Bank = { id: 'b2', created_at: '2026-01-01', label: 'Swedbank', year_basis: null, year_basis_source: null, billing: null, billing_source: null, catalog_id: null }

const agreement: Mortgage = { id: 'm1', created_at: '2026-01-01', bank_id: 'b1', label: 'Vårt bolån', start_date: '2024-03-01', archived: false, end_date: null }
const part: LoanPart = {
  id: 'p1', created_at: '2026-01-01', label: 'Rörlig del', loan_number: '9021',
  start_balance: 1_000_000, original_balance: 1_000_000, start_date: '2024-03-01', archived: false, mortgage_id: 'm1',
}
const covering: RatePeriod = { id: 'r1', created_at: '2026-01-01', loan_part_id: 'p1', start_date: '2024-03-01', end_date: null, rate: 3.5, rate_type: 'rörlig' }

function stubEnv() {
  vi.stubGlobal('confirm', vi.fn(() => true))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  // jsdom's <dialog> has no showModal/close — polyfill enough for the tests.
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false }
}

function seedStore(over: {
  banks?: Bank[]; mortgages?: Mortgage[]; parts?: LoanPart[]; payments?: Payment[]; periods?: RatePeriod[]
} = {}) {
  const banks = over.banks ?? [b1, b2]
  const mortgages = over.mortgages ?? [agreement]
  const parts = over.parts ?? [part]
  const payments = over.payments ?? []
  const periods = over.periods ?? [covering]
  vi.mocked(Store.cachedSnapshot).mockReturnValue({
    version: 6, banks, mortgages, loan_parts: parts, payments, valuations: [], rate_periods: periods, contributions: [], settings: defaultSettings(),
  })
  vi.mocked(Store.listLoanParts).mockResolvedValue(parts)
  vi.mocked(Store.listPayments).mockResolvedValue(payments)
  vi.mocked(Store.listValuations).mockResolvedValue([])
  vi.mocked(Store.listRatePeriods).mockResolvedValue(periods)
  vi.mocked(Store.listContributions).mockResolvedValue([])
  vi.mocked(Store.getSettings).mockResolvedValue(defaultSettings())
  vi.mocked(Store.listBanks).mockResolvedValue(banks)
  vi.mocked(Store.listMortgages).mockResolvedValue(mortgages)
  vi.mocked(Store.listCatalogBanks).mockResolvedValue([])
}

beforeEach(() => {
  vi.clearAllMocks()
  stubEnv()
  seedStore()
})

// Walk the wizard from a freshly opened page to step 2 (bank chosen + Nästa).
async function openWizardToDrafts(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Byt bank' }))
  const dialog = await screen.findByRole('dialog', { name: 'Byt bank' })
  // Step 1: choose a DIFFERENT household bank (the current one is excluded).
  await user.selectOptions(within(dialog).getByRole('combobox'), 'existing:b2')
  await user.click(within(dialog).getByRole('button', { name: 'Nästa' }))
  return dialog as HTMLDialogElement
}

describe('Bolanekoll — change-bank wizard (plan 109c Stage 2)', () => {
  it('previews the copied fields, and supports add/edit/remove of drafts', async () => {
    const user = userEvent.setup()
    renderBolanekoll()
    const dialog = await openWizardToDrafts(user)

    // The draft is seeded from the copy preview: label + resolved balance.
    const labelInput = within(dialog).getByDisplayValue('Rörlig del') as HTMLInputElement
    expect(labelInput).toBeInTheDocument()
    expect(within(dialog).getByDisplayValue('1000000')).toBeInTheDocument()
    // Edit the label.
    await user.clear(labelInput)
    await user.type(labelInput, 'Ombunden del')
    expect(within(dialog).getByDisplayValue('Ombunden del')).toBeInTheDocument()
    // Add a draft, then remove one — count of balance inputs tracks the drafts.
    await user.click(within(dialog).getByRole('button', { name: '+ Lägg till lånedel' }))
    expect(within(dialog).getAllByRole('button', { name: 'Ta bort lånedel' })).toHaveLength(2)
    await user.click(within(dialog).getAllByRole('button', { name: 'Ta bort lånedel' })[1])
    expect(within(dialog).getAllByRole('button', { name: 'Ta bort lånedel' })).toHaveLength(1)

    // Review step states plainly that rate periods are NOT copied.
    await user.click(within(dialog).getByRole('button', { name: 'Nästa' }))
    expect(within(dialog).getByText(/Räntevillkoren måste läggas in på nytt/)).toBeInTheDocument()
  })

  it('requires an explicit acknowledgement when the drafts do not sum to the old closing debt', async () => {
    const user = userEvent.setup()
    renderBolanekoll()
    const dialog = await openWizardToDrafts(user)

    // Break the total: 900 000 vs the old agreement's 1 000 000 closing debt.
    const balanceInput = within(dialog).getByDisplayValue('1000000') as HTMLInputElement
    await user.clear(balanceInput)
    await user.type(balanceInput, '900000')
    await user.click(within(dialog).getByRole('button', { name: 'Nästa' }))

    // Review: the mismatch is flagged and Nästa is blocked until acknowledged.
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/skiljer sig/)
    const nextBtn = within(dialog).getByRole('button', { name: 'Nästa' })
    expect(nextBtn).toBeDisabled()
    await user.click(within(dialog).getByRole('checkbox'))
    expect(nextBtn).toBeEnabled()
  })

  it('keeps the wizard open and shows the error when the bank-change RPC fails', async () => {
    vi.mocked(Store.changeMortgageBank).mockRejectedValueOnce({ message: 'Failed to fetch' })
    const user = userEvent.setup()
    renderBolanekoll()
    const dialog = await openWizardToDrafts(user)

    await user.click(within(dialog).getByRole('button', { name: 'Nästa' })) // → review
    await user.click(within(dialog).getByRole('button', { name: 'Nästa' })) // → confirm
    await user.click(within(dialog).getByRole('button', { name: 'Byt bank' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Ingen anslutning. Ändringen sparades inte i molnet.')
    expect(dialog.open).toBe(true)
  })

  it('surfaces the Lägg till räntevillkor prompt after a successful bank change', async () => {
    const newAgreement: Mortgage = { id: 'm2', created_at: '2026-02-01', bank_id: 'b2', label: 'Bolån', start_date: '2026-02-01', archived: false, end_date: null }
    const newPart: LoanPart = { id: 'np1', created_at: '2026-02-01', label: 'Rörlig del', loan_number: '', start_balance: 1_000_000, original_balance: 1_000_000, start_date: '2026-02-01', archived: false, mortgage_id: 'm2' }
    vi.mocked(Store.changeMortgageBank).mockImplementationOnce(async () => {
      // After the change: old agreement archived, new active agreement with a
      // fresh part that has NO rate period (rates are deliberately not copied).
      vi.mocked(Store.listMortgages).mockResolvedValue([{ ...agreement, archived: true, end_date: '2026-02-01' }, newAgreement])
      vi.mocked(Store.listLoanParts).mockResolvedValue([{ ...part, archived: false }, newPart])
      vi.mocked(Store.listRatePeriods).mockResolvedValue([covering]) // covers old p1 only
      return { mortgage: newAgreement, parts: [newPart] }
    })
    const user = userEvent.setup()
    renderBolanekoll()
    const dialog = await openWizardToDrafts(user)

    await user.click(within(dialog).getByRole('button', { name: 'Nästa' })) // → review
    await user.click(within(dialog).getByRole('button', { name: 'Nästa' })) // → confirm
    await user.click(within(dialog).getByRole('button', { name: 'Byt bank' }))

    expect(await screen.findByRole('button', { name: /Lägg till räntevillkor/ })).toBeInTheDocument()
    expect(Store.changeMortgageBank).toHaveBeenCalledWith(expect.objectContaining({
      old_mortgage_id: 'm1', bank_id: 'b2', effective_date: expect.any(String),
    }))
  })
})

describe('Bolanekoll — Tidigare avtal + Ångra bankbyte (plan 109c Stage 2)', () => {
  const predecessor: Mortgage = { id: 'm0', created_at: '2023-01-01', bank_id: 'b1', label: 'Gammalt bolån', start_date: '2022-01-01', archived: true, end_date: '2025-06-01' }
  const successor: Mortgage = { id: 'm1', created_at: '2025-06-01', bank_id: 'b2', label: 'Nytt bolån', start_date: '2025-06-01', archived: false, end_date: null }
  const oldPart: LoanPart = { id: 'p0', created_at: '2023-01-01', label: 'Gammal del', loan_number: '111', start_balance: 800_000, original_balance: 800_000, start_date: '2022-01-01', archived: true, mortgage_id: 'm0' }
  const oldPayment: Payment = { id: 'pay0', created_at: '2024-01-01', loan_part_id: 'p0', date: '2024-01-15', kind: 'interest', description: 'Ränta', amount: 1800, balance_after: null, paid_by: 'joint', source: 'import', is_insats: false }
  const newPart: LoanPart = { id: 'p1', created_at: '2025-06-01', label: 'Ny del', loan_number: '', start_balance: 800_000, original_balance: 800_000, start_date: '2025-06-01', archived: false, mortgage_id: 'm1' }

  it('renders the archived agreement as Avslutat with its rows scoped to it, and offers Ångra bankbyte while the new agreement is transaction-free', async () => {
    seedStore({ banks: [b1, b2], mortgages: [predecessor, successor], parts: [oldPart, newPart], payments: [oldPayment], periods: [] })
    const user = userEvent.setup()
    renderBolanekoll()

    await user.click(await screen.findByRole('button', { name: 'Tidigare avtal' }))
    const dialog = await screen.findByRole('dialog', { name: 'Tidigare avtal' })
    // The archived agreement is labelled Avslutat and its own part/transaction show.
    expect(within(dialog).getByText('Avslutat')).toBeInTheDocument()
    expect(within(dialog).getByText('Gammal del')).toBeInTheDocument()
    expect(within(dialog).getByText('Ränta')).toBeInTheDocument()
    // The ACTIVE agreement's part is not part of this archived detail (scoping).
    expect(within(dialog).queryByText('Ny del')).not.toBeInTheDocument()
    // Ångra bankbyte is offered — the new agreement m1 has no transactions.
    expect(within(dialog).getByRole('button', { name: 'Ångra bankbyte' })).toBeInTheDocument()
  })

  it('hides Ångra bankbyte once the new agreement has a transaction', async () => {
    const newPayment: Payment = { id: 'payn', created_at: '2025-07-01', loan_part_id: 'p1', date: '2025-07-15', kind: 'interest', description: 'Ränta', amount: 1500, balance_after: null, paid_by: 'joint', source: 'import', is_insats: false }
    seedStore({ banks: [b1, b2], mortgages: [predecessor, successor], parts: [oldPart, newPart], payments: [oldPayment, newPayment], periods: [] })
    const user = userEvent.setup()
    renderBolanekoll()

    await user.click(await screen.findByRole('button', { name: 'Tidigare avtal' }))
    const dialog = await screen.findByRole('dialog', { name: 'Tidigare avtal' })
    expect(within(dialog).queryByRole('button', { name: 'Ångra bankbyte' })).not.toBeInTheDocument()
  })

  it('shows a visible error and stays open when the revert RPC fails', async () => {
    vi.mocked(Store.revertMortgageBankChange).mockRejectedValueOnce({ message: 'Failed to fetch' })
    seedStore({ banks: [b1, b2], mortgages: [predecessor, successor], parts: [oldPart, newPart], payments: [oldPayment], periods: [] })
    const user = userEvent.setup()
    renderBolanekoll()

    await user.click(await screen.findByRole('button', { name: 'Tidigare avtal' }))
    const dialog = await screen.findByRole('dialog', { name: 'Tidigare avtal' }) as HTMLDialogElement
    await user.click(within(dialog).getByRole('button', { name: 'Ångra bankbyte' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Ingen anslutning. Ändringen sparades inte i molnet.')
    expect(dialog.open).toBe(true)
    expect(Store.revertMortgageBankChange).toHaveBeenCalledWith('m1')
  })
})
