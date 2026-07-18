import { useEffect, useState } from 'react'
import { Pencil } from 'lucide-react'
import DialogShell from '../../components/DialogShell'
import Icon from '../../components/Icon'
import { useConfirm } from '../../components/useConfirm'
import { persistenceErrorMessage } from '../../lib/persistence-error'
import { partBalance, partsForMortgage, paymentsForMortgage, effectiveRatePeriod } from '../../lib/mortgage'
import type { Bank, LoanPart, Mortgage, Payment, RatePeriod } from '../../lib/mortgage'
import { fmtMoney, fmtPct, kindLabel } from './shared'

// Tidigare avtal (plan 109 decision 7): the closed agreements, newest first,
// then an editable detail scoped to the selected one. Editing history reuses the
// SAME Part/Payment dialogs the page uses (via the parent callbacks) so a
// historical row never reactivates the agreement or moves to the active one —
// the edit keeps the row's existing agreement link.
//
// The most recent bank change also offers Ångra bankbyte here, but ONLY while
// the new (active) agreement is still transaction-free (computed by the parent;
// the RPC re-verifies). Reverting deletes the new agreement and its parts and
// reactivates the predecessor.
export default function AgreementHistoryDialog({
  open, mortgages, banks, parts, periods, payments,
  canRevert, revertTargetLabel, onRevert, onEditPart, onEditPayment, onClose,
}: {
  open: boolean
  mortgages: Mortgage[]
  banks: Bank[]
  parts: LoanPart[]
  periods: RatePeriod[]
  payments: Payment[]
  canRevert: boolean
  revertTargetLabel: string
  onRevert: () => Promise<void>
  onEditPart: (id: string) => void
  onEditPayment: (id: string) => void
  onClose: () => void
}) {
  const confirm = useConfirm()
  const archived = mortgages
    .filter(m => m && m.archived)
    .sort((a, b) => String(b.end_date ?? '').localeCompare(String(a.end_date ?? '')))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [reverting, setReverting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setSelectedId(archived[0]?.id ?? null)
    setReverting(false)
    setError(null)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps -- archived derives from props

  const selected = selectedId ? archived.find(m => m.id === selectedId) ?? null : null
  const bankLabel = (m: Mortgage | null) => m?.bank_id ? (banks.find(b => b.id === m.bank_id)?.label || 'Okänd bank') : 'Okänd bank'
  const dateRange = (m: Mortgage) => `${m.start_date || '—'} → ${m.end_date || '—'}`

  const detailParts = selected ? partsForMortgage(parts, selected.id) : []
  const detailPeriods = (partId: string) => periods
    .filter(p => p.loan_part_id === partId)
    .sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)))
  const detailPayments = selected ? paymentsForMortgage(payments, parts, selected.id) : []

  async function handleRevert() {
    if (!(await confirm({
      title: 'Ångra bankbytet?',
      message:
        'Detta RADERAR det nya avtalet (' + revertTargetLabel + ') och dess lånedelar, och ÅTERAKTIVERAR det tidigare avtalet. ' +
        'Det går bara så länge inga transaktioner har registrerats på det nya avtalet. Åtgärden kan inte göras ogjord.',
      confirmLabel: 'Ångra bankbyte',
    }))) return
    setReverting(true)
    setError(null)
    try {
      await onRevert()
      onClose()
    } catch (err) {
      // No partial state — the RPC is atomic. Show the failure in place.
      setError(persistenceErrorMessage(err))
    } finally {
      setReverting(false)
    }
  }

  return (
    <DialogShell open={open} onClose={onClose} className="bk-dialog bk-history" ariaLabel="Tidigare avtal">
      <div className="dialog-body">
        <h3 className="dialog-title">Tidigare avtal <span className="card-en">· Previous agreements</span></h3>

        {canRevert && (
          <div className="history-revert" role="group" aria-label="Ångra bankbyte">
            <p>
              <b>Ångra det senaste bankbytet?</b> Det nya avtalet ({revertTargetLabel}) har inga registrerade transaktioner ännu.
              Att ångra raderar det nya avtalet och dess lånedelar och återaktiverar det tidigare avtalet.
            </p>
            {error && <p className="dialog-error" role="alert">{error}</p>}
            <button type="button" className="btn btn-ghost btn-danger" onClick={handleRevert} disabled={reverting}>
              {reverting ? 'Ångrar…' : 'Ångra bankbyte'}
            </button>
          </div>
        )}

        {archived.length === 0 ? (
          <p className="empty">Inga tidigare avtal. Ett avtal hamnar här när du byter bank.</p>
        ) : (
          <div className="history-layout">
            <ul className="history-list">
              {archived.map(m => (
                <li key={m.id}>
                  <button type="button"
                    className={'history-item' + (m.id === selectedId ? ' is-selected' : '')}
                    aria-pressed={m.id === selectedId}
                    onClick={() => setSelectedId(m.id)}>
                    <span className="history-item-bank">{bankLabel(m)}</span>
                    <span className="history-item-dates">{dateRange(m)}</span>
                  </button>
                </li>
              ))}
            </ul>

            {selected && (
              <div className="history-detail">
                <div className="history-detail-head">
                  <span className="agreement-status is-closed">Avslutat</span>
                  <span className="history-detail-name">{selected.label || 'Bolån'}</span>
                  <span className="history-detail-bank">{bankLabel(selected)}</span>
                  <span className="history-detail-range">{dateRange(selected)}</span>
                </div>

                <h4 className="history-section-head">Lånedelar</h4>
                {detailParts.length === 0 ? <p className="empty">Inga lånedelar.</p> : (
                  <ul className="history-parts">
                    {detailParts.map(p => {
                      const per = effectiveRatePeriod(p, periods)
                      const myPeriods = detailPeriods(p.id)
                      return (
                        <li key={p.id} className="history-part">
                          <div className="history-part-head">
                            <span className="ld-name">{p.label || '(namnlös)'}{p.loan_number && <span className="ld-loanno">#{p.loan_number}</span>}</span>
                            <span className="history-part-bal">{fmtMoney(partBalance(p, payments))}</span>
                            {per?.rate != null && <span className="ld-rate">{fmtPct(per.rate)}</span>}
                            <button type="button" className="icon-btn" title="Redigera lånedel" aria-label="Redigera lånedel"
                              onClick={() => onEditPart(p.id)}><Icon icon={Pencil} /></button>
                          </div>
                          {myPeriods.length > 0 && (
                            <ul className="history-periods">
                              {myPeriods.map(r => (
                                <li key={r.id}>
                                  <span>{r.start_date || '—'} → {r.end_date || 'nu'}</span>
                                  <span>{r.rate != null ? fmtPct(r.rate) : '—'} · {r.rate_type === 'bunden' ? 'Bunden' : 'Rörlig'}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}

                <h4 className="history-section-head">Transaktioner <span className="count-pill">{detailPayments.length}</span></h4>
                {detailPayments.length === 0 ? <p className="empty">Inga transaktioner.</p> : (
                  <div className="table-wrap">
                    <table className="data-table history-payments">
                      <thead><tr><th className="col-date">Datum</th><th>Typ</th><th className="num">Belopp</th><th className="col-act" /></tr></thead>
                      <tbody>
                        {detailPayments.map(p => (
                          <tr key={p.id}>
                            <td className="col-date">{p.date || '—'}</td>
                            <td><span className={'kind-tag kind-' + (p.kind || 'other')}>{kindLabel(p.kind)}</span></td>
                            <td className="num">{fmtMoney(p.amount)}</td>
                            <td className="col-act">
                              <button type="button" className="icon-btn" title="Redigera transaktion" aria-label="Redigera transaktion"
                                onClick={() => onEditPayment(p.id)}><Icon icon={Pencil} /></button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="form-hint">Ändringar i historiken stannar på det avslutade avtalet och påverkar inte det aktiva avtalets prognos.</p>
              </div>
            )}
          </div>
        )}

        <div className="dialog-actions">
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost" onClick={onClose}>Stäng</button>
        </div>
      </div>
    </DialogShell>
  )
}
