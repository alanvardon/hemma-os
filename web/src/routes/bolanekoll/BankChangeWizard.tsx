import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import DialogShell from '../../components/DialogShell'
import FormField from '../../components/FormField'
import Icon from '../../components/Icon'
import { persistenceErrorMessage } from '../../lib/persistence-error'
import { copyPartsPreview, parseAmount, todayISO } from '../../lib/mortgage'
import type { Bank, CatalogBank, LoanPart, Payment } from '../../lib/mortgage'
import BankPicker, { type BankSelection } from './BankPicker'
import { fmtMoney } from './shared'

// What the wizard hands back for one atomic bank change. The parent resolves
// `selection` to a private bank id (creating it when needed) and calls
// changeMortgageBank — the wizard never touches the store itself.
export interface BankChangeResult {
  selection: BankSelection
  effective_date: string
  label: string
  parts: Array<{ label: string; balance: number; planned_amortization: number | null }>
}

// One editable draft part on step 2. Seeded from copyPartsPreview (label,
// resolved balance, amortisation suggestion) and freely renamed / re-amounted /
// added / removed. The provenance fields are display-only — they never persist.
interface Draft {
  key: string
  label: string
  balance: string
  amort: string
  estimated: boolean
  seeded: boolean
}

let draftSeq = 0
const nextKey = () => 'draft-' + (draftSeq++)

// The change-bank wizard (plan 109 decision 3/4): four progressive steps in one
// dialog. A bank change closes the active agreement and opens a new one with
// editable COPIES of the loan parts — a starting point, never a migration of
// bank history. Rate periods, account numbers and transactions are deliberately
// NOT copied (copyPartsPreview already enforces the copy set). A failure leaves
// the old agreement active, keeps the dialog open on the same step and shows the
// error.
export default function BankChangeWizard({
  open, currentBankId, currentAgreementLabel, banks, catalogBanks, parts, payments, onConfirm, onClose,
}: {
  open: boolean
  currentBankId: string | null
  currentAgreementLabel: string
  banks: Bank[]
  catalogBanks: CatalogBank[]
  /** Loan parts of the agreement being closed (archived ones are filtered by the preview). */
  parts: LoanPart[]
  payments: Payment[]
  onConfirm: (result: BankChangeResult) => Promise<void>
  onClose: () => void
}) {
  const [step, setStep] = useState(1)
  const [effectiveDate, setEffectiveDate] = useState('')
  const [selection, setSelection] = useState<BankSelection>(null)
  const [customLabel, setCustomLabel] = useState('')
  const [label, setLabel] = useState('')
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [ack, setAck] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset the whole wizard whenever it opens; opening never mutates anything.
  useEffect(() => {
    if (!open) return
    setStep(1)
    setEffectiveDate(todayISO())
    setSelection(null)
    setCustomLabel('')
    setLabel('')
    setAck(false)
    setSaving(false)
    setError(null)
  }, [open])

  // The copy preview at the chosen effective date — the plan-107 resolver gives
  // each part's resolved outstanding balance plus its observed/estimated quality.
  const preview = useMemo(
    () => copyPartsPreview(parts, payments, effectiveDate || todayISO()),
    [parts, payments, effectiveDate])

  // (Re)seed the editable drafts from the preview whenever the wizard opens or
  // the effective date changes (the balances are anchored to that date). Edits
  // made on step 2 survive because this only fires on those two triggers.
  useEffect(() => {
    if (!open) return
    setDrafts(preview.drafts.map((d): Draft => ({
      key: nextKey(),
      label: d.label,
      balance: String(Math.round(d.balance)),
      amort: d.planned_amortization != null ? String(Math.round(d.planned_amortization)) : '',
      estimated: d.balance_quality === 'estimated',
      seeded: true,
    })))
  }, [open, effectiveDate]) // eslint-disable-line react-hooks/exhaustive-deps -- preview follows effectiveDate

  const bankReady = !!selection && (selection.kind !== 'custom' || selection.label.trim() !== '')
  const dateReady = effectiveDate.trim() !== ''
  const step1Ready = dateReady && bankReady

  const draftSum = useMemo(() => drafts.reduce((s, d) => s + (parseAmount(d.balance) || 0), 0), [drafts])
  // The old agreement's resolved closing debt at the effective date.
  const closingDebt = preview.total_balance
  const mismatch = Math.abs(draftSum - closingDebt) > 1
  const anyEstimated = drafts.some(d => d.estimated) || preview.estimated
  const partsReady = drafts.length > 0 && drafts.every(d => {
    const b = parseAmount(d.balance)
    return Number.isFinite(b) && b >= 0
  })
  // A mismatch is legitimate (fees, cash adjustments, restructuring) but must be
  // explicitly acknowledged — never silently corrected (plan 109 decision 4).
  const reviewReady = partsReady && (!mismatch || ack)

  function updateDraft(key: string, patch: Partial<Draft>) {
    setDrafts(prev => prev.map(d => d.key === key ? { ...d, ...patch } : d))
  }
  function addDraft() {
    setDrafts(prev => [...prev, { key: nextKey(), label: '', balance: '', amort: '', estimated: false, seeded: false }])
  }
  function removeDraft(key: string) {
    setDrafts(prev => prev.filter(d => d.key !== key))
  }

  async function confirm() {
    if (!reviewReady || !bankReady || !dateReady) return
    setSaving(true)
    setError(null)
    try {
      await onConfirm({
        selection,
        effective_date: effectiveDate.trim(),
        label: label.trim(),
        parts: drafts.map(d => ({
          label: d.label.trim() || 'Lånedel',
          balance: parseAmount(d.balance) || 0,
          planned_amortization: d.amort.trim() === '' ? null : (parseAmount(d.amort) || 0),
        })),
      })
      onClose()
    } catch (err) {
      // The old agreement stays active; the dialog STAYS OPEN on step 4 and
      // shows the failure — a throwing store is not enough (write-semantics gate).
      setError(persistenceErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <DialogShell open={open} onClose={onClose} className="bk-dialog bk-wizard" ariaLabel="Byt bank">
      <div className="dialog-body">
        <h3 className="dialog-title">Byt bank <span className="card-en">· Change bank</span></h3>
        <ol className="wizard-steps" aria-hidden="true">
          {['Bank', 'Lånedelar', 'Granska', 'Bekräfta'].map((lbl, i) => (
            <li key={lbl} className={'wizard-step' + (step === i + 1 ? ' is-current' : step > i + 1 ? ' is-done' : '')}>
              <span className="wizard-step-no">{i + 1}</span>{lbl}
            </li>
          ))}
        </ol>

        {step === 1 && (
          <div className="wizard-panel">
            <p className="form-hint">
              Ett bankbyte avslutar det nuvarande avtalet ({currentAgreementLabel}) och skapar ett nytt hos den valda banken. Det gamla avtalet med hela sin historik sparas och nås via Tidigare avtal.
            </p>
            <div className="form-grid">
              <FormField label="Bytesdatum">
                <input type="date" value={effectiveDate} onChange={e => setEffectiveDate(e.target.value)} />
              </FormField>
              <FormField label="Namn på nytt avtal" wide>
                <input type="text" placeholder="t.ex. Bolån" value={label} onChange={e => setLabel(e.target.value)} />
              </FormField>
              <BankPicker banks={banks} catalogBanks={catalogBanks} selection={selection}
                customLabel={customLabel} onChange={setSelection} onCustomLabel={setCustomLabel}
                excludeBankId={currentBankId} />
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="wizard-panel">
            <p className="form-hint">
              Föreslagna lånedelar för det nya avtalet — kopierade som utgångspunkt från de nuvarande delarnas saldo vid bytesdatumet. Byt namn, justera saldo och amortering, lägg till eller ta bort delar efter behov.
            </p>
            {anyEstimated && (
              <p className="wizard-warn" role="status">
                ⚠ Ett eller flera saldon är uppskattade (ränta saknas i historiken). Kontrollera beloppen innan du bekräftar.
              </p>
            )}
            <div className="wizard-drafts">
              {drafts.map(d => (
                <div key={d.key} className="wizard-draft">
                  <div className="wizard-draft-fields">
                    <FormField label="Lånedel" wide>
                      <input type="text" placeholder="Lånedel" value={d.label}
                        onChange={e => updateDraft(d.key, { label: e.target.value })} />
                    </FormField>
                    <FormField label="Ingående saldo">
                      <input type="text" inputMode="decimal" placeholder="0" value={d.balance}
                        onChange={e => updateDraft(d.key, { balance: e.target.value })} />
                    </FormField>
                    <FormField label="Amortering (kr/mån)">
                      <input type="text" inputMode="decimal" placeholder="valfritt" value={d.amort}
                        onChange={e => updateDraft(d.key, { amort: e.target.value })} />
                    </FormField>
                  </div>
                  <div className="wizard-draft-meta">
                    <span className={'wizard-prov' + (d.estimated ? ' is-estimated' : '')}>
                      {d.seeded ? (d.estimated ? 'uppskattat saldo' : 'observerat saldo') : 'ny del'}
                    </span>
                    <button type="button" className="icon-btn" title="Ta bort lånedel" aria-label="Ta bort lånedel"
                      onClick={() => removeDraft(d.key)}><Icon icon={X} /></button>
                  </div>
                </div>
              ))}
              {drafts.length === 0 && <p className="empty">Inga lånedelar. Lägg till minst en för att fortsätta.</p>}
            </div>
            <button type="button" className="btn btn-ghost" onClick={addDraft}>+ Lägg till lånedel</button>
            <div className="wizard-sum">
              <span>Summa nya delar</span>
              <b>{fmtMoney(draftSum)}</b>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="wizard-panel">
            <h4 className="wizard-review-head">Granska bankbytet</h4>
            <ul className="wizard-review-list">
              <li><b>Behålls:</b> det nuvarande avtalet och hela dess historik (lånedelar, räntevillkor och transaktioner) — nås via Tidigare avtal.</li>
              <li><b>Kopieras som utgångspunkt:</b> lånedelarnas namn, deras saldo vid bytesdatumet som nytt ingående saldo, och amorteringsförslag med startdatum satt till bytesdatumet.</li>
              <li><b>Kopieras INTE:</b> räntevillkor/räntor/bindningstider, kontonummer, samt betalningar, ränta, avgifter och tidigare amorteringar. <b>Räntevillkoren måste läggas in på nytt</b> efter bytet.</li>
            </ul>
            <p className="form-hint">Kopian är en utgångspunkt, inte en överföring av bankhistoriken.</p>
            {anyEstimated && (
              <p className="wizard-warn" role="status">
                ⚠ Minst ett ingående saldo är uppskattat. Kontrollera det mot bankens uppgifter.
              </p>
            )}
            {mismatch && (
              <div className="wizard-mismatch" role="alert">
                <p>
                  ⚠ Summan av de nya delarna ({fmtMoney(draftSum)}) skiljer sig från det gamla avtalets skuld vid bytesdatumet ({fmtMoney(closingDebt)}) — en skillnad på {fmtMoney(Math.abs(draftSum - closingDebt))}.
                  Det kan vara riktigt (avgifter, kontantinsats eller omstrukturering), men bekräfta att skillnaden är avsiktlig.
                </p>
                <label className="checkbox-field">
                  <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} />
                  <span>Jag bekräftar att skillnaden i totalsumma är avsiktlig.</span>
                </label>
              </div>
            )}
          </div>
        )}

        {step === 4 && (
          <div className="wizard-panel">
            <p className="wizard-confirm-lead">
              Byt till <b>{selection?.kind === 'existing' ? (banks.find(b => b.id === selection.bankId)?.label || 'vald bank') : selection?.kind === 'catalog' ? selection.label : (selection?.kind === 'custom' ? (selection.label || 'egen bank') : 'vald bank')}</b> från och med {effectiveDate}, med {drafts.length} ny{drafts.length === 1 ? '' : 'a'} lånedel{drafts.length === 1 ? '' : 'ar'} på totalt {fmtMoney(draftSum)}.
            </p>
            <p className="form-hint">
              Det gamla avtalet arkiveras men raderas inte. Åtgärden är atomär — allt lyckas, eller inget ändras.
            </p>
            {error && <p className="dialog-error" role="alert">{error}</p>}
          </div>
        )}

        <div className="dialog-actions">
          {step > 1 && <button type="button" className="btn btn-ghost" onClick={() => setStep(s => s - 1)} disabled={saving}>Tillbaka</button>}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>Avbryt</button>
          {step === 1 && <button type="button" className="btn btn-primary" disabled={!step1Ready} onClick={() => setStep(2)}>Nästa</button>}
          {step === 2 && <button type="button" className="btn btn-primary" disabled={!partsReady} onClick={() => setStep(3)}>Nästa</button>}
          {step === 3 && <button type="button" className="btn btn-primary" disabled={!reviewReady} onClick={() => setStep(4)}>Nästa</button>}
          {step === 4 && <button type="button" className="btn btn-primary" disabled={saving || !reviewReady} onClick={confirm}>{saving ? 'Byter…' : 'Byt bank'}</button>}
        </div>
      </div>
    </DialogShell>
  )
}
