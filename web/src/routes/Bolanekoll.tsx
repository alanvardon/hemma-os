import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import Chart from 'chart.js/auto'
import { Money, Percent } from '../components/AnimatedNumber'
import { useTheme } from '../App'
import {
  defaultSettings, parseCsv, parseAmount, autoMapColumns, classifyKind,
  makeLoanPart, makeRatePeriod, makePayment, flagDuplicates, assignPaymentsToPart,
  partBalance, totalBalance, totalAmortized, totalInterest, ranteavdrag,
  propertyValue, equity, loanToValue, ownerSplit, ownerPercents, otherOwner,
  effectiveRatePeriod, bindingStatus, weightedAvgRate, derivedRate, amorteringskravStatus,
  equityTimeline, equityBridge, projectMilestones, monthlyAmortizationRate, monthlyCost,
  paymentsToCsv, headerSignature, mappingToNames, applyPreset, reconcileBalance,
  contributionSplit, settlement, todayISO, normPaidBy,
} from '../lib/mortgage'
import type { LoanPart, RatePeriod, Payment, Valuation, Contribution, MortgageSettings, CsvResult, ColMapping, Owner } from '../lib/mortgage'
import * as Store from '../lib/mortgage-store'

// ── Formatters (faithful to mortgagetracker.js) ──────────────────────────────

const CURRENCY_SUFFIX: Record<string, string> = { SEK: 'kr', NOK: 'kr', DKK: 'kr', EUR: '€', USD: '$', GBP: '£' }
const KIND_LABELS: Record<string, string> = { interest: 'Ränta', amortization: 'Amortering', payment: 'Betalning', loan: 'Lån', fee: 'Avgift', other: 'Övrigt' }
function kindLabel(k: string): string { return KIND_LABELS[k] || k || '—' }

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

// ── Segmented control ────────────────────────────────────────────────────────

function Segmented<T extends string>({ value, options, onChange, small }: {
  value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; small?: boolean
}) {
  return (
    <div className={'segmented' + (small ? ' segmented-sm' : '')} role="radiogroup">
      {options.map(o => (
        <button key={o.v} type="button" role="radio" aria-checked={value === o.v}
          className={'seg' + (value === o.v ? ' is-active' : '')} onClick={() => onChange(o.v)}>{o.label}</button>
      ))}
    </div>
  )
}

// ── PeriodDialog ───────────────────────────────────────────────────────────

interface PeriodDlgProps {
  open: boolean; partId: string | null; id: string | null; periods: RatePeriod[]
  onSave: (data: Omit<RatePeriod, 'id' | 'created_at'>) => void
  onDelete: (id: string) => void; onClose: () => void
}
function PeriodDialog({ open, partId, id, periods, onSave, onDelete, onClose }: PeriodDlgProps) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { if (open) ref.current?.showModal(); else ref.current?.close() }, [open])
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
    <dialog ref={ref} className="bk-dialog" onClick={e => e.target === e.currentTarget && onClose()}>
      <form className="dialog-body" onSubmit={submit}>
        <h3 className="dialog-title">{id ? 'Edit rate period' : 'Add rate period'}</h3>
        <div className="form-grid">
          <label className="form-field"><span>From (start)</span><input type="date" value={form.start_date} onChange={e => set('start_date', e.target.value)} /></label>
          <label className="form-field"><span>To (end, optional)</span><input type="date" value={form.end_date} onChange={e => set('end_date', e.target.value)} /></label>
          <label className="form-field"><span>Interest rate %</span><input type="text" inputMode="decimal" placeholder="e.g. 3.54" value={form.rate} onChange={e => set('rate', e.target.value)} /></label>
          <div className="form-field">
            <span>Rate type</span>
            <Segmented value={form.rate_type} onChange={v => set('rate_type', v)}
              options={[{ v: 'rörlig', label: 'Rörlig' }, { v: 'bunden', label: 'Bunden' }]} />
          </div>
        </div>
        <p className="form-hint">Leave “to” blank for the current, ongoing rate. A bunden term’s end date is its villkorsändringsdag.</p>
        <div className="dialog-actions">
          {id && <button type="button" className="btn btn-ghost btn-danger" onClick={() => { if (confirm('Delete this rate period?')) onDelete(id) }}>Delete</button>}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">Save</button>
        </div>
      </form>
    </dialog>
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
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { if (open) ref.current?.showModal(); else ref.current?.close() }, [open])
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
      <dialog ref={ref} className="bk-dialog" onClick={e => e.target === e.currentTarget && onClose()}>
        <form className="dialog-body" onSubmit={submit}>
          <h3 className="dialog-title">{id ? 'Edit loan part' : 'Add loan part'}</h3>
          <div className="form-grid">
            <label className="form-field form-wide"><span>Label</span><input type="text" placeholder="e.g. Lånedel 1 (rörlig)" value={form.label} onChange={e => set('label', e.target.value)} /></label>
            <label className="form-field"><span>Loan # (optional)</span><input type="text" placeholder="e.g. 9021 33 12345" value={form.loan_number} onChange={e => set('loan_number', e.target.value)} /></label>
            <label className="form-field"><span>Start balance</span><input type="text" inputMode="decimal" placeholder="0" value={form.start_balance} onChange={e => set('start_balance', e.target.value)} /></label>
            <label className="form-field"><span>As of date</span><input type="date" value={form.start_date} onChange={e => set('start_date', e.target.value)} /></label>
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
      </dialog>
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
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { if (open) ref.current?.showModal(); else ref.current?.close() }, [open])
  const rec = id ? valuations.find(v => v.id === id) : null
  const [form, setForm] = useState({ date: todayISO(), value: '', note: '' })
  useEffect(() => { if (open) setForm({ date: rec?.date || todayISO(), value: rec?.value ? String(rec.value) : '', note: rec?.note || '' }) }, [open, id]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: string, v: string) => setForm(p => ({ ...p, [k]: v }))
  function submit(e: React.FormEvent) { e.preventDefault(); onSave({ date: form.date, value: parseAmount(form.value) || 0, note: form.note }) }
  return (
    <dialog ref={ref} className="bk-dialog" onClick={e => e.target === e.currentTarget && onClose()}>
      <form className="dialog-body" onSubmit={submit}>
        <h3 className="dialog-title">{id ? 'Edit property value' : 'Add property value'}</h3>
        <div className="form-grid">
          <label className="form-field"><span>Date</span><input type="date" value={form.date} onChange={e => set('date', e.target.value)} /></label>
          <label className="form-field"><span>Value</span><input type="text" inputMode="decimal" placeholder="0" value={form.value} onChange={e => set('value', e.target.value)} /></label>
          <label className="form-field form-wide"><span>Note (optional)</span><input type="text" placeholder="e.g. Booli estimate" value={form.note} onChange={e => set('note', e.target.value)} /></label>
        </div>
        <p className="form-hint">Equity is this value minus the outstanding debt. Add a new one whenever you re-value.</p>
        <div className="dialog-actions">
          {id && <button type="button" className="btn btn-ghost btn-danger" onClick={() => { if (confirm('Delete this valuation?')) onDelete(id) }}>Delete</button>}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">Save</button>
        </div>
      </form>
    </dialog>
  )
}

// ── PaymentDialog ──────────────────────────────────────────────────────────

interface PayDlgProps {
  open: boolean; id: string | null; payments: Payment[]; parts: LoanPart[]; settings: MortgageSettings
  onSave: (data: Omit<Payment, 'id' | 'created_at'>) => void
  onDelete: (id: string) => void; onClose: () => void
}
function PaymentDialog({ open, id, payments, parts, settings, onSave, onDelete, onClose }: PayDlgProps) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { if (open) ref.current?.showModal(); else ref.current?.close() }, [open])
  const rec = id ? payments.find(p => p.id === id) : null
  const [form, setForm] = useState({ date: todayISO(), loan_part_id: '', kind: 'interest', amount: '', balance_after: '', paid_by: 'joint' })
  useEffect(() => {
    if (open) setForm({ date: rec?.date || todayISO(), loan_part_id: rec?.loan_part_id || (parts[0]?.id || ''), kind: rec?.kind || 'interest', amount: rec?.amount ? String(rec.amount) : '', balance_after: rec?.balance_after != null ? String(rec.balance_after) : '', paid_by: rec?.paid_by || 'joint' })
  }, [open, id]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: string, v: string) => setForm(p => ({ ...p, [k]: v }))
  function submit(e: React.FormEvent) { e.preventDefault(); onSave(makePayment({ date: form.date, loan_part_id: form.loan_part_id || null, kind: form.kind as Payment['kind'], amount: parseAmount(form.amount), balance_after: form.balance_after ? parseAmount(form.balance_after) : null, paid_by: normPaidBy(form.paid_by) })) }
  const aName = settings.owner_a_name || 'Alex', bName = settings.owner_b_name || 'Sam'
  return (
    <dialog ref={ref} className="bk-dialog" onClick={e => e.target === e.currentTarget && onClose()}>
      <form className="dialog-body" onSubmit={submit}>
        <h3 className="dialog-title">{id ? 'Edit payment' : 'Add payment'}</h3>
        <div className="form-grid">
          <label className="form-field form-wide"><span>Loan part</span>
            <select className="select" value={form.loan_part_id} onChange={e => set('loan_part_id', e.target.value)}>
              {parts.map(p => <option key={p.id} value={p.id}>{p.label || p.id}</option>)}
            </select>
          </label>
          <label className="form-field"><span>Date</span><input type="date" value={form.date} onChange={e => set('date', e.target.value)} /></label>
          <label className="form-field"><span>Type</span>
            <select className="select" value={form.kind} onChange={e => set('kind', e.target.value)}>
              <option value="interest">Ränta · Interest</option>
              <option value="amortization">Amortering · Principal</option>
              <option value="payment">Betalning · Payment</option>
              <option value="loan">Lån · Disbursement</option>
              <option value="fee">Avgift · Fee</option>
              <option value="other">Övrigt · Other</option>
            </select>
          </label>
          <label className="form-field"><span>Amount (Belopp)</span><input type="text" inputMode="decimal" placeholder="0" value={form.amount} onChange={e => set('amount', e.target.value)} /></label>
          <label className="form-field"><span>Balance after (Saldo, optional)</span><input type="text" inputMode="decimal" placeholder="0" value={form.balance_after} onChange={e => set('balance_after', e.target.value)} /></label>
          {settings.track_contributions && (
            <label className="form-field form-wide"><span>Paid by</span>
              <select className="select" value={form.paid_by} onChange={e => set('paid_by', e.target.value)}>
                <option value="joint">Joint · split by ownership</option>
                <option value="a">{aName}</option>
                <option value="b">{bName}</option>
              </select>
            </label>
          )}
        </div>
        <div className="dialog-actions">
          {id && <button type="button" className="btn btn-ghost btn-danger" onClick={() => { if (confirm('Delete this payment?')) onDelete(id) }}>Delete</button>}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">Save</button>
        </div>
      </form>
    </dialog>
  )
}

// ── ContribDialog ──────────────────────────────────────────────────────────

interface ContDlgProps {
  open: boolean; id: string | null; contributions: Contribution[]; settings: MortgageSettings
  onSave: (data: Omit<Contribution, 'id' | 'created_at'>) => void
  onDelete: (id: string) => void; onClose: () => void
}
function ContribDialog({ open, id, contributions, settings, onSave, onDelete, onClose }: ContDlgProps) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { if (open) ref.current?.showModal(); else ref.current?.close() }, [open])
  const rec = id ? contributions.find(c => c.id === id) : null
  const [form, setForm] = useState({ owner: 'a' as Owner, date: todayISO(), amount: '', note: '' })
  useEffect(() => { if (open) setForm({ owner: (rec?.owner as Owner) || 'a', date: rec?.date || todayISO(), amount: rec?.amount ? String(rec.amount) : '', note: rec?.note || '' }) }, [open, id]) // eslint-disable-line react-hooks/exhaustive-deps
  const aName = settings.owner_a_name || 'Alex', bName = settings.owner_b_name || 'Sam'
  function submit(e: React.FormEvent) { e.preventDefault(); onSave({ owner: form.owner, date: form.date, amount: parseAmount(form.amount) || 0, note: form.note }) }
  return (
    <dialog ref={ref} className="bk-dialog" onClick={e => e.target === e.currentTarget && onClose()}>
      <form className="dialog-body" onSubmit={submit}>
        <h3 className="dialog-title">{id ? 'Edit contribution' : 'Add contribution'}</h3>
        <div className="form-grid">
          <div className="form-field">
            <span>Who paid</span>
            <Segmented value={form.owner} onChange={v => setForm(p => ({ ...p, owner: v }))}
              options={[{ v: 'a' as Owner, label: aName }, { v: 'b' as Owner, label: bName }]} />
          </div>
          <label className="form-field"><span>Date</span><input type="date" value={form.date} onChange={e => setForm(p => ({ ...p, date: e.target.value }))} /></label>
          <label className="form-field"><span>Amount</span><input type="text" inputMode="decimal" placeholder="0" value={form.amount} onChange={e => setForm(p => ({ ...p, amount: e.target.value }))} /></label>
          <label className="form-field form-wide"><span>Note (optional)</span><input type="text" placeholder="e.g. Down payment" value={form.note} onChange={e => setForm(p => ({ ...p, note: e.target.value }))} /></label>
        </div>
        <p className="form-hint">A lump sum one owner put in — down payment or extra amortering — beyond the shared split.</p>
        <div className="dialog-actions">
          {id && <button type="button" className="btn btn-ghost btn-danger" onClick={() => { if (confirm('Delete this contribution?')) onDelete(id) }}>Delete</button>}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">Save</button>
        </div>
      </form>
    </dialog>
  )
}

// ── SettingsDialog ─────────────────────────────────────────────────────────

interface SetDlgProps {
  open: boolean; settings: MortgageSettings
  onSave: (patch: Partial<MortgageSettings>) => void; onClose: () => void
  onExportJSON: () => void; onExportCSV: () => void; onImportJSON: (e: React.ChangeEvent<HTMLInputElement>) => void
}
function SettingsDialog({ open, settings, onSave, onClose, onExportJSON, onExportCSV, onImportJSON }: SetDlgProps) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { if (open) ref.current?.showModal(); else ref.current?.close() }, [open])
  const [form, setForm] = useState({ ...settings })
  useEffect(() => { if (open) setForm({ ...settings }) }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const f = (k: keyof MortgageSettings) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const v = e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value
    setForm(p => ({ ...p, [k]: v }))
  }
  function submit(e: React.FormEvent) { e.preventDefault(); onSave({ ...form, my_ownership_pct: Number(form.my_ownership_pct), household_income_yearly: form.household_income_yearly ? Number(form.household_income_yearly) : null }) }
  const aName = form.owner_a_name || 'Alex', bName = form.owner_b_name || 'Sam'
  return (
    <dialog ref={ref} className="bk-dialog" onClick={e => e.target === e.currentTarget && onClose()}>
      <form className="dialog-body" onSubmit={submit}>
        <h3 className="dialog-title">Settings</h3>
        <div className="form-grid">
          <label className="form-field form-wide"><span>Property name (optional)</span><input type="text" placeholder="e.g. Storgatan 4" value={form.property_name} onChange={f('property_name')} /></label>
          <label className="form-field"><span>Owner A name</span><input type="text" value={form.owner_a_name} onChange={f('owner_a_name')} /></label>
          <label className="form-field"><span>Owner B name</span><input type="text" value={form.owner_b_name} onChange={f('owner_b_name')} /></label>
          <label className="form-field"><span>My ownership %</span><input type="text" inputMode="decimal" placeholder="50" value={form.my_ownership_pct} onChange={f('my_ownership_pct')} /></label>
          <div className="form-field">
            <span>Which owner am I?</span>
            <Segmented value={(form.i_am as Owner) || 'a'} onChange={v => setForm(p => ({ ...p, i_am: v }))}
              options={[{ v: 'a' as Owner, label: aName }, { v: 'b' as Owner, label: bName }]} />
          </div>
          <label className="form-field"><span>Currency</span>
            <select className="select" value={form.currency} onChange={f('currency')}>
              <option value="SEK">SEK · kr</option><option value="NOK">NOK · kr</option><option value="DKK">DKK · kr</option>
              <option value="EUR">EUR · €</option><option value="USD">USD · $</option><option value="GBP">GBP · £</option>
            </select>
          </label>
          <label className="form-field"><span>Household income / year (optional)</span><input type="text" inputMode="decimal" placeholder="e.g. 720000" value={form.household_income_yearly ?? ''} onChange={f('household_income_yearly')} /></label>
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
    </dialog>
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
function M(value: number, signed?: boolean) {
  return <Money value={value} currencySuffix={CURRENCY_SUFFIX[CURRENT_CURRENCY] || 'kr'} signed={signed} />
}
function P(value: number) { return <Percent value={value} decimals={2} space locale="sv-SE" /> }

// ── Main component ─────────────────────────────────────────────────────────

export default function Bolanekoll() {
  const { theme, toggleTheme } = useTheme()
  useLayoutEffect(() => { document.documentElement.classList.remove('calc-layout') }, [])

  const [parts, setParts] = useState<LoanPart[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [valuations, setValuations] = useState<Valuation[]>([])
  const [periods, setPeriods] = useState<RatePeriod[]>([])
  const [contributions, setContributions] = useState<Contribution[]>([])
  const [settings, setSettings] = useState<MortgageSettings>(defaultSettings())

  const [toast, setToast] = useState({ msg: '', show: false })
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  const [bridgePeriod, setBridgePeriod] = useState<'ytd' | '12m' | 'all'>('ytd')
  const [extraAmort, setExtraAmort] = useState('')
  const [paymentFilter, setPaymentFilter] = useState('all')
  const [isDragging, setIsDragging] = useState(false)
  const [importCfg, setImportCfg] = useState<ImportCfg | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [partDlg, setPartDlg] = useState<{ open: boolean; id: string | null }>({ open: false, id: null })
  const [valDlg, setValDlg] = useState<{ open: boolean; id: string | null }>({ open: false, id: null })
  const [payDlg, setPayDlg] = useState<{ open: boolean; id: string | null }>({ open: false, id: null })
  const [contDlg, setContDlg] = useState<{ open: boolean; id: string | null }>({ open: false, id: null })
  const [settingsDlg, setSettingsDlg] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<Chart | null>(null)

  CURRENT_CURRENCY = settings.currency || 'SEK'

  function showToast(msg: string) {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast({ msg, show: true })
    toastTimer.current = setTimeout(() => setToast(t => ({ ...t, show: false })), 2600)
  }
  function flashSaved() { setSaved(true); setTimeout(() => setSaved(false), 1400) }

  const refresh = useCallback(async () => {
    const [ps, pays, vals, pers, contribs, sett] = await Promise.all([
      Store.listLoanParts(), Store.listPayments(), Store.listValuations(),
      Store.listRatePeriods(), Store.listContributions(), Store.getSettings(),
    ])
    setParts(ps); setPayments(pays); setValuations(vals); setPeriods(pers); setContributions(contribs); setSettings(sett)
  }, [])

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => { document.title = (settings.property_name || 'Bolånekoll') + ' · Hemma' }, [settings.property_name])

  const nameOf = useCallback((p: Owner) => p === 'b' ? (settings.owner_b_name || 'Sam') : (settings.owner_a_name || 'Alex'), [settings])

  // ── Derived data ───────────────────────────────────────────────────────────
  const today = todayISO()
  const balance = useMemo(() => totalBalance(parts, payments), [parts, payments])
  const value = useMemo(() => propertyValue(valuations), [valuations])
  const eq = useMemo(() => equity(value, balance), [value, balance])
  const ltv = useMemo(() => loanToValue(balance, value), [balance, value])
  const split = useMemo(() => ownerSplit(eq, settings), [eq, settings])
  const pct = useMemo(() => ownerPercents(settings), [settings])
  const amortized = useMemo(() => totalAmortized(parts, payments), [parts, payments])
  const interest = useMemo(() => totalInterest(payments), [payments])
  const deduction = useMemo(() => ranteavdrag(interest), [interest])
  const hasValuation = valuations.length > 0
  const timeline = useMemo(() => equityTimeline(parts, payments, valuations, settings), [parts, payments, valuations, settings])

  const soon = useMemo(() => {
    let s: { days: number; until: string } | null = null
    parts.forEach(p => {
      const bs = bindingStatus(p, periods)
      if (bs.bound && bs.days_left != null && (s == null || bs.days_left < s.days)) s = { days: bs.days_left, until: bs.until! }
    })
    return s as { days: number; until: string } | null
  }, [parts, periods])

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

  // ── Chart (stacked area: my equity → partner → bank) ─────────────────────────
  useEffect(() => {
    if (!canvasRef.current) return
    if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null }
    const renderable = timeline.length >= 2 && valuations.length > 0
    if (!renderable) return
    const style = getComputedStyle(document.documentElement.querySelector('.bk-root') || document.documentElement)
    const get = (v: string) => style.getPropertyValue(v).trim()
    const cc = { grid: get('--rule'), tick: get('--ink-soft'), tooltipBg: get('--paper-card'), tooltipBorder: get('--rule'), tooltipTitle: get('--ink'), tooltipBody: get('--ink-mid'), legend: get('--ink-mid'), a: get('--chart-mine') || '#357a4c', b: get('--chart-partner') || '#3d7e94', bank: get('--chart-bank') || '#c08a44' }
    const hexToRgba = (hex: string, alpha: number) => {
      let h = String(hex || '').replace('#', '')
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
      const n = parseInt(h, 16)
      if (isNaN(n)) return `rgba(0,0,0,${alpha})`
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
    }
    const me: Owner = settings.i_am === 'b' ? 'b' : 'a', other: Owner = me === 'a' ? 'b' : 'a'
    const mk = (label: string, key: 'a_equity' | 'b_equity' | 'bank', color: string) => ({
      label, data: timeline.map(r => Math.max(0, r[key])), borderColor: color, backgroundColor: hexToRgba(color, 0.28),
      borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 4, pointHitRadius: 10, tension: 0.25, fill: true,
    })
    chartRef.current = new Chart(canvasRef.current, {
      type: 'line',
      data: {
        labels: timeline.map(r => r.label),
        datasets: [
          mk(nameOf(me) + '’s equity', (me + '_equity') as 'a_equity' | 'b_equity', cc.a),
          mk(nameOf(other) + '’s equity', (other + '_equity') as 'a_equity' | 'b_equity', cc.b),
          mk('Banken · Bank', 'bank', cc.bank),
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        animation: { duration: 600, easing: 'easeOutQuart' },
        plugins: {
          legend: { position: 'top', labels: { font: { family: 'Inter', size: 12 }, color: cc.legend, boxWidth: 14, padding: 14, usePointStyle: true, pointStyle: 'rectRounded' } },
          tooltip: {
            backgroundColor: cc.tooltipBg, borderColor: cc.tooltipBorder, borderWidth: 1,
            titleColor: cc.tooltipTitle, bodyColor: cc.tooltipBody,
            titleFont: { family: 'Inter', size: 12, weight: 500 }, bodyFont: { family: 'Inter', size: 12 },
            padding: 10, cornerRadius: 10, boxPadding: 4,
            callbacks: { label: (item) => ' ' + item.dataset.label + ': ' + Math.round(Number(item.raw) || 0).toLocaleString('sv-SE') + ' kr' },
          },
        },
        scales: {
          x: { grid: { color: cc.grid, lineWidth: 0.5 }, ticks: { font: { family: 'Inter', size: 11 }, color: cc.tick, maxTicksLimit: 12 } },
          y: { stacked: true, grid: { color: cc.grid, lineWidth: 0.5 }, ticks: { font: { family: 'Inter', size: 11 }, color: cc.tick, callback: (v: number | string) => Math.round(Number(v) / 1000) + 'k' } },
        },
      },
    })
    return () => { chartRef.current?.destroy(); chartRef.current = null }
  }, [timeline, valuations, settings, theme, nameOf])

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
    const sig = headerSignature(importCfg.parsed.headers)
    await Store.saveSettings({ import_presets: { ...settings.import_presets, [sig]: mappingToNames(importCfg.parsed.headers, importCfg.mapping) } })
    const savedRows = await Store.addPayments(drafts)
    await refresh(); flashSaved()
    showToast('Added ' + savedRows.length + ' row' + (savedRows.length === 1 ? '' : 's') + ' from “' + importCfg.file.name + '”.')
    if (importCfg.queue.length) { const cfg = await loadFile(importCfg.queue[0]); setImportCfg({ ...cfg, queue: importCfg.queue.slice(1), qIdx: importCfg.qIdx + 1 }) }
    else setImportCfg(null)
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
    if (partDlg.id) await Store.updateLoanPart(partDlg.id, data); else await Store.addLoanPart(data)
    await refresh(); flashSaved(); setPartDlg({ open: false, id: null }); showToast(partDlg.id ? 'Loan part updated.' : 'Loan part added.')
  }
  async function handleDeletePart(id: string) { await Store.removeLoanPart(id); await refresh(); flashSaved(); setPartDlg({ open: false, id: null }); showToast('Loan part deleted.') }
  async function handleSavePeriod(partId: string, data: Omit<RatePeriod, 'id' | 'created_at'>, existingId?: string) {
    if (existingId) await Store.updateRatePeriod(existingId, data); else await Store.addRatePeriod({ ...data, loan_part_id: partId })
    await refresh(); flashSaved(); showToast(existingId ? 'Rate period updated.' : 'Rate period added.')
  }
  async function handleDeletePeriod(id: string) { await Store.removeRatePeriod(id); await refresh(); flashSaved() }
  async function handleSaveVal(data: Omit<Valuation, 'id' | 'created_at'>) {
    if (valDlg.id) await Store.updateValuation(valDlg.id, data); else await Store.addValuation(data)
    await refresh(); flashSaved(); setValDlg({ open: false, id: null }); showToast('Valuation saved.')
  }
  async function handleDeleteVal(id: string) { await Store.removeValuation(id); await refresh(); flashSaved(); setValDlg({ open: false, id: null }); showToast('Valuation deleted.') }
  async function handleSavePay(data: Omit<Payment, 'id' | 'created_at'>) {
    if (payDlg.id) await Store.updatePayment(payDlg.id, data); else await Store.addPayment(data)
    await refresh(); flashSaved(); setPayDlg({ open: false, id: null }); showToast('Payment saved.')
  }
  async function handleDeletePay(id: string) { await Store.removePayment(id); await refresh(); flashSaved(); setPayDlg({ open: false, id: null }); showToast('Payment deleted.') }
  async function handleSaveCont(data: Omit<Contribution, 'id' | 'created_at'>) {
    if (contDlg.id) await Store.updateContribution(contDlg.id, data); else await Store.addContribution(data)
    await refresh(); flashSaved(); setContDlg({ open: false, id: null }); showToast('Contribution saved.')
  }
  async function handleDeleteCont(id: string) { await Store.removeContribution(id); await refresh(); flashSaved(); setContDlg({ open: false, id: null }); showToast('Contribution deleted.') }
  async function handleSaveSettings(patch: Partial<MortgageSettings>) { await Store.saveSettings(patch); await refresh(); flashSaved(); setSettingsDlg(false); showToast('Settings saved.') }

  async function clearPayments() {
    const scoped = paymentFilter === 'all' ? payments : payments.filter(p => p.loan_part_id === paymentFilter)
    if (!scoped.length) return
    if (!confirm('Delete ' + scoped.length + ' payment' + (scoped.length === 1 ? '' : 's') + '? This can’t be undone.')) return
    for (const p of scoped) await Store.removePayment(p.id)
    await refresh(); flashSaved(); showToast('Payments deleted.')
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
    catch (err) { alert(String(err)) }
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
  const partNameById = (pid: string | null) => parts.find(p => p.id === pid)?.label || '—'

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="bk-root">
      <header className="page-header">
        <div className="header-brand">
          <Link className="hub-link" to="/">‹ Hemma</Link>
          <div>
            <h1>{settings.property_name || 'Bolånekoll'}</h1>
            <p className="tagline">Track your mortgage — how much of the home you own vs the bank</p>
          </div>
        </div>
        <div className="header-actions">
          <span className={'save-state' + (saved ? ' show' : '')}>Saved ✓</span>
          <button className="btn btn-ghost theme-toggle-btn" onClick={() => setSettingsDlg(true)} title="Settings" aria-label="Settings">⚙</button>
          <button className="btn btn-ghost theme-toggle-btn" onClick={toggleTheme} title="Toggle dark mode" aria-label="Toggle dark mode">{theme === 'dark' ? '☾' : '☀'}</button>
        </div>
      </header>

      <main className="wrap">

        {/* ── Dashboard ── */}
        <section className="card dashboard-card">
          <div className="dash-main">
            <p className="dash-label">Eget kapital · Total equity</p>
            <p className="dash-headline">{hasValuation ? M(eq) : '—'}</p>
            <p className="dash-sub">{dashSub}</p>
          </div>
          <div className="split-row">
            <div className="split-card is-accent">
              <span className="split-name">{nameOf('a')} · {fmtPct(pct.a)}</span>
              <span className="split-val">{hasValuation ? M(split.a) : '—'}</span>
              <span className="split-sub">equity share</span>
            </div>
            <div className="split-card">
              <span className="split-name">{nameOf('b')} · {fmtPct(pct.b)}</span>
              <span className="split-val">{hasValuation ? M(split.b) : '—'}</span>
              <span className="split-sub">equity share</span>
            </div>
          </div>
          <div className="metric-row">
            <div className="metric-chip is-accent"><span className="metric-label">Remaining debt</span><span className="metric-val">{M(balance)}</span></div>
            <div className="metric-chip"><span className="metric-label">Property value</span><span className="metric-val">{hasValuation ? M(value) : '—'}</span></div>
            <div className="metric-chip"><span className="metric-label">Loan-to-value</span><span className="metric-val">{hasValuation ? P(ltv) : '—'}</span></div>
            <div className="metric-chip"><span className="metric-label">Total amortised</span><span className="metric-val">{M(amortized)}</span></div>
            <div className="metric-chip"><span className="metric-label">Interest paid</span><span className="metric-val">{M(interest)}</span></div>
            {settings.ranteavdrag && <div className="metric-chip"><span className="metric-label">Ränteavdrag (est.)</span><span className="metric-val">{M(deduction)}</span></div>}
            {soon && <div className={'metric-chip' + (soon.days <= 90 ? ' is-warn' : '')}><span className="metric-label">Bound rate ends</span><span className="metric-val">{soon.until}</span></div>}
          </div>
          {reconcile.length > 0 && (
            <div className="reconcile-banner">
              Start-balance check — your entered start balance doesn’t match where the imported ledger begins (a partial import, or a start balance to update — today’s balance still tracks the Saldo correctly):
              <ul>{reconcile.map(r => <li key={r.loan_part_id}>{r.label || 'Loan part'}: start balance {fmtMoney(r.start_balance!)} vs the ledger’s earliest Saldo {fmtMoney(r.start_saldo!)} — off by {fmtMoney(Math.abs(r.drift!))}</li>)}</ul>
            </div>
          )}
        </section>

        {/* ── Ownership vs bank over time ── */}
        <section className="card">
          <div className="card-head"><h2>Ägande över tid <span className="card-en">· Ownership vs bank</span></h2></div>
          <div className="chart-wrap">
            {timeline.length >= 2 && valuations.length > 0
              ? <canvas ref={canvasRef} />
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
              <table className="data-table">
                <thead><tr><th>Loan part</th><th className="num">Balance</th><th className="num">Share</th><th>Rate</th><th className="col-act"></th></tr></thead>
                <tbody>
                  {parts.map(p => {
                    const bal = partBalance(p, payments)
                    const share = partsTotal > 0 ? bal / partsTotal * 100 : 0
                    const per = effectiveRatePeriod(p, periods, undefined)
                    const der = derivedRate(p, payments)
                    return (
                      <tr key={p.id} className={p.archived ? 'is-settled' : ''}>
                        <td>{p.label || '(no name)'}{p.loan_number && <span className="row-note"> #{p.loan_number}</span>}</td>
                        <td className="num">{fmtMoney(bal)}</td>
                        <td className="num">{fmtPct(share)}</td>
                        <td>
                          {per && per.rate != null ? (
                            <>{fmtPct(per.rate)} <span className="row-note">{per.rate_type === 'bunden' ? 'bunden' : 'rörlig'}</span>{der != null && <span className="row-note"> · ~{fmtPct(der)} ledger</span>}</>
                          ) : der != null ? <span className="row-note">~{fmtPct(der)} ledger</span> : '—'}
                        </td>
                        <td className="col-act">
                          <button type="button" className="icon-btn" title="Edit" onClick={() => setPartDlg({ open: true, id: p.id })}>✎</button>
                          <button type="button" className="icon-btn" data-del-part title="Delete" onClick={() => { if (confirm('Delete this loan part and all its payments? This can’t be undone.')) handleDeletePart(p.id) }}>✕</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
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
                      <tr key={v.id}>
                        <td className="col-date">{v.date || '—'}</td>
                        <td className="num">{fmtMoney(v.value)}</td>
                        <td>{v.note || ''}</td>
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
              <div className="segmented" role="radiogroup" aria-label="Filter payments">
                <button type="button" className={'seg' + (paymentFilter === 'all' ? ' is-active' : '')} onClick={() => setPaymentFilter('all')}>All</button>
                {parts.map(p => <button key={p.id} type="button" className={'seg' + (paymentFilter === p.id ? ' is-active' : '')} onClick={() => setPaymentFilter(p.id)}>{p.label || 'part'}</button>)}
              </div>
              <button type="button" className="btn btn-ghost" onClick={() => setPayDlg({ open: true, id: null })}>+ Add payment</button>
              <button type="button" className="btn btn-ghost btn-danger" disabled={!filteredPayments.length} onClick={clearPayments}>{paymentFilter === 'all' ? 'Delete all' : 'Delete ' + partNameById(paymentFilter)}</button>
            </div>
          </div>
          {!filteredPayments.length ? (
            <p className="empty">{payments.length ? 'No payments for this loan part.' : 'No payments yet. Import a statement above, or add one manually.'}</p>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th className="col-date">Date</th><th>Loan part</th><th>Type</th><th className="num">Amount</th><th className="num">Balance</th><th className="col-act"></th></tr></thead>
                <tbody>
                  {filteredPayments.map(p => (
                    <tr key={p.id}>
                      <td className="col-date">{p.date || '—'}</td>
                      <td>{partNameById(p.loan_part_id)}</td>
                      <td><span className={'kind-tag kind-' + (p.kind || 'other')}>{kindLabel(p.kind)}</span></td>
                      <td className="num">{fmtMoney(p.amount)}</td>
                      <td className="num">{p.balance_after != null ? fmtMoney(p.balance_after) : '—'}</td>
                      <td className="col-act">
                        <button type="button" className="icon-btn" title="Edit" onClick={() => setPayDlg({ open: true, id: p.id })}>✎</button>
                        <button type="button" className="icon-btn" data-del-pay title="Delete" onClick={() => { if (confirm('Delete this payment?')) handleDeletePay(p.id) }}>✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── Contributions ── */}
        {settings.track_contributions && (
          <section className="card">
            <div className="card-head">
              <h2>Insatser <span className="card-en">· Contributions</span></h2>
              <span className="count-pill">{contributions.length}</span>
              <div className="card-actions"><button type="button" className="btn btn-ghost" onClick={() => setContDlg({ open: true, id: null })}>+ Add contribution</button></div>
            </div>
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
          </section>
        )}

      </main>

      {/* ── Dialogs ── */}
      <PartDialog open={partDlg.open} id={partDlg.id} parts={parts} periods={periods} payments={payments}
        onSave={handleSavePart} onDelete={handleDeletePart} onClose={() => setPartDlg({ open: false, id: null })}
        onSavePeriod={handleSavePeriod} onDeletePeriod={handleDeletePeriod} />
      <ValuationDialog open={valDlg.open} id={valDlg.id} valuations={valuations} onSave={handleSaveVal} onDelete={handleDeleteVal} onClose={() => setValDlg({ open: false, id: null })} />
      <PaymentDialog open={payDlg.open} id={payDlg.id} payments={payments} parts={parts} settings={settings} onSave={handleSavePay} onDelete={handleDeletePay} onClose={() => setPayDlg({ open: false, id: null })} />
      <ContribDialog open={contDlg.open} id={contDlg.id} contributions={contributions} settings={settings} onSave={handleSaveCont} onDelete={handleDeleteCont} onClose={() => setContDlg({ open: false, id: null })} />
      <SettingsDialog open={settingsDlg} settings={settings} onSave={handleSaveSettings} onClose={() => setSettingsDlg(false)}
        onExportJSON={handleExportJSON} onExportCSV={handleExportCSV} onImportJSON={handleImportJSON} />

      {/* ── Toast ── */}
      <div className={'bk-toast' + (toast.show ? ' show' : '')} role="status" aria-live="polite">{toast.msg}</div>
    </div>
  )
}
