// @vitest-environment jsdom
// Exercises the promise-based confirm() flow end-to-end through ConfirmProvider
// (the imperative bridge that replaces native window.confirm across ~20 sites):
// a consumer calls confirm({...}), the shared dialog appears, and the user's
// pick resolves the promise. jsdom's <dialog> has no showModal/close — polyfill
// enough for DialogShell's open/close effect (same shim the Bolånekoll tests use).
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, beforeAll } from 'vitest'
import { ConfirmProvider, useConfirm } from './useConfirm'
import type { ConfirmOptions } from './ConfirmDialog'

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false }
})

// A tiny consumer: a button that calls confirm() with the given options and
// records the resolved boolean into the DOM so tests can assert on it.
function Consumer({ options }: { options: ConfirmOptions }) {
  const confirm = useConfirm()
  return (
    <button onClick={async () => {
      const ok = await confirm(options)
      document.body.setAttribute('data-result', String(ok))
    }}>trigger</button>
  )
}

function renderWith(options: ConfirmOptions) {
  document.body.removeAttribute('data-result')
  return render(
    <ConfirmProvider>
      <Consumer options={options} />
    </ConfirmProvider>,
  )
}

describe('ConfirmDialog via ConfirmProvider', () => {
  it('shows the title when confirm() is called', async () => {
    const user = userEvent.setup()
    renderWith({ title: 'Ta bort betalning?' })
    expect(screen.queryByText('Ta bort betalning?')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'trigger' }))
    expect(screen.getByText('Ta bort betalning?')).toBeInTheDocument()
  })

  it('resolves true when the confirm button is clicked', async () => {
    const user = userEvent.setup()
    renderWith({ title: 'Ta bort?', confirmLabel: 'Ta bort' })
    await user.click(screen.getByRole('button', { name: 'trigger' }))
    await user.click(screen.getByRole('button', { name: 'Ta bort' }))
    expect(document.body.getAttribute('data-result')).toBe('true')
  })

  it('resolves false when the cancel button is clicked', async () => {
    const user = userEvent.setup()
    renderWith({ title: 'Ta bort?', cancelLabel: 'Avbryt' })
    await user.click(screen.getByRole('button', { name: 'trigger' }))
    await user.click(screen.getByRole('button', { name: 'Avbryt' }))
    expect(document.body.getAttribute('data-result')).toBe('false')
  })

  it('resolves false when Escape fires the dialog cancel event', async () => {
    const user = userEvent.setup()
    renderWith({ title: 'Ta bort?' })
    await user.click(screen.getByRole('button', { name: 'trigger' }))
    // jsdom doesn't translate Escape → the native <dialog> cancel event, so
    // dispatch it directly — this is the path DialogShell wires to onClose.
    const dialog = screen.getByRole('dialog')
    dialog.dispatchEvent(new Event('cancel'))
    await waitFor(() => expect(document.body.getAttribute('data-result')).toBe('false'))
  })

  it('omits the danger class when danger: false', async () => {
    const user = userEvent.setup()
    renderWith({ title: 'Öppna igen?', confirmLabel: 'Öppna igen', danger: false })
    await user.click(screen.getByRole('button', { name: 'trigger' }))
    expect(screen.getByRole('button', { name: 'Öppna igen' })).not.toHaveClass('confirm-danger')
  })

  it('renders the danger class by default', async () => {
    const user = userEvent.setup()
    renderWith({ title: 'Ta bort?', confirmLabel: 'Ta bort' })
    await user.click(screen.getByRole('button', { name: 'trigger' }))
    expect(screen.getByRole('button', { name: 'Ta bort' })).toHaveClass('confirm-danger')
  })

  it('renders lines as list items', async () => {
    const user = userEvent.setup()
    renderWith({ title: 'Avviker', lines: ['rad ett', 'rad två'], danger: false })
    await user.click(screen.getByRole('button', { name: 'trigger' }))
    expect(screen.getByText('rad ett')).toBeInTheDocument()
    expect(screen.getByText('rad två')).toBeInTheDocument()
  })
})
