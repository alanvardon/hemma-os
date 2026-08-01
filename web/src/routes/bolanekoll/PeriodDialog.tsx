import { useEffect, useMemo, useState } from 'react'
import DialogShell from '../../components/DialogShell'
import FormField from '../../components/FormField'
import Segmented from '../../components/Segmented'
import { useConfirm } from '../../components/useConfirm'
import {
  makeRatePeriod,
  parseAmount,
  proposeRatePeriodTransition,
  ratePeriodNeighbours,
  todayISO,
} from '../../lib/mortgage'
import type { RatePeriod } from '../../lib/mortgage'
import {
  predecessorCloseDisclosure,
  ratePeriodInvalidMessage,
} from './ratePeriodCopy'
import type { SavePeriodResult } from './useMortgageWorkspace'

interface PeriodDlgProps {
  open: boolean; partId: string | null; id: string | null; periods: RatePeriod[]
  onSave: (data: Omit<RatePeriod, 'id' | 'created_at'>) => Promise<SavePeriodResult>
  onDelete: (id: string) => void; onClose: () => void
}
export default function PeriodDialog({ open, partId, id, periods, onSave, onDelete, onClose }: PeriodDlgProps) {
  const confirm = useConfirm()
  const rec = id ? periods.find(p => p.id === id) : null
  const [form, setForm] = useState({ start_date: '', end_date: '', rate: '', rate_type: 'rörlig' as 'rörlig' | 'bunden' })
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    if (open) {
      setForm({ start_date: rec?.start_date || todayISO(), end_date: rec?.end_date || '', rate: rec?.rate != null ? String(rec.rate) : '', rate_type: rec?.rate_type || 'rörlig' })
      setError(null)
      setPending(false)
    }
  }, [open, id]) // eslint-disable-line react-hooks/exhaustive-deps
  // Clearing the error on every edit keeps a stale failure from describing a
  // draft the owner has already changed.
  const set = (k: string, v: string) => { setError(null); setForm(p => ({ ...p, [k]: v })) }

  const draft = useMemo(
    () => makeRatePeriod({ loan_part_id: partId, start_date: form.start_date || todayISO(), end_date: form.end_date || null, rate: parseAmount(form.rate), rate_type: form.rate_type }),
    [partId, form],
  )
  // Creating resolves the draft against the real timeline, so an overlap, a gap
  // or a duplicate start is caught before anything is persisted. Editing passes
  // an empty timeline, which applies exactly the same date/rate rules without
  // re-resolving neighbours (plan 127 §1).
  const proposal = useMemo(
    () => (partId ? proposeRatePeriodTransition(partId, id ? [] : periods, draft) : null),
    [partId, id, periods, draft],
  )
  const neighbours = useMemo(
    () => (partId && !id ? ratePeriodNeighbours(partId, periods, draft.start_date) : null),
    [partId, id, periods, draft.start_date],
  )

  // A timeline conflict is worth showing the moment it exists; a half-typed rate
  // or date is not, so those two reasons only surface on an actual submit.
  const conflict = proposal?.status === 'invalid' && proposal.reason !== 'invalid-rate' && proposal.reason !== 'invalid-date'
    ? ratePeriodInvalidMessage(proposal.reason, neighbours)
    : null
  const disclosure = proposal?.status === 'valid' && proposal.transition.close && neighbours?.previous
    ? predecessorCloseDisclosure(neighbours.previous, proposal.transition.close.end_date)
    : null

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (pending) return
    if (proposal?.status === 'invalid') {
      setError(ratePeriodInvalidMessage(proposal.reason, neighbours))
      return
    }
    setError(null)
    setPending(true)
    try {
      // Closes only on a resolved success. A creation writes two rows in
      // sequence (plan 127 Fix 3), so a failure can mean the new period is
      // stored while its predecessor still overlaps — the dialog has to stay
      // open with the draft and the repair instruction.
      const result = await onSave(draft)
      if (result.ok) onClose()
      else setError(result.message)
    } finally {
      setPending(false)
    }
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
        {disclosure && <p className="form-hint rate-transition-note">{disclosure}</p>}
        {conflict && <p className="dialog-error" role="alert">{conflict}</p>}
        {error && error !== conflict && <p className="dialog-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          {id && <button type="button" className="btn btn-ghost btn-danger" disabled={pending} onClick={async () => { if (await confirm({ title: 'Delete this rate period?' })) onDelete(id) }}>Delete</button>}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost" disabled={pending} onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={pending}>Save</button>
        </div>
      </form>
    </DialogShell>
  )
}
