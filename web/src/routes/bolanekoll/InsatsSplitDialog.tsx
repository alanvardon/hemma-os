import { useEffect, useState } from 'react'
import DialogShell from '../../components/DialogShell'
import FormField from '../../components/FormField'
import { usePersonNames } from '../../components/usePersonNames'
import { parseAmount } from '../../lib/mortgage'
import type { Payment, MortgageSettings } from '../../lib/mortgage'
import { fmtMoney } from './shared'

// Opened from the ledger ★. Splits one extra-payment line between the two
// owners (a co-funded insats), or removes the insats flag entirely.

interface InsatsDlgProps {
  open: boolean; payment: Payment | null; settings: MortgageSettings
  onSave: (split: { a: number; b: number }) => void
  onRemove: () => void; onClose: () => void
}
export default function InsatsSplitDialog({ open, payment, settings, onSave, onRemove, onClose }: InsatsDlgProps) {
  const amount = payment ? Math.round(Number(payment.amount) || 0) : 0
  const { a: aName, b: bName } = usePersonNames(settings.owner_a_name, settings.owner_b_name)
  const [aStr, setAStr] = useState(''); const [bStr, setBStr] = useState('')
  useEffect(() => {
    if (!open || !payment) return
    let a: number
    if (payment.paid_split) a = Math.round(Number(payment.paid_split.a) || 0)
    else if (payment.paid_by === 'a') a = amount
    else if (payment.paid_by === 'b') a = 0
    else { const pct = Number(settings.my_ownership_pct); const ap = settings.i_am === 'b' ? 100 - pct : pct; a = Math.round(amount * (isFinite(ap) ? ap : 50) / 100) }
    setAStr(String(a)); setBStr(String(Math.max(0, amount - a)))
  }, [open, payment?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const av = Math.max(0, Math.min(amount, parseAmount(aStr) || 0))
  const bv = Math.max(0, Math.min(amount, parseAmount(bStr) || 0))
  const balanced = av + bv === amount
  function changeA(v: string) { setAStr(v); const a = Math.max(0, Math.min(amount, parseAmount(v) || 0)); setBStr(String(Math.max(0, amount - a))) }
  function changeB(v: string) { setBStr(v); const b = Math.max(0, Math.min(amount, parseAmount(v) || 0)); setAStr(String(Math.max(0, amount - b))) }
  function submit(e: React.FormEvent) { e.preventDefault(); onSave({ a: av, b: bv }) }
  return (
    <DialogShell open={open} onClose={onClose} className="bk-dialog">
      <form className="dialog-body" onSubmit={submit}>
        <h3 className="dialog-title">Allocate insats</h3>
        <p className="config-note" style={{ marginBottom: '1rem' }}>Split this {fmtMoney(amount)} extra payment between {aName} and {bName} — how much each person actually paid in. Editing one side fills the other.</p>
        <div className="form-grid">
          <FormField label={aName}><input type="text" inputMode="decimal" value={aStr} onChange={e => changeA(e.target.value)} /></FormField>
          <FormField label={bName}><input type="text" inputMode="decimal" value={bStr} onChange={e => changeB(e.target.value)} /></FormField>
        </div>
        <p className={'form-hint' + (balanced ? '' : ' is-warn')}>{fmtMoney(av)} + {fmtMoney(bv)} = {fmtMoney(av + bv)}{balanced ? '' : ' · should equal ' + fmtMoney(amount)}</p>
        <div className="dialog-actions">
          {payment?.is_insats && <button type="button" className="btn btn-ghost btn-danger" onClick={onRemove}>Remove insats</button>}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!balanced}>Save</button>
        </div>
      </form>
    </DialogShell>
  )
}
