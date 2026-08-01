// @vitest-environment jsdom
// Plan 127 §4 — the Kommande band: a default-collapsed, separate preview of
// rate periods that have not started yet, sitting above the Lånedelar table.
// Dates are built relative to `today` (via addDaysISO/todayISO), never
// hard-coded, so the suite doesn't rot as the wall clock moves — the same
// discipline Stage 3's Bolanekoll.rateperiod.test.tsx uses, and it matters
// even more here since the whole feature is date-relative.
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Bolanekoll from './Bolanekoll'
import { ConfirmProvider } from '../components/useConfirm'
import * as Store from '../lib/mortgage-store'
import { defaultSettings, addDaysISO, todayISO } from '../lib/mortgage'

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

function setupCommon() {
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
  vi.mocked(Store.listPayments).mockResolvedValue([])
  vi.mocked(Store.listValuations).mockResolvedValue([])
  vi.mocked(Store.listContributions).mockResolvedValue([])
  vi.mocked(Store.getSettings).mockResolvedValue(defaultSettings())
  vi.mocked(Store.listBanks).mockResolvedValue([])
  vi.mocked(Store.listMortgages).mockResolvedValue([])
  vi.mocked(Store.listCatalogBanks).mockResolvedValue([])
}

const today = todayISO()
function d(n: number): string {
  const iso = addDaysISO(today, n)
  if (iso == null) throw new Error('addDaysISO failed in test fixture')
  return iso
}

const part1 = {
  id: 'p1', created_at: '2026-01-01', label: 'Lånedel 1', loan_number: '',
  start_balance: 1_000_000, start_date: '2020-01-01', archived: false,
}
const part2 = {
  id: 'p2', created_at: '2026-01-01', label: 'Lånedel 2', loan_number: '',
  start_balance: 500_000, start_date: '2020-01-01', archived: false,
}

// p1: a current period, then TWO future periods on two different start
// dates — deliberately on the SAME part, so groups.length (2) and
// uniquePartCount (1) diverge, proving the chip shows the unique-part count
// and not the row/group count.
const p1Current = {
  id: 'rp1-current', created_at: '2026-01-01', loan_part_id: 'p1',
  start_date: d(-60), end_date: d(9), rate: 3.93, rate_type: 'rörlig' as const,
}
const p1Next1 = {
  id: 'rp1-next1', created_at: '2026-01-01', loan_part_id: 'p1',
  start_date: d(10), end_date: d(39), rate: 4.29, rate_type: 'rörlig' as const,
}
const p1Next2 = {
  id: 'rp1-next2', created_at: '2026-01-01', loan_part_id: 'p1',
  start_date: d(40), end_date: null, rate: 4.61, rate_type: 'bunden' as const,
}
// p2: only a current, open-ended period — nothing upcoming on this part.
const p2Current = {
  id: 'rp2-current', created_at: '2026-01-01', loan_part_id: 'p2',
  start_date: d(-90), end_date: null, rate: 3.5, rate_type: 'rörlig' as const,
}

const upcomingFixtureParts = [part1, part2]
const upcomingFixturePeriods = [p1Current, p1Next1, p1Next2, p2Current]

function mockSnapshot(parts: typeof upcomingFixtureParts, periods: typeof upcomingFixturePeriods) {
  vi.mocked(Store.cachedSnapshot).mockReturnValue({
    version: 1, banks: [], mortgages: [],
    loan_parts: parts, payments: [], valuations: [], rate_periods: periods, contributions: [],
    settings: defaultSettings(),
  })
  vi.mocked(Store.listLoanParts).mockResolvedValue(parts)
  vi.mocked(Store.listRatePeriods).mockResolvedValue(periods)
}

describe('Bolanekoll — Kommande band (plan 127 §4)', () => {
  beforeEach(() => {
    setupCommon()
    mockSnapshot(upcomingFixtureParts, upcomingFixturePeriods)
  })

  it('is collapsed by default: the toggle reads aria-expanded=false and the table is not in the document', async () => {
    renderBolanekoll()
    const toggle = await screen.findByRole('button', { name: /kommande ränteperioder/i })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Startdatum')).not.toBeInTheDocument()
  })

  it('the collapsed chip shows the earliest countdown and the UNIQUE part count, not the group count', async () => {
    renderBolanekoll()
    const toggle = await screen.findByRole('button', { name: /kommande ränteperioder/i })
    // Earliest upcoming start is d(10) → "om 10 dagar".
    expect(within(toggle).getByText('om 10 dagar')).toBeInTheDocument()
    // Two groups exist (d(10) and d(40)), but both belong to part1 alone —
    // the chip must read "1 lånedel", not "2".
    expect(within(toggle).getByText('1 lånedel')).toBeInTheDocument()
  })

  it('expanding reveals every group and each row carries no balance/share values', async () => {
    const user = userEvent.setup()
    renderBolanekoll()
    const toggle = await screen.findByRole('button', { name: /kommande ränteperioder/i })
    await user.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const table = (await screen.findByText('Startdatum')).closest('table')!
    // Only the Kommande-specific columns — no Balance/Share header at all.
    const headerText = within(table).getByRole('row', { name: /Startdatum/ }).textContent || ''
    expect(headerText).not.toMatch(/Balance/i)
    expect(headerText).not.toMatch(/Share/i)

    // Both future periods on part1 appear as separate rows (two groups).
    expect(within(table).getByText(/4,29 %/)).toBeInTheDocument()
    expect(within(table).getByText(/4,61 %/)).toBeInTheDocument()
    expect(within(table).getAllByText('Lånedel 1')).toHaveLength(2)
    // No money figure (kr) or percentage-share figure is rendered anywhere
    // in the expanded table — only the rate badges above, which are %, not kr.
    expect(within(table).queryByText(/kr\b/)).not.toBeInTheDocument()
  })

  it('the edit action opens the standalone PeriodDialog in edit mode with that period', async () => {
    const user = userEvent.setup()
    renderBolanekoll()
    const toggle = await screen.findByRole('button', { name: /kommande ränteperioder/i })
    await user.click(toggle)

    const table = (await screen.findByText('Startdatum')).closest('table')!
    const row = within(table).getByText(/4,61 %/).closest('tr')!
    await user.click(within(row).getByRole('button', { name: /redigera/i }))

    const dialog = (await screen.findByRole('heading', { name: 'Redigera ränteperiod', level: 3 })).closest('dialog')!
    expect(dialog.open).toBe(true)
    expect(within(dialog).getByLabelText('Räntesats %')).toHaveValue('4.61')
    // Exactly one dialog — never stacked on the Kommande band itself.
    expect(document.querySelectorAll('dialog[open]').length).toBe(1)
  })
})

describe('Bolanekoll — Kommande band absence (plan 127 §4)', () => {
  it('renders no band at all when nothing is upcoming', async () => {
    setupCommon()
    mockSnapshot([part1], [p1Current])
    renderBolanekoll()
    // Let the initial async load settle on something we know renders.
    await screen.findByRole('heading', { name: /Bolåneavtal/, level: 2 })
    expect(screen.queryByRole('button', { name: /kommande ränteperioder/i })).not.toBeInTheDocument()
    expect(screen.queryByText('Startdatum')).not.toBeInTheDocument()
  })
})
