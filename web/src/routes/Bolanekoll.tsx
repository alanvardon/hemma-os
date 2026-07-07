import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Money, Percent } from '../components/AnimatedNumber'
import EquityStackChart, { type EquityPoint } from '../components/charts/EquityStackChart'
import Collapse from '../components/Collapse'
import DialogShell from '../components/DialogShell'
import FormField from '../components/FormField'
import PageHeader from '../components/PageHeader'
import ThemeToggle from '../components/ThemeToggle'
import { useSaveFlash } from '../components/useSaveFlash'
import { useToast } from '../components/useToast'
import { useToolPageActive } from '../lib/toolTransition'
import {
  defaultSettings, parseCsv, parseAmount, autoMapColumns, classifyKind,
  makeLoanPart, makeRatePeriod, makePayment, flagDuplicates, assignPaymentsToPart,
  partBalance, totalBalance, totalAmortized, totalInterest, ranteavdrag,
  propertyValue, equity, loanToValue, otherOwner,
  purchasePrice, costBasisEquity, costBasisOwnedPct, costBasisSplit, derivedDeposit, insatsPayments,
  effectiveRatePeriod, bindingStatus, groupLoanParts, weightedAvgRate, derivedRate, amorteringskravStatus,
  equityTimeline, equityBridge, projectMilestones, monthlyAmortizationRate, monthlyCost,
  paymentsToCsv, headerSignature, mappingToNames, applyPreset, reconcileBalance,
  contributionSplit, settlement, todayISO, normPaidBy,
} from '../lib/mortgage'
import type { LoanPart, LoanPartGroup, RatePeriod, Payment, Valuation, Contribution, MortgageSettings, CsvResult, ColMapping, Owner, PaidBy } from '../lib/mortgage'
import * as Store from '../lib/mortgage-store'
import { CURRENCY_SUFFIX } from '../lib/format'
import Segmented from '../components/Segmented'

// A <tr> can't animate its own height, so revealed rows animate it inside each
// cell instead: the td keeps zero vertical padding (see .cell-pad in CSS) and
// this wrapper tweens the content 0 ↔ auto, so the whole row genuinely grows
// and shrinks rather than popping in at full height with only a fade.
function CellReveal({ reduce, children }: { reduce: boolean | null; children?: ReactNode }) {
  return (
    <motion.div
      style={{ overflow: 'hidden' }}
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={reduce ? { duration: 0 } : { duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="cell-pad">{children}</div>
    </motion.div>
  )
}

// ── Formatters (faithful to mortgagetracker.js) ──────────────────────────────

const KIND_LABELS: Record<string, string> = { interest: 'Ränta', amortization: 'Amortering', payment: 'Betalning', loan: 'Lån', fee: 'Avgift', other: 'Övrigt' }
function kindLabel(k: string): string { return KIND_LABELS[k] || k || '—' }
// Payments ledger paginates: show the most recent PAY_PAGE, reveal more on click.
const PAY_PAGE = 20

function periodFrom(period: string): string | null {
  const d = new Date(), p = (n: number) => (n < 10 ? '0' : '') + n
  if (period === 'ytd') return d.getFullYear() + '-01-01'
  if (period === '12m') { d.setFullYear(d.getFullYear() - 1); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) }
  return null
}
function monthsToWhen(months: number | null): string {
  if (months == null) return '—'
  if (months <= 0) return 'nu · now'
  const d = new Date(); d.setMonth(d.getMonth() + months)
  const s = d.toLocaleDateString('sv-SE', { month: 'short', year: 'numeric' })
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// ── Sub-types ────────────────────────────────────────────────────────────────

interface TriageRow {
  classification: 'include' | 'skip'
  specText: string; kind: Payment['kind']; amount: number; balance_after: number | null
  hasAmount: boolean; loan_part_id: string | null; partMatched: boolean; duplicate: boolean
}
interface ImportCfg {
  file: File; parsed: CsvResult; mapping: ColMapping; importPart: string
  triage: TriageRow[]; queue: File[]; qIdx: number
}

// ── PeriodDialog ───────────────────────────────────────────────────────────

interface PeriodDlgProps {
  open: boolean; partId: string | null; id: string | null; periods: RatePeriod[]
  onSave: (data: Omit<RatePeriod, 'id' | 'created_at'>) => void
  onDelete: (id: string) => void; onClose: () => void
}
function PeriodDialog({ open, partId, id, periods, onSave, onDelete, onClose }: PeriodDlgProps) {
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

// ── PartDialog ─────────────────────────────────────────────────────────────

interface PartDlgProps {
  open: boolean; id: string | null; parts: LoanPart[]; periods: RatePeriod[]; payments: Payment[]
  onSave: (data: Omit<LoanPart, 'id' | 'created_at'>) => void
  onDelete: (id: string) => void; onClose: () => void
  onSavePeriod: (partId: string, data: Omit<RatePeriod, 'id' | 'created_at'>, existingId?: string) => void
  onDeletePeriod: (id: string) => void
}
function PartDialog({ open, id, parts, periods, payments, onSave, onDelete, onClose, onSavePeriod, onDeletePeriod }: PartDlgProps) {
  const rec = id ? parts.find(p => p.id === id) : null
  const [form, setForm] = useState({ label: '', loan_number: '', start_balance: '', start_date: '' })
  const [periodDlg, setPeriodDlg] = useState<{ open: boolean; id: string | null }>({ open: false, id: null })
  useEffect(() => {
    if (open) setForm({ label: rec?.label || '', loan_number: rec?.loan_number || '', start_balance: rec?.start_balance ? String(rec.start_balance) : '', start_date: rec?.start_date || todayISO() })
  }, [open, id]) // eslint-disable-line react-hooks/exhaustive-deps
  const myPeriods = periods.filter(p => p.loan_part_id === id).sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)))
  const set = (k: string, v: string) => setForm(p => ({ ...p, [k]: v }))
  function submit(e: React.FormEvent) {
    e.preventDefault()
    onSave(makeLoanPart({ label: form.label.trim() || 'Lånedel', loan_number: form.loan_number.trim(), start_balance: form.start_balance.trim() === '' ? 0 : parseAmount(form.start_balance), start_date: form.start_date.trim() }))
  }
  const der = id && rec ? derivedRate(rec, payments) : null
  return (
    <>
      <DialogShell open={open} onClose={onClose} className="bk-dialog">
        <form className="dialog-body" onSubmit={submit}>
          <h3 className="dialog-title">{id ? 'Edit loan part' : 'Add loan part'}</h3>
          <div className="form-grid">
            <FormField label="Label" wide><input type="text" placeholder="e.g. Lånedel 1 (rörlig)" value={form.label} onChange={e => set('label', e.target.value)} /></FormField>
            <FormField label="Loan # (optional)"><input type="text" placeholder="e.g. 9021 33 12345" value={form.loan_number} onChange={e => set('loan_number', e.target.value)} /></FormField>
            <FormField label="Start balance"><input type="text" inputMode="decimal" placeholder="0" value={form.start_balance} onChange={e => set('start_balance', e.target.value)} /></FormField>
            <FormField label="As of date"><input type="date" value={form.start_date} onChange={e => set('start_date', e.target.value)} /></FormField>
          </div>
          <p className="form-hint">The start balance is the part's debt on the "as of" date. The interest rate is set per period below.</p>
          {id && (
            <div className="rate-history">
              <div className="rate-history-head">
                <span>Rate periods</span>
                <span className="rate-derived">{der != null ? 'Ledger ≈ ' + fmtPct(der) : ''}</span>
              </div>
              {myPeriods.length ? (
                <ul className="rate-list">
                  {myPeriods.map(r => {
                    const bunden = r.rate_type === 'bunden'
                    return (
                      <li key={r.id}>
                        <span className="rate-when">{r.start_date || '—'} → {r.end_date || 'nu · now'}</span>
                        <span className="rate-pct">{r.rate != null ? fmtPct(r.rate) : '—'}</span>
                        <span className={'rate-type' + (bunden ? ' is-bunden' : '')}>{bunden ? 'Bunden' : 'Rörlig'}</span>
                        <span className="rate-acts">
                          <button type="button" className="icon-btn" title="Edit" onClick={() => setPeriodDlg({ open: true, id: r.id })}>✎</button>
                          <button type="button" className="icon-btn" title="Delete" onClick={() => { if (confirm('Delete this rate period?')) onDeletePeriod(r.id) }}>✕</button>
                        </span>
                      </li>
                    )
                  })}
                </ul>
              ) : <ul className="rate-list"><li className="rate-empty">No rate periods yet — add one to set this part’s rate.</li></ul>}
              <button type="button" className="btn btn-ghost" id="p-rate-add" onClick={() => setPeriodDlg({ open: true, id: null })}>+ Add rate period</button>
            </div>
          )}
          <div className="dialog-actions">
            {id && <button type="button" className="btn btn-ghost btn-danger" onClick={() => { if (confirm('Delete this loan part and all its payments? This can’t be undone.')) onDelete(id) }}>Delete</button>}
            <span style={{ flex: 1 }} />
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary">Save</button>
          </div>
        </form>
      </DialogShell>
      <PeriodDialog open={periodDlg.open} partId={id} id={periodDlg.id} periods={periods}
        onSave={data => { onSavePeriod(id!, data, periodDlg.id || undefined); setPeriodDlg({ open: false, id: null }) }}
        onDelete={pid => { onDeletePeriod(pid); setPeriodDlg({ open: false, id: null }) }}
        onClose={() => setPeriodDlg({ open: false, id: null })} />
    </>
  )
}

// ── ValuationDialog ────────────────────────────────────────────────────────

interface ValDlgProps {
  open: boolean; id: string | null; valuations: Valuation[]
  onSave: (data: Omit<Valuation, 'id' | 'created_at'>) => void
  onDelete: (id: string) => void; onClose: () => void
}
function ValuationDialog({ open, id, valuations, onSave, onDelete, onClose }: ValDlgProps) {
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

// ── PaymentDialog ──────────────────────────────────────────────────────────

interface PayDlgProps {
  open: boolean; id: string | null; payments: Payment[]; parts: LoanPart[]; settings: MortgageSettings
  onSave: (data: Omit<Payment, 'id' | 'created_at'>) => void
  onDelete: (id: string) => void; onClose: () => void
}
function PaymentDialog({ open, id, payments, parts, settings, onSave, onDelete, onClose }: PayDlgProps) {
  const rec = id ? payments.find(p => p.id === id) : null
  const [form, setForm] = useState({ date: todayISO(), loan_part_id: '', kind: 'interest', amount: '', balance_after: '', paid_by: 'joint', is_insats: false })
  useEffect(() => {
    if (open) setForm({ date: rec?.date || todayISO(), loan_part_id: rec?.loan_part_id || (parts[0]?.id || ''), kind: rec?.kind || 'interest', amount: rec?.amount ? String(rec.amount) : '', balance_after: rec?.balance_after != null ? String(rec.balance_after) : '', paid_by: rec?.paid_by || 'joint', is_insats: !!rec?.is_insats })
  }, [open, id]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: string, v: string) => setForm(p => ({ ...p, [k]: v }))
  function submit(e: React.FormEvent) { e.preventDefault(); onSave(makePayment({ date: form.date, loan_part_id: form.loan_part_id || null, kind: form.kind as Payment['kind'], amount: parseAmount(form.amount), balance_after: form.balance_after ? parseAmount(form.balance_after) : null, paid_by: normPaidBy(form.paid_by), is_insats: form.is_insats })) }
  const aName = settings.owner_a_name || 'Alex', bName = settings.owner_b_name || 'Sam'
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

// ── CopyToPartsDialog ─────────────────────────────────────────────────────

interface CopyDlgProps {
  open: boolean; source: Payment | null; parts: LoanPart[]
  onConfirm: (targetIds: string[]) => void; onClose: () => void
}
function CopyToPartsDialog({ open, source, parts, onConfirm, onClose }: CopyDlgProps) {
  const candidates = source
    ? (source.loan_part_id == null ? parts : parts.filter(p => p.id !== source.loan_part_id))
    : []
  const [checked, setChecked] = useState<Set<string>>(new Set())
  useEffect(() => { if (open) setChecked(new Set(candidates.map(p => p.id))) }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: string) => setChecked(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })
  return (
    <DialogShell open={open} onClose={onClose} className="bk-dialog">
      <div className="dialog-body">
        <h3 className="dialog-title">Copy payment to parts</h3>
        <p className="config-note" style={{ marginBottom: '1rem' }}>Copies this payment (same date, amount, type) to each selected part with balance cleared.</p>
        <div className="copy-parts-list">
          {candidates.map(pt => (
            <label key={pt.id} className="copy-part-row">
              <input type="checkbox" checked={checked.has(pt.id)} onChange={() => toggle(pt.id)} />
              <span>{pt.label || pt.id}</span>
            </label>
          ))}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={checked.size === 0}
            onClick={() => onConfirm([...checked])}>
            Copy to {checked.size} part{checked.size === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </DialogShell>
  )
}

// ── InsatsSplitDialog ──────────────────────────────────────────────────────
// Opened from the ledger ★. Splits one extra-payment line between the two
// owners (a co-funded insats), or removes the insats flag entirely.

interface InsatsDlgProps {
  open: boolean; payment: Payment | null; settings: MortgageSettings
  onSave: (split: { a: number; b: number }) => void
  onRemove: () => void; onClose: () => void
}
function InsatsSplitDialog({ open, payment, settings, onSave, onRemove, onClose }: InsatsDlgProps) {
  const amount = payment ? Math.round(Number(payment.amount) || 0) : 0
  const aName = settings.owner_a_name || 'Alex', bName = settings.owner_b_name || 'Sam'
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
        <p className="config-note" style={{ marginBottom: '1rem' }}>Split this {fmtMoney(amount)} extra payment between {aName} and {bName} — how much each person actually funded. Editing one side fills the other.</p>
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

// ── ContribDialog ──────────────────────────────────────────────────────────

interface ContDlgProps {
  open: boolean; id: string | null; contributions: Contribution[]; settings: MortgageSettings
  onSave: (data: Omit<Contribution, 'id' | 'created_at'>) => void
  onDelete: (id: string) => void; onClose: () => void
}
function ContribDialog({ open, id, contributions, settings, onSave, onDelete, onClose }: ContDlgProps) {
  const rec = id ? contributions.find(c => c.id === id) : null
  const [form, setForm] = useState({ owner: 'a' as Owner, date: todayISO(), amount: '', note: '' })
  useEffect(() => { if (open) setForm({ owner: (rec?.owner as Owner) || 'a', date: rec?.date || todayISO(), amount: rec?.amount ? String(rec.amount) : '', note: rec?.note || '' }) }, [open, id]) // eslint-disable-line react-hooks/exhaustive-deps
  const aName = settings.owner_a_name || 'Alex', bName = settings.owner_b_name || 'Sam'
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

// ── SettingsDialog ─────────────────────────────────────────────────────────

interface SetDlgProps {
  open: boolean; settings: MortgageSettings
  onSave: (patch: Partial<MortgageSettings>) => void; onClose: () => void
  onExportJSON: () => void; onExportCSV: () => void; onImportJSON: (e: React.ChangeEvent<HTMLInputElement>) => void
}
function SettingsDialog({ open, settings, onSave, onClose, onExportJSON, onExportCSV, onImportJSON }: SetDlgProps) {
  const [form, setForm] = useState({ ...settings })
  useEffect(() => { if (open) setForm({ ...settings }) }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const f = (k: keyof MortgageSettings) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const v = e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value
    setForm(p => ({ ...p, [k]: v }))
  }
  function submit(e: React.FormEvent) { e.preventDefault(); onSave({ ...form, my_ownership_pct: Number(form.my_ownership_pct), household_income_yearly: form.household_income_yearly ? Number(form.household_income_yearly) : null }) }
  const aName = form.owner_a_name || 'Alex', bName = form.owner_b_name || 'Sam'
  return (
    <DialogShell open={open} onClose={onClose} className="bk-dialog">
      <form className="dialog-body" onSubmit={submit}>
        <h3 className="dialog-title">Settings</h3>
        <div className="form-grid">
          <FormField label="Property name (optional)" wide><input type="text" placeholder="e.g. Storgatan 4" value={form.property_name} onChange={f('property_name')} /></FormField>
          <FormField label="Owner A name"><input type="text" value={form.owner_a_name} onChange={f('owner_a_name')} /></FormField>
          <FormField label="Owner B name"><input type="text" value={form.owner_b_name} onChange={f('owner_b_name')} /></FormField>
          <FormField label="My ownership %"><input type="text" inputMode="decimal" placeholder="50" value={form.my_ownership_pct} onChange={f('my_ownership_pct')} /></FormField>
          <div className="form-field">
            <span>Which owner am I?</span>
            <Segmented value={(form.i_am as Owner) || 'a'} onChange={v => setForm(p => ({ ...p, i_am: v }))}
              options={[{ v: 'a' as Owner, label: aName }, { v: 'b' as Owner, label: bName }]} />
          </div>
          <FormField label="Currency">
            <select className="select" value={form.currency} onChange={f('currency')}>
              <option value="SEK">SEK · kr</option><option value="NOK">NOK · kr</option><option value="DKK">DKK · kr</option>
              <option value="EUR">EUR · €</option><option value="USD">USD · $</option><option value="GBP">GBP · £</option>
            </select>
          </FormField>
          <FormField label="Household income / year (optional)"><input type="text" inputMode="decimal" placeholder="e.g. 720000" value={form.household_income_yearly ?? ''} onChange={f('household_income_yearly')} /></FormField>
          <label className="form-field checkbox-field form-wide">
            <input type="checkbox" checked={form.ranteavdrag} onChange={f('ranteavdrag')} />
            <span>Show estimated ränteavdrag (interest tax deduction)</span>
          </label>
          <label className="form-field checkbox-field form-wide">
            <input type="checkbox" checked={form.track_contributions} onChange={f('track_contributions')} />
            <span>Track contributions — per-owner amortering &amp; lump sums for contribution-based ownership</span>
          </label>
          <div className="form-field form-wide">
            <span>Backup</span>
            <div className="settings-data-row">
              <button type="button" className="btn btn-ghost" onClick={onExportJSON}>Export JSON</button>
              <button type="button" className="btn btn-ghost" onClick={onExportCSV}>Export CSV</button>
              <label className="btn btn-ghost" style={{ cursor: 'pointer' }}>Import JSON
                <input type="file" accept=".json,application/json" hidden onChange={onImportJSON} />
              </label>
            </div>
            <p className="config-note">Download everything as JSON — loan parts, payments, valuations and settings — or restore a backup (merges by id, so re-importing is safe). Export CSV writes the payment ledger for Excel/Sheets or your tax return.</p>
          </div>
        </div>
        <div className="dialog-actions">
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">Save</button>
        </div>
      </form>
    </DialogShell>
  )
}

// ── Money formatter bound to currency at module scope via a mutable ref ──────
// (formatMoney needs the active currency; keep a module-level setter updated by
// the component so plain helpers can format without threading currency through.)
let CURRENT_CURRENCY = 'SEK'
function fmtMoney(n: number): string {
  const suffix = CURRENCY_SUFFIX[CURRENT_CURRENCY] || 'kr'
  return (Math.round(Number(n) || 0)).toLocaleString('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' ' + suffix
}
function fmtPct(n: number): string { return (Number(n) || 0).toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' %' }

// Animated equivalents for the SUMMARY figures (dashboard, bridge, insights).
// Data-table cells, the import triage and prose keep the plain string formatters
// above (long ledgers shouldn't roll on every keystroke).
function M(value: number, signed?: boolean, rollIn?: boolean) {
  return <Money value={value} currencySuffix={CURRENCY_SUFFIX[CURRENT_CURRENCY] || 'kr'} signed={signed} rollIn={rollIn} />
}
function P(value: number, rollIn?: boolean) { return <Percent value={value} decimals={2} space locale="sv-SE" rollIn={rollIn} /> }

// ── Main component ─────────────────────────────────────────────────────────

export default function Bolanekoll() {
  const active = useToolPageActive('/bolanekoll')
  useLayoutEffect(() => { document.documentElement.classList.remove('calc-layout') }, [])

  const [parts, setParts] = useState<LoanPart[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [valuations, setValuations] = useState<Valuation[]>([])
  const [periods, setPeriods] = useState<RatePeriod[]>([])
  const [contributions, setContributions] = useState<Contribution[]>([])
  const [settings, setSettings] = useState<MortgageSettings>(defaultSettings())

  const { toast, showToast } = useToast()
  const { saveVisible: saved, flashSaved } = useSaveFlash()
  // mortgage-store.ts throws on write errors so the UI can react — every
  // mutation below must catch and surface it, or a failed save looks
  // successful (optimistic cache) until the next cloud read silently drops it.
  function saveErr(err: unknown) {
    // supabase-js throws plain {message, ...} objects (not Error instances) for
    // Postgrest/network errors, so read .message directly rather than gating on
    // `instanceof Error` — that check is false for them and prints "[object Object]".
    const message = (err as { message?: string } | null)?.message
    showToast('Kunde inte spara — ' + (message || String(err)))
  }
  const [bridgePeriod, setBridgePeriod] = useState<'ytd' | '12m' | 'all'>('ytd')
  const [extraAmort, setExtraAmort] = useState('')
  const [paymentFilter, setPaymentFilter] = useState('all')
  const [payVisible, setPayVisible] = useState(PAY_PAGE)
  const [isDragging, setIsDragging] = useState(false)
  const [importCfg, setImportCfg] = useState<ImportCfg | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [partDlg, setPartDlg] = useState<{ open: boolean; id: string | null }>({ open: false, id: null })
  const [valDlg, setValDlg] = useState<{ open: boolean; id: string | null }>({ open: false, id: null })
  const [payDlg, setPayDlg] = useState<{ open: boolean; id: string | null }>({ open: false, id: null })
  const [copyDlg, setCopyDlg] = useState<{ open: boolean; source: Payment | null }>({ open: false, source: null })
  const [insatsDlg, setInsatsDlg] = useState<{ open: boolean; payment: Payment | null }>({ open: false, payment: null })
  const [expandedPays, setExpandedPays] = useState<Set<string>>(new Set())
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const groupsSeeded = useRef(false)
  const [avslutadeOpen, setAvslutadeOpen] = useState(false)
  const reduceMotion = useReducedMotion()
  const [contDlg, setContDlg] = useState<{ open: boolean; id: string | null }>({ open: false, id: null })
  const [settingsDlg, setSettingsDlg] = useState(false)

  CURRENT_CURRENCY = settings.currency || 'SEK'

  const refresh = useCallback(async () => {
    const [ps, pays, vals, pers, contribs, sett] = await Promise.all([
      Store.listLoanParts(), Store.listPayments(), Store.listValuations(),
      Store.listRatePeriods(), Store.listContributions(), Store.getSettings(),
    ])
    setParts(ps); setPayments(pays); setValuations(vals); setPeriods(pers); setContributions(contribs); setSettings(sett)
  }, [])

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => { document.title = (settings.property_name || 'Bolånekoll') + ' · Hemma·OS' }, [settings.property_name])
  // Collapse the ledger back to the first page whenever the part filter changes.
  useEffect(() => { setPayVisible(PAY_PAGE) }, [paymentFilter])

  const nameOf = useCallback((p: Owner) => p === 'b' ? (settings.owner_b_name || 'Sam') : (settings.owner_a_name || 'Alex'), [settings])

  // ── Derived data ───────────────────────────────────────────────────────────
  const today = todayISO()
  const balance = useMemo(() => totalBalance(parts, payments), [parts, payments])
  const value = useMemo(() => propertyValue(valuations), [valuations])
  const eq = useMemo(() => equity(value, balance), [value, balance])
  const ltv = useMemo(() => loanToValue(balance, value), [balance, value])
  const amortized = useMemo(() => totalAmortized(parts, payments), [parts, payments])
  const interest = useMemo(() => totalInterest(payments), [payments])
  const deduction = useMemo(() => ranteavdrag(interest), [interest])
  const hasValuation = valuations.length > 0

  // Cost-basis equity: valuation-independent, anchored on the flagged köpeskilling.
  const price = useMemo(() => purchasePrice(valuations), [valuations])
  const hasPurchase = price > 0
  const costBasisEq = useMemo(() => costBasisEquity(price, balance), [price, balance])
  const ownedPct = useMemo(() => costBasisOwnedPct(price, balance), [price, balance])
  const cbSplit = useMemo(() => costBasisSplit(price, balance, payments, contributions, settings), [price, balance, payments, contributions, settings])
  const deposit = useMemo(() => derivedDeposit(price, parts, payments), [price, parts, payments])
  const insatsPays = useMemo(() => insatsPayments(payments), [payments])
  const timeline = useMemo(() => equityTimeline(parts, payments, valuations, settings), [parts, payments, valuations, settings])

  const soon = useMemo(() => {
    let s: { days: number; until: string } | null = null
    parts.forEach(p => {
      const bs = bindingStatus(p, periods)
      if (bs.bound && bs.days_left != null && (s == null || bs.days_left < s.days)) s = { days: bs.days_left, until: bs.until! }
    })
    return s as { days: number; until: string } | null
  }, [parts, periods])

  const loanGroups = useMemo(() => groupLoanParts(parts, periods, payments, today), [parts, periods, payments, today])
  const archivedParts = useMemo(() => parts.filter(p => p.archived), [parts])

  useEffect(() => {
    if (groupsSeeded.current || !loanGroups.length) return
    groupsSeeded.current = true
    setExpandedGroups(new Set(loanGroups.filter(g => g.is_catchall || g.expired).map(g => g.key)))
  }, [loanGroups])

  function toggleGroup(key: string) {
    setExpandedGroups(prev => { const s = new Set(prev); s.has(key) ? s.delete(key) : s.add(key); return s })
  }
  function repriceLabel(days: number | null, expired: boolean): string {
    if (days == null) return ''
    if (expired) return Math.abs(days) + ' d overdue'
    if (days <= 60) return 'in ' + days + ' d'
    return 'in ' + Math.round(days / 30.44) + ' mo'
  }
  const repriceMeta = (g: LoanPartGroup) => (
    <span className="ld-meta">
      <span className="ld-date">{g.end_date}</span>
      {g.days_left != null && <span className={'ld-countdown' + (g.expired ? ' is-expired' : '')}>{repriceLabel(g.days_left, g.expired)}</span>}
    </span>
  )
  // Rate pill. `blended` prefixes Ø for a balance-weighted group average (mixed types).
  const rateBadge = (rate: number | null, type: 'rörlig' | 'bunden' | null, blended = false) =>
    rate == null ? null : (
      <span className={'ld-rate' + (type === 'bunden' ? ' is-bunden' : '')}>
        {blended ? 'Ø ' : ''}{fmtPct(rate)}{type ? ' · ' + (type === 'bunden' ? 'bunden' : 'rörlig') : ''}
      </span>
    )
  const partActs = (p: LoanPart) => (
    <>
      <button type="button" className="icon-btn" title="Edit" onClick={() => setPartDlg({ open: true, id: p.id })}>✎</button>
      <button type="button" className="icon-btn" data-del-part title="Delete" onClick={() => { if (confirm('Delete this loan part and all its payments? This can’t be undone.')) handleDeletePart(p.id) }}>✕</button>
    </>
  )

  const bridgeFrom = useMemo(() => {
    const from = periodFrom(bridgePeriod)
    if (from != null) return from
    const dates: string[] = []
    valuations.forEach(v => { if (v.date) dates.push(String(v.date)) })
    payments.forEach(p => { if (p.date) dates.push(String(p.date)) })
    dates.sort()
    return dates.length ? dates[0] : today
  }, [bridgePeriod, valuations, payments, today])
  const bridge = useMemo(() => equityBridge(parts, payments, valuations, bridgeFrom, today), [parts, payments, valuations, bridgeFrom, today])

  const costRows = useMemo(() => monthlyCost(payments, { ranteavdrag: settings.ranteavdrag }), [payments, settings.ranteavdrag])
  const blended = useMemo(() => weightedAvgRate(parts, periods, payments), [parts, periods, payments])
  const krav = useMemo(() => amorteringskravStatus(parts, payments, valuations, settings), [parts, payments, valuations, settings])

  const extra = Math.max(0, parseAmount(extraAmort) || 0)
  const base = useMemo(() => monthlyAmortizationRate(parts, payments), [parts, payments])
  const ms = useMemo(() => projectMilestones(parts, payments, valuations, settings, { extraMonthly: extra }), [parts, payments, valuations, settings, extra])

  const reconcile = useMemo(() => reconcileBalance(parts, payments).filter(r => {
    if (r.drift == null || r.start_balance == null) return false
    return Math.abs(r.drift) >= Math.max(r.start_balance * 0.01, 5000)
  }), [parts, payments])

  const contribSplit = useMemo(() => settings.track_contributions ? contributionSplit(payments, contributions, settings) : null, [payments, contributions, settings])
  const settl = useMemo(() => settings.track_contributions ? settlement(payments, contributions, settings) : null, [payments, contributions, settings])

  const insightsReady = parts.length > 0 && valuations.length > 0 && payments.length > 0

  // ── Chart data (stacked area: my equity → partner → bank) ────────────────────
  // Resolve the timeline into display-ordered bands; negatives clip to 0 so the
  // stack never inverts (matches the old Chart.js Math.max(0, …)).
  const me: Owner = settings.i_am === 'b' ? 'b' : 'a'
  const other: Owner = me === 'a' ? 'b' : 'a'
  const chartData = useMemo<EquityPoint[]>(
    () => timeline.map(r => ({
      label: r.label,
      mine: Math.max(0, me === 'a' ? r.a_equity : r.b_equity),
      partner: Math.max(0, me === 'a' ? r.b_equity : r.a_equity),
      bank: Math.max(0, r.bank),
    })),
    [timeline, me],
  )

  // ── Import ───────────────────────────────────────────────────────────────
  function buildTriage(parsed: CsvResult, mapping: ColMapping, importPart: string): TriageRow[] {
    const auto = importPart === '__auto__' && mapping.loan_number != null
    const fallback = auto ? (parts[0]?.id || null) : (importPart || null)
    const loanNumbers = parsed.rows.map(r => mapping.loan_number == null ? null : (r[mapping.loan_number] ?? ''))
    const assigns = assignPaymentsToPart(loanNumbers, parts, { selectedPartId: fallback, auto })
    const candidates = parsed.rows.map((row, i) => {
      const specText = (mapping.specification != null ? row[mapping.specification] : '')?.trim() || ''
      const amt = mapping.amount == null ? NaN : parseAmount(row[mapping.amount])
      const bal = mapping.balance == null ? NaN : parseAmount(row[mapping.balance])
      const amount = isFinite(amt) ? Math.abs(amt) : 0
      const balance_after = isFinite(bal) ? Math.abs(bal) : null
      const hasAmount = amount > 0 || balance_after != null
      const a = assigns[i]
      return { specText, kind: classifyKind(specText), amount, balance_after, hasAmount, loan_part_id: a?.loan_part_id ?? null, partMatched: a?.matched ?? false }
    })
    const dupInput = candidates.map(c => ({ date: '', loan_part_id: c.loan_part_id, kind: c.kind, amount: c.amount }))
    const dups = flagDuplicates(payments, dupInput)
    return candidates.map((c, i) => ({ ...c, duplicate: !!dups[i], classification: (dups[i] || !c.hasAmount ? 'skip' : 'include') as 'include' | 'skip' }))
  }
  async function loadFile(file: File): Promise<ImportCfg> {
    const text = await file.text()
    const parsed = parseCsv(text)
    let mapping = autoMapColumns(parsed.headers)
    const sig = headerSignature(parsed.headers)
    if (settings.import_presets[sig]) mapping = applyPreset(parsed.headers, settings.import_presets[sig])
    const importPart = mapping.loan_number != null ? '__auto__' : (parts[0]?.id || '')
    return { file, parsed, mapping, importPart, triage: buildTriage(parsed, mapping, importPart), queue: [], qIdx: 0 }
  }
  async function handleFiles(files: FileList | File[]) {
    const arr = Array.from(files).filter(f => f.name.endsWith('.csv') || f.type.includes('csv') || f.type.includes('text'))
    if (!arr.length) return
    if (!parts.length) { showToast('Add a loan part first, then import.'); return }
    const cfg = await loadFile(arr[0])
    setImportCfg({ ...cfg, queue: arr.slice(1), qIdx: 0 })
  }
  function reTriage(patch: Partial<Pick<ImportCfg, 'mapping' | 'importPart'>>) {
    setImportCfg(p => {
      if (!p) return p
      const mapping = patch.mapping ?? p.mapping
      const importPart = patch.importPart ?? p.importPart
      return { ...p, mapping, importPart, triage: buildTriage(p.parsed, mapping, importPart) }
    })
  }
  async function confirmImport() {
    if (!importCfg) return
    const drafts = importCfg.triage
      .filter(t => t.hasAmount && t.classification === 'include')
      .map((t, i) => {
        const row = importCfg.parsed.rows[importCfg.triage.indexOf(t)] || importCfg.parsed.rows[i]
        return makePayment({ loan_part_id: t.loan_part_id, date: (importCfg.mapping.date != null ? row[importCfg.mapping.date] : '')?.trim() || '', kind: t.kind, description: t.specText, amount: t.amount, balance_after: t.balance_after, source: 'import:' + importCfg.file.name })
      })
    if (!drafts.length) { showToast('Nothing selected to add.'); return }
    try {
      const sig = headerSignature(importCfg.parsed.headers)
      await Store.saveSettings({ import_presets: { ...settings.import_presets, [sig]: mappingToNames(importCfg.parsed.headers, importCfg.mapping) } })
      const savedRows = await Store.addPayments(drafts)
      await refresh(); flashSaved()
      showToast('Added ' + savedRows.length + ' row' + (savedRows.length === 1 ? '' : 's') + ' from “' + importCfg.file.name + '”.')
      if (importCfg.queue.length) { const cfg = await loadFile(importCfg.queue[0]); setImportCfg({ ...cfg, queue: importCfg.queue.slice(1), qIdx: importCfg.qIdx + 1 }) }
      else setImportCfg(null)
    } catch (err) { saveErr(err) }
  }
  const triageSummary = useMemo(() => {
    if (!importCfg) return ''
    let add = 0, skip = 0, invalid = 0, dup = 0, ints = 0
    importCfg.triage.forEach(t => {
      if (!t.hasAmount) { invalid++; return }
      if (t.classification === 'skip') { skip++; return }
      add++; if (t.kind === 'interest') ints++; if (t.duplicate) dup++
    })
    const out = [add + ' row' + (add === 1 ? '' : 's') + ' to add']
    if (ints) out.push(ints + ' ränta')
    if (dup) out.push(dup + ' possible duplicate' + (dup === 1 ? '' : 's'))
    if (skip) out.push(skip + ' skipped')
    if (invalid) out.push(invalid + ' without an amount')
    return out.join(' · ')
  }, [importCfg])
  const addCount = importCfg ? importCfg.triage.filter(t => t.hasAmount && t.classification === 'include').length : 0

  // ── Handlers ─────────────────────────────────────────────────────────────
  async function handleSavePart(data: Omit<LoanPart, 'id' | 'created_at'>) {
    try {
      if (partDlg.id) await Store.updateLoanPart(partDlg.id, data); else await Store.addLoanPart(data)
      await refresh(); flashSaved(); setPartDlg({ open: false, id: null }); showToast(partDlg.id ? 'Loan part updated.' : 'Loan part added.')
    } catch (err) { saveErr(err) }
  }
  async function handleDeletePart(id: string) {
    try { await Store.removeLoanPart(id); await refresh(); flashSaved(); setPartDlg({ open: false, id: null }); showToast('Loan part deleted.') }
    catch (err) { saveErr(err) }
  }
  async function handleSavePeriod(partId: string, data: Omit<RatePeriod, 'id' | 'created_at'>, existingId?: string) {
    try {
      if (existingId) await Store.updateRatePeriod(existingId, data); else await Store.addRatePeriod({ ...data, loan_part_id: partId })
      await refresh(); flashSaved(); showToast(existingId ? 'Rate period updated.' : 'Rate period added.')
    } catch (err) { saveErr(err) }
  }
  async function handleDeletePeriod(id: string) {
    try { await Store.removeRatePeriod(id); await refresh(); flashSaved() }
    catch (err) { saveErr(err) }
  }
  // Offer to switch on contribution tracking the first time the user records an
  // insats / contribution — never flip it silently.
  async function maybeEnableContributions(msg: string) {
    if (settings.track_contributions) return
    if (confirm(msg)) {
      try { await Store.saveSettings({ track_contributions: true }) }
      catch (err) { saveErr(err) }
    }
  }
  async function handleSaveVal(data: Omit<Valuation, 'id' | 'created_at'>) {
    try {
      let savedId = valDlg.id
      if (valDlg.id) await Store.updateValuation(valDlg.id, data)
      else { const v = await Store.addValuation(data); savedId = v.id }
      // Only one valuation can be the köpeskilling — clear the flag on the rest.
      if (data.is_purchase && savedId) {
        for (const v of valuations) if (v.id !== savedId && v.is_purchase) await Store.updateValuation(v.id, { is_purchase: false })
      }
      await refresh(); flashSaved(); setValDlg({ open: false, id: null }); showToast(data.is_purchase ? 'Köpeskilling set.' : 'Valuation saved.')
    } catch (err) { saveErr(err) }
  }
  async function handleToggleInsats(p: Payment) {
    try {
      await Store.updatePayment(p.id, { is_insats: !p.is_insats, ...(p.is_insats ? { paid_split: null } : {}) })
      await refresh(); flashSaved()
      if (!p.is_insats) await maybeEnableContributions('Flagged as insats. Turn on contribution tracking to see per-owner insatser and the funded split?')
    } catch (err) { saveErr(err) }
  }
  // With contributions tracked, the ★ opens the split dialog instead of a plain toggle.
  function handleStarClick(p: Payment) {
    if (settings.track_contributions) setInsatsDlg({ open: true, payment: p })
    else handleToggleInsats(p)
  }
  async function handleSaveInsatsSplit(payment: Payment, split: { a: number; b: number }) {
    try {
      const paid_by: PaidBy = split.a > 0 && split.b > 0 ? 'joint' : split.a > 0 ? 'a' : split.b > 0 ? 'b' : payment.paid_by
      await Store.updatePayment(payment.id, { is_insats: true, paid_split: split, paid_by })
      await refresh(); flashSaved(); setInsatsDlg({ open: false, payment: null }); showToast('Insats allocation saved.')
    } catch (err) { saveErr(err) }
  }
  async function handleRemoveInsats(payment: Payment) {
    try {
      await Store.updatePayment(payment.id, { is_insats: false, paid_split: null })
      await refresh(); flashSaved(); setInsatsDlg({ open: false, payment: null }); showToast('Insats flag removed.')
    } catch (err) { saveErr(err) }
  }
  function toggleExpandPay(id: string) {
    setExpandedPays(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })
  }
  async function handleDeleteVal(id: string) {
    try { await Store.removeValuation(id); await refresh(); flashSaved(); setValDlg({ open: false, id: null }); showToast('Valuation deleted.') }
    catch (err) { saveErr(err) }
  }
  async function handleSavePay(data: Omit<Payment, 'id' | 'created_at'>) {
    try {
      if (payDlg.id) await Store.updatePayment(payDlg.id, data); else await Store.addPayment(data)
      await refresh(); flashSaved(); setPayDlg({ open: false, id: null }); showToast('Payment saved.')
      if (data.is_insats) await maybeEnableContributions('Saved as insats. Turn on contribution tracking to see per-owner insatser and the funded split?')
    } catch (err) { saveErr(err) }
  }
  async function handleDeletePay(id: string) {
    try { await Store.removePayment(id); await refresh(); flashSaved(); setPayDlg({ open: false, id: null }); showToast('Payment deleted.') }
    catch (err) { saveErr(err) }
  }
  async function handleCopyToParts(source: Payment, targetIds: string[]) {
    try {
      await Store.addPayments(targetIds.map(partId => makePayment({ ...source, loan_part_id: partId, balance_after: null })))
      await refresh(); flashSaved(); setCopyDlg({ open: false, source: null })
      showToast(`Copied to ${targetIds.length} part${targetIds.length === 1 ? '' : 's'}.`)
    } catch (err) { saveErr(err) }
  }
  async function handleSaveCont(data: Omit<Contribution, 'id' | 'created_at'>) {
    try {
      if (contDlg.id) await Store.updateContribution(contDlg.id, data); else await Store.addContribution(data)
      await refresh(); flashSaved(); setContDlg({ open: false, id: null }); showToast('Contribution saved.')
    } catch (err) { saveErr(err) }
  }
  async function handleDeleteCont(id: string) {
    try { await Store.removeContribution(id); await refresh(); flashSaved(); setContDlg({ open: false, id: null }); showToast('Contribution deleted.') }
    catch (err) { saveErr(err) }
  }
  async function handleSaveSettings(patch: Partial<MortgageSettings>) {
    try { await Store.saveSettings(patch); await refresh(); flashSaved(); setSettingsDlg(false); showToast('Settings saved.') }
    catch (err) { saveErr(err) }
  }

  async function clearPayments() {
    const scoped = paymentFilter === 'all' ? payments : payments.filter(p => p.loan_part_id === paymentFilter)
    if (!scoped.length) return
    if (!confirm('Delete ' + scoped.length + ' payment' + (scoped.length === 1 ? '' : 's') + '? This can’t be undone.')) return
    try {
      for (const p of scoped) await Store.removePayment(p.id)
      await refresh(); flashSaved(); showToast('Payments deleted.')
    } catch (err) { saveErr(err) }
  }

  function handleExportCSV() {
    const csv = paymentsToCsv(payments, parts)
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'bolanekoll-betalningar.csv'; a.click(); URL.revokeObjectURL(url)
  }
  async function handleExportJSON() {
    const json = await Store.exportJSON()
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'bolanekoll-backup.json'; a.click(); URL.revokeObjectURL(url)
  }
  async function handleImportJSON(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return
    try { const added = await Store.importJSON(await file.text()); await refresh(); flashSaved(); showToast('Restored ' + Object.values(added).reduce((a, b) => a + b, 0) + ' rows.') }
    catch (err) { saveErr(err) }
    e.target.value = ''
  }

  // ── Derived display values ───────────────────────────────────────────────
  const dashSub = !parts.length
    ? 'Add a loan part and a property value to get started.'
    : !hasValuation
      ? 'Add a property value to see equity · ' + fmtMoney(balance) + ' owed across ' + parts.length + ' part' + (parts.length === 1 ? '' : 's') + '.'
      : fmtPct(ltv) + ' loan-to-value · ' + fmtMoney(balance) + ' still owed to the bank.'

  const bridgeLabel = bridgePeriod === 'ytd' ? 'i år' : bridgePeriod === '12m' ? 'senaste 12 mån' : 'sedan start'
  const wsum = Math.abs(bridge.amortization_gain) + Math.abs(bridge.appreciation_gain)
  const pa = wsum > 0 ? Math.round(Math.abs(bridge.amortization_gain) / wsum * 100) : 0

  const lastCost = costRows.length ? costRows[costRows.length - 1] : null
  const partsTotal = balance

  const chronVals = useMemo(() => valuations.slice().sort((a, b) => String(a.date).localeCompare(String(b.date))), [valuations])
  const maxVal = chronVals.reduce((mx, v) => Math.max(mx, Number(v.value) || 0), 0)

  const filteredPayments = paymentFilter === 'all' ? payments : payments.filter(p => p.loan_part_id === paymentFilter)
  const shownPayments = filteredPayments.slice(0, payVisible)
  const hiddenPayCount = filteredPayments.length - shownPayments.length
  const partNameById = (pid: string | null) => parts.find(p => p.id === pid)?.label || '—'

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={'bk-root' + (active ? ' vt-page' : '')}>
      <PageHeader
        backTo="/bolanekoll"
        title={settings.property_name || 'Bolånekoll'}
        tagline="Track your mortgage — how much of the home you own vs the bank"
        saveVisible={saved}
        actions={<>
          <button className="btn btn-ghost theme-toggle-btn" onClick={() => setSettingsDlg(true)} title="Settings" aria-label="Settings">⚙</button>
          <ThemeToggle />
        </>}
      />

      <main className="wrap">

        {/* ── Dashboard ── */}
        <section className="card dashboard-card">
          <div className="dash-main">
            <p className="dash-label">Insatt kapital · Cost-basis equity</p>
            <p className="dash-headline">{hasPurchase ? M(costBasisEq, false, true) : '—'}</p>
            <p className="dash-sub">
              {hasPurchase
                ? <>{P(ownedPct, true)} of the köpeskilling funded — deposit plus amortised</>
                : 'Flag your köpeskilling in Bostadens värde to see how much of the home you’ve actually paid for.'}
            </p>
          </div>
          {hasPurchase && settings.track_contributions && (
            <div className="split-row">
              <div className={'split-card' + (me === 'a' ? ' is-accent' : '')}>
                <span className="split-name">{nameOf('a')} · {fmtPct(cbSplit.a_pct)}</span>
                <span className="split-val">{M(cbSplit.a, false, true)}</span>
                <span className="split-sub">funded</span>
              </div>
              <div className={'split-card' + (me === 'b' ? ' is-accent' : '')}>
                <span className="split-name">{nameOf('b')} · {fmtPct(cbSplit.b_pct)}</span>
                <span className="split-val">{M(cbSplit.b, false, true)}</span>
                <span className="split-sub">funded</span>
              </div>
            </div>
          )}
          <div className="metric-row">
            <div className="metric-chip is-accent"><span className="metric-label">Remaining debt</span><span className="metric-val">{M(balance, false, true)}</span></div>
            <div className="metric-chip"><span className="metric-label">Property value</span><span className="metric-val">{hasValuation ? M(value, false, true) : '—'}</span></div>
            {hasPurchase && <div className="metric-chip"><span className="metric-label">Köpeskilling</span><span className="metric-val">{M(price, false, true)}</span></div>}
            {hasPurchase && <div className="metric-chip"><span className="metric-label">Kontantinsats</span><span className="metric-val">{M(deposit, false, true)}</span></div>}
            <div className="metric-chip"><span className="metric-label">Loan-to-value</span><span className="metric-val">{hasValuation ? P(ltv, true) : '—'}</span></div>
            <div className="metric-chip"><span className="metric-label">Total amortised</span><span className="metric-val">{M(amortized, false, true)}</span></div>
            <div className="metric-chip"><span className="metric-label">Interest paid</span><span className="metric-val">{M(interest, false, true)}</span></div>
            {settings.ranteavdrag && <div className="metric-chip"><span className="metric-label">Ränteavdrag (est.)</span><span className="metric-val">{M(deduction, false, true)}</span></div>}
            {soon && <div className={'metric-chip' + (soon.days <= 90 ? ' is-warn' : '')}><span className="metric-label">Nästa villkorsändring</span><span className="metric-val">{soon.until}</span></div>}
          </div>
          {reconcile.length > 0 && (
            <div className="reconcile-banner">
              Start-balance check — your entered start balance doesn’t match where the imported ledger begins (a partial import, or a start balance to update — today’s balance still tracks the Saldo correctly):
              <ul>{reconcile.map(r => <li key={r.loan_part_id}>{r.label || 'Loan part'}: start balance {fmtMoney(r.start_balance!)} vs the ledger’s earliest Saldo {fmtMoney(r.start_saldo!)} — off by {fmtMoney(Math.abs(r.drift!))}</li>)}</ul>
            </div>
          )}
        </section>

        {/* ── Market equity (secondary, beneath cost-basis) ── */}
        <section className="card market-card">
          <div className="dash-main">
            <p className="dash-label">Marknadsvärde · Market equity</p>
            <p className="dash-headline">{hasValuation ? M(eq, false, true) : '—'}</p>
            <p className="dash-sub">{dashSub}</p>
          </div>
          {hasValuation && settings.track_contributions && (
            <div className="split-row">
              <div className={'split-card' + (me === 'a' ? ' is-accent' : '')}>
                <span className="split-name">{nameOf('a')} · {fmtPct(cbSplit.a_pct)}</span>
                <span className="split-val">{M(eq * cbSplit.a_pct / 100, false, true)}</span>
                <span className="split-sub">equity share</span>
              </div>
              <div className={'split-card' + (me === 'b' ? ' is-accent' : '')}>
                <span className="split-name">{nameOf('b')} · {fmtPct(cbSplit.b_pct)}</span>
                <span className="split-val">{M(eq * cbSplit.b_pct / 100, false, true)}</span>
                <span className="split-sub">equity share</span>
              </div>
            </div>
          )}
        </section>

        {/* ── Ownership vs bank over time ── */}
        <section className="card">
          <div className="card-head"><h2>Ägande över tid <span className="card-en">· Ownership vs bank</span></h2></div>
          <div className="chart-wrap">
            {timeline.length >= 2 && valuations.length > 0
              ? <EquityStackChart data={chartData}
                  mineLabel={nameOf(me) + '’s equity'} partnerLabel={nameOf(other) + '’s equity'}
                  bankLabel="Banken · Bank" formatMoney={fmtMoney} />
              : <p className="chart-empty">{valuations.length === 0 ? 'Add a property value to chart your equity vs the bank.' : 'Import a few months of payments to see the trend.'}</p>}
          </div>
        </section>

        {/* ── Insights ── */}
        <section className="card">
          <div className="card-head">
            <h2>Insikter <span className="card-en">· Insights</span></h2>
            <div className="card-actions">
              <Segmented value={bridgePeriod} onChange={setBridgePeriod}
                options={[{ v: 'ytd', label: 'I år' }, { v: '12m', label: '12 mån' }, { v: 'all', label: 'Allt' }]} />
            </div>
          </div>
          {!insightsReady ? (
            <p className="insights-empty">Add a property value and a few months of payments to see how your equity is growing.</p>
          ) : (
            <>
              <div className="bridge">
                <div className="bridge-head">
                  <span className="bridge-title">Förändring eget kapital · equity change {bridgeLabel}</span>
                  <span className={'bridge-total' + (bridge.total_gain < 0 ? ' is-neg' : '')}>{M(bridge.total_gain, true)}</span>
                </div>
                <div className="bridge-bar">
                  <span className={'bridge-seg is-amort' + (bridge.amortization_gain < 0 ? ' is-neg' : '')} style={{ width: pa + '%' }} />
                  <span className={'bridge-seg is-appr' + (bridge.appreciation_gain < 0 ? ' is-neg' : '')} style={{ width: (100 - pa) + '%' }} />
                </div>
                <div className="bridge-legend">
                  <span className="bridge-key"><span className="bridge-dot is-amort" />Amortering <b>{M(bridge.amortization_gain, true)}</b></span>
                  <span className="bridge-key"><span className="bridge-dot is-appr" />Värdeökning · appreciation <b>{M(bridge.appreciation_gain, true)}</b></span>
                </div>
              </div>
              <div className="metric-row">
                {lastCost && <div className="metric-chip"><span className="metric-label">{settings.ranteavdrag ? 'Latest mo · net cost' : 'Latest mo · cost'}</span><span className="metric-val">{M(lastCost.net)}</span></div>}
                {blended > 0 && <div className="metric-chip is-accent"><span className="metric-label">Blended rate</span><span className="metric-val">{P(blended)}</span></div>}
                {krav.has_value && <div className="metric-chip"><span className="metric-label">Amorteringskrav (est.)</span><span className="metric-val">{krav.exempt ? 'None · LTV ≤ 50 %' : krav.required_pct + ' % · ' + fmtMoney(krav.required_annual) + '/år'}</span></div>}
              </div>
            </>
          )}
        </section>

        {/* ── Projection ── */}
        <section className="card">
          <div className="card-head">
            <h2>Prognos <span className="card-en">· Projection</span></h2>
            <div className="card-actions">
              <label className="proj-field" htmlFor="extraAmort">Extra amortering / mån</label>
              <input type="text" id="extraAmort" className="proj-input" inputMode="decimal" autoComplete="off" placeholder="0" value={extraAmort} onChange={e => setExtraAmort(e.target.value)} />
            </div>
          </div>
          {!parts.length ? (
            <p className="proj-note">Add a loan part to project your payoff.</p>
          ) : (
            <>
              <p className="proj-note">
                {ms.flat && extra <= 0
                  ? 'Interest-only — the balance stays flat. Enter an extra monthly amortering above to see a payoff date.'
                  : 'At ' + fmtMoney(ms.per_month) + '/mo (' + fmtMoney(base) + ' observed + ' + fmtMoney(extra) + ' extra), property value held flat.'}
              </p>
              <div className="metric-row">
                <div className={'metric-chip' + (ms.payoff_months != null ? ' is-accent' : '')}><span className="metric-label">Payoff</span><span className="metric-val">{ms.payoff_months == null ? 'Never' : monthsToWhen(ms.payoff_months)}</span></div>
                {valuations.length > 0 && <div className="metric-chip"><span className="metric-label">70 % LTV</span><span className="metric-val">{monthsToWhen(ms.ltv70_months)}</span></div>}
                {valuations.length > 0 && <div className="metric-chip"><span className="metric-label">50 % LTV</span><span className="metric-val">{monthsToWhen(ms.ltv50_months)}</span></div>}
              </div>
            </>
          )}
        </section>

        {/* ── Import payments ── */}
        <section className="card import-card">
          <div className="card-head"><h2>Importera betalningar <span className="card-en">· Import payments</span></h2></div>
          {!parts.length ? (
            <div className="import-guard">
              <p>Add a loan part first — then import its payment CSV.</p>
              <button type="button" className="btn btn-primary" onClick={() => setPartDlg({ open: true, id: null })}>+ Add loan part</button>
            </div>
          ) : !importCfg ? (
            <div className={'dropzone' + (isDragging ? ' is-drag' : '')}
              onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={e => { e.preventDefault(); setIsDragging(false); handleFiles(e.dataTransfer.files) }}
              onClick={() => fileInputRef.current?.click()}>
              <input ref={fileInputRef} type="file" accept=".csv,text/csv,text/plain" hidden multiple onChange={e => e.target.files && handleFiles(e.target.files)} />
              <div className="dropzone-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M5 20h14" /></svg>
              </div>
              <p className="dropzone-lead">Drop one or more mortgage <strong>.csv</strong> files here, or <span className="link-btn">browse</span>.</p>
              <p className="dropzone-hint">One file per loan part · we map the columns and step through them one at a time.</p>
            </div>
          ) : (
            <div className="import-config">
              <div className="import-filebar">
                <span className="file-pill">{importCfg.file.name} · {importCfg.parsed.rows.length} rows</span>
                {importCfg.queue.length > 0 && <span className="queue-info">+{importCfg.queue.length} file{importCfg.queue.length === 1 ? '' : 's'} queued</span>}
                <button type="button" className="link-btn" onClick={() => { setImportCfg(null); if (fileInputRef.current) fileInputRef.current.value = '' }}>Choose other files</button>
              </div>
              <div className="config-grid">
                {([['date', 'Date column'], ['specification', 'Type column (Specifikation)'], ['amount', 'Amount column (Belopp)']] as const).map(([k, lbl]) => (
                  <div key={k} className="config-field">
                    <label>{lbl}</label>
                    <select className="select" value={importCfg.mapping[k] ?? ''} onChange={e => reTriage({ mapping: { ...importCfg.mapping, [k]: e.target.value !== '' ? Number(e.target.value) : null } })}>
                      <option value="">— none —</option>
                      {importCfg.parsed.headers.map((h, i) => <option key={i} value={i}>{h || 'Column ' + (i + 1)}</option>)}
                    </select>
                  </div>
                ))}
              </div>
              <div className="config-grid">
                {([['balance', 'Balance column (Saldo)'], ['loan_number', 'Loan # column (optional)']] as const).map(([k, lbl]) => (
                  <div key={k} className="config-field">
                    <label>{lbl}</label>
                    <select className="select" value={importCfg.mapping[k] ?? ''} onChange={e => reTriage({ mapping: { ...importCfg.mapping, [k]: e.target.value !== '' ? Number(e.target.value) : null } })}>
                      <option value="">— none —</option>
                      {importCfg.parsed.headers.map((h, i) => <option key={i} value={i}>{h || 'Column ' + (i + 1)}</option>)}
                    </select>
                  </div>
                ))}
                <div className="config-field">
                  <label>Which loan part is this file for?</label>
                  <select className="select" value={importCfg.importPart} onChange={e => reTriage({ importPart: e.target.value })}>
                    {importCfg.mapping.loan_number != null && <option value="__auto__">Auto-detect from loan #</option>}
                    {parts.map(p => <option key={p.id} value={p.id}>{p.label || '(loan part)'}</option>)}
                  </select>
                </div>
              </div>
              <div className="triage-bar">
                <span className="triage-summary">{triageSummary}</span>
                <span className="triage-toggle">
                  <button type="button" className="link-btn" onClick={() => setImportCfg(p => p ? { ...p, triage: p.triage.map(t => t.hasAmount ? { ...t, classification: 'include' } : t) } : p)}>Include all</button>
                  <span className="triage-sep" aria-hidden="true">·</span>
                  <button type="button" className="link-btn" onClick={() => setImportCfg(p => p ? { ...p, triage: p.triage.map(t => ({ ...t, classification: 'skip' })) } : p)}>Skip all</button>
                </span>
              </div>
              <div className="table-wrap triage-wrap">
                <table className="data-table triage-table">
                  <thead><tr><th className="col-treat">Treatment</th><th className="col-date">Date</th><th>Type</th><th className="num">Amount</th><th className="num">Balance</th></tr></thead>
                  <tbody>
                    {importCfg.triage.map((t, i) => {
                      const row = importCfg.parsed.rows[i]
                      const cls = t.classification === 'skip' ? 'skip' : 'include'
                      const rowClass = !t.hasAmount ? 'is-excluded' : t.duplicate ? 'is-dup' : cls === 'skip' ? 'is-excluded' : ''
                      const auto = importCfg.importPart === '__auto__'
                      return (
                        <tr key={i} className={rowClass}>
                          <td className="col-treat">
                            {t.hasAmount ? (
                              <Segmented small value={cls} onChange={v => setImportCfg(p => p ? { ...p, triage: p.triage.map((r, j) => j === i ? { ...r, classification: v } : r) } : p)}
                                options={[{ v: 'include', label: 'Include' }, { v: 'skip', label: 'Skip' }]} />
                            ) : <span className="treat-na">no amount</span>}
                          </td>
                          <td className="col-date">{importCfg.mapping.date != null ? row[importCfg.mapping.date] : ''}</td>
                          <td>
                            {t.specText || kindLabel(t.kind)}
                            {t.duplicate && <span className="row-flag">possible duplicate</span>}
                            {auto && t.hasAmount && <span className={'row-flag' + (t.partMatched ? ' row-flag-refund' : '')}>{(t.partMatched ? '→ ' : 'no loan # → ') + partNameById(t.loan_part_id)}</span>}
                          </td>
                          <td className="num">{t.hasAmount && t.amount ? fmtMoney(t.amount) : '—'}</td>
                          <td className="num">{t.balance_after != null ? fmtMoney(t.balance_after) : '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="import-actions">
                <button type="button" className="btn btn-ghost" onClick={() => { setImportCfg(null); if (fileInputRef.current) fileInputRef.current.value = '' }}>Cancel</button>
                <button type="button" className="btn btn-primary" disabled={addCount === 0} onClick={confirmImport}>{addCount ? 'Add ' + addCount + ' row' + (addCount === 1 ? '' : 's') : 'Nothing to add'}</button>
              </div>
            </div>
          )}
        </section>

        {/* ── Loan parts ── */}
        <section className="card">
          <div className="card-head">
            <h2>Lånedelar <span className="card-en">· Loan parts</span></h2>
            <span className="count-pill">{parts.length}</span>
            <div className="card-actions"><button type="button" className="btn btn-ghost" onClick={() => setPartDlg({ open: true, id: null })}>+ Add loan part</button></div>
          </div>
          {!parts.length ? <p className="empty">No loan parts yet. Add your lånedelar — one per loan account — to begin.</p> : (
            <div className="table-wrap">
              <table className="data-table lanedelar-table">
                <thead><tr><th>Lånedel <span className="th-en">· part</span></th><th className="num">Balance</th><th className="num">Share</th><th className="col-act"></th></tr></thead>
                <tbody>
                  {loanGroups.map(g => {
                    // Every date+rate group is a uniform collapsible folder — even a
                    // one-part group — so the list reads consistently.
                    const isExp = expandedGroups.has(g.key)
                    return (
                      <Fragment key={g.key}>
                        <tr className={'ld-group' + (g.expired ? ' is-expired' : '') + (g.is_catchall ? ' is-catchall' : '') + (isExp ? ' is-open' : '')}>
                          <td>
                            <button type="button" className="ld-disclose" aria-expanded={isExp} title={isExp ? 'Collapse' : 'Expand'} onClick={() => toggleGroup(g.key)}>
                              <motion.span
                                className="ld-tri"
                                animate={{ rotate: isExp ? 90 : 0 }}
                                transition={reduceMotion ? { duration: 0 } : { duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                              >▸</motion.span>
                              {g.is_catchall
                                ? <span className="ld-needs">No reprice date set</span>
                                : <>{repriceMeta(g)}{rateBadge(g.rate, g.rate_type, g.rate_type == null)}</>}
                              <span className="ld-count">{g.parts.length} part{g.parts.length === 1 ? '' : 's'}</span>
                            </button>
                          </td>
                          <td className="num ld-sum">{fmtMoney(g.total_balance)}</td>
                          <td className="num ld-sum">{fmtPct(g.share_pct)}</td>
                          <td className="col-act"></td>
                        </tr>
                        <AnimatePresence initial={false}>
                          {isExp && g.parts.map(p => {
                            const bal = partBalance(p, payments)
                            const share = partsTotal > 0 ? bal / partsTotal * 100 : 0
                            const per = effectiveRatePeriod(p, periods)
                            return (
                              <motion.tr key={p.id} className="ld-member">
                                <td>
                                  <CellReveal reduce={reduceMotion}>
                                    <span className="ld-member-label">
                                      <span className="ld-name">{p.label || '(no name)'}{p.loan_number && <span className="ld-loanno">#{p.loan_number}</span>}</span>
                                      {rateBadge(per?.rate ?? null, per?.rate_type ?? null)}
                                    </span>
                                  </CellReveal>
                                </td>
                                <td className="num"><CellReveal reduce={reduceMotion}>{fmtMoney(bal)}</CellReveal></td>
                                <td className="num"><CellReveal reduce={reduceMotion}>{fmtPct(share)}</CellReveal></td>
                                <td className="col-act"><CellReveal reduce={reduceMotion}>{partActs(p)}</CellReveal></td>
                              </motion.tr>
                            )
                          })}
                        </AnimatePresence>
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
              {archivedParts.length > 0 && (
                <div className="avslutade-section">
                  <button type="button" className="avslutade-toggle" aria-expanded={avslutadeOpen} onClick={() => setAvslutadeOpen(v => !v)}>
                    <motion.span
                      className="expand-btn"
                      animate={{ rotate: avslutadeOpen ? 90 : 0 }}
                      transition={reduceMotion ? { duration: 0 } : { duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                    >▸</motion.span> Avslutade <span className="count-pill">{archivedParts.length}</span>
                  </button>
                  <Collapse open={avslutadeOpen}>
                    <table className="data-table avslutade-table">
                      <tbody>
                        {archivedParts.map(p => {
                          const bal = partBalance(p, payments)
                          return (
                            <tr key={p.id} className="is-settled">
                              <td><span className="ld-name">{p.label || '(no name)'}{p.loan_number && <span className="ld-loanno">#{p.loan_number}</span>}</span></td>
                              <td className="num">{fmtMoney(bal)}</td>
                              <td className="col-act">{partActs(p)}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </Collapse>
                </div>
              )}
            </div>
          )}
        </section>

        {/* ── Property value ── */}
        <section className="card">
          <div className="card-head">
            <h2>Bostadens värde <span className="card-en">· Property value</span></h2>
            <span className="count-pill">{valuations.length}</span>
            <div className="card-actions"><button type="button" className="btn btn-ghost" onClick={() => setValDlg({ open: true, id: null })}>+ Add value</button></div>
          </div>
          {!valuations.length ? <p className="empty">No valuations yet. Add what the home is worth today — update it whenever you re-value.</p> : (
            <>
              {chronVals.length > 1 && (
                <div className="bars">
                  {chronVals.map(v => {
                    const w = maxVal > 0 ? Math.max(2, Math.round((Number(v.value) || 0) / maxVal * 100)) : 0
                    return (
                      <div key={v.id} className="bar-row is-groceries">
                        <span className="bar-label">{v.date || '—'}</span>
                        <span className="bar-track"><span className="bar-fill" style={{ width: w + '%' }} /></span>
                        <span className="bar-val num">{fmtMoney(v.value)}</span>
                      </div>
                    )
                  })}
                </div>
              )}
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th className="col-date">Date</th><th className="num">Value</th><th>Note</th><th className="col-act"></th></tr></thead>
                  <tbody>
                    {valuations.map(v => (
                      <tr key={v.id} className={v.is_purchase ? 'is-purchase' : ''}>
                        <td className="col-date">{v.date || '—'}</td>
                        <td className="num">{fmtMoney(v.value)}</td>
                        <td>{v.note || ''}{v.is_purchase && <span className="row-flag row-flag-kop">köpeskilling</span>}</td>
                        <td className="col-act">
                          <button type="button" className="icon-btn" title="Edit" onClick={() => setValDlg({ open: true, id: v.id })}>✎</button>
                          <button type="button" className="icon-btn" data-del-val title="Delete" onClick={() => { if (confirm('Delete this valuation?')) handleDeleteVal(v.id) }}>✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>

        {/* ── Payments ── */}
        <section className="card">
          <div className="card-head">
            <h2>Betalningar <span className="card-en">· Payments</span></h2>
            <span className="count-pill">{filteredPayments.length}</span>
            <div className="card-actions">
              <Segmented value={paymentFilter} onChange={setPaymentFilter} ariaLabel="Filter payments"
                options={[{ v: 'all', label: 'All' }, ...parts.map(p => ({ v: p.id, label: p.label || 'part' }))]} />
              <button type="button" className="btn btn-ghost" onClick={() => setPayDlg({ open: true, id: null })}>+ Add payment</button>
              <button type="button" className="btn btn-ghost btn-danger" disabled={!filteredPayments.length} onClick={clearPayments}>{paymentFilter === 'all' ? 'Delete all' : 'Delete ' + partNameById(paymentFilter)}</button>
            </div>
          </div>
          <motion.div key={paymentFilter} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.13, ease: [0.22, 1, 0.36, 1] }}>
            {!filteredPayments.length ? (
              <p className="empty">{payments.length ? 'No payments for this loan part.' : 'No payments yet. Import a statement above, or add one manually.'}</p>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th className="col-date">Date</th><th>Loan part</th><th>Type</th><th className="num">Amount</th><th className="num">Balance</th><th className="col-act"></th></tr></thead>
                  <tbody>
                    {shownPayments.map(p => {
                      const isExp = expandedPays.has(p.id)
                      return (
                      <Fragment key={p.id}>
                        <tr className={(p.is_insats ? 'is-insats' : '') + (isExp ? ' is-expanded' : '')}>
                          <td className="col-date">
                            {p.is_insats && (
                              <motion.button
                                type="button"
                                className="icon-btn expand-btn"
                                title={isExp ? 'Hide allocation' : 'Show allocation'}
                                aria-expanded={isExp}
                                onClick={() => toggleExpandPay(p.id)}
                                animate={{ rotate: isExp ? 90 : 0 }}
                                transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
                              >▸</motion.button>
                            )}
                            {p.date || '—'}
                          </td>
                          <td>{partNameById(p.loan_part_id)}</td>
                          <td><span className={'kind-tag kind-' + (p.kind || 'other')}>{kindLabel(p.kind)}</span>{p.is_insats && <span className="row-flag row-flag-insats">insats</span>}</td>
                          <td className="num">{fmtMoney(p.amount)}</td>
                          <td className="num">{p.balance_after != null ? fmtMoney(p.balance_after) : '—'}</td>
                          <td className="col-act">
                            <button type="button" className={'icon-btn' + (p.is_insats ? ' is-on' : '')} title={settings.track_contributions ? (p.is_insats ? 'Edit insats split' : 'Flag as insats & split') : (p.is_insats ? 'Unflag insats' : 'Flag as insats')} onClick={() => handleStarClick(p)}>{p.is_insats ? '★' : '☆'}</button>
                            <button type="button" className="icon-btn" title="Edit" onClick={() => setPayDlg({ open: true, id: p.id })}>✎</button>
                            {parts.length > 1 && (
                              <button type="button" className="icon-btn" title="Copy to parts" onClick={() => setCopyDlg({ open: true, source: p })}>⧉</button>
                            )}
                            <button type="button" className="icon-btn" data-del-pay title="Delete" onClick={() => { if (confirm('Delete this payment?')) handleDeletePay(p.id) }}>✕</button>
                          </td>
                        </tr>
                        <AnimatePresence initial={false}>
                          {p.is_insats && isExp && (
                            <motion.tr key="detail" className="pay-detail">
                              <td colSpan={6}>
                                <CellReveal reduce={reduceMotion}>
                                <div className="pay-detail-inner">
                                  <span className="pay-detail-label">Insats funded by</span>
                                  {p.paid_split ? (
                                    <>
                                      <span className="alloc-chip"><b>{nameOf('a')}</b> {fmtMoney(p.paid_split.a)}</span>
                                      <span className="alloc-chip"><b>{nameOf('b')}</b> {fmtMoney(p.paid_split.b)}</span>
                                    </>
                                  ) : (
                                    <span className="alloc-chip">{p.paid_by === 'joint'
                                      ? 'Joint · split by ownership'
                                      : <><b>{nameOf(p.paid_by === 'b' ? 'b' : 'a')}</b> {fmtMoney(p.amount)}</>}</span>
                                  )}
                                  {!p.paid_split && settings.track_contributions && <button type="button" className="link-btn" onClick={() => setInsatsDlg({ open: true, payment: p })}>allocate…</button>}
                                  {p.description && <span className="pay-detail-note">{p.description}</span>}
                                </div>
                                </CellReveal>
                              </td>
                            </motion.tr>
                          )}
                        </AnimatePresence>
                      </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </motion.div>
          {(hiddenPayCount > 0 || payVisible > PAY_PAGE) && (
            <div className="table-more">
              {hiddenPayCount > 0 && (
                <button type="button" className="btn btn-ghost" onClick={() => setPayVisible(v => v + PAY_PAGE)}>
                  Visa fler <span className="card-en">· Show {Math.min(PAY_PAGE, hiddenPayCount)} more</span>
                  <span className="more-count">{hiddenPayCount} left</span>
                </button>
              )}
              {payVisible > PAY_PAGE && (
                <button type="button" className="link-btn" onClick={() => setPayVisible(PAY_PAGE)}>Show less</button>
              )}
            </div>
          )}
        </section>

        {/* ── Contributions / insatser ── */}
        {(settings.track_contributions || insatsPays.length > 0) && (
          <section className="card">
            <div className="card-head">
              <h2>Insatser <span className="card-en">· Contributions</span></h2>
              <span className="count-pill">{contributions.length}</span>
              <div className="card-actions"><button type="button" className="btn btn-ghost" onClick={() => setContDlg({ open: true, id: null })}>+ Add contribution</button></div>
            </div>
            {hasPurchase && (
              <p className="contrib-note">Kontantinsats (deriverad) · köpeskilling − lån = <b>{fmtMoney(deposit)}</b>. Add who paid it below so the funded split is right.</p>
            )}
            {contribSplit && (
              <>
                <div className="split-row">
                  <div className={'split-card' + (settings.i_am !== 'b' ? ' is-accent' : '')}><span className="split-name">{nameOf('a')} · {fmtPct(contribSplit.a_pct)}</span><span className="split-val">{fmtMoney(contribSplit.a)}</span><span className="split-sub">contributed</span></div>
                  <div className={'split-card' + (settings.i_am === 'b' ? ' is-accent' : '')}><span className="split-name">{nameOf('b')} · {fmtPct(contribSplit.b_pct)}</span><span className="split-val">{fmtMoney(contribSplit.b)}</span><span className="split-sub">contributed</span></div>
                </div>
                <p className="contrib-note">
                  {settl?.owes && settl.amount > 0
                    ? nameOf(settl.owes) + ' owes ' + nameOf(otherOwner(settl.owes)) + ' ' + fmtMoney(settl.amount) + ' to reach the target ownership split.'
                    : contribSplit.total > 0 ? 'Contributions are in line with the target ownership split.'
                      : 'Log who paid each amortering (in a payment) and any lump sums to build contribution-based ownership.'}
                </p>
              </>
            )}
            {!contributions.length ? <p className="empty">No lump sums yet. Per-owner amortering is counted automatically from the payments above; add down payments here.</p> : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th className="col-date">Date</th><th>Owner</th><th className="num">Amount</th><th>Note</th><th className="col-act"></th></tr></thead>
                  <tbody>
                    {contributions.map(c => (
                      <tr key={c.id}>
                        <td className="col-date">{c.date || '—'}</td>
                        <td>{c.owner === 'joint' ? 'Gemensam · Joint' : nameOf(c.owner === 'b' ? 'b' : 'a')}</td>
                        <td className="num">{fmtMoney(c.amount)}</td>
                        <td>{c.note || ''}</td>
                        <td className="col-act">
                          <button type="button" className="icon-btn" title="Edit" onClick={() => setContDlg({ open: true, id: c.id })}>✎</button>
                          <button type="button" className="icon-btn" title="Delete" onClick={() => { if (confirm('Delete this contribution?')) handleDeleteCont(c.id) }}>✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {insatsPays.length > 0 && (
              <div className="insats-extra">
                <p className="contrib-note">Extra amorteringar flaggade i liggaren · flagged in the ledger (info — these already lower your debt &amp; raise amortised):</p>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead><tr><th className="col-date">Date</th><th>Owner</th><th>Loan part</th><th className="num">Amount</th></tr></thead>
                    <tbody>
                      {insatsPays.map(p => (
                        <tr key={p.id}>
                          <td className="col-date">{p.date || '—'}</td>
                          <td>{p.paid_split
                            ? <span className="insats-alloc">{nameOf('a')} {fmtMoney(p.paid_split.a)} · {nameOf('b')} {fmtMoney(p.paid_split.b)}</span>
                            : (p.paid_by === 'joint' ? 'Gemensam · Joint' : nameOf(p.paid_by === 'b' ? 'b' : 'a'))}</td>
                          <td>{partNameById(p.loan_part_id)}</td>
                          <td className="num">{fmtMoney(p.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        )}

      </main>

      {/* ── Dialogs ── */}
      <PartDialog open={partDlg.open} id={partDlg.id} parts={parts} periods={periods} payments={payments}
        onSave={handleSavePart} onDelete={handleDeletePart} onClose={() => setPartDlg({ open: false, id: null })}
        onSavePeriod={handleSavePeriod} onDeletePeriod={handleDeletePeriod} />
      <ValuationDialog open={valDlg.open} id={valDlg.id} valuations={valuations} onSave={handleSaveVal} onDelete={handleDeleteVal} onClose={() => setValDlg({ open: false, id: null })} />
      <PaymentDialog open={payDlg.open} id={payDlg.id} payments={payments} parts={parts} settings={settings} onSave={handleSavePay} onDelete={handleDeletePay} onClose={() => setPayDlg({ open: false, id: null })} />
      <CopyToPartsDialog open={copyDlg.open} source={copyDlg.source} parts={parts} onConfirm={ids => copyDlg.source && handleCopyToParts(copyDlg.source, ids)} onClose={() => setCopyDlg({ open: false, source: null })} />
      <InsatsSplitDialog open={insatsDlg.open} payment={insatsDlg.payment} settings={settings}
        onSave={split => insatsDlg.payment && handleSaveInsatsSplit(insatsDlg.payment, split)}
        onRemove={() => insatsDlg.payment && handleRemoveInsats(insatsDlg.payment)}
        onClose={() => setInsatsDlg({ open: false, payment: null })} />
      <ContribDialog open={contDlg.open} id={contDlg.id} contributions={contributions} settings={settings} onSave={handleSaveCont} onDelete={handleDeleteCont} onClose={() => setContDlg({ open: false, id: null })} />
      <SettingsDialog open={settingsDlg} settings={settings} onSave={handleSaveSettings} onClose={() => setSettingsDlg(false)}
        onExportJSON={handleExportJSON} onExportCSV={handleExportCSV} onImportJSON={handleImportJSON} />

      {/* ── Toast ── */}
      <div className={'bk-toast' + (toast.show ? ' show' : '')} role="status" aria-live="polite">{toast.msg}</div>
    </div>
  )
}
