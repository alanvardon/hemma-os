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

const startInput = () => screen.getByLabelText('From (start)')
const rateInput = () => screen.getByLabelText('Interest rate %')
const saveButton = () => screen.getByRole('button', { name: 'Save' })

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
