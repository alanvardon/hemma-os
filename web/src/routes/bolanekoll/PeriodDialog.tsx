import { useEffect, useMemo, useState } from 'react'
import DialogShell from '../../components/DialogShell'
import FormField from '../../components/FormField'
import Segmented from '../../components/Segmented'
import { useConfirm } from '../../components/useConfirm'
import {
  dayBefore,
  defaultRatePeriodStart,
  makeRatePeriod,
  parseAmount,
  proposeRatePeriodTransition,
  ratePeriodNeighbours,
  todayISO,
} from '../../lib/mortgage'
import type { RatePeriod } from '../../lib/mortgage'
import {
  predecessorCloseDisclosure,
  RATE_PERIOD_DELETE_CONFIRM_TITLE,
  rateDeltaLabel,
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
  // Plan 127 §2 — once the owner has directly edited Villkorsändringsdag or
  // Typ, the create-only recompute below must never overwrite it again, even
  // though Gäller från keeps changing. Reset alongside the form on every open.
  const [endTouched, setEndTouched] = useState(false)
  const [typeTouched, setTypeTouched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    if (!open) return
    if (id) {
      // Editing an existing record: defaults come straight from it. The
      // create-only contextual recompute below never runs for an edit.
      setForm({ start_date: rec?.start_date || todayISO(), end_date: rec?.end_date || '', rate: rec?.rate != null ? String(rec.rate) : '', rate_type: rec?.rate_type || 'rörlig' })
    } else {
      // Plan 127 §2 — "Ny räntesats" always starts from the surrounding
      // timeline: the day after a closed predecessor, else today. Räntesats
      // stays empty — it's the value being changed, never guessed. Typ and
      // the end boundary are derived from THIS start date by the recompute
      // effect below, the same rule that reruns when Gäller från changes.
      const start = partId ? defaultRatePeriodStart(partId, periods, todayISO()) : todayISO()
      setForm({ start_date: start, end_date: '', rate: '', rate_type: 'rörlig' })
    }
    setError(null)
    setPending(false)
    setEndTouched(false)
    setTypeTouched(false)
  }, [open, id]) // eslint-disable-line react-hooks/exhaustive-deps
  // Clearing the error on every edit keeps a stale failure from describing a
  // draft the owner has already changed.
  const set = (k: string, v: string) => {
    setError(null)
    if (k === 'end_date') setEndTouched(true)
    if (k === 'rate_type') setTypeTouched(true)
    setForm(p => ({ ...p, [k]: v }))
  }

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

  // Plan 127 §2 — re-derive Typ and the end boundary every time Gäller från
  // (and therefore `neighbours`) changes, but only for a field the owner has
  // not directly touched. This is the ONE recompute path: it also produces
  // the very first default, since the mount effect above seeds start_date and
  // leaves end_date/rate_type for this effect to fill in.
  useEffect(() => {
    if (!open || id || !partId) return
    setForm(p => {
      const rate_type = typeTouched ? p.rate_type : (neighbours?.previous?.rate_type || 'rörlig')
      const end_date = endTouched ? p.end_date : (neighbours?.next ? (dayBefore(neighbours.next.start_date) ?? '') : '')
      if (rate_type === p.rate_type && end_date === p.end_date) return p
      return { ...p, rate_type, end_date }
    })
  }, [neighbours, open, id, partId, typeTouched, endTouched])

  // A timeline conflict is worth showing the moment it exists; a half-typed rate
  // or date is not, so those two reasons only surface on an actual submit.
  const conflict = proposal?.status === 'invalid' && proposal.reason !== 'invalid-rate' && proposal.reason !== 'invalid-date'
    ? ratePeriodInvalidMessage(proposal.reason, neighbours)
    : null
  const disclosure = proposal?.status === 'valid' && proposal.transition.close && neighbours?.previous
    ? predecessorCloseDisclosure(neighbours.previous, proposal.transition.close.end_date)
    : null

  // Plan 127 §2 — the delta beside the new rate once a valid number is
  // entered, measured against the immediate predecessor at this start date.
  // Create-only: an edit has no "current" rate to compare against.
  const deltaInfo = useMemo(() => {
    if (id) return null
    const previousRate = neighbours?.previous?.rate ?? null
    const rate = draft.rate
    if (previousRate == null || typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) return null
    return { label: rateDeltaLabel(previousRate, rate), sign: Math.sign(rate - previousRate) }
  }, [id, neighbours, draft.rate])

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
        <h3 className="dialog-title">{id ? 'Redigera ränteperiod' : 'Ny räntesats'}</h3>
        <div className="form-grid">
          <FormField label="Gäller från"><input type="date" value={form.start_date} onChange={e => set('start_date', e.target.value)} /></FormField>
          <FormField label="Villkorsändringsdag (valfritt)"><input type="date" value={form.end_date} onChange={e => set('end_date', e.target.value)} /></FormField>
          <FormField label="Räntesats %">
            {/* aria-label pins the accessible name to the caption alone — the
                delta span below is also inside this label, and its text would
                otherwise get folded into the wrapping label's computed name. */}
            <input type="text" inputMode="decimal" placeholder="t.ex. 3,54" aria-label="Räntesats %" value={form.rate} onChange={e => set('rate', e.target.value)} />
            {deltaInfo && (
              <span className={'rate-delta' + (deltaInfo.sign > 0 ? ' is-up' : deltaInfo.sign < 0 ? ' is-down' : '')}>
                {deltaInfo.label}
              </span>
            )}
          </FormField>
          <div className="form-field">
            <span>Typ</span>
            <Segmented value={form.rate_type} onChange={v => set('rate_type', v)}
              options={[{ v: 'rörlig', label: 'Rörlig' }, { v: 'bunden', label: 'Bunden' }]} />
          </div>
        </div>
        <p className="form-hint">Rörlig bolåneränta är normalt bunden tre månader i taget. Ange bankens nästa villkorsändringsdag när den är känd; lämna tomt endast när perioden saknar ett känt slutdatum.</p>
        {disclosure && <p className="form-hint rate-transition-note">{disclosure}</p>}
        {conflict && <p className="dialog-error" role="alert">{conflict}</p>}
        {error && error !== conflict && <p className="dialog-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          {id && <button type="button" className="btn btn-ghost btn-danger" disabled={pending} onClick={async () => { if (await confirm({ title: RATE_PERIOD_DELETE_CONFIRM_TITLE })) onDelete(id) }}>Ta bort</button>}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost" disabled={pending} onClick={onClose}>Avbryt</button>
          <button type="submit" className="btn btn-primary" disabled={pending}>Spara</button>
        </div>
      </form>
    </DialogShell>
  )
}
