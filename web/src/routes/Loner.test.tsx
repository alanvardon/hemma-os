// @vitest-environment jsdom
// Plan 139, Stage 3 — the Löner tool. Per AGENTS.md ("Writes, failures, and
// cache/cloud disagreement") every save path is asserted on the actual store
// calls AND on what the user sees: a failed save keeps the dialog open with the
// inputs intact and shows a Swedish message; a conflict says so; a half can
// only be created for your own slot (or an unassigned one); an emailed draft is
// visible at once with its amounts; and editing a complete month shows the
// recomputed transfer. Also ports the still-relevant reminder-settings
// assertions from the old Hushallsbudget.salary-email test.
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSubmission, defaultState, money as fmt } from '../lib/hushallsbudget'
import type { SalarySubmission } from '../lib/hushallsbudget'
import * as budgetStore from '../lib/hushallsbudget-store'
import * as salaryStore from '../lib/salary-store'
import * as draftsStore from '../lib/salary-drafts-store'
import * as emailStore from '../lib/salary-email-store'
import * as settingsStore from '../lib/salary-reminder-settings-store'
import { PersistenceError } from '../lib/persistence-error'
import { usePersonIdentity } from '../components/usePersonIdentity'
import type { PersonIdentityView } from '../components/usePersonIdentity'
import Loner from './Loner'
import { currentMonth, monthLabel } from './loner-labels'

vi.mock('../lib/hushallsbudget-store')
vi.mock('../lib/salary-store')
// Keep the real typed errors (the route matches them with instanceof); mock the I/O.
vi.mock('../lib/salary-drafts-store', async (importActual) => {
  const actual = await importActual<typeof import('../lib/salary-drafts-store')>()
  return { ...actual, listDrafts: vi.fn(), saveHalf: vi.fn(), discardDrafts: vi.fn() }
})
vi.mock('../lib/salary-reminder-settings-store')
vi.mock('../lib/salary-email-store')
vi.mock('../components/usePersonIdentity')

const THIS_MONTH = currentMonth()
const DRAFT_AT = '2026-10-03T08:00:00.123456+00:00'

function person(slot: 'a' | 'b', name: string, assigned: string | null) {
  return { id: `p-${slot}`, slot, display_name: name, assigned_email: assigned }
}
// `mine` is the signed-in slot (null = account not linked to a person).
function identityView(mine: 'a' | 'b' | null, bAssigned: string | null = 'sam@example.com'): PersonIdentityView {
  const PA = person('a', 'Alex', 'alex@example.com')
  const PB = person('b', 'Sam', bAssigned)
  const me = mine === 'a' ? PA : mine === 'b' ? PB : null
  return {
    status: 'ready',
    identity: { householdId: 'h1', myPersonId: me?.id ?? null, myProfileName: null, people: [PA, PB] },
    configured: true, people: [PA, PB], myPerson: me,
    personFor: () => null, isMe: () => false, myToolSlot: () => null, refresh: async () => {},
  }
}

function draft(slot: 'a' | 'b', amount: number, via: 'email' | 'app' = 'email', note: string | null = null): draftsStore.SalaryDraft {
  return { month: THIS_MONTH, slot, income_items: [{ label: 'Lön', amount }], note, submitted_via: via, updated_at: DRAFT_AT }
}

// The plan's "Base" golden row: A 38 450 + 1 250 = 39 700, B 31 200 → A pays B
// 4 250, each takes home 35 450.
function baseRow(): SalarySubmission {
  return {
    ...buildSubmission({
      month: THIS_MONTH,
      incomesA: [{ label: 'Lön', amount: 38450 }, { label: 'Barnbidrag', amount: 1250 }],
      incomesB: [{ label: 'Lön', amount: 31200 }],
      personAName: 'Alex', personBName: 'Sam',
    }),
    id: 'sub-1', created_at: '2026-09-01T10:00:00.000Z', updated_at: '2026-09-01T10:00:00.000Z',
  }
}

function renderRoute() {
  const router = createMemoryRouter([
    { path: '/loner', element: <Loner /> },
    { path: '/', element: <div>Home</div> },
  ], { initialEntries: ['/loner'] })
  return render(<RouterProvider router={router} />)
}

const dialogEl = () => document.querySelector('dialog.hb-modal') as HTMLDialogElement
const dialog = () => within(dialogEl())
// The editor focuses (and selects) its first amount ~30 ms after opening; typing
// before that would be overwritten by the selection, so wait for the focus.
async function firstAmount(): Promise<HTMLElement> {
  const amount = (await dialog().findAllByLabelText('Belopp, kr'))[0]
  await waitFor(() => expect(amount).toHaveFocus())
  return amount
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(budgetStore.loadBudget).mockResolvedValue({ ...defaultState(), people: ['Alex', 'Sam'] })
  vi.mocked(salaryStore.list).mockResolvedValue([])
  vi.mocked(salaryStore.exportJSON).mockResolvedValue('{}')
  vi.mocked(usePersonIdentity).mockReturnValue(identityView('a'))
  vi.mocked(draftsStore.listDrafts).mockResolvedValue([])
  vi.mocked(draftsStore.saveHalf).mockResolvedValue({ status: 'pending', updated_at: DRAFT_AT })
  vi.mocked(settingsStore.loadSalaryReminderSettings).mockResolvedValue({ settings: { enabled: true, send_day: 25, notify_partner: true, email_results: true }, unknown: false })
  vi.mocked(settingsStore.saveSalaryReminderSettings).mockResolvedValue(undefined)
  vi.mocked(emailStore.listResultsEmailStatus).mockResolvedValue(new Map())
  vi.mocked(emailStore.requestResultsEmail).mockResolvedValue('queued')
})

describe('Who may submit what (D2/D3)', () => {
  it('shows "Skicka in din lön" for your own missing half and no submit button for the other person’s assigned half', async () => {
    renderRoute()
    expect(await screen.findByRole('button', { name: 'Skicka in din lön' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /skicka in för/i })).not.toBeInTheDocument()
    // Sam still reads as not submitted — just without an action.
    const samRow = screen.getByText('Sam', { selector: '.person-name' }).closest('li') as HTMLElement
    expect(within(samRow).getByText('Ej inskickad')).toBeInTheDocument()
    expect(within(samRow).queryByRole('button')).not.toBeInTheDocument()
  })

  it('lets you submit the half of a slot nobody is assigned to (D3), labelled with their name', async () => {
    vi.mocked(usePersonIdentity).mockReturnValue(identityView('a', null))
    renderRoute()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Skicka in för Sam' }))
    expect(dialogEl()).toHaveAttribute('open')
    await user.click(dialog().getByRole('button', { name: 'Spara' }))
    await waitFor(() => expect(draftsStore.saveHalf).toHaveBeenCalledWith(THIS_MONTH, 'b', expect.any(Array), null, null))
  })

  it('offers nothing and explains why when the account is not linked and both slots are assigned', async () => {
    vi.mocked(usePersonIdentity).mockReturnValue(identityView(null))
    renderRoute()
    expect(await screen.findByText('Ditt konto är inte kopplat till en person i hushållet.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /skicka in/i })).not.toBeInTheDocument()
  })
})

describe('Submitting your own half', () => {
  it('prefills from the budget baseline and creates the half with a null expected version', async () => {
    renderRoute()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Skicka in din lön' }))
    // defaultState's first baseline income for Alex.
    await waitFor(() => expect(dialog().getAllByLabelText('Belopp, kr')[0]).toHaveValue('46 000'))
    await user.click(dialog().getByRole('button', { name: 'Spara' }))
    await waitFor(() => expect(draftsStore.saveHalf).toHaveBeenCalledWith(
      THIS_MONTH, 'a', expect.arrayContaining([expect.objectContaining({ amount: 46000 })]), null, null,
    ))
    await waitFor(() => expect(dialogEl()).not.toHaveAttribute('open'))
  })

  it('on a failed save keeps the dialog open with the inputs intact and shows the Swedish error toast', async () => {
    vi.mocked(draftsStore.saveHalf).mockRejectedValue(new Error('network down'))
    renderRoute()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Skicka in din lön' }))
    const amount = await firstAmount()
    await user.clear(amount)
    await user.type(amount, '41000')
    await user.click(dialog().getByRole('button', { name: 'Spara' }))

    expect(await dialog().findByText('Kunde inte spara — försök igen.')).toBeInTheDocument()
    expect(dialogEl()).toHaveAttribute('open')
    expect(dialog().getAllByLabelText('Belopp, kr')[0]).toHaveValue('41 000')
    // Not a success: nothing was reloaded as saved, and the button is usable again.
    expect(dialog().getByRole('button', { name: 'Spara' })).toBeEnabled()
  })

  it('shows the Swedish forbidden message when the server rejects the slot', async () => {
    vi.mocked(draftsStore.saveHalf).mockRejectedValue(new draftsStore.SalaryHalfForbidden())
    renderRoute()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Skicka in din lön' }))
    await user.click(await dialog().findByRole('button', { name: 'Spara' }))
    expect(await dialog().findByRole('alert')).toHaveTextContent('Du kan bara skicka in din egen lön.')
    expect(dialogEl()).toHaveAttribute('open')
  })
})

describe('An emailed draft', () => {
  it('renders immediately with its amount and "via e-post", and shows no transfer figure while waiting', async () => {
    vi.mocked(draftsStore.listDrafts).mockResolvedValue([draft('b', 38900, 'email')])
    renderRoute()
    const state = await screen.findByText(/Inskickad via e-post · 3 okt/, { selector: '.ln-person-state' })
    expect(state).toBeInTheDocument()
    expect(screen.getByText(fmt(38900), { selector: '.ln-person-amount' })).toBeInTheDocument()
    // The status chip (month card and month list) says who the month is waiting on.
    expect(screen.getAllByText('Väntar på Alex', { selector: '.ln-chip' }).length).toBeGreaterThan(0)
    expect(screen.getByText('Överföringen räknas ut när båda har skickat in')).toBeInTheDocument()
    // Never a transfer or take-home figure for a waiting month.
    expect(screen.queryByText(/betalar/)).not.toBeInTheDocument()
    expect(screen.queryByText(/var och en får/i)).not.toBeInTheDocument()
  })

  it('edits a pending half against the exact version it was loaded with', async () => {
    vi.mocked(draftsStore.listDrafts).mockResolvedValue([draft('b', 38900, 'email', 'bonus')])
    renderRoute()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Redigera Sams lön' }))
    // The email origin is tagged, the saved note and amount are prefilled.
    expect(await dialog().findByText('Inskickad via e-post')).toBeInTheDocument()
    expect(dialog().getAllByLabelText('Belopp, kr')[0]).toHaveValue('38 900')
    expect(dialog().getByLabelText(/Anteckning/)).toHaveValue('bonus')
    await user.click(dialog().getByRole('button', { name: 'Spara' }))
    await waitFor(() => expect(draftsStore.saveHalf).toHaveBeenCalledWith(
      THIS_MONTH, 'b', [{ label: 'Lön', amount: 38900 }], 'bonus', DRAFT_AT,
    ))
  })

  it('on a conflict keeps the editor open with the inputs and offers to reload', async () => {
    vi.mocked(draftsStore.listDrafts).mockResolvedValue([draft('b', 38900)])
    vi.mocked(draftsStore.saveHalf).mockRejectedValue(new draftsStore.SalaryHalfConflict())
    renderRoute()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Redigera Sams lön' }))
    const amount = await firstAmount()
    await user.clear(amount)
    await user.type(amount, '40000')
    await user.click(dialog().getByRole('button', { name: 'Spara' }))

    expect(await dialog().findByRole('alert')).toHaveTextContent('Någon annan ändrade precis den här lönen. Ladda om och försök igen.')
    expect(dialogEl()).toHaveAttribute('open')
    expect(dialog().getAllByLabelText('Belopp, kr')[0]).toHaveValue('40 000')

    // "Ladda om" re-reads the server and reopens on its version.
    vi.mocked(draftsStore.listDrafts).mockResolvedValue([{ ...draft('b', 39500), updated_at: '2026-10-04T09:00:00.654321+00:00' }])
    await user.click(dialog().getByRole('button', { name: 'Ladda om' }))
    await waitFor(() => expect(dialog().getAllByLabelText('Belopp, kr')[0]).toHaveValue('39 500'))
    expect(dialog().queryByRole('alert')).not.toBeInTheDocument()
  })

  it('when the month became complete meanwhile, reopens as an edit of the finished month and keeps the inputs', async () => {
    vi.mocked(draftsStore.listDrafts).mockResolvedValueOnce([]).mockResolvedValue([])
    vi.mocked(draftsStore.saveHalf).mockResolvedValue({ status: 'already_logged', updated_at: null })
    renderRoute()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Skicka in din lön' }))
    const amount = await firstAmount()
    await user.clear(amount)
    await user.type(amount, '42000')
    // Between opening and saving, the other person completed the month.
    vi.mocked(salaryStore.list).mockResolvedValue([baseRow()])
    await user.click(dialog().getByRole('button', { name: 'Spara' }))

    expect(await dialog().findByText('Månaden blev klar under tiden — dina ändringar ligger nu på den färdiga månaden')).toBeInTheDocument()
    expect(dialog().getByText('Redigera din lön')).toBeInTheDocument()
    expect(dialog().getAllByLabelText('Belopp, kr')[0]).toHaveValue('42 000')
    // Saving now edits the finished row — never creates a second one.
    await user.click(dialog().getByRole('button', { name: 'Spara' }))
    await waitFor(() => expect(salaryStore.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'sub-1', income_a: 42000 })))
  })
})

describe('A complete month', () => {
  it('shows the transfer, and editing Sam’s half recomputes it (Edit B golden values) and marks the month "Ändrad"', async () => {
    let rows: SalarySubmission[] = [baseRow()]
    vi.mocked(salaryStore.list).mockImplementation(async () => rows)
    vi.mocked(salaryStore.update).mockImplementation(async (record) => {
      rows = [{ ...record, updated_at: new Date().toISOString() }]
      return rows[0]
    })
    renderRoute()
    // Base: Alex pays Sam 4 250 kr, each takes home 35 450 kr.
    expect(await screen.findByText(`Alex betalar Sam ${fmt(4250)} · var och en får ${fmt(35450)}`, { selector: '.pot-transfer-text' })).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Redigera Sams lön' }))
    // Edit B: Lön 33 000 + Barnbidrag 1 250 = 34 250.
    const first = await firstAmount()
    await user.clear(first)
    await user.type(first, '33000')
    await user.click(dialog().getByRole('button', { name: '+ Lägg till inkomst' }))
    await user.type(dialog().getAllByLabelText('Inkomstens namn')[1], 'Barnbidrag')
    await user.type(dialog().getAllByLabelText('Belopp, kr')[1], '1250')
    // The live preview already shows the recomputed figure.
    expect(dialog().getByText(fmt(2725), { selector: '.pot-transfer-amount' })).toBeInTheDocument()
    await user.click(dialog().getByRole('button', { name: 'Spara' }))

    await waitFor(() => expect(salaryStore.update).toHaveBeenCalledTimes(1))
    const saved = vi.mocked(salaryStore.update).mock.calls[0][0]
    expect(saved).toMatchObject({
      id: 'sub-1', created_at: '2026-09-01T10:00:00.000Z', person_a_name: 'Alex', person_b_name: 'Sam',
      income_a: 39700, income_b: 34250, transfer_amount: 2725, transfer_from: 'a', transfer_to: 'b', equal_share: 36975,
    })
    // Recomputed figures on screen: 2 725 kr, each 36 975 kr.
    expect(await screen.findByText(`Alex betalar Sam ${fmt(2725)} · var och en får ${fmt(36975)}`, { selector: '.pot-transfer-text' })).toBeInTheDocument()
    // The month list marks it as edited.
    await user.click(screen.getByRole('button', { name: new RegExp(monthLabel(THIS_MONTH)) }))
    expect(await screen.findByText('Ändrad', { selector: '.detail-label' })).toBeInTheDocument()
  })

  it('does not call a month "Ändrad" when it was never edited', async () => {
    vi.mocked(salaryStore.list).mockResolvedValue([baseRow()])
    renderRoute()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: new RegExp(monthLabel(THIS_MONTH)) }))
    expect(await screen.findByText('Överföring', { selector: '.detail-label' })).toBeInTheDocument()
    expect(screen.queryByText('Ändrad', { selector: '.detail-label' })).not.toBeInTheDocument()
  })

  it('on a revision conflict keeps the editor open with the inputs intact and says so', async () => {
    vi.mocked(salaryStore.list).mockResolvedValue([baseRow()])
    vi.mocked(salaryStore.update).mockRejectedValue(new PersistenceError('conflict'))
    renderRoute()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Redigera Sams lön' }))
    const amount = await firstAmount()
    await user.clear(amount)
    await user.type(amount, '33000')
    await user.click(dialog().getByRole('button', { name: 'Spara' }))
    expect(await dialog().findByRole('alert')).toHaveTextContent('Någon annan ändrade precis den här lönen. Ladda om och försök igen.')
    expect(dialogEl()).toHaveAttribute('open')
    expect(dialog().getAllByLabelText('Belopp, kr')[0]).toHaveValue('33 000')
  })

  it('on any other save failure keeps the dialog open with a Swedish error toast', async () => {
    vi.mocked(salaryStore.list).mockResolvedValue([baseRow()])
    vi.mocked(salaryStore.update).mockRejectedValue(new Error('boom'))
    renderRoute()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Redigera din lön' }))
    await user.click(await dialog().findByRole('button', { name: 'Spara' }))
    expect(await dialog().findByText('Kunde inte spara — försök igen.')).toBeInTheDocument()
    expect(dialogEl()).toHaveAttribute('open')
  })

  it('lists a legacy duplicate month as a separate row labelled "Dubblett"', async () => {
    vi.mocked(salaryStore.list).mockResolvedValue([
      baseRow(), { ...baseRow(), id: 'sub-0', created_at: '2026-08-01T10:00:00.000Z' },
    ])
    renderRoute()
    expect(await screen.findByText('Dubblett')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: new RegExp(monthLabel(THIS_MONTH)) })).toHaveLength(2)
  })
})

describe('Reminder settings card (moved from Hushållsbudget)', () => {
  it('saves a change to the send day', async () => {
    renderRoute()
    const select = await screen.findByRole('combobox', { name: /skicka på dag/i })
    await waitFor(() => expect(select).not.toBeDisabled())
    const user = userEvent.setup()
    await user.selectOptions(select, '10')
    await waitFor(() => expect(settingsStore.saveSalaryReminderSettings).toHaveBeenCalledWith({ enabled: true, send_day: 10, notify_partner: true, email_results: true }))
  })

  it('on a save failure, reverts the control and shows a toast', async () => {
    vi.mocked(settingsStore.saveSalaryReminderSettings).mockRejectedValue(new Error('network'))
    renderRoute()
    const toggle = await screen.findByRole('checkbox', { name: /månatlig lönepåminnelse/i })
    await waitFor(() => expect(toggle).not.toBeDisabled())
    expect(toggle).toBeChecked()
    const user = userEvent.setup()
    await user.click(toggle)
    await waitFor(() => expect(toggle).toBeChecked())
    expect(await screen.findByText('Kunde inte spara påminnelsen — försök igen.')).toBeInTheDocument()
  })

  it('with the reminder off, the day is disabled but still shows the saved day; turning it on re-enables it', async () => {
    vi.mocked(settingsStore.loadSalaryReminderSettings).mockResolvedValue({ settings: { enabled: false, send_day: 12, notify_partner: true, email_results: true }, unknown: false })
    renderRoute()
    const toggle = await screen.findByRole('checkbox', { name: /månatlig lönepåminnelse/i })
    const select = await screen.findByRole('combobox', { name: /skicka på dag/i })
    await waitFor(() => expect(toggle).not.toBeDisabled())
    expect(toggle).not.toBeChecked()
    expect(select).toBeDisabled()
    expect(select).toHaveValue('12')
    const user = userEvent.setup()
    await user.click(toggle)
    await waitFor(() => expect(select).not.toBeDisabled())
    await waitFor(() => expect(settingsStore.saveSalaryReminderSettings).toHaveBeenCalledWith({ enabled: true, send_day: 12, notify_partner: true, email_results: true }))
  })

  it('while settings load, shows no fake value: placeholder day, disabled unchecked toggle', async () => {
    vi.mocked(settingsStore.loadSalaryReminderSettings).mockReturnValue(new Promise(() => {}))
    renderRoute()
    const select = await screen.findByRole('combobox', { name: /skicka på dag/i })
    const toggle = await screen.findByRole('checkbox', { name: /månatlig lönepåminnelse/i })
    expect(select).toHaveValue('')
    expect(toggle).toBeDisabled()
    expect(toggle).not.toBeChecked()
  })

  it('says so when the setting could not be read', async () => {
    vi.mocked(settingsStore.loadSalaryReminderSettings).mockResolvedValue({ settings: { enabled: true, send_day: 25, notify_partner: true, email_results: true }, unknown: true })
    renderRoute()
    expect(await screen.findByText(/Kunde inte läsa inställningen/)).toBeInTheDocument()
  })
})

const ALL_ON = { enabled: true, send_day: 25, notify_partner: true, email_results: true }

describe('Email toggles (D7/D8)', () => {
  const NOTIFY = /mejla när den andra har skickat in/i
  const RESULTS = /mejla resultatet när månaden är klar/i

  it('a toggle saves the whole settings object with only that field changed', async () => {
    renderRoute()
    const toggle = await screen.findByRole('checkbox', { name: NOTIFY })
    await waitFor(() => expect(toggle).not.toBeDisabled())
    expect(toggle).toBeChecked()
    await userEvent.setup().click(toggle)
    await waitFor(() => expect(settingsStore.saveSalaryReminderSettings).toHaveBeenCalledWith({ ...ALL_ON, notify_partner: false }))
    expect(toggle).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: RESULTS })).toBeChecked()
  })

  it('a failed save reverts the toggle and shows the error', async () => {
    vi.mocked(settingsStore.saveSalaryReminderSettings).mockRejectedValue(new Error('network'))
    renderRoute()
    const toggle = await screen.findByRole('checkbox', { name: RESULTS })
    await waitFor(() => expect(toggle).not.toBeDisabled())
    await userEvent.setup().click(toggle)
    expect(await screen.findByText('Kunde inte spara inställningen — försök igen.')).toBeInTheDocument()
    await waitFor(() => expect(toggle).toBeChecked())
  })

  it('reads a stored off value as off and shows loading state while loading', async () => {
    vi.mocked(settingsStore.loadSalaryReminderSettings).mockResolvedValue({ settings: { ...ALL_ON, email_results: false }, unknown: false })
    renderRoute()
    const toggle = await screen.findByRole('checkbox', { name: RESULTS })
    await waitFor(() => expect(toggle).not.toBeDisabled())
    expect(toggle).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: NOTIFY })).toBeChecked()
  })

  it('while settings load, both toggles are disabled, unchecked and aria-busy', async () => {
    vi.mocked(settingsStore.loadSalaryReminderSettings).mockReturnValue(new Promise(() => {}))
    renderRoute()
    for (const name of [NOTIFY, RESULTS]) {
      const toggle = await screen.findByRole('checkbox', { name })
      expect(toggle).toBeDisabled()
      expect(toggle).not.toBeChecked()
      expect(toggle.closest('[aria-busy]')).toHaveAttribute('aria-busy', 'true')
    }
  })
})

describe('Resend the results email (D8)', () => {
  async function openMonth() {
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: new RegExp(monthLabel(THIS_MONTH)) }))
    return user
  }
  const resendButton = () => screen.findByRole('button', { name: 'Skicka resultatet igen' })

  beforeEach(() => {
    vi.mocked(salaryStore.list).mockResolvedValue([baseRow()])
    vi.mocked(salaryStore.update).mockReset()
    vi.mocked(salaryStore.update).mockResolvedValue(baseRow())
  })

  it('requests the email for that row and shows the success text; the status is refreshed', async () => {
    renderRoute()
    const user = await openMonth()
    await user.click(await resendButton())
    expect(await screen.findByText('Resultatet mejlas till er båda inom några minuter.')).toBeInTheDocument()
    expect(emailStore.requestResultsEmail).toHaveBeenCalledWith('sub-1')
    // once on load, once after the request
    await waitFor(() => expect(emailStore.listResultsEmailStatus).toHaveBeenCalledTimes(2))
  })

  it('says so when a mail is already on its way', async () => {
    vi.mocked(emailStore.requestResultsEmail).mockResolvedValue('already_queued')
    renderRoute()
    const user = await openMonth()
    await user.click(await resendButton())
    expect(await screen.findByText('Ett mejl är redan på väg.')).toBeInTheDocument()
  })

  it('an RPC failure shows the error and leaves the button usable', async () => {
    vi.mocked(emailStore.requestResultsEmail).mockRejectedValue(new Error('boom'))
    renderRoute()
    const user = await openMonth()
    await user.click(await resendButton())
    expect(await screen.findByText('Kunde inte skicka — försök igen.')).toBeInTheDocument()
    expect(await resendButton()).toBeEnabled()
  })

  it('disables the button while the request is in flight', async () => {
    let finish: (v: 'queued') => void = () => {}
    vi.mocked(emailStore.requestResultsEmail).mockReturnValue(new Promise((r) => { finish = r }))
    renderRoute()
    const user = await openMonth()
    await user.click(await resendButton())
    expect(await resendButton()).toBeDisabled()
    finish('queued')
    await waitFor(async () => expect(await resendButton()).toBeEnabled())
  })

  it('shows "Senast mejlat" for a sent month, "Ett mejl är på väg" when queued', async () => {
    vi.mocked(emailStore.listResultsEmailStatus).mockResolvedValue(new Map([
      ['sub-1', { submission_id: 'sub-1', last_sent_at: '2026-10-05T08:00:00.000Z', queued: false }],
    ]))
    const { unmount } = renderRoute()
    await openMonth()
    expect(await screen.findByText('Senast mejlat 5 okt')).toBeInTheDocument()
    unmount()
    vi.mocked(emailStore.listResultsEmailStatus).mockResolvedValue(new Map([
      ['sub-1', { submission_id: 'sub-1', last_sent_at: '2026-10-05T08:00:00.000Z', queued: true }],
    ]))
    renderRoute()
    await openMonth()
    expect(await screen.findByText('Ett mejl är på väg')).toBeInTheDocument()
  })

  it('an edited month shows the changed notice and a primary button', async () => {
    vi.mocked(salaryStore.list).mockResolvedValue([{ ...baseRow(), updated_at: '2026-10-10T10:00:00.000Z' }])
    vi.mocked(emailStore.listResultsEmailStatus).mockResolvedValue(new Map([
      ['sub-1', { submission_id: 'sub-1', last_sent_at: '2026-10-05T08:00:00.000Z', queued: false }],
    ]))
    renderRoute()
    await openMonth()
    expect(await screen.findByText(/Månaden har ändrats sedan senaste mejlet/)).toBeInTheDocument()
    expect(await resendButton()).toHaveClass('btn-primary')
  })

  it('an unedited month keeps the ghost button; a never-emailed month shows no status line', async () => {
    renderRoute()
    await openMonth()
    expect(await resendButton()).not.toHaveClass('btn-primary')
    expect(screen.queryByText(/Senast mejlat|Ett mejl är på väg|har ändrats/)).not.toBeInTheDocument()
  })

  it('each legacy duplicate row has its own resend for its own id', async () => {
    vi.mocked(salaryStore.list).mockResolvedValue([
      baseRow(), { ...baseRow(), id: 'sub-0', created_at: '2026-08-01T10:00:00.000Z' },
    ])
    renderRoute()
    const user = userEvent.setup()
    const heads = await screen.findAllByRole('button', { name: new RegExp(monthLabel(THIS_MONTH)) })
    await user.click(heads[1])
    await user.click(await resendButton())
    expect(emailStore.requestResultsEmail).toHaveBeenCalledWith('sub-0')
  })

  it('after editing a complete month, the offer mails that row\'s new result', async () => {
    renderRoute()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Redigera din lön' }))
    await user.click(await dialog().findByRole('button', { name: 'Spara' }))
    expect(await screen.findByText('Sparat. Mejla det nya resultatet?')).toBeInTheDocument()
    expect(emailStore.requestResultsEmail).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Mejla det nya resultatet' }))
    await waitFor(() => expect(emailStore.requestResultsEmail).toHaveBeenCalledWith('sub-1'))
    expect(await screen.findByText('Resultatet mejlas till er båda inom några minuter.')).toBeInTheDocument()
  })

  it('saving a draft half does not offer a results email', async () => {
    vi.mocked(salaryStore.list).mockResolvedValue([])
    renderRoute()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Skicka in din lön' }))
    await user.click(await dialog().findByRole('button', { name: 'Spara' }))
    await waitFor(() => expect(draftsStore.saveHalf).toHaveBeenCalled())
    expect(screen.queryByText('Sparat. Mejla det nya resultatet?')).not.toBeInTheDocument()
  })
})
