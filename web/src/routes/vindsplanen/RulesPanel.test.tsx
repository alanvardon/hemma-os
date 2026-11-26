// @vitest-environment jsdom
// Plan 146: the Rules check group in the Plan tab. The example plan's turning
// stairs are a hair under 200 cm of free height, its window sills pass, and a
// row tied to an item selects it.
import { useState } from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { deriveGeometry } from '../../lib/vindsplanen/attic'
import { examplePlan } from '../../lib/vindsplanen/plan'
import { checkRules, RULES_SOURCE } from '../../lib/vindsplanen/rules'
import RulesPanel from './RulesPanel'
import { rulesSummary } from './rulesText'

afterEach(cleanup)

const plan = examplePlan()
const rules = checkRules(deriveGeometry(plan.options.attic), plan)

function Harness() {
  const [sel, setSel] = useState<string | null>(null)
  return (
    <>
      <RulesPanel rules={rules} items={plan.items} selectedId={sel} onSelect={setSel} />
      <output data-testid="sel">{sel ?? ''}</output>
    </>
  )
}

describe('RulesPanel', () => {
  it('summarises the tally in the header', () => {
    render(<Harness />)
    expect(screen.getByText('1 not OK · 5 can’t tell')).toBeTruthy()
    expect(rulesSummary([])).toBe('All checks OK')
  })

  it('shows the c1 free-height row as Not OK with the numbers', () => {
    render(<Harness />)
    const row = screen.getByText(/Free height 196 cm/).closest('.vp-rule') as HTMLElement
    expect(within(row).getByText(/Not OK/)).toBeTruthy()
    expect(row.textContent).toContain('196')
    expect(row.textContent).toContain('200')
    expect(row.textContent).toContain('BFS 2024:9 2 kap. 25 §')
  })

  it('shows the sill rows as OK and groups the case-by-case rows', () => {
    render(<Harness />)
    const sills = screen.getAllByText(/Sill 100 cm above the floor — at most 120 cm allowed/)
    expect(sills).toHaveLength(3)
    for (const s of sills) expect(within(s.closest('.vp-rule') as HTMLElement).getByText(/OK/).textContent).toMatch(/OK$/)
    expect(screen.getByText('Can be checked')).toBeTruthy()
    expect(screen.getByText('Assessed case by case')).toBeTruthy()
    expect(screen.getByText(/change of use is for the kommun to decide/)).toBeTruthy()
  })

  it('shows the source footer', () => {
    render(<Harness />)
    expect(screen.getByText(RULES_SOURCE)).toBeTruthy()
  })

  it('selects the item when its row is clicked', async () => {
    render(<Harness />)
    await userEvent.click(screen.getByRole('button', { name: /Free height 196 cm/ }))
    expect(screen.getByTestId('sel').textContent).toBe('c1')
  })
})
