// @vitest-environment jsdom
// Plan 150: the Material tab's "Quantities and cost" group. Prices are typed in
// kr/m² (sv-SE comma accepted), commit on blur / Enter, and are never clamped:
// an invalid entry shows a message and leaves the plan untouched.
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deriveGeometry } from '../../lib/vindsplanen/attic'
import { examplePlan, PRICES_NONE, type PlanV2 } from '../../lib/vindsplanen/plan'
import { costLines, quantities } from '../../lib/vindsplanen/quantities'
import MaterialsPanel from './MaterialsPanel'
import { fmtKr } from './fmt'

afterEach(cleanup)

const base = examplePlan()
const geo = deriveGeometry(base.options.attic)
const q = quantities(geo, base)

function Harness({ initial, onPlan }: { initial?: PlanV2; onPlan?: (p: PlanV2) => void }) {
  const [plan, setPlan] = useState(initial ?? { ...base, prices: { ...PRICES_NONE } })
  return (
    <MaterialsPanel
      geo={geo}
      plan={plan}
      onChange={(p) => {
        setPlan(p)
        onPlan?.(p)
      }}
    />
  )
}

const line = (key: string) => document.querySelector(`[data-line="${key}"]`) as HTMLElement
const priceInput = (key: string) => line(key).querySelector('input') as HTMLInputElement
const amount = (key: string) => line(key).querySelector('output')!.textContent

describe('Quantities and cost', () => {
  it('the example plan has a 0 m² insulation line (nothing boarded) and area on the others', () => {
    expect(q.insulation).toBe(0)
    expect(q.floor).toBeGreaterThan(0)
  })

  it('shows no estimate and "Price missing" while nothing is entered', () => {
    render(<Harness />)
    expect(screen.getByText('Enter prices to see an estimate.')).toBeInTheDocument()
    expect(screen.queryByText(/Estimated material cost/)).toBeNull()
    expect(amount('floor')).toBe('Price missing')
    expect(amount('insulation')).toBe('0 kr') // 0 m²: never "missing"
  })

  it('saves "450,5" as 450.5 and shows the line amount rounded to whole kronor', async () => {
    const onPlan = vi.fn()
    render(<Harness onPlan={onPlan} />)
    await userEvent.type(priceInput('floor'), '450,5')
    await userEvent.tab()
    expect(onPlan).toHaveBeenCalledTimes(1)
    expect(onPlan.mock.calls[0][0].prices.floor).toBe(450.5)
    expect(amount('floor')).toBe(fmtKr(q.floor * 450.5))
    expect(priceInput('floor')).toHaveValue('450,5')
  })

  it('commits on Enter and shows the total with the missing lines named', async () => {
    render(<Harness />)
    await userEvent.type(priceInput('floor'), '1 000{Enter}')
    const lines = costLines(q, { ...PRICES_NONE, floor: 1000 })
    expect(screen.getByText(/Estimated material cost/)).toHaveTextContent(('Estimated material cost: ' + fmtKr(lines[0].kr!)).replace(/\s/g, ' '))
    expect(screen.getByText('Price missing for: ceiling panel, walls.')).toBeInTheDocument()
    expect(screen.getByText('Estimate incl. VAT, excluding waste, labour and delivery.')).toBeInTheDocument()
  })

  it('an invalid entry shows the message and leaves the stored price alone', async () => {
    const onPlan = vi.fn()
    render(<Harness initial={{ ...base, prices: { ...PRICES_NONE, floor: 300 } }} onPlan={onPlan} />)
    const input = priceInput('floor')
    await userEvent.clear(input)
    await userEvent.type(input, '-5')
    await userEvent.tab()
    expect(screen.getByRole('alert')).toHaveTextContent('Enter an amount of 0 or more')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(onPlan).not.toHaveBeenCalled()
    expect(amount('floor')).toBe(fmtKr(q.floor * 300))
    fireEvent.change(input, { target: { value: 'abc' } })
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('clearing a price stores null and the line shows "Price missing"', async () => {
    const onPlan = vi.fn()
    render(<Harness initial={{ ...base, prices: { ...PRICES_NONE, floor: 300 } }} onPlan={onPlan} />)
    await userEvent.clear(priceInput('floor'))
    await userEvent.tab()
    expect(onPlan.mock.calls[0][0].prices.floor).toBeNull()
    expect(amount('floor')).toBe('Price missing')
  })

  it('a price of 0 is kept and gives 0 kr', async () => {
    const onPlan = vi.fn()
    render(<Harness onPlan={onPlan} />)
    await userEvent.type(priceInput('floor'), '0{Enter}')
    expect(onPlan.mock.calls[0][0].prices.floor).toBe(0)
    expect(amount('floor')).toBe('0 kr')
  })

  it('a 0 m² insulation line without a price does not block the total', () => {
    render(<Harness initial={{ ...base, prices: { floor: 100, panel: 100, walls: 100, insulation: null } }} />)
    expect(screen.getByText(/Estimated material cost/)).toBeInTheDocument()
    expect(screen.queryByText(/Price missing for/)).toBeNull()
    expect(amount('insulation')).toBe('0 kr')
  })

  it('lists what each line counts in a disclosure', () => {
    render(<Harness />)
    expect(screen.getByText('What’s counted')).toBeInTheDocument()
    expect(screen.getByText(/storage rooms and closets/)).toBeInTheDocument()
  })
})
