// @vitest-environment jsdom
// Plan 128 Stage 5 — the third Bankprofil control (Räntemodell), its
// provenance chip, and the standing replay-evidence line. Mirrors
// SettingsDialog.test.tsx's convention: a renderDialog(overrides) helper
// returning the onSave spy.
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import BankProfileDialog from './BankProfileDialog'
import type { Bank, CatalogBank, EffectiveBankProfile, ProfileFit } from '../../lib/mortgage'

const bank: Bank = {
  id: 'b1', created_at: '2026-01-01', label: 'Danske',
  year_basis: null, year_basis_source: null,
  billing: null, billing_source: null,
  charge_basis: null, charge_basis_source: null,
  catalog_id: null,
}

const catalogBanks: CatalogBank[] = []

function effectiveWith(overrides: Partial<{
  year_basis_source: EffectiveBankProfile['year_basis']['source']
  billing_source: EffectiveBankProfile['billing']['source']
  charge_basis_source: EffectiveBankProfile['charge_basis']['source']
}> = {}): EffectiveBankProfile {
  return {
    year_basis: { value: 365, source: overrides.year_basis_source ?? 'default' },
    billing: { value: 'month-end', source: overrides.billing_source ?? 'default' },
    charge_basis: { value: 'days', source: overrides.charge_basis_source ?? 'default' },
    drift: [],
  }
}

function renderDialog(overrides: {
  bank?: Bank
  effective?: EffectiveBankProfile | null
  fit?: ProfileFit | null
} = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined)
  render(
    <BankProfileDialog
      open
      bank={overrides.bank ?? bank}
      banks={[overrides.bank ?? bank]}
      catalogBanks={catalogBanks}
      effective={overrides.effective === undefined ? effectiveWith() : overrides.effective}
      suggestion={null}
      agreementCount={1}
      fit={overrides.fit === undefined ? null : overrides.fit}
      onSave={onSave}
      onClose={() => {}}
    />,
  )
  return { onSave }
}

function dialog() {
  return screen.getByRole('dialog', { name: 'Bankprofil' })
}

describe('BankProfileDialog — Räntemodell control (plan 128 Stage 5)', () => {
  it.each([
    ['declared', 'Hushållslås'],
    ['detected', 'Automatisk detektion'],
    ['catalog', 'Katalogvärde'],
    ['default', 'Standard'],
  ] as const)('shows the %s provenance chip for charge_basis', (source, label) => {
    renderDialog({ effective: effectiveWith({ charge_basis_source: source }) })
    const section = screen.getByText('Räntemodell').closest('.bankprofil-section')!
    expect(within(section as HTMLElement).getByText(label)).toBeInTheDocument()
  })

  it('renders the Auto/Ränta per dag/Fast månadsränta options', () => {
    renderDialog()
    const group = screen.getByRole('radiogroup', { name: 'Räntemodell' })
    expect(within(group).getByRole('radio', { name: 'Auto' })).toBeInTheDocument()
    expect(within(group).getByRole('radio', { name: 'Ränta per dag' })).toBeInTheDocument()
    expect(within(group).getByRole('radio', { name: 'Fast månadsränta' })).toBeInTheDocument()
  })

  it('pre-selects the declared value when opening on a bank with a declared charge_basis', () => {
    renderDialog({ bank: { ...bank, charge_basis: 'monthly', charge_basis_source: 'declared' } })
    const group = screen.getByRole('radiogroup', { name: 'Räntemodell' })
    expect(within(group).getByRole('radio', { name: 'Fast månadsränta' })).toHaveAttribute('aria-checked', 'true')
  })

  it('pre-selects the declared 360 year_basis and month-end billing exactly as before (regression)', () => {
    renderDialog({
      bank: { ...bank, year_basis: 360, year_basis_source: 'declared', billing: 'month-end', billing_source: 'declared' },
    })
    expect(within(dialog()).getByRole('radio', { name: 'faktisk/360' })).toHaveAttribute('aria-checked', 'true')
    expect(within(dialog()).getByRole('radio', { name: 'Månadsslut' })).toHaveAttribute('aria-checked', 'true')
  })

  it('does not pre-select a value whose source is not declared (e.g. detected)', () => {
    renderDialog({ bank: { ...bank, charge_basis: 'monthly', charge_basis_source: 'detected' } })
    const group = screen.getByRole('radiogroup', { name: 'Räntemodell' })
    expect(within(group).getByRole('radio', { name: 'Auto' })).toHaveAttribute('aria-checked', 'true')
    expect(within(group).getByRole('radio', { name: 'Fast månadsränta' })).toHaveAttribute('aria-checked', 'false')
  })

  it('submits charge_basis: null when left on Auto, alongside the other two fields (regression)', async () => {
    const user = userEvent.setup()
    const { onSave } = renderDialog()
    await user.click(within(dialog()).getByRole('button', { name: 'Spara' }))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0][0]).toMatchObject({ year_basis: null, billing: null, charge_basis: null })
  })

  it('submits the selected charge_basis, and year_basis/billing still submit correctly (regression)', async () => {
    const user = userEvent.setup()
    const { onSave } = renderDialog()
    await user.click(within(dialog()).getByRole('radio', { name: 'Ränta per dag' }))
    await user.click(within(dialog()).getByRole('radio', { name: 'faktisk/360' }))
    await user.click(within(dialog()).getByRole('radio', { name: 'Fast dag' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Spara' }))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0][0]).toMatchObject({ year_basis: 360, billing: 'fixed', charge_basis: 'days' })
  })
})

describe('BankProfileDialog — replay evidence line (plan 128 Stage 5)', () => {
  it('is absent when no fit exists', () => {
    renderDialog({ fit: null })
    expect(screen.queryByText(/debiteringar/)).not.toBeInTheDocument()
  })

  it('shows the proven copy with covered count and residual when fit.proven is true', () => {
    const fit: ProfileFit = {
      year_basis: 360, charge_basis: 'days', billing: 'month-end',
      covered: 7, residual: 2, runner_up_residual: 40, proven: true,
    }
    renderDialog({ fit })
    expect(screen.getByText('Modellen återskapar bankens 7 senaste debiteringar inom 2 kr.')).toBeInTheDocument()
  })

  it('shows the unproven copy with covered count and residual when fit.proven is false', () => {
    const fit: ProfileFit = {
      year_basis: 365, charge_basis: 'days', billing: 'fixed',
      covered: 3, residual: 55, runner_up_residual: 60, proven: false,
    }
    renderDialog({ fit })
    expect(screen.getByText('3 debiteringar i historiken, 55 kr avvikelse — inte tillräckligt för att fastställas automatiskt.')).toBeInTheDocument()
  })
})
