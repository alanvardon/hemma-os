import { useEffect, useState } from 'react'
import DialogShell from '../../components/DialogShell'
import FormField from '../../components/FormField'
import { persistenceErrorMessage } from '../../lib/persistence-error'
import { todayISO } from '../../lib/mortgage'
import type { Bank, CatalogBank } from '../../lib/mortgage'
import BankPicker, { type BankSelection } from './BankPicker'

export interface CreateAgreementInput {
  label: string
  start_date: string
  selection: BankSelection
}

// Creating the first mortgage agreement requires a label/start date AND a
// bank (catalogue or custom) before loan parts can be added (plan 109 decision
// 2). The start date reads as "hos banken sedan …" — the relationship's start,
// never a binding date.
export default function AgreementDialog({ open, banks, catalogBanks, onSave, onClose }: {
  open: boolean
  banks: Bank[]
  catalogBanks: CatalogBank[]
  onSave: (input: CreateAgreementInput) => Promise<void>
  onClose: () => void
}) {
  const [label, setLabel] = useState('')
  const [startDate, setStartDate] = useState('')
  const [selection, setSelection] = useState<BankSelection>(null)
  const [customLabel, setCustomLabel] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setLabel('')
    setStartDate(todayISO())
    setSelection(banks[0] ? { kind: 'existing', bankId: banks[0].id } : null)
    setCustomLabel('')
    setSaving(false)
    setError(null)
  }, [open, banks])

  // A bank is required; a custom pick needs a non-empty name.
  const bankReady = !!selection && (selection.kind !== 'custom' || selection.label.trim() !== '')
  const canSave = startDate.trim() !== '' && bankReady

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      await onSave({ label: label.trim(), start_date: startDate.trim(), selection })
      onClose()
    } catch (err) {
      setError(persistenceErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <DialogShell open={open} onClose={onClose} className="bk-dialog" ariaLabel="Skapa bolåneavtal">
      <form className="dialog-body" onSubmit={submit}>
        <h3 className="dialog-title">Skapa bolåneavtal <span className="card-en">· New mortgage agreement</span></h3>
        <div className="form-grid">
          <FormField label="Namn" wide>
            <input type="text" placeholder="t.ex. Bolån" value={label} onChange={e => setLabel(e.target.value)} />
          </FormField>
          <FormField label="Hos banken sedan">
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
          </FormField>
          <BankPicker banks={banks} catalogBanks={catalogBanks} selection={selection}
            customLabel={customLabel} onChange={setSelection} onCustomLabel={setCustomLabel} />
        </div>
        <p className="form-hint">
          Startdatumet är när du blev kund hos banken — inte ett bindningsdatum. Lägg till lånedelar när avtalet är skapat.
        </p>
        {error && <p className="dialog-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost" onClick={onClose}>Avbryt</button>
          <button type="submit" className="btn btn-primary" disabled={saving || !canSave}>{saving ? 'Sparar…' : 'Skapa'}</button>
        </div>
      </form>
    </DialogShell>
  )
}
