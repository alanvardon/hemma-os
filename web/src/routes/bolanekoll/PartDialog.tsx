import { useEffect, useState } from 'react'
import { Pencil, X } from 'lucide-react'
import DialogShell from '../../components/DialogShell'
import FormField from '../../components/FormField'
import Icon from '../../components/Icon'
import { useConfirm } from '../../components/useConfirm'
import { makeLoanPart, parseAmount, todayISO, derivedRate, ratePeriodStatus } from '../../lib/mortgage'
import type { LoanPart, RatePeriod, Payment } from '../../lib/mortgage'
import { fmtPct } from './shared'
import { RATE_PERIOD_DELETE_CONFIRM_TITLE, RATE_PERIOD_STATUS_LABEL } from './ratePeriodCopy'

interface PartDlgProps {
  open: boolean; id: string | null; parts: LoanPart[]; periods: RatePeriod[]; payments: Payment[]
  onSave: (data: Omit<LoanPart, 'id' | 'created_at'>) => void
  onDelete: (id: string) => void; onClose: () => void
  // Plan 127 §2 — the rate-history list no longer owns a nested PeriodDialog.
  // Choosing "edit" (a real periodId) or "+ Lägg till ränteperiod" (null,
  // meaning create) both hand off to the ONE standalone dialog the caller
  // mounts, so a correction and a fresh "Ny räntesats" never stack two
  // dialogs on screen.
  onEditPeriod: (partId: string, periodId: string | null) => void
  onDeletePeriod: (id: string) => void
}
export default function PartDialog({ open, id, parts, periods, payments, onSave, onDelete, onClose, onEditPeriod, onDeletePeriod }: PartDlgProps) {
  const confirm = useConfirm()
  const rec = id ? parts.find(p => p.id === id) : null
  const [form, setForm] = useState({ label: '', loan_number: '', start_balance: '', start_date: '', planned_amortization: '', planned_amortization_start: '' })
  useEffect(() => {
    if (open) setForm({
      label: rec?.label || '', loan_number: rec?.loan_number || '',
      start_balance: rec?.start_balance ? String(rec.start_balance) : '', start_date: rec?.start_date || todayISO(),
      planned_amortization: rec?.planned_amortization != null ? String(rec.planned_amortization) : '',
      planned_amortization_start: rec?.planned_amortization_start || '',
    })
  }, [open, id]) // eslint-disable-line react-hooks/exhaustive-deps
  const myPeriods = periods.filter(p => p.loan_part_id === id).sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)))
  const set = (k: string, v: string) => setForm(p => ({ ...p, [k]: v }))
  function submit(e: React.FormEvent) {
    e.preventDefault()
    onSave(makeLoanPart({
      label: form.label.trim() || 'Lånedel', loan_number: form.loan_number.trim(),
      start_balance: form.start_balance.trim() === '' ? 0 : parseAmount(form.start_balance), start_date: form.start_date.trim(),
      // Plan 105 — an empty declared amortering means "detect from history"; the
      // normaliser turns '' into null. A "Gäller från" without an amount is inert.
      planned_amortization: form.planned_amortization.trim() === '' ? null : parseAmount(form.planned_amortization),
      planned_amortization_start: form.planned_amortization_start.trim() || null,
    }))
  }
  const der = id && rec ? derivedRate(rec, payments) : null
  return (
    <DialogShell open={open} onClose={onClose} className="bk-dialog">
      <form className="dialog-body" onSubmit={submit}>
        <h3 className="dialog-title">{id ? 'Edit loan part' : 'Add loan part'}</h3>
        <div className="form-grid">
          <FormField label="Label" wide><input type="text" placeholder="e.g. Lånedel 1 (rörlig)" value={form.label} onChange={e => set('label', e.target.value)} /></FormField>
          <FormField label="Loan # (optional)"><input type="text" placeholder="e.g. 9021 33 12345" value={form.loan_number} onChange={e => set('loan_number', e.target.value)} /></FormField>
          <FormField label="Start balance"><input type="text" inputMode="decimal" placeholder="0" value={form.start_balance} onChange={e => set('start_balance', e.target.value)} /></FormField>
          <FormField label="As of date"><input type="date" value={form.start_date} onChange={e => set('start_date', e.target.value)} /></FormField>
          <FormField label="Planerad amortering (kr/mån)"><input type="text" inputMode="decimal" placeholder="beräknas från historik" value={form.planned_amortization} onChange={e => set('planned_amortization', e.target.value)} /></FormField>
          <FormField label="Gäller från (valfritt)"><input type="date" value={form.planned_amortization_start} onChange={e => set('planned_amortization_start', e.target.value)} /></FormField>
        </div>
        <p className="form-hint">The start balance is the part's debt on the "as of" date. The interest rate is set per period below.</p>
        <p className="form-hint">Planerad amortering överstyr det som räknas fram från historiken — lämna tomt för att detektera. 0 kr låser delen som amorteringsfri. "Gäller från" daterar en ändring så den inte skrivs bakåt.</p>
        {id && (
          <div className="rate-history">
            <div className="rate-history-head">
              <span>Ränteperioder</span>
              <span className="rate-derived">{der != null ? 'Historiken ≈ ' + fmtPct(der) : ''}</span>
            </div>
            {myPeriods.length ? (
              <ul className="rate-list">
                {myPeriods.map(r => {
                  const bunden = r.rate_type === 'bunden'
                  // Plan 127 §5 — an open-ended period has no real end date to
                  // show, so the placeholder is the actual Swedish status
                  // (Aktuell/Kommande) instead of the old "nu · now" stand-in.
                  // A period WITH an end date already communicates via that
                  // date and keeps showing it verbatim.
                  const openEndedStatus = r.end_date ? null : RATE_PERIOD_STATUS_LABEL[ratePeriodStatus(r, todayISO())]
                  return (
                    <li key={r.id}>
                      <span className="rate-when">{r.start_date || '—'} → {r.end_date || openEndedStatus}</span>
                      <span className="rate-pct">{r.rate != null ? fmtPct(r.rate) : '—'}</span>
                      <span className={'rate-type' + (bunden ? ' is-bunden' : '')}>{bunden ? 'Bunden' : 'Rörlig'}</span>
                      <span className="rate-acts">
                        <button type="button" className="icon-btn" title="Redigera" aria-label="Redigera" onClick={() => onEditPeriod(id!, r.id)}><Icon icon={Pencil} /></button>
                        <button type="button" className="icon-btn" title="Ta bort" aria-label="Ta bort" onClick={async () => { if (await confirm({ title: RATE_PERIOD_DELETE_CONFIRM_TITLE })) onDeletePeriod(r.id) }}><Icon icon={X} /></button>
                      </span>
                    </li>
                  )
                })}
              </ul>
            ) : <ul className="rate-list"><li className="rate-empty">Inga ränteperioder än — lägg till en för att sätta lånedelens ränta.</li></ul>}
            <button type="button" className="btn btn-ghost" id="p-rate-add" onClick={() => onEditPeriod(id!, null)}>+ Lägg till ränteperiod</button>
          </div>
        )}
        <div className="dialog-actions">
          {id && <button type="button" className="btn btn-ghost btn-danger" onClick={async () => { if (await confirm({ title: 'Delete this loan part?', message: 'All its payments and rate periods are deleted too. This can’t be undone.' })) onDelete(id) }}>Delete</button>}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">Save</button>
        </div>
      </form>
    </DialogShell>
  )
}
