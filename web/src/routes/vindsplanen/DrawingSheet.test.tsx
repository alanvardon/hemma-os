// @vitest-environment jsdom
// Plan 145: the builder's drawing sheet. The Save tab's "Print drawing" opens a
// full-screen sheet with the example plan's dimensions and a title block; Close
// and Esc return focus to the button.
import { useState } from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deriveGeometry } from '../../lib/vindsplanen/attic'
import { examplePlan } from '../../lib/vindsplanen/plan'
import { dimText } from '../../lib/vindsplanen/drawing'
import DrawingView from './DrawingSheet'
import SavePanel from './SavePanel'

afterEach(cleanup)

const plan = examplePlan()
const geo = deriveGeometry(plan.options.attic)

function Harness() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <SavePanel plan={plan} saveState="idle" onImport={() => {}} onReset={() => {}} onRetry={() => {}} onPrint={() => setOpen(true)} />
      {open && <DrawingView geo={geo} plan={plan} date={new Date('2026-11-26T12:00:00')} onClose={() => setOpen(false)} />}
    </>
  )
}

describe('Print drawing', () => {
  it('opens the sheet with the plan dimensions and the title block', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Print drawing' }))
    const dlg = screen.getByRole('dialog', { name: "Builder's drawing" })
    expect(within(dlg).getAllByRole('img').length).toBeGreaterThanOrEqual(2) // the plan and a stair section
    const text = dlg.textContent ?? ''
    expect(text).toContain('850') // overall length
    for (const x of [geo.RAFT_X[0], geo.RAFT_X[1] - geo.RAFT_X[0]]) expect(text).toContain(dimText(x))
    // the schedule table beside the plan, and the section titled by the stair tag
    const table = within(dlg).getByRole('table')
    expect(within(table).getByRole('rowheader', { name: 'W1' })).toBeTruthy()
    expect(table.textContent).toContain('Roof window 78×118 cm · south slope, bay 2 · sill 100 cm')
    expect(table.textContent).toContain('Door 80 × 200 cm in partition wall at 480 cm from west gable')
    expect(text).toContain('Section S1 — turning stairs, looking east')
    expect(text).toContain('Vindsplanen')
    expect(text).toContain('2026-11-26')
    expect(text).toContain('Dimensions in cm')
    expect(text).toContain('Drawn in Hemma·OS — check all measurements on site')
    expect(within(dlg).getByRole('button', { name: 'Print' })).toBeTruthy()
  })

  it('prints through window.print', async () => {
    const user = userEvent.setup()
    const print = vi.spyOn(window, 'print').mockImplementation(() => {})
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Print drawing' }))
    await user.click(screen.getByRole('button', { name: 'Print' }))
    expect(print).toHaveBeenCalledTimes(1)
  })

  it('Close returns focus to the opener', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Print drawing' })
    await user.click(opener)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
    expect(document.body.classList.contains('vp-sheet-open')).toBe(false)
  })

  it('Esc closes and returns focus', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Print drawing' })
    await user.click(opener)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })
})
