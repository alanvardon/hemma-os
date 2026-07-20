// @vitest-environment jsdom
// Plan 111 Stage 3 — the ownership control names the FINANCIAL FACT (owner A's
// share), not the account perspective. This pins the renamed label and that
// Save submits the explicit person-independent `owner_a_ownership_pct`.
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import SettingsDialog from './SettingsDialog'
import { defaultSettings } from '../../lib/mortgage'

function renderDialog(settings = defaultSettings()) {
  const onSave = vi.fn()
  render(
    <SettingsDialog
      open
      settings={settings}
      onSave={onSave}
      onClose={() => {}}
      onExportJSON={() => {}}
      onExportCSV={() => {}}
      onImportJSON={() => {}}
    />,
  )
  return { onSave }
}

describe('SettingsDialog — person-independent ownership control', () => {
  it("names owner A's share with the current owner A display name", () => {
    renderDialog({ ...defaultSettings(), owner_a_name: 'Anna', owner_b_name: 'Bo' })
    expect(screen.getByText('Anna ägarandel (%)')).toBeInTheDocument()
    // The perspective-relative wording is gone.
    expect(screen.queryByText('My ownership %')).not.toBeInTheDocument()
  })

  it('submits the edited share as owner_a_ownership_pct without touching i_am', async () => {
    const user = userEvent.setup()
    const settings = { ...defaultSettings(), owner_a_ownership_pct: 50, i_am: 'b' as const }
    const { onSave } = renderDialog(settings)

    const input = screen.getByLabelText('Person A ägarandel (%)')
    await user.clear(input)
    await user.type(input, '70')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0][0]).toMatchObject({ owner_a_ownership_pct: 70, i_am: 'b' })
  })
})
