import { useEffect, useState } from 'react'
import DialogShell from '../../components/DialogShell'
import Segmented from '../../components/Segmented'
import { persistenceErrorMessage } from '../../lib/persistence-error'
import { money } from '../../lib/format'
import type { Bank, CatalogBank, EffectiveBankProfile, BankProfileSuggestion, ConventionSource, ConventionDriftWarning, ProfileFit } from '../../lib/mortgage'
import BankPicker, { type BankSelection } from './BankPicker'

// What a profile save intends: which bank the agreement points at (null = keep
// the current one) and the household's convention locks. Opening the modal never
// saves — the parent commits this on the explicit Spara press.
// A field is present only when the owner actually touched its control this
// session — see the touched-vs-initial diff in `submit` below. Omitting an
// untouched field (rather than sending its Auto-mapped null) matters the
// moment a control shows Auto because the stored value is merely 'detected',
// not 'declared': a save that resent every field unconditionally would erase
// that undeclared-but-fitted value back to null, silently undoing plan 128's
// write-once guarantee for the two fields the owner never meant to touch.
export interface BankProfileSaveInput {
  selection: BankSelection
  year_basis?: 360 | 365 | null
  billing?: 'month-end' | 'fixed' | null
  charge_basis?: 'days' | 'monthly' | null
}

type YearBasisChoice = 'auto' | '360' | '365'
type BillingChoice = 'auto' | 'month-end' | 'fixed'
type ChargeBasisChoice = 'auto' | 'days' | 'monthly'

const SOURCE_LABELS: Record<ConventionSource, string> = {
  declared: 'Hushållslås',
  detected: 'Automatisk detektion',
  catalog: 'Katalogvärde',
  default: 'Standard',
}

const CONVENTION_VALUE_LABELS: Record<ConventionDriftWarning['held'], string> = {
  360: 'faktisk/360', 365: '365',
  'month-end': 'månadsslut', fixed: 'fast dag',
  days: 'ränta per dag', monthly: 'fast månadsränta',
}
function conventionValueLabel(v: ConventionDriftWarning['held']): string {
  return CONVENTION_VALUE_LABELS[v]
}

const DRIFT_FIELD_LABELS: Record<ConventionDriftWarning['field'], string> = {
  year_basis: 'Bankår', billing: 'Avisering', charge_basis: 'Räntemodell',
}
// Which profile the fresh evidence contradicts. 'detected' is a value a
// previous load FITTED AND STORED (plan 128) — it is the household's own
// record, not the catalogue's, and must not be attributed to the catalogue.
const DRIFT_SOURCE_LABELS: Record<ConventionDriftWarning['against'], string> = {
  declared: 'ditt lås', detected: 'den fastställda profilen', catalog: 'katalogvärdet',
}

function driftLabel(d: ConventionDriftWarning): string {
  const field = DRIFT_FIELD_LABELS[d.field]
  const held = conventionValueLabel(d.held)
  const observed = conventionValueLabel(d.observed)
  const source = DRIFT_SOURCE_LABELS[d.against]
  return `${field}: ${source} anger ${held}, men din historik tyder tydligt på ${observed}. Prognosen använder ${conventionValueLabel(d.effective)}.`
}

// The bank-profile modal owns bank selection and the convention locks. Catalogue
// values are read-only identity; the household's own locks are the only editable
// controls. Drift (fresh evidence contradicting a lock or the catalogue value)
// is explained here in full — the card only badges it.
export default function BankProfileDialog({
  open, bank, banks, catalogBanks, effective, suggestion, agreementCount, fit, onSave, onClose,
}: {
  open: boolean
  bank: Bank | null
  banks: Bank[]
  catalogBanks: CatalogBank[]
  effective: EffectiveBankProfile | null
  suggestion: BankProfileSuggestion | null
  agreementCount: number
  fit: ProfileFit | null
  onSave: (input: BankProfileSaveInput) => Promise<void>
  onClose: () => void
}) {
  const [selection, setSelection] = useState<BankSelection>(null)
  const [customLabel, setCustomLabel] = useState('')
  const [yearBasis, setYearBasis] = useState<YearBasisChoice>('auto')
  const [billing, setBilling] = useState<BillingChoice>('auto')
  const [chargeBasis, setChargeBasis] = useState<ChargeBasisChoice>('auto')
  // The choice each control opened on, so `submit` can tell an owner EDIT
  // apart from a field that merely rendered as Auto because it holds an
  // undeclared 'detected'/'catalog'/'default' value — see BankProfileSaveInput.
  const [initialYearBasis, setInitialYearBasis] = useState<YearBasisChoice>('auto')
  const [initialBilling, setInitialBilling] = useState<BillingChoice>('auto')
  const [initialChargeBasis, setInitialChargeBasis] = useState<ChargeBasisChoice>('auto')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset the form from the current bank each time the modal opens — opening
  // must never mutate anything (plan 109 decision: opening never saves).
  useEffect(() => {
    if (!open) return
    setSelection(bank ? { kind: 'existing', bankId: bank.id } : null)
    setCustomLabel('')
    const yb = bank?.year_basis_source === 'declared' && (bank.year_basis === 360 || bank.year_basis === 365)
      ? (String(bank.year_basis) as YearBasisChoice) : 'auto'
    const bi = bank?.billing_source === 'declared' && (bank.billing === 'month-end' || bank.billing === 'fixed')
      ? bank.billing : 'auto'
    const cb = bank?.charge_basis_source === 'declared' && (bank.charge_basis === 'days' || bank.charge_basis === 'monthly')
      ? bank.charge_basis : 'auto'
    setYearBasis(yb); setInitialYearBasis(yb)
    setBilling(bi); setInitialBilling(bi)
    setChargeBasis(cb); setInitialChargeBasis(cb)
    setSaving(false)
    setError(null)
  }, [open, bank])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const input: BankProfileSaveInput = { selection }
      if (yearBasis !== initialYearBasis) input.year_basis = yearBasis === 'auto' ? null : (Number(yearBasis) as 360 | 365)
      if (billing !== initialBilling) input.billing = billing === 'auto' ? null : billing
      if (chargeBasis !== initialChargeBasis) input.charge_basis = chargeBasis === 'auto' ? null : chargeBasis
      await onSave(input)
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

        <div className="bankprofil-section">
          <div className="bankprofil-row-head">
            <span className="bankprofil-label">Räntemodell <span className="card-en">· Charge basis</span></span>
            {effective && <span className="bankprofil-source">{SOURCE_LABELS[effective.charge_basis.source]}</span>}
          </div>
          <Segmented<ChargeBasisChoice>
            value={chargeBasis}
            ariaLabel="Räntemodell"
            onChange={setChargeBasis}
            options={[
              { v: 'auto', label: 'Auto' },
              { v: 'days', label: 'Ränta per dag' },
              { v: 'monthly', label: 'Fast månad' },
            ]}
          />
        </div>

        {fit && (
          <p className="bankprofil-evidence">
            {fit.proven
              ? `Modellen återskapar bankens ${fit.covered} senaste debiteringar inom ${money(fit.residual)}.`
              : `${fit.covered} debiteringar i historiken, ${money(fit.residual)} avvikelse — inte tillräckligt för att fastställas automatiskt.`}
          </p>
        )}

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
