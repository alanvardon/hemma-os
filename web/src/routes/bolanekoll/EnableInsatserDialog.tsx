import DialogShell from '../../components/DialogShell'
import type { Payment } from '../../lib/mortgage'
import { fmtMoney } from './shared'

// Opened from the ledger ★ while contribution tracking is still off — the
// in-app replacement for the old window.confirm on this path. The feature
// question comes BEFORE any data changes: turn tracking on and go straight to
// allocating this payment, just flag the row without tracking, or do nothing.

interface EnableDlgProps {
  open: boolean; payment: Payment | null
  onEnable: () => void; onFlagOnly: () => void; onClose: () => void
}
export default function EnableInsatserDialog({ open, payment, onEnable, onFlagOnly, onClose }: EnableDlgProps) {
  const amount = payment ? Math.round(Number(payment.amount) || 0) : 0
  return (
    <DialogShell open={open} onClose={onClose} className="bk-dialog" ariaLabel="Flag as insats">
      <div className="dialog-body">
        <h3 className="dialog-title">Flagga som insats <span className="card-en">· Flag as insats</span></h3>
        <p className="config-note" style={{ marginBottom: '1.2rem' }}>
          Contribution tracking is off. Turn it on to allocate this {fmtMoney(amount)} between the owners
          and see the paid-in split — Ägarandel — on the dashboard and in the Insatser section.
          Or just flag the payment as an extra amortering, without per-owner tracking.
        </p>
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onFlagOnly}>Flagga bara · Just flag</button>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={onEnable}>Turn on &amp; allocate</button>
        </div>
      </div>
    </DialogShell>
  )
}
