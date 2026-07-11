// @vitest-environment jsdom
// The simple end of the harness (plan 78): a pure props → DOM component with
// real conditional logic (the active pill) and no store to mock — the template
// for fanning out further component tests. If this file compiles and its
// assertions run, the jsdom docblock + jest-dom matchers + user-event are wired
// correctly.
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import Segmented from './Segmented'

const OPTIONS = [
  { v: 'ytd', label: 'I år' },
  { v: '12m', label: '12 mån' },
  { v: 'all', label: 'Allt' },
] as const

describe('Segmented', () => {
  it('renders one radio per option and marks the selected one', () => {
    render(<Segmented value="12m" options={OPTIONS.slice()} onChange={() => {}} />)
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(3)
    // aria-checked tracks `value`, not click state — only the selected segment.
    expect(screen.getByRole('radio', { name: '12 mån' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'I år' })).not.toBeChecked()
  })

  it('calls onChange with the clicked segment’s value', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Segmented value="ytd" options={OPTIONS.slice()} onChange={onChange} />)
    await user.click(screen.getByRole('radio', { name: 'Allt' }))
    expect(onChange).toHaveBeenCalledWith('all')
  })
})
