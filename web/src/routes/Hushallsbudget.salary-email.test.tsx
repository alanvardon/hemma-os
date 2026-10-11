// @vitest-environment jsdom
// Plan 132, Stage 5 — the in-app side of the "email each person their own
// salary half" flow: a pending emailed draft prefills its column and tags it,
// saving discards that month's drafts (and a discard FAILURE still leaves the
// submission saved and tells the user via a toast that survives the modal
// closing), the "waiting for…" note renders off a single pending draft, and
// the reminder settings row saves on change / reverts + toasts on failure.
// Per AGENTS.md ("Writes, failures, and cache/cloud disagreement") these are
// data-mutation paths, so this asserts on the actual store calls AND on what
// the user sees — not just that a pure function returns the right shape.
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultState } from '../lib/hushallsbudget'
import * as budgetStore from '../lib/hushallsbudget-store'
import * as salaryStore from '../lib/salary-store'
import * as draftsStore from '../lib/salary-drafts-store'
import * as settingsStore from '../lib/salary-reminder-settings-store'
import { usePersonIdentity } from '../components/usePersonIdentity'
import type { PersonIdentityView } from '../components/usePersonIdentity'
import Hushallsbudget from './Hushallsbudget'

vi.mock('../lib/hushallsbudget-store')
vi.mock('../lib/mortgage-store', () => ({ loadMortgageSyncSnapshot: () => Promise.resolve(null) }))
vi.mock('../lib/salary-store')
vi.mock('../lib/salary-drafts-store')
vi.mock('../lib/salary-reminder-settings-store')
vi.mock('../components/usePersonIdentity')
// visx charts need a real ResizeObserver (absent in jsdom) — stub the donut.
vi.mock('../components/charts/BudgetDonutChart', () => ({ default: () => null }))
// NumberFlow's getSnapshotBeforeUpdate needs browser layout APIs jsdom lacks;
// a save/modal interaction re-renders the summary figures (see
// Hushallsbudget.mortgagesync.test.tsx for the same stub).
vi.mock('../components/AnimatedNumber', () => ({
  Money: ({ value }: { value: number }) => <span>{Math.round(value)}</span>,
  Percent: ({ value }: { value: number }) => <span>{value}</span>,
  Num: ({ value }: { value: number }) => <span>{value}</span>,
  MoneyCompact: ({ value }: { value: number }) => <span>{Math.round(value)}</span>,
}))

const PA = { id: 'p-a', slot: 'a' as const, display_name: 'Alex', assigned_email: null }
const PB = { id: 'p-b', slot: 'b' as const, display_name: 'Sam', assigned_email: null }
const IDENTITY: PersonIdentityView = {
  status: 'ready', identity: null, configured: true, people: [PA, PB], myPerson: null,
  personFor: (tool, s) => (tool === 'hushallsbudget' ? (s === 'a' ? PA : PB) : null),
  isMe: () => false, myToolSlot: () => null, refresh: async () => {},
}

// Mirrors Hushallsbudget.tsx's own currentMonth()/monthLabel() so the
// pending-note assertion doesn't hardcode "today".
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function currentMonth(): string { return new Date().toISOString().slice(0, 7) }
function monthLabel(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym)!
  return MONTHS[parseInt(m[2], 10) - 1] + ' ' + m[1]
}
const THIS_MONTH = currentMonth()

function renderRoute() {
  const router = createMemoryRouter([
    { path: '/hushallsbudget', element: <Hushallsbudget /> },
    { path: '/', element: <div>Home</div> },
  ], { initialEntries: ['/hushallsbudget'] })
  return render(<RouterProvider router={router} />)
}

async function openSalaryModal() {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: /submit this month.s salaries/i }))
  return user
}

// The page ALSO has its own top-of-page `.income-col`s (same class name, the
// budget baseline editor) — scope to the open modal's dialog so a match there
// never shadows the modal's SalaryItemColumn.
function incomeColumnFor(name: string): HTMLElement {
  const dialog = document.querySelector('dialog.hb-modal')
  if (!dialog) throw new Error('salary modal dialog not found')
  const heads = within(dialog as HTMLElement).getAllByText(name)
  const col = heads.map((el) => el.closest('.income-col')).find((el): el is HTMLElement => el !== null)
  if (!col) throw new Error(`no income column found for ${name}`)
  return col
}

beforeEach(() => {
  vi.clearAllMocks()
  const state = { ...defaultState(), people: ['Alex', 'Sam'] }
  vi.mocked(budgetStore.loadBudget).mockResolvedValue(state)
  vi.mocked(budgetStore.saveBudget).mockResolvedValue(undefined)
  vi.mocked(salaryStore.list).mockResolvedValue([])
  vi.mocked(usePersonIdentity).mockReturnValue(IDENTITY)
  vi.mocked(draftsStore.listDrafts).mockResolvedValue([])
  vi.mocked(draftsStore.discardDrafts).mockResolvedValue(undefined)
  vi.mocked(settingsStore.loadSalaryReminderSettings).mockResolvedValue({ settings: { enabled: true, send_day: 25 }, unknown: false })
  vi.mocked(settingsStore.saveSalaryReminderSettings).mockResolvedValue(undefined)
})

describe('SalaryModal — emailed draft prefill', () => {
  it('prefills slot B from its pending draft and tags the column, leaving slot A on the baseline', async () => {
    vi.mocked(draftsStore.listDrafts).mockResolvedValue([
      { slot: 'b', income_items: [{ label: 'Lön', amount: 38900 }], note: null },
    ])
    renderRoute()
    await openSalaryModal()

    const colB = incomeColumnFor('Sam')
    await waitFor(() => expect(within(colB).getByDisplayValue('38 900')).toBeInTheDocument())
    expect(within(colB).getByText('Submitted via email')).toBeInTheDocument()

    const colA = incomeColumnFor('Alex')
    expect(within(colA).queryByText('Submitted via email')).not.toBeInTheDocument()
    // Slot A has no draft — untouched baseline amount (defaultState's 46000).
    expect(within(colA).getByDisplayValue('46 000')).toBeInTheDocument()
  })
})

describe('Pending "waiting for…" note', () => {
  it('renders with the submitter and the other person’s name when exactly one draft exists', async () => {
    vi.mocked(draftsStore.listDrafts).mockResolvedValue([
      { slot: 'b', income_items: [{ label: 'Lön', amount: 38900 }], note: null },
    ])
    renderRoute()
    const note = await screen.findByText((_c, el) => el?.classList.contains('salary-pending-note') ?? false)
    expect(note.textContent).toBe(`Sam has submitted for ${monthLabel(THIS_MONTH)} — waiting for Alex`)
  })

  it('shows nothing when there is no pending draft', async () => {
    renderRoute()
    await screen.findByRole('button', { name: /submit this month.s salaries/i })
    expect(screen.queryByText((_c, el) => el?.classList.contains('salary-pending-note') ?? false)).not.toBeInTheDocument()
  })

  it('shows nothing when both halves are already in (two drafts)', async () => {
    vi.mocked(draftsStore.listDrafts).mockResolvedValue([
      { slot: 'a', income_items: [{ label: 'Lön', amount: 42000 }], note: null },
      { slot: 'b', income_items: [{ label: 'Lön', amount: 38900 }], note: null },
    ])
    renderRoute()
    await screen.findByRole('button', { name: /submit this month.s salaries/i })
    expect(screen.queryByText((_c, el) => el?.classList.contains('salary-pending-note') ?? false)).not.toBeInTheDocument()
  })

  it('carries the emailed notes into the note field (A first, " · "-joined) so finishing in-app keeps them', async () => {
    vi.mocked(draftsStore.listDrafts).mockResolvedValue([
      { slot: 'b', income_items: [{ label: 'Lön', amount: 38900 }], note: ' parental leave ' },
      { slot: 'a', income_items: [{ label: 'Lön', amount: 42000 }], note: 'bonus' },
    ])
    renderRoute()
    const user = await openSalaryModal()

    await waitFor(() => expect(screen.getByLabelText(/^Note/)).toHaveValue('bonus · parental leave'))
    await user.click(screen.getByRole('button', { name: /confirm.*save/i }))
    await waitFor(() => expect(salaryStore.add).toHaveBeenCalledWith(expect.objectContaining({ note: 'bonus · parental leave' })))
  })
})

describe('Save → discard drafts', () => {
  it('on a successful save, discards that month’s drafts', async () => {
    renderRoute()
    const user = await openSalaryModal()
    await user.click(screen.getByRole('button', { name: /confirm.*save/i }))
    await waitFor(() => expect(salaryStore.add).toHaveBeenCalled())
    await waitFor(() => expect(draftsStore.discardDrafts).toHaveBeenCalledWith(THIS_MONTH))
  })

  it('when discardDrafts fails, the submission still counts and the user sees a toast that survives the modal closing', async () => {
    vi.mocked(draftsStore.discardDrafts).mockRejectedValue(new Error('rpc failed'))
    renderRoute()
    const user = await openSalaryModal()
    await user.click(screen.getByRole('button', { name: /confirm.*save/i }))

    // The submission is saved regardless of the discard outcome.
    await waitFor(() => expect(salaryStore.add).toHaveBeenCalled())
    // The modal closes as it does today...
    await waitFor(() => expect(document.querySelector('dialog.hb-modal')).not.toHaveAttribute('open'))
    // ...but the failure notice is still visible (it lives in the PARENT's
    // own toast, not the modal's, which would have unmounted it).
    expect(await screen.findByText('Saved, but couldn’t clear the emailed entry — it will be cleared next time.')).toBeInTheDocument()
  })
})

describe('Reminder settings row', () => {
  it('saves a change to the send day', async () => {
    renderRoute()
    const select = await screen.findByRole('combobox', { name: /day of month to send the salary reminder email/i })
    await waitFor(() => expect(select).not.toBeDisabled())
    const user = userEvent.setup()
    await user.selectOptions(select, '10')
    await waitFor(() => expect(settingsStore.saveSalaryReminderSettings).toHaveBeenCalledWith({ enabled: true, send_day: 10 }))
  })

  it('on a save failure, reverts the control and shows a toast', async () => {
    vi.mocked(settingsStore.saveSalaryReminderSettings).mockRejectedValue(new Error('network'))
    renderRoute()
    const toggle = await screen.findByRole('checkbox', { name: /email salary reminder on/i })
    await waitFor(() => expect(toggle).not.toBeDisabled())
    expect(toggle).toBeChecked()
    const user = userEvent.setup()
    await user.click(toggle)
    // Optimistic uncheck, then the rejected save reverts it back to checked.
    await waitFor(() => expect(toggle).toBeChecked())
    expect(await screen.findByText('Couldn’t save the reminder setting — try again.')).toBeInTheDocument()
  })
})
