import { useEffect, useState } from 'react'
import DialogShell from '../../components/DialogShell'
import FormField from '../../components/FormField'
import Segmented from '../../components/Segmented'
import { usePersonNames } from '../../components/usePersonNames'
import { parseAmount, todayISO } from '../../lib/mortgage'
import type { Contribution, MortgageSettings, Owner } from '../../lib/mortgage'

interface ContDlgProps {
  open: boolean; id: string | null; contributions: Contribution[]; settings: MortgageSettings
  onSave: (data: Omit<Contribution, 'id' | 'created_at'>) => void
  onDelete: (id: string) => void; onClose: () => void
}
export default function ContribDialog({ open, id, contributions, settings, onSave, onDelete, onClose }: ContDlgProps) {
  const rec = id ? contributions.find(c => c.id === id) : null
  const [form, setForm] = useState({ owner: 'a' as Owner, date: todayISO(), amount: '', note: '' })
  useEffect(() => { if (open) setForm({ owner: (rec?.owner as Owner) || 'a', date: rec?.date || todayISO(), amount: rec?.amount ? String(rec.amount) : '', note: rec?.note || '' }) }, [open, id]) // eslint-disable-line react-hooks/exhaustive-deps
  const { a: aName, b: bName } = usePersonNames(settings.owner_a_name, settings.owner_b_name)
  function submit(e: React.FormEvent) { e.preventDefault(); onSave({ owner: form.owner, date: form.date, amount: parseAmount(form.amount) || 0, note: form.note }) }
  return (
    <DialogShell open={open} onClose={onClose} className="bk-dialog">
      <form className="dialog-body" onSubmit={submit}>
        <h3 className="dialog-title">{id ? 'Edit contribution' : 'Add contribution'}</h3>
        <div className="form-grid">
          <div className="form-field">
            <span>Who paid</span>
            <Segmented value={form.owner} onChange={v => setForm(p => ({ ...p, owner: v }))}
              options={[{ v: 'a' as Owner, label: aName }, { v: 'b' as Owner, label: bName }]} />
          </div>
          <FormField label="Date"><input type="date" value={form.date} onChange={e => setForm(p => ({ ...p, date: e.target.value }))} /></FormField>
          <FormField label="Amount"><input type="text" inputMode="decimal" placeholder="0" value={form.amount} onChange={e => setForm(p => ({ ...p, amount: e.target.value }))} /></FormField>
          <FormField label="Note (optional)" wide><input type="text" placeholder="e.g. Down payment" value={form.note} onChange={e => setForm(p => ({ ...p, note: e.target.value }))} /></FormField>
        </div>
        <p className="form-hint">A lump sum one owner put in — down payment or extra amortering — beyond the shared split.</p>
        <div className="dialog-actions">
          {id && <button type="button" className="btn btn-ghost btn-danger" onClick={() => { if (confirm('Delete this contribution?')) onDelete(id) }}>Delete</button>}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">Save</button>
        </div>
      </form>
    </DialogShell>
  )
}
