import { useEffect, useState } from 'react'
import DialogShell from '../../components/DialogShell'
import FormField from '../../components/FormField'
import { parseAmount, todayISO } from '../../lib/mortgage'
import type { Valuation } from '../../lib/mortgage'

interface ValDlgProps {
  open: boolean; id: string | null; valuations: Valuation[]
  onSave: (data: Omit<Valuation, 'id' | 'created_at'>) => void
  onDelete: (id: string) => void; onClose: () => void
}
export default function ValuationDialog({ open, id, valuations, onSave, onDelete, onClose }: ValDlgProps) {
  const rec = id ? valuations.find(v => v.id === id) : null
  const [form, setForm] = useState({ date: todayISO(), value: '', note: '', is_purchase: false })
  useEffect(() => { if (open) setForm({ date: rec?.date || todayISO(), value: rec?.value ? String(rec.value) : '', note: rec?.note || '', is_purchase: !!rec?.is_purchase }) }, [open, id]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: string, v: string) => setForm(p => ({ ...p, [k]: v }))
  function submit(e: React.FormEvent) { e.preventDefault(); onSave({ date: form.date, value: parseAmount(form.value) || 0, note: form.note, is_purchase: form.is_purchase }) }
  return (
    <DialogShell open={open} onClose={onClose} className="bk-dialog">
      <form className="dialog-body" onSubmit={submit}>
        <h3 className="dialog-title">{id ? 'Edit property value' : 'Add property value'}</h3>
        <div className="form-grid">
          <FormField label="Date"><input type="date" value={form.date} onChange={e => set('date', e.target.value)} /></FormField>
          <FormField label="Value"><input type="text" inputMode="decimal" placeholder="0" value={form.value} onChange={e => set('value', e.target.value)} /></FormField>
          <FormField label="Note (optional)" wide><input type="text" placeholder="e.g. Booli estimate" value={form.note} onChange={e => set('note', e.target.value)} /></FormField>
          <label className="form-field checkbox-field form-wide">
            <input type="checkbox" checked={form.is_purchase} onChange={e => setForm(p => ({ ...p, is_purchase: e.target.checked }))} />
            <span>This is the original purchase price (köpeskilling) — anchors cost-basis equity</span>
          </label>
        </div>
        <p className="form-hint">Equity is this value minus the outstanding debt. Add a new one whenever you re-value. Flag the purchase date’s value as the köpeskilling to power the cost-basis hero.</p>
        <div className="dialog-actions">
          {id && <button type="button" className="btn btn-ghost btn-danger" onClick={() => { if (confirm('Delete this valuation?')) onDelete(id) }}>Delete</button>}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">Save</button>
        </div>
      </form>
    </DialogShell>
  )
}
