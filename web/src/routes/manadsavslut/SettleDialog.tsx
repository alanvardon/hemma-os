import { useEffect, useMemo, useState } from 'react'
import DialogShell from '../../components/DialogShell'
import FormField from '../../components/FormField'
import { Money } from '../../components/AnimatedNumber'
import { usePersonNames } from '../../components/usePersonNames'
import { CURRENCY_SUFFIX } from '../../lib/format'
import { buildSettlement, monthLabel, monthsWithOpenItems, itemsForMonth } from '../../lib/manadsavslut'
import type { Item, Payment, MonthEndSettings } from '../../lib/manadsavslut'
import { currencyState, clean, defaultPeriodLabel } from './shared'

interface SettleDlgProps {
  open: boolean; openItems: Item[]; pendingCount: number; settings: MonthEndSettings
  onConfirm: (draft: Omit<Payment, 'id' | 'created_at'>) => void; onClose: () => void
}
export default function SettleDialog({ open, openItems, pendingCount, settings, onConfirm, onClose }: SettleDlgProps) {
  const { nameOf } = usePersonNames(settings.person_a_name, settings.person_b_name)
  const months = useMemo(() => monthsWithOpenItems(openItems), [openItems])
  const [month, setMonth] = useState<string>('')
  const [period, setPeriod] = useState('')
  const [note, setNote] = useState('')
  useEffect(() => {
    if (open) { const m = months[0] ?? '__all__'; setMonth(m); setNote(''); setPeriod(m === '__all__' ? defaultPeriodLabel() : monthLabel(m)) }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const scope = month === '__all__' ? openItems : itemsForMonth(openItems, month)
  const pending = useMemo(() => buildSettlement(scope, {}), [scope])

  function onMonthChange(m: string) { setMonth(m); setPeriod(m === '__all__' ? defaultPeriodLabel() : monthLabel(m)) }
  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!pending.item_ids.length) return
    onConfirm({ ...pending, period_label: clean(period), note: clean(note) })
  }
  const transfer = pending.from_person && pending.amount > 0
    ? <>{nameOf(pending.from_person)} → {nameOf(pending.to_person)} · <strong><Money value={pending.amount} currencySuffix={CURRENCY_SUFFIX[currencyState.current] || 'kr'} maxDecimals={2} rollIn /></strong></>
    : <>Even — no transfer</>
  return (
    <DialogShell open={open} onClose={onClose} className="ma-dialog">
      <form className="dialog-body" onSubmit={submit}>
        <h3 className="dialog-title">Settle up</h3>
        <div className="form-grid">
          <FormField label="Settle which month?" wide>
            <select className="select" value={month} onChange={e => onMonthChange(e.target.value)}>
              {months.map(mk => <option key={mk} value={mk}>{monthLabel(mk)} ({itemsForMonth(openItems, mk).length})</option>)}
              <option value="__all__">All open items ({openItems.length})</option>
            </select>
          </FormField>
        </div>
        <p className="settle-line">
          {pending.item_ids.length
            ? <>{transfer} — closing {pending.item_ids.length} item{pending.item_ids.length === 1 ? '' : 's'}.</>
            : 'No open items in this period.'}
        </p>
        {pendingCount > 0 && (
          <p className="settle-pending-note">{pendingCount} item{pendingCount === 1 ? '' : 's'} still “ask later” — not included. Resolve them in the list first if you want them in.</p>
        )}
        <div className="form-grid">
          <FormField label="Period label" wide><input type="text" autoComplete="off" placeholder="e.g. Juni 2026" value={period} onChange={e => setPeriod(e.target.value)} /></FormField>
          <FormField label="Note (optional)" wide><input type="text" autoComplete="off" value={note} onChange={e => setNote(e.target.value)} /></FormField>
        </div>
        <p className="form-hint">Closes just the chosen month's open items under one payment — a true month-end. Pick “All open items” to settle everything. Reopen later from History.</p>
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!pending.item_ids.length}>Confirm settlement</button>
        </div>
      </form>
    </DialogShell>
  )
}
