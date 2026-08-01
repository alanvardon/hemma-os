// @vitest-environment jsdom
// Plan 127 §3 — "the store throws" is not "the owner finds out" (AGENTS.md).
// Creating a rate period writes two rows in sequence and the atomic RPC was cut
// deliberately, so the only thing standing between a half-completed transition
// and a silently overlapping timeline is this dialog: it must stay open, keep
// the draft, and render the dated repair instruction.
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import PeriodDialog from './PeriodDialog'
import type { SavePeriodResult } from './useMortgageWorkspace'
import { addDaysISO, dayBefore, todayISO } from '../../lib/mortgage'
import type { RatePeriod } from '../../lib/mortgage'

// A single open-ended `rörlig` period at 3,93 %, the shape a household actually
// has when the bank announces the next rate.
const predecessor: RatePeriod = {
  id: 'rp-prev', created_at: '2026-05-01T00:00:00Z', loan_part_id: 'part-1',
  start_date: '2026-05-01', end_date: null, rate: 3.93, rate_type: 'rörlig',
}
const CLOSE_FAILED = 'Den nya perioden sparades, men den föregående kunde inte avslutas. '
  + 'Perioderna överlappar — öppna föregående period och sätt slutdatum 2026-07-31.'

function renderDialog(
  onSave: (data: Omit<RatePeriod, 'id' | 'created_at'>) => Promise<SavePeriodResult>,
  periods: RatePeriod[] = [predecessor],
) {
  const onClose = vi.fn()
  render(
    <PeriodDialog
      open
      partId="part-1"
      id={null}
      periods={periods}
      onSave={onSave}
      onDelete={() => {}}
      onClose={onClose}
    />,
  )
  return { onClose }
}

const startInput = () => screen.getByLabelText('Gäller från')
const rateInput = () => screen.getByLabelText('Räntesats %')
const saveButton = () => screen.getByRole('button', { name: 'Spara' })

/** Enter a valid successor: 4,29 % from 2026-08-01, closing the predecessor. */
async function enterSuccessor(user: ReturnType<typeof userEvent.setup>) {
  fireEvent.change(startInput(), { target: { value: '2026-08-01' } })
  await user.clear(rateInput())
  await user.type(rateInput(), '4,29')
}

describe('PeriodDialog — the save contract', () => {
  it('shows the dated repair instruction and keeps the draft when closing the predecessor fails', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue({ ok: false, message: CLOSE_FAILED })
    const { onClose } = renderDialog(onSave)

    await enterSuccessor(user)
    await user.click(saveButton())

    expect(onSave).toHaveBeenCalledTimes(1)
    // The owner sees the exact date to set by hand, not "kunde inte spara".
    expect(screen.getByRole('alert')).toHaveTextContent(CLOSE_FAILED)
    expect(screen.getByText(CLOSE_FAILED)).toBeInTheDocument()
    // The dialog stays open with everything the owner typed still in the form.
    expect(onClose).not.toHaveBeenCalled()
    expect(startInput()).toHaveValue('2026-08-01')
    expect(rateInput()).toHaveValue('4,29')
  })

  it('disables the submit control while the save is pending, so it cannot be sent twice', async () => {
    const user = userEvent.setup()
    let resolveSave!: (result: SavePeriodResult) => void
    const onSave = vi.fn(() => new Promise<SavePeriodResult>(resolve => { resolveSave = resolve }))
    const { onClose } = renderDialog(onSave)

    await enterSuccessor(user)
    await user.click(saveButton())

    expect(saveButton()).toBeDisabled()
    await user.click(saveButton())
    expect(onSave).toHaveBeenCalledTimes(1)

    // Only a resolved success closes the dialog.
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => { resolveSave({ ok: true }) })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(saveButton()).not.toBeDisabled()
  })

  it('discloses the predecessor close before saving, so the write matches what was shown', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue({ ok: true })
    renderDialog(onSave)

    await enterSuccessor(user)

    expect(screen.getByText('Föregående period (3,93 % · rörlig) avslutas 2026-07-31.')).toBeInTheDocument()
  })

  it('blocks a gap before persistence and names the contiguous start date', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue({ ok: true })
    const { onClose } = renderDialog(onSave, [{ ...predecessor, end_date: '2026-07-31' }])

    fireEvent.change(startInput(), { target: { value: '2026-08-05' } })
    await user.clear(rateInput())
    await user.type(rateInput(), '4,29')

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Perioderna lämnar ett glapp. Den nya perioden måste börja 2026-08-01 '
      + 'eller så behöver den föregående perioden korrigeras.',
    )
    await user.click(saveButton())
    expect(onSave).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})

// ── Contextual create defaults (plan 127 §2) ────────────────────────────────
// Dates are derived from the REAL today() rather than hard-coded, so the test
// stays deterministic without pinning the system clock to a fictional date.
describe('PeriodDialog — contextual create defaults', () => {
  it('defaults Gäller från to the day after a closed predecessor, carries Typ, leaves Räntesats empty, and pre-fills the end boundary from a later period', () => {
    const today = todayISO()
    const closedEnd = addDaysISO(today, -40)!
    const closedStart = addDaysISO(closedEnd, -90)!
    const laterStart = addDaysISO(today, 90)!
    const closedPredecessor: RatePeriod = {
      id: 'rp-a', created_at: '2026-01-01T00:00:00Z', loan_part_id: 'part-1',
      start_date: closedStart, end_date: closedEnd, rate: 3.5, rate_type: 'bunden',
    }
    const later: RatePeriod = {
      id: 'rp-c', created_at: '2026-01-01T00:00:00Z', loan_part_id: 'part-1',
      start_date: laterStart, end_date: null, rate: 4.5, rate_type: 'rörlig',
    }
    renderDialog(vi.fn(), [closedPredecessor, later])

    expect(startInput()).toHaveValue(addDaysISO(closedEnd, 1))
    expect(rateInput()).toHaveValue('') // Räntesats is the value being changed — never guessed.
    expect(screen.getByLabelText('Villkorsändringsdag (valfritt)')).toHaveValue(dayBefore(laterStart))
    expect(screen.getByRole('radio', { name: 'Bunden' })).toBeChecked() // Typ carries from the predecessor.
  })

  it('defaults Gäller från to today when the latest predecessor is still open-ended', () => {
    renderDialog(vi.fn()) // default fixture: predecessor is open-ended
    expect(startInput()).toHaveValue(todayISO())
  })

  it('never overwrites an end date or type the owner already typed, even after Gäller från changes again', async () => {
    const user = userEvent.setup()
    renderDialog(vi.fn())

    const endInput = screen.getByLabelText('Villkorsändringsdag (valfritt)')
    fireEvent.change(endInput, { target: { value: '2026-12-24' } })
    await user.click(screen.getByRole('radio', { name: 'Bunden' }))

    // Changing Gäller från again would normally re-derive both fields; since
    // the owner already touched them, they must stay exactly as typed.
    fireEvent.change(startInput(), { target: { value: '2026-09-15' } })

    expect(endInput).toHaveValue('2026-12-24')
    expect(screen.getByRole('radio', { name: 'Bunden' })).toBeChecked()
  })
})

// ── Rate delta (plan 127 §2) ────────────────────────────────────────────────
describe('PeriodDialog — rate delta', () => {
  it('shows no delta until a valid rate is entered', () => {
    renderDialog(vi.fn())
    expect(screen.queryByText(/pp$/)).not.toBeInTheDocument()
  })

  it('shows an increasing delta with a plus sign, in percentage points against the predecessor', async () => {
    const user = userEvent.setup()
    renderDialog(vi.fn()) // predecessor rate 3,93 %
    await user.type(rateInput(), '4,29')
    expect(screen.getByText('+0,36 pp')).toBeInTheDocument()
  })

  it('shows a decreasing delta with a minus sign', async () => {
    const user = userEvent.setup()
    renderDialog(vi.fn())
    await user.type(rateInput(), '3,50')
    expect(screen.getByText('−0,43 pp')).toBeInTheDocument()
  })
})
