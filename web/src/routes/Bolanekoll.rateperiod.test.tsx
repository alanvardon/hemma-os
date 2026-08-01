// @vitest-environment jsdom
// Plan 127 §2 — the standalone PeriodDialog moved out of PartDialog into
// Bolanekoll.tsx as the ONE instance on the page: a Lånedelar row's one-click
// "Ny räntesats" and PartDialog's rate-history "Redigera" both target it, so a
// correction never stacks on top of another open dialog.
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
vi.mock('../lib/riksbank', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/riksbank')>(),
  fetchPolicyRate: vi.fn().mockRejectedValue(new Error('no network in tests')),
}))
vi.mock('../components/usePersonIdentity', () => ({ usePersonIdentity: vi.fn() }))
import { usePersonIdentity, type PersonIdentityView } from '../components/usePersonIdentity'

function identityView(): PersonIdentityView {
  return {
    status: 'ready', identity: null, configured: false, people: [],
    myPerson: null, personFor: () => null, isMe: () => false,
    myToolSlot: () => null,
    refresh: async () => {},
  }
}

function renderBolanekoll() {
  const router = createMemoryRouter([{ path: '/', element: <Bolanekoll /> }], {
    initialEntries: ['/'],
  })
  return render(<ConfirmProvider><RouterProvider router={router} /></ConfirmProvider>)
}

// One loan part with a single open-ended `rörlig` period — no known reprice
// date yet, the everyday state for a household on a rolling rörlig rate. That
// makes groupLoanParts bucket it as the "no reprice date set" folder, which
// the page auto-expands on load, so the member row's actions are reachable
// without first driving the folder's disclosure toggle.
const part = {
  id: 'p1', created_at: '2026-01-01', label: 'Lånedel 1', loan_number: '',
  start_balance: 1_000_000, start_date: '2026-01-01', archived: false,
}
const period = {
  id: 'rp1', created_at: '2026-01-01', loan_part_id: 'p1', start_date: '2026-01-01',
  end_date: null, rate: 3.93, rate_type: 'rörlig' as const,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(usePersonIdentity).mockReturnValue(identityView())
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
    version: 1, banks: [], mortgages: [],
    loan_parts: [part], payments: [], valuations: [], rate_periods: [period], contributions: [],
    settings: defaultSettings(),
  })
  vi.mocked(Store.listLoanParts).mockResolvedValue([part])
  vi.mocked(Store.listPayments).mockResolvedValue([])
  vi.mocked(Store.listValuations).mockResolvedValue([])
  vi.mocked(Store.listRatePeriods).mockResolvedValue([period])
  vi.mocked(Store.listContributions).mockResolvedValue([])
  vi.mocked(Store.getSettings).mockResolvedValue(defaultSettings())
  vi.mocked(Store.listBanks).mockResolvedValue([])
  vi.mocked(Store.listMortgages).mockResolvedValue([])
  vi.mocked(Store.listCatalogBanks).mockResolvedValue([])
})

describe('Bolanekoll — one-click Ny räntesats (plan 127 §2)', () => {
  it('opens the standalone create dialog for that part in one click', async () => {
    const user = userEvent.setup()
    renderBolanekoll()

    await user.click(await screen.findByRole('button', { name: 'Ny räntesats' }))

    const dialog = (await screen.findByRole('heading', { name: 'Ny räntesats', level: 3 })).closest('dialog')!
    expect(dialog.open).toBe(true)
    // A create never guesses the rate.
    expect(within(dialog).getByLabelText('Räntesats %')).toHaveValue('')
    // Exactly one dialog is open — no stacking.
    expect(document.querySelectorAll('dialog[open]').length).toBe(1)
  })
})

describe('Bolanekoll — editing a rate period from PartDialog closes it and opens the standalone dialog (plan 127 §2)', () => {
  it('never stacks PartDialog and the rate-period dialog', async () => {
    const user = userEvent.setup()
    renderBolanekoll()

    // Open the part for editing, then choose the period's Redigera action.
    await user.click(await screen.findByRole('button', { name: 'Edit' }))
    const partDialog = (await screen.findByRole('heading', { name: 'Edit loan part', level: 3 })).closest('dialog')!
    await user.click(within(partDialog).getByRole('button', { name: 'Redigera' }))

    // PartDialog is closed…
    expect(partDialog.open).toBe(false)
    // …and the standalone dialog is open in EDIT mode with the period's rate.
    const periodDialog = (await screen.findByRole('heading', { name: 'Redigera ränteperiod', level: 3 })).closest('dialog')!
    expect(periodDialog.open).toBe(true)
    expect(within(periodDialog).getByLabelText('Räntesats %')).toHaveValue('3.93')
    // Never two dialogs open at once.
    expect(document.querySelectorAll('dialog[open]').length).toBe(1)
  })
})
