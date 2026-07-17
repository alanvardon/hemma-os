import { useEffect, useState } from 'react'
import DialogShell from '../../components/DialogShell'
import Segmented from '../../components/Segmented'
import { persistenceErrorMessage } from '../../lib/persistence-error'
import type { Bank, CatalogBank, EffectiveBankProfile, BankProfileSuggestion, ConventionSource, ConventionDriftWarning } from '../../lib/mortgage'
import BankPicker, { type BankSelection } from './BankPicker'

// What a profile save intends: which bank the agreement points at (null = keep
// the current one) and the household's convention locks. Opening the modal never
// saves — the parent commits this on the explicit Spara press.
export interface BankProfileSaveInput {
  selection: BankSelection
  year_basis: 360 | 365 | null
  billing: 'month-end' | 'fixed' | null
}

type YearBasisChoice = 'auto' | '360' | '365'
type BillingChoice = 'auto' | 'month-end' | 'fixed'

const SOURCE_LABELS: Record<ConventionSource, string> = {
  declared: 'Hushållslås',
  detected: 'Automatisk detektion',
  catalog: 'Katalogvärde',
  default: 'Standard',
}

function conventionValueLabel(v: ConventionDriftWarning['held']): string {
  return v === 360 ? 'faktisk/360' : v === 365 ? '365' : v === 'month-end' ? 'månadsslut' : 'fast dag'
}

function driftLabel(d: ConventionDriftWarning): string {
  const field = d.field === 'year_basis' ? 'Bankår' : 'Avisering'
  const held = conventionValueLabel(d.held)
  const observed = conventionValueLabel(d.observed)
  const source = d.against === 'declared' ? 'ditt lås' : 'katalogvärdet'
  return `${field}: ${source} anger ${held}, men din historik tyder tydligt på ${observed}. Prognosen använder ${conventionValueLabel(d.effective)}.`
}

// The bank-profile modal owns bank selection and the convention locks. Catalogue
// values are read-only identity; the household's own locks are the only editable
// controls. Drift (fresh evidence contradicting a lock or the catalogue value)
// is explained here in full — the card only badges it.
export default function BankProfileDialog({
  open, bank, banks, catalogBanks, effective, suggestion, agreementCount, onSave, onClose,
}: {
  open: boolean
  bank: Bank | null
  banks: Bank[]
  catalogBanks: CatalogBank[]
  effective: EffectiveBankProfile | null
  suggestion: BankProfileSuggestion | null
  agreementCount: number
  onSave: (input: BankProfileSaveInput) => Promise<void>
  onClose: () => void
}) {
  const [selection, setSelection] = useState<BankSelection>(null)
  const [customLabel, setCustomLabel] = useState('')
  const [yearBasis, setYearBasis] = useState<YearBasisChoice>('auto')
  const [billing, setBilling] = useState<BillingChoice>('auto')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset the form from the current bank each time the modal opens — opening
  // must never mutate anything (plan 109 decision: opening never saves).
  useEffect(() => {
    if (!open) return
    setSelection(bank ? { kind: 'existing', bankId: bank.id } : null)
    setCustomLabel('')
    setYearBasis(bank?.year_basis_source === 'declared' && (bank.year_basis === 360 || bank.year_basis === 365)
      ? (String(bank.year_basis) as YearBasisChoice) : 'auto')
    setBilling(bank?.billing_source === 'declared' && (bank.billing === 'month-end' || bank.billing === 'fixed')
      ? bank.billing : 'auto')
    setSaving(false)
    setError(null)
  }, [open, bank])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await onSave({
        selection,
        year_basis: yearBasis === 'auto' ? null : (Number(yearBasis) as 360 | 365),
        billing: billing === 'auto' ? null : billing,
      })
      onClose()
    } catch (err) {
      // The modal STAYS OPEN and shows the failure — a throwing store is not
      // enough; the user must see the save didn't land (plan write-semantics gate).
      setError(persistenceErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  // "Lås detta" — the learner is confident and the current value isn't already
  // locked to it. Only offered for a /360 year-basis reading (365 is the default
  // and needs no lock).
  const suggestYb = suggestion?.year_basis
  const offerLockYb = !!suggestYb && suggestYb.confident && suggestYb.value === 360 && yearBasis !== '360'

  return (
    <DialogShell open={open} onClose={onClose} className="bk-dialog" ariaLabel="Bankprofil">
      <form className="dialog-body" onSubmit={submit}>
        <h3 className="dialog-title">Bankprofil <span className="card-en">· Bank profile</span></h3>

        <div className="form-grid">
          <BankPicker banks={banks} catalogBanks={catalogBanks} selection={selection}
            customLabel={customLabel} onChange={setSelection} onCustomLabel={setCustomLabel} />
        </div>

        {agreementCount > 1 && (
          <p className="form-hint" role="note">
            Den här bankprofilen används i {agreementCount} bolåneavtal. Ändringar av bankår och avisering gäller alla.
          </p>
        )}

        <div className="bankprofil-section">
          <div className="bankprofil-row-head">
            <span className="bankprofil-label">Bankår <span className="card-en">· Day-count year</span></span>
            {effective && <span className="bankprofil-source">{SOURCE_LABELS[effective.year_basis.source]}</span>}
          </div>
          <Segmented<YearBasisChoice>
            value={yearBasis}
            ariaLabel="Bankår"
            onChange={setYearBasis}
            options={[
              { v: 'auto', label: 'Auto' },
              { v: '360', label: 'faktisk/360' },
              { v: '365', label: '365' },
            ]}
          />
          {offerLockYb && (
            <p className="bankprofil-suggest">
              Historiken tyder på faktisk/360.
              <button type="button" className="btn btn-ghost btn-xs" onClick={() => setYearBasis('360')}>Lås detta</button>
            </p>
          )}
        </div>

        <div className="bankprofil-section">
          <div className="bankprofil-row-head">
            <span className="bankprofil-label">Avisering <span className="card-en">· Billing</span></span>
            {effective && <span className="bankprofil-source">{SOURCE_LABELS[effective.billing.source]}</span>}
          </div>
          <Segmented<BillingChoice>
            value={billing}
            ariaLabel="Avisering"
            onChange={setBilling}
            options={[
              { v: 'auto', label: 'Auto' },
              { v: 'month-end', label: 'Månadsslut' },
              { v: 'fixed', label: 'Fast dag' },
            ]}
          />
        </div>

        {effective && effective.drift.length > 0 && (
          <div className="bankprofil-drift" role="status">
            {effective.drift.map((d, i) => <p key={i}>⚠ {driftLabel(d)}</p>)}
          </div>
        )}

        <p className="form-hint">
          Profilen styr hur prognosen för räntor och aviseringar räknas fram. Katalogvärden är gemensamma och kan inte redigeras här.
        </p>

        {error && <p className="dialog-error" role="alert">{error}</p>}

        <div className="dialog-actions">
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost" onClick={onClose}>Avbryt</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Sparar…' : 'Spara'}</button>
        </div>
      </form>
    </DialogShell>
  )
}
