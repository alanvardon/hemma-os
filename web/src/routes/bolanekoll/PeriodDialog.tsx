import { useEffect, useState } from 'react'
import DialogShell from '../../components/DialogShell'
import FormField from '../../components/FormField'
import Segmented from '../../components/Segmented'
import { makeRatePeriod, parseAmount, todayISO } from '../../lib/mortgage'
import type { RatePeriod } from '../../lib/mortgage'

interface PeriodDlgProps {
  open: boolean; partId: string | null; id: string | null; periods: RatePeriod[]
  onSave: (data: Omit<RatePeriod, 'id' | 'created_at'>) => void
  onDelete: (id: string) => void; onClose: () => void
}
export default function PeriodDialog({ open, partId, id, periods, onSave, onDelete, onClose }: PeriodDlgProps) {
  const rec = id ? periods.find(p => p.id === id) : null
  const [form, setForm] = useState({ start_date: '', end_date: '', rate: '', rate_type: 'rörlig' as 'rörlig' | 'bunden' })
  useEffect(() => {
    if (open) setForm({ start_date: rec?.start_date || todayISO(), end_date: rec?.end_date || '', rate: rec?.rate != null ? String(rec.rate) : '', rate_type: rec?.rate_type || 'rörlig' })
  }, [open, id]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: string, v: string) => setForm(p => ({ ...p, [k]: v }))
  function submit(e: React.FormEvent) {
    e.preventDefault()
    onSave(makeRatePeriod({ loan_part_id: partId, start_date: form.start_date || todayISO(), end_date: form.end_date || null, rate: parseAmount(form.rate), rate_type: form.rate_type }))
  }
  return (
    <DialogShell open={open} onClose={onClose} className="bk-dialog">
      <form className="dialog-body" onSubmit={submit}>
        <h3 className="dialog-title">{id ? 'Edit rate period' : 'Add rate period'}</h3>
        <div className="form-grid">
          <FormField label="From (start)"><input type="date" value={form.start_date} onChange={e => set('start_date', e.target.value)} /></FormField>
          <FormField label="Villkorsändringsdag (optional)"><input type="date" value={form.end_date} onChange={e => set('end_date', e.target.value)} /></FormField>
          <FormField label="Interest rate %"><input type="text" inputMode="decimal" placeholder="e.g. 3.54" value={form.rate} onChange={e => set('rate', e.target.value)} /></FormField>
          <div className="form-field">
            <span>Rate type</span>
            <Segmented value={form.rate_type} onChange={v => set('rate_type', v)}
              options={[{ v: 'rörlig', label: 'Rörlig' }, { v: 'bunden', label: 'Bunden' }]} />
          </div>
        </div>
        <p className="form-hint">Nästa ränteändring — bankens datum. Rörlig is a rolling 3-month binding, so it has one too; leave blank for an ongoing rate with no known date.</p>
        <div className="dialog-actions">
          {id && <button type="button" className="btn btn-ghost btn-danger" onClick={() => { if (confirm('Delete this rate period?')) onDelete(id) }}>Delete</button>}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">Save</button>
        </div>
      </form>
    </DialogShell>
  )
}
