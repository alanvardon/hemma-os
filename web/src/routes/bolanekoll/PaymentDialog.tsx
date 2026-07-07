import { useEffect, useState } from 'react'
import DialogShell from '../../components/DialogShell'
import FormField from '../../components/FormField'
import { usePersonNames } from '../../components/usePersonNames'
import { makePayment, parseAmount, todayISO, normPaidBy } from '../../lib/mortgage'
import type { LoanPart, Payment, MortgageSettings } from '../../lib/mortgage'

interface PayDlgProps {
  open: boolean; id: string | null; payments: Payment[]; parts: LoanPart[]; settings: MortgageSettings
  onSave: (data: Omit<Payment, 'id' | 'created_at'>) => void
  onDelete: (id: string) => void; onClose: () => void
}
export default function PaymentDialog({ open, id, payments, parts, settings, onSave, onDelete, onClose }: PayDlgProps) {
  const rec = id ? payments.find(p => p.id === id) : null
  const [form, setForm] = useState({ date: todayISO(), loan_part_id: '', kind: 'interest', amount: '', balance_after: '', paid_by: 'joint', is_insats: false })
  useEffect(() => {
    if (open) setForm({ date: rec?.date || todayISO(), loan_part_id: rec?.loan_part_id || (parts[0]?.id || ''), kind: rec?.kind || 'interest', amount: rec?.amount ? String(rec.amount) : '', balance_after: rec?.balance_after != null ? String(rec.balance_after) : '', paid_by: rec?.paid_by || 'joint', is_insats: !!rec?.is_insats })
  }, [open, id]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: string, v: string) => setForm(p => ({ ...p, [k]: v }))
  function submit(e: React.FormEvent) { e.preventDefault(); onSave(makePayment({ date: form.date, loan_part_id: form.loan_part_id || null, kind: form.kind as Payment['kind'], amount: parseAmount(form.amount), balance_after: form.balance_after ? parseAmount(form.balance_after) : null, paid_by: normPaidBy(form.paid_by), is_insats: form.is_insats })) }
  const { a: aName, b: bName } = usePersonNames(settings.owner_a_name, settings.owner_b_name)
  return (
    <DialogShell open={open} onClose={onClose} className="bk-dialog">
      <form className="dialog-body" onSubmit={submit}>
        <h3 className="dialog-title">{id ? 'Edit payment' : 'Add payment'}</h3>
        <div className="form-grid">
          <FormField label="Loan part" wide>
            <select className="select" value={form.loan_part_id} onChange={e => set('loan_part_id', e.target.value)}>
              {parts.map(p => <option key={p.id} value={p.id}>{p.label || p.id}</option>)}
            </select>
          </FormField>
          <FormField label="Date"><input type="date" value={form.date} onChange={e => set('date', e.target.value)} /></FormField>
          <FormField label="Type">
            <select className="select" value={form.kind} onChange={e => set('kind', e.target.value)}>
              <option value="interest">Ränta · Interest</option>
              <option value="amortization">Amortering · Principal</option>
              <option value="payment">Betalning · Payment</option>
              <option value="loan">Lån · Disbursement</option>
              <option value="fee">Avgift · Fee</option>
              <option value="other">Övrigt · Other</option>
            </select>
          </FormField>
          <FormField label="Amount (Belopp)"><input type="text" inputMode="decimal" placeholder="0" value={form.amount} onChange={e => set('amount', e.target.value)} /></FormField>
          <FormField label="Balance after (Saldo, optional)"><input type="text" inputMode="decimal" placeholder="0" value={form.balance_after} onChange={e => set('balance_after', e.target.value)} /></FormField>
          {settings.track_contributions && (
            <FormField label="Paid by" wide>
              <select className="select" value={form.paid_by} onChange={e => set('paid_by', e.target.value)}>
                <option value="joint">Joint · split by ownership</option>
                <option value="a">{aName}</option>
                <option value="b">{bName}</option>
              </select>
            </FormField>
          )}
          <label className="form-field checkbox-field form-wide">
            <input type="checkbox" checked={form.is_insats} onChange={e => setForm(p => ({ ...p, is_insats: e.target.checked }))} />
            <span>Flag as insats — an extra amortering you chose to make (lists it under Insatser)</span>
          </label>
        </div>
        <div className="dialog-actions">
          {id && <button type="button" className="btn btn-ghost btn-danger" onClick={() => { if (confirm('Delete this payment?')) onDelete(id) }}>Delete</button>}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">Save</button>
        </div>
      </form>
    </DialogShell>
  )
}
