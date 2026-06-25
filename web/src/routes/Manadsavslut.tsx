import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTheme } from '../App'
import {
  defaultSettings, otherPerson, parseCsv, parseAmount, autoMapColumns, inferSpendSign,
  computeOwedAmount, classifyToItemFields, makeItem, flagDuplicates, netBalance, buildSettlement,
  monthKey, monthLabel, monthsWithOpenItems, itemsForMonth,
  spendByCategory, grocerySpendByMonth, fillMonthGaps,
} from '../lib/manadsavslut'
import type { Item, Payment, MonthEndSettings, Person, Treatment, CsvResult, ColMapping } from '../lib/manadsavslut'
import * as Store from '../lib/manadsavslut-store'

// ── Formatters (faithful to manadsavslut.js) ─────────────────────────────────

const CURRENCY_SUFFIX: Record<string, string> = { SEK: 'kr', NOK: 'kr', DKK: 'kr', EUR: '€', USD: '$', GBP: '£' }
let CURRENT_CURRENCY = 'SEK'
function fmtMoney(n: number): string {
  const num = Number(n) || 0
  const hasOre = Math.abs(num - Math.round(num)) > 0.005
  const suffix = CURRENCY_SUFFIX[CURRENT_CURRENCY] || 'kr'
  return num.toLocaleString('sv-SE', { minimumFractionDigits: hasOre ? 2 : 0, maximumFractionDigits: 2 }) + ' ' + suffix
}
const clean = (v: unknown) => String(v == null ? '' : v).trim()
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100
function todayISO(): string {
  const d = new Date(), p = (n: number) => (n < 10 ? '0' : '') + n
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}
function defaultPeriodLabel(): string {
  try { const s = new Date().toLocaleDateString('sv-SE', { month: 'long', year: 'numeric' }); return s.charAt(0).toUpperCase() + s.slice(1) } catch { return '' }
}

// ── Segmented control ────────────────────────────────────────────────────────

function Segmented<T extends string>({ value, options, onChange, small, ariaLabel }: {
  value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; small?: boolean; ariaLabel?: string
}) {
  return (
    <div className={'segmented' + (small ? ' segmented-sm' : '')} role="radiogroup" aria-label={ariaLabel}>
      {options.map(o => (
        <button key={o.v} type="button" role="radio" aria-checked={value === o.v}
          className={'seg' + (value === o.v ? ' is-active' : '')} onClick={() => onChange(o.v)}>{o.label}</button>
      ))}
    </div>
  )
}

// ── Triage (import) ──────────────────────────────────────────────────────────

interface TriageRow { classification: Treatment; kind: 'charge' | 'refund' | 'noamount'; charge: number; duplicate: boolean }
interface ImportCfg { file: File; parsed: CsvResult; mapping: ColMapping; frontedBy: Person; triage: TriageRow[] }

function cellAt(row: string[], idx: number | null): string { return idx == null ? '' : (row[idx] == null ? '' : row[idx]) }

// Derive { kind, charge, duplicate } for each parsed row against the current
// mapping + chosen card. Classification is preserved by the caller.
function deriveTriage(parsed: CsvResult, mapping: ColMapping, frontedBy: Person, existing: Item[]): Omit<TriageRow, 'classification'>[] {
  const amounts = parsed.rows.map(r => mapping.enter_amount == null ? NaN : parseAmount(r[mapping.enter_amount]))
  const spendSign = inferSpendSign(amounts)
  const candidates = parsed.rows.map((r, i) => {
    const amt = amounts[i]
    const charge = isFinite(amt) ? round2(amt * spendSign) : NaN
    if (!isFinite(charge) || charge === 0) return { kind: 'noamount' as const, charge: 0, cand: null }
    return {
      kind: (charge < 0 ? 'refund' : 'charge') as 'charge' | 'refund',
      charge,
      cand: { date_purchased: clean(cellAt(r, mapping.date_purchased)), description: clean(cellAt(r, mapping.description)), enter_amount: charge, fronted_by: frontedBy },
    }
  })
  const dups = flagDuplicates(existing, candidates.map(c => c.cand))
  return candidates.map((c, i) => ({ kind: c.kind, charge: c.charge, duplicate: !!dups[i] }))
}

// ── ItemDialog ───────────────────────────────────────────────────────────────

interface ItemDlgProps {
  open: boolean; id: string | null; items: Item[]; settings: MonthEndSettings; defaultClass: Treatment
  onSave: (rec: Omit<Item, 'id' | 'created_at'>) => void; onClose: () => void
}
function ItemDialog({ open, id, items, settings, defaultClass, onSave, onClose }: ItemDlgProps) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { if (open) ref.current?.showModal(); else ref.current?.close() }, [open])
  const rec = id ? items.find(i => i.id === id) : null
  const [form, setForm] = useState({ date: todayISO(), desc: '', amount: '', note: '', fronted: 'a' as Person, split: 'split' as 'split' | 'full' })
  useEffect(() => {
    if (open) setForm({
      date: rec?.date_purchased || todayISO(), desc: rec?.description || '', amount: rec?.enter_amount != null ? String(rec.enter_amount) : '',
      note: rec?.note || '', fronted: rec ? rec.fronted_by : 'a', split: rec ? (rec.split ? 'split' : 'full') : (defaultClass === 'full' ? 'full' : 'split'),
    })
  }, [open, id]) // eslint-disable-line react-hooks/exhaustive-deps
  const aName = settings.person_a_name || 'Alex', bName = settings.person_b_name || 'Sam'
  const nameOf = (p: Person) => p === 'b' ? bName : aName

  const amt = parseAmount(form.amount)
  const hint = (() => {
    if (!isFinite(amt) || amt === 0) return ''
    const owed = otherPerson(form.fronted)
    const share = computeOwedAmount(amt, form.split === 'split')
    const verb = amt < 0 ? ' is credited ' : ' will owe '
    return nameOf(owed) + verb + fmtMoney(Math.abs(share)) + (form.split === 'split' ? ' (half of ' + fmtMoney(Math.abs(amt)) + ')' : '')
  })()

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const a = parseAmount(form.amount)
    if (!isFinite(a) || a === 0) return
    onSave(makeItem({
      date_purchased: clean(form.date), description: clean(form.desc) || '(no description)',
      enter_amount: a, split: form.split === 'split', fronted_by: form.fronted, owed_by: otherPerson(form.fronted), note: clean(form.note),
    }))
  }
  return (
    <dialog ref={ref} className="ma-dialog" onClick={e => e.target === e.currentTarget && onClose()}>
      <form className="dialog-body" onSubmit={submit}>
        <h3 className="dialog-title">{id ? 'Edit item' : 'Add item'}</h3>
        <div className="form-grid">
          <label className="form-field"><span>Date</span><input type="date" value={form.date} onChange={e => setForm(p => ({ ...p, date: e.target.value }))} /></label>
          <label className="form-field form-wide"><span>Description</span><input type="text" autoComplete="off" placeholder="e.g. Groceries" value={form.desc} onChange={e => setForm(p => ({ ...p, desc: e.target.value }))} /></label>
          <label className="form-field"><span>Charge — minus for a refund</span><input type="text" inputMode="decimal" autoComplete="off" placeholder="0" value={form.amount} onChange={e => setForm(p => ({ ...p, amount: e.target.value }))} /></label>
          <div className="form-field">
            <span>Paid by</span>
            <Segmented value={form.fronted} onChange={v => setForm(p => ({ ...p, fronted: v }))} options={[{ v: 'a' as Person, label: aName }, { v: 'b' as Person, label: bName }]} />
          </div>
          <div className="form-field">
            <span>Treatment</span>
            <Segmented value={form.split} onChange={v => setForm(p => ({ ...p, split: v }))} options={[{ v: 'split' as const, label: 'Split 50/50' }, { v: 'full' as const, label: 'Owes all' }]} />
          </div>
          <label className="form-field form-wide"><span>Note (optional)</span><input type="text" autoComplete="off" value={form.note} onChange={e => setForm(p => ({ ...p, note: e.target.value }))} /></label>
        </div>
        <p className="form-hint">{hint}</p>
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">Save</button>
        </div>
      </form>
    </dialog>
  )
}

// ── SettleDialog ───────────────────────────────────────────────────────────

interface SettleDlgProps {
  open: boolean; openItems: Item[]; settings: MonthEndSettings
  onConfirm: (draft: Omit<Payment, 'id' | 'created_at'>) => void; onClose: () => void
}
function SettleDialog({ open, openItems, settings, onConfirm, onClose }: SettleDlgProps) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { if (open) ref.current?.showModal(); else ref.current?.close() }, [open])
  const aName = settings.person_a_name || 'Alex', bName = settings.person_b_name || 'Sam'
  const nameOf = (p: Person | null) => p === 'b' ? bName : p === 'a' ? aName : ''
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
    ? <>{nameOf(pending.from_person)} → {nameOf(pending.to_person)} · <strong>{fmtMoney(pending.amount)}</strong></>
    : <>Even — no transfer</>
  return (
    <dialog ref={ref} className="ma-dialog" onClick={e => e.target === e.currentTarget && onClose()}>
      <form className="dialog-body" onSubmit={submit}>
        <h3 className="dialog-title">Settle up</h3>
        <div className="form-grid">
          <label className="form-field form-wide"><span>Settle which month?</span>
            <select className="select" value={month} onChange={e => onMonthChange(e.target.value)}>
              {months.map(mk => <option key={mk} value={mk}>{monthLabel(mk)} ({itemsForMonth(openItems, mk).length})</option>)}
              <option value="__all__">All open items ({openItems.length})</option>
            </select>
          </label>
        </div>
        <p className="settle-line">
          {pending.item_ids.length
            ? <>{transfer} — closing {pending.item_ids.length} item{pending.item_ids.length === 1 ? '' : 's'}.</>
            : 'No open items in this period.'}
        </p>
        <div className="form-grid">
          <label className="form-field form-wide"><span>Period label</span><input type="text" autoComplete="off" placeholder="e.g. Juni 2026" value={period} onChange={e => setPeriod(e.target.value)} /></label>
          <label className="form-field form-wide"><span>Note (optional)</span><input type="text" autoComplete="off" value={note} onChange={e => setNote(e.target.value)} /></label>
        </div>
        <p className="form-hint">Closes just the chosen month's open items under one payment — a true month-end. Pick “All open items” to settle everything. Reopen later from History.</p>
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!pending.item_ids.length}>Confirm settlement</button>
        </div>
      </form>
    </dialog>
  )
}

// ── SettingsDialog ───────────────────────────────────────────────────────────

interface SetDlgProps {
  open: boolean; settings: MonthEndSettings
  onSave: (patch: Partial<MonthEndSettings>) => void; onClose: () => void
  onExport: () => void; onImport: (e: React.ChangeEvent<HTMLInputElement>) => void
}
function SettingsDialog({ open, settings, onSave, onClose, onExport, onImport }: SetDlgProps) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { if (open) ref.current?.showModal(); else ref.current?.close() }, [open])
  const [form, setForm] = useState({ ...settings })
  useEffect(() => { if (open) setForm({ ...settings }) }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  function submit(e: React.FormEvent) {
    e.preventDefault()
    onSave({ person_a_name: clean(form.person_a_name) || 'Alex', person_b_name: clean(form.person_b_name) || 'Sam', currency: form.currency || 'SEK', default_split: !!form.default_split })
  }
  return (
    <dialog ref={ref} className="ma-dialog" onClick={e => e.target === e.currentTarget && onClose()}>
      <form className="dialog-body" onSubmit={submit}>
        <h3 className="dialog-title">Settings</h3>
        <div className="form-grid">
          <label className="form-field"><span>Name A</span><input type="text" autoComplete="off" value={form.person_a_name} onChange={e => setForm(p => ({ ...p, person_a_name: e.target.value }))} /></label>
          <label className="form-field"><span>Name B</span><input type="text" autoComplete="off" value={form.person_b_name} onChange={e => setForm(p => ({ ...p, person_b_name: e.target.value }))} /></label>
          <div className="form-field form-wide">
            <span>Default treatment for new / imported rows</span>
            <Segmented value={form.default_split ? 'split' : 'full'} onChange={v => setForm(p => ({ ...p, default_split: v === 'split' }))} options={[{ v: 'split' as const, label: 'Split 50/50' }, { v: 'full' as const, label: 'Owes all' }]} />
          </div>
          <label className="form-field form-wide"><span>Currency</span>
            <select className="select" value={form.currency} onChange={e => setForm(p => ({ ...p, currency: e.target.value }))}>
              <option value="SEK">SEK · kr</option><option value="NOK">NOK · kr</option><option value="DKK">DKK · kr</option>
              <option value="EUR">EUR · €</option><option value="USD">USD · $</option><option value="GBP">GBP · £</option>
            </select>
          </label>
          <div className="form-field form-wide">
            <span>Backup</span>
            <div className="settings-data-row">
              <button type="button" className="btn btn-ghost" onClick={onExport}>Export JSON</button>
              <label className="btn btn-ghost" style={{ cursor: 'pointer' }}>Import JSON
                <input type="file" accept=".json,application/json" hidden onChange={onImport} />
              </label>
            </div>
            <p className="config-note">Download everything — items, settlements and settings — or restore a backup (merges by id, so re-importing is safe).</p>
          </div>
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">Save</button>
        </div>
      </form>
    </dialog>
  )
}

// ── Main component ─────────────────────────────────────────────────────────

export default function Manadsavslut() {
  const { theme, toggleTheme } = useTheme()
  useLayoutEffect(() => { document.documentElement.classList.remove('calc-layout') }, [])

  const [items, setItems] = useState<Item[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [settings, setSettings] = useState<MonthEndSettings>(defaultSettings())

  const [toast, setToast] = useState({ msg: '', show: false })
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [saved, setSaved] = useState(false)

  const [defaultClass, setDefaultClass] = useState<Treatment>('split')
  const [currentFilter, setCurrentFilter] = useState<'open' | 'all' | 'a' | 'b'>('open')
  const [insightsPeriod, setInsightsPeriod] = useState<'month' | '3m' | 'all'>('all')

  const [isDragging, setIsDragging] = useState(false)
  const [importCfg, setImportCfg] = useState<ImportCfg | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [itemDlg, setItemDlg] = useState<{ open: boolean; id: string | null }>({ open: false, id: null })
  const [settleDlg, setSettleDlg] = useState(false)
  const [settingsDlg, setSettingsDlg] = useState(false)

  CURRENT_CURRENCY = settings.currency || 'SEK'
  const aName = settings.person_a_name || 'Alex', bName = settings.person_b_name || 'Sam'
  const nameOf = useCallback((p: Person | null) => p === 'b' ? bName : p === 'a' ? aName : '', [aName, bName])

  function showToast(msg: string) {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast({ msg, show: true })
    toastTimer.current = setTimeout(() => setToast(t => ({ ...t, show: false })), 2600)
  }
  function flashSaved() { setSaved(true); setTimeout(() => setSaved(false), 1400) }

  const refresh = useCallback(async () => {
    const [its, pays, sett] = await Promise.all([Store.listItems(), Store.listPayments(), Store.getSettings()])
    setItems(its); setPayments(pays); setSettings(sett); setDefaultClass(sett.default_split ? 'split' : 'full')
  }, [])
  useEffect(() => { refresh() }, [refresh])

  // ── Import ───────────────────────────────────────────────────────────────
  async function handleFile(file: File) {
    if (!file) return
    const text = await file.text()
    const parsed = parseCsv(text)
    if (!parsed.headers.length || !parsed.rows.length) { showToast('That file has no rows to import.'); return }
    const mapping = autoMapColumns(parsed.headers)
    const frontedBy: Person = 'a'
    const derived = deriveTriage(parsed, mapping, frontedBy, items)
    const triage: TriageRow[] = derived.map(d => ({ ...d, classification: d.duplicate ? 'exclude' : defaultClass }))
    setImportCfg({ file, parsed, mapping, frontedBy, triage })
  }
  function reDerive(next: { mapping?: ColMapping; frontedBy?: Person }) {
    setImportCfg(cfg => {
      if (!cfg) return cfg
      const mapping = next.mapping ?? cfg.mapping
      const frontedBy = next.frontedBy ?? cfg.frontedBy
      const derived = deriveTriage(cfg.parsed, mapping, frontedBy, items)
      return { ...cfg, mapping, frontedBy, triage: cfg.triage.map((t, i) => ({ ...t, ...derived[i] })) }
    })
  }
  function setAllClass(c: Treatment) { setImportCfg(cfg => cfg ? { ...cfg, triage: cfg.triage.map(t => ({ ...t, classification: c })) } : cfg) }
  function cancelImport() { setImportCfg(null); if (fileInputRef.current) fileInputRef.current.value = '' }

  const triageSummary = useMemo(() => {
    if (!importCfg) return ''
    let add = 0, excl = 0, refundIncl = 0, invalid = 0, dup = 0
    importCfg.triage.forEach(t => {
      if (t.kind === 'noamount') { invalid++; return }
      if (t.classification === 'exclude') { excl++; return }
      add++; if (t.kind === 'refund') refundIncl++; if (t.duplicate) dup++
    })
    const parts = [add + ' item' + (add === 1 ? '' : 's') + ' to add']
    if (refundIncl) parts.push(refundIncl + ' refund' + (refundIncl === 1 ? '' : 's') + ' included')
    if (dup) parts.push(dup + ' possible duplicate' + (dup === 1 ? '' : 's'))
    if (excl) parts.push(excl + ' excluded')
    if (invalid) parts.push(invalid + ' without an amount')
    return parts.join(' · ')
  }, [importCfg])
  const addCount = importCfg ? importCfg.triage.filter(t => (t.kind === 'charge' || t.kind === 'refund') && t.classification !== 'exclude').length : 0

  async function confirmImport() {
    if (!importCfg) return
    if (importCfg.mapping.enter_amount == null) { showToast('Pick the amount column first.'); return }
    const drafts: Omit<Item, 'id' | 'created_at'>[] = []
    importCfg.parsed.rows.forEach((row, i) => {
      const t = importCfg.triage[i]
      if (t.kind !== 'charge' && t.kind !== 'refund') return
      const fields = classifyToItemFields(t.classification, importCfg.frontedBy)
      if (!fields) return
      drafts.push(makeItem({
        date_purchased: clean(cellAt(row, importCfg.mapping.date_purchased)),
        description: clean(cellAt(row, importCfg.mapping.description)) || '(no description)',
        enter_amount: t.charge, split: fields.split, fronted_by: importCfg.frontedBy, owed_by: fields.owed_by, source: 'import:' + importCfg.file.name,
      }))
    })
    if (!drafts.length) { showToast('Nothing selected to add.'); return }
    const savedRows = await Store.addItems(drafts)
    cancelImport(); await refresh(); flashSaved()
    showToast('Added ' + savedRows.length + ' item' + (savedRows.length === 1 ? '' : 's') + '.')
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  const open = useMemo(() => items.filter(it => !it.paid), [items])
  const bal = useMemo(() => netBalance(open), [open])

  const filteredItems = useMemo(() => items.filter(it => {
    if (currentFilter === 'open') return !it.paid
    if (currentFilter === 'a') return it.fronted_by === 'a'
    if (currentFilter === 'b') return it.fronted_by === 'b'
    return true
  }), [items, currentFilter])

  const itemsByPayment = useMemo(() => {
    const by: Record<string, Item[]> = {}
    items.forEach(it => { if (it.payment_id) (by[it.payment_id] = by[it.payment_id] || []).push(it) })
    return by
  }, [items])

  const periodItems = useMemo(() => {
    if (insightsPeriod === 'all') return items
    const n = insightsPeriod === '3m' ? 3 : 1
    const keys: Record<string, boolean> = {}, now = new Date()
    for (let k = 0; k < n; k++) { const d = new Date(now.getFullYear(), now.getMonth() - k, 1); const mo = d.getMonth() + 1; keys[d.getFullYear() + '-' + (mo < 10 ? '0' : '') + mo] = true }
    return items.filter(it => keys[monthKey(it.date_purchased)])
  }, [items, insightsPeriod])

  const cats = useMemo(() => spendByCategory(periodItems), [periodItems])
  const catTotal = cats.reduce((s, c) => s + c.total, 0)
  const groc = cats.find(c => c.key === 'groceries')
  const grocPct = catTotal > 0 && groc ? Math.round(groc.total / catTotal * 100) : 0
  const byMonth = useMemo(() => fillMonthGaps(grocerySpendByMonth(periodItems)), [periodItems])

  // ── Handlers ───────────────────────────────────────────────────────────────
  async function handleSaveItem(rec: Omit<Item, 'id' | 'created_at'>) {
    if (itemDlg.id) await Store.updateItem(itemDlg.id, { date_purchased: rec.date_purchased, description: rec.description, enter_amount: rec.enter_amount, split: rec.split, amount: rec.amount, fronted_by: rec.fronted_by, owed_by: rec.owed_by, note: rec.note })
    else await Store.addItem(rec)
    await refresh(); flashSaved(); setItemDlg({ open: false, id: null }); showToast(itemDlg.id ? 'Item updated.' : 'Item added.')
  }
  async function deleteItem(id: string) { if (!confirm('Delete this item?')) return; await Store.removeItem(id); await refresh(); flashSaved(); showToast('Item deleted.') }
  async function toggleType(it: Item, split: boolean) { await Store.updateItem(it.id, { split, amount: computeOwedAmount(it.enter_amount, split) }); await refresh(); flashSaved() }
  async function clearOpen() {
    const openIds = items.filter(it => !it.paid).map(it => it.id)
    if (!openIds.length) { showToast('No open items to delete.'); return }
    if (!confirm('Delete all ' + openIds.length + ' open item' + (openIds.length === 1 ? '' : 's') + '? Settled items are kept. This can’t be undone.')) return
    const n = await Store.removeItems(openIds); await refresh(); flashSaved(); showToast('Deleted ' + n + ' open item' + (n === 1 ? '' : 's') + '.')
  }
  async function confirmSettle(draft: Omit<Payment, 'id' | 'created_at'>) {
    const p = await Store.settle(draft); setSettleDlg(false); await refresh(); flashSaved()
    showToast(p.amount > 0 ? 'Settled — ' + fmtMoney(p.amount) + ' closed.' : 'Items closed.')
  }
  async function reopen(id: string) { if (!confirm('Reopen this settlement? Its items become open again.')) return; await Store.removePayment(id); await refresh(); flashSaved(); showToast('Settlement reopened.') }
  async function handleSaveSettings(patch: Partial<MonthEndSettings>) { await Store.saveSettings(patch); await refresh(); flashSaved(); setSettingsDlg(false); showToast('Settings saved.') }

  async function handleExport() {
    const text = await Store.exportJSON()
    const blob = new Blob([text], { type: 'application/json' })
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'manadsavslut-backup-' + todayISO() + '.json'; a.click(); URL.revokeObjectURL(url)
    showToast('Backup downloaded.')
  }
  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return
    try { const added = await Store.importJSON(await file.text()); await refresh(); flashSaved(); showToast('Imported ' + added.items + ' item' + (added.items === 1 ? '' : 's') + ' and ' + added.payments + ' settlement' + (added.payments === 1 ? '' : 's') + '.') }
    catch (err) { showToast((err as Error).message || 'Could not import that file.') }
    e.target.value = ''
  }

  // ── Balance display ──────────────────────────────────────────────────────
  let balLabel: string, balAmount: string, balSub: string
  if (!open.length) { balLabel = 'All settled'; balAmount = '—'; balSub = 'Nothing outstanding.' }
  else if (!bal.from || bal.amount <= 0) { balLabel = 'Even'; balAmount = fmtMoney(0); balSub = open.length + ' open item' + (open.length === 1 ? '' : 's') + ' · they cancel out' }
  else { balLabel = nameOf(bal.from) + ' owes ' + nameOf(bal.to); balAmount = fmtMoney(bal.amount); balSub = 'across ' + open.length + ' open item' + (open.length === 1 ? '' : 's') }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="ma-root">
      <header className="page-header">
        <div className="header-brand">
          <Link className="hub-link" to="/">‹ Hemma</Link>
          <div>
            <h1>Månadsavslut</h1>
            <p className="tagline">Reconcile shared spending and settle up — the month-end close</p>
          </div>
        </div>
        <div className="header-actions">
          <span className={'save-state' + (saved ? ' show' : '')}>Saved ✓</span>
          <button className="btn btn-ghost theme-toggle-btn" onClick={() => setSettingsDlg(true)} title="Settings" aria-label="Settings">⚙</button>
          <button className="btn btn-ghost theme-toggle-btn" onClick={toggleTheme} title="Toggle dark mode" aria-label="Toggle dark mode">{theme === 'dark' ? '☾' : '☀'}</button>
        </div>
      </header>

      <main className="wrap">

        {/* ── Outstanding balance + settle ── */}
        <section className="card balance-card">
          <div className="balance-main">
            <p className="balance-label">{balLabel}</p>
            <p className="balance-amount">{balAmount}</p>
            <p className="balance-sub">{balSub}</p>
          </div>
          <button type="button" className="btn btn-primary balance-settle" disabled={!open.length} onClick={() => setSettleDlg(true)}>Settle up</button>
        </section>

        {/* ── Import a card statement ── */}
        <section className="card import-card">
          <div className="card-head"><h2>Importera kontoutdrag <span className="card-en">· Import a statement</span></h2></div>
          {!importCfg ? (
            <div className={'dropzone' + (isDragging ? ' is-drag' : '')}
              onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={e => { e.preventDefault(); setIsDragging(false); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]) }}
              onClick={() => fileInputRef.current?.click()}>
              <input ref={fileInputRef} type="file" accept=".csv,text/csv,text/plain" hidden onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])} />
              <div className="dropzone-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M5 20h14" /></svg>
              </div>
              <p className="dropzone-lead">Drop a card-statement <strong>.csv</strong> here, or <span className="link-btn">browse</span>.</p>
              <p className="dropzone-hint">Swedish or English headers · comma or semicolon · we map the columns for you.</p>
            </div>
          ) : (
            <div className="import-config">
              <div className="import-filebar">
                <span className="file-pill">{importCfg.file.name} · {importCfg.parsed.rows.length} rows · “{importCfg.parsed.delimiter === '\t' ? 'tab' : importCfg.parsed.delimiter}” delimited</span>
                <button type="button" className="link-btn" onClick={cancelImport}>Choose a different file</button>
              </div>
              <div className="config-grid">
                {([['date_purchased', 'Date column'], ['description', 'Description column'], ['enter_amount', 'Amount column']] as const).map(([k, lbl]) => (
                  <div key={k} className="config-field">
                    <label>{lbl}</label>
                    <select className="select" value={importCfg.mapping[k] ?? ''} onChange={e => reDerive({ mapping: { ...importCfg.mapping, [k]: e.target.value !== '' ? Number(e.target.value) : null } })}>
                      <option value="">— none —</option>
                      {importCfg.parsed.headers.map((h, i) => <option key={i} value={i}>{h || 'Column ' + (i + 1)}</option>)}
                    </select>
                  </div>
                ))}
              </div>
              <div className="config-grid">
                <div className="config-field">
                  <label>Whose card is this?</label>
                  <Segmented value={importCfg.frontedBy} onChange={v => reDerive({ frontedBy: v })} options={[{ v: 'a' as Person, label: aName }, { v: 'b' as Person, label: bName }]} />
                  <p className="config-note">{nameOf(otherPerson(importCfg.frontedBy))} owes their share of the split / “owes all” rows.</p>
                </div>
                <div className="config-field">
                  <label>Default treatment per row</label>
                  <Segmented value={defaultClass} onChange={v => { setDefaultClass(v); setAllClass(v) }} options={[{ v: 'split' as Treatment, label: 'Split 50/50' }, { v: 'full' as Treatment, label: 'Owes all' }, { v: 'exclude' as Treatment, label: 'Exclude' }]} />
                  <p className="config-note">Set per row below, or change them all at once.</p>
                </div>
              </div>
              <div className="triage-bar">
                <span className="triage-summary">{triageSummary}</span>
                <span className="triage-hint">Tip: change “Default treatment” to set every row at once.</span>
              </div>
              <div className="table-wrap triage-wrap">
                <table className="data-table triage-table">
                  <thead><tr><th className="col-treat">Treatment</th><th className="col-date">Date</th><th>Description</th><th className="num">Amount</th></tr></thead>
                  <tbody>
                    {importCfg.triage.map((t, i) => {
                      const row = importCfg.parsed.rows[i]
                      const isAmt = t.kind === 'charge' || t.kind === 'refund'
                      const rowClass = !isAmt ? 'is-excluded' : t.duplicate ? 'is-dup' : t.classification === 'exclude' ? 'is-excluded' : ''
                      return (
                        <tr key={i} className={rowClass}>
                          <td className="col-treat">
                            {isAmt ? (
                              <Segmented small value={t.classification} onChange={v => setImportCfg(cfg => cfg ? { ...cfg, triage: cfg.triage.map((r, j) => j === i ? { ...r, classification: v } : r) } : cfg)}
                                options={[{ v: 'split' as Treatment, label: 'Split' }, { v: 'full' as Treatment, label: 'All' }, { v: 'exclude' as Treatment, label: 'Skip' }]} />
                            ) : <span className="treat-na">no amount</span>}
                          </td>
                          <td className="col-date">{cellAt(row, importCfg.mapping.date_purchased)}</td>
                          <td>
                            {cellAt(row, importCfg.mapping.description)}
                            {t.kind === 'refund' && <span className="row-flag row-flag-refund">refund</span>}
                            {isAmt && t.duplicate && <span className="row-flag">possible duplicate</span>}
                          </td>
                          <td className={'num' + (t.kind === 'refund' ? ' is-neg' : '')}>{isAmt ? fmtMoney(t.charge) : '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="import-actions">
                <button type="button" className="btn btn-ghost" onClick={cancelImport}>Cancel</button>
                <button type="button" className="btn btn-primary" disabled={addCount === 0 || importCfg.mapping.enter_amount == null} onClick={confirmImport}>{addCount ? 'Add ' + addCount + ' item' + (addCount === 1 ? '' : 's') : 'Nothing to add'}</button>
              </div>
            </div>
          )}
        </section>

        {/* ── Items ── */}
        <section className="card">
          <div className="card-head">
            <h2>Poster <span className="card-en">· Items</span></h2>
            <span className="count-pill">{filteredItems.length}</span>
            <div className="card-actions">
              <div className="segmented" role="radiogroup" aria-label="Filter items">
                {([['open', 'Open'], ['all', 'All'], ['a', aName], ['b', bName]] as const).map(([f, lbl]) => (
                  <button key={f} type="button" role="radio" aria-checked={currentFilter === f} className={'seg' + (currentFilter === f ? ' is-active' : '')} onClick={() => setCurrentFilter(f)}>{lbl}</button>
                ))}
              </div>
              <button type="button" className="btn btn-ghost" onClick={() => setItemDlg({ open: true, id: null })}>+ Add item</button>
              <button type="button" className="btn btn-ghost btn-danger" onClick={clearOpen}>Delete all open</button>
            </div>
          </div>
          {!filteredItems.length ? (
            <p className="empty">{items.length ? 'No items match this filter.' : 'No items yet. Import a statement above, or add one manually.'}</p>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th className="col-date">Date</th><th>Item</th><th>Paid by</th><th>Owes</th><th>Type</th><th className="num">Charge</th><th className="num">Owed</th><th>Status</th><th className="col-act"></th></tr></thead>
                <tbody>
                  {filteredItems.map(it => (
                    <tr key={it.id} className={it.paid ? 'is-settled' : ''}>
                      <td className="col-date">{it.date_purchased}</td>
                      <td>{it.description}{it.note && <span className="row-note"> {it.note}</span>}</td>
                      <td>{nameOf(it.fronted_by)}</td>
                      <td>{nameOf(it.owed_by)}</td>
                      <td className="col-type">
                        {it.paid ? (it.split ? 'Split' : 'All') : (
                          <Segmented small value={it.split ? 'split' : 'full'} onChange={v => toggleType(it, v === 'split')} options={[{ v: 'split' as const, label: 'Split' }, { v: 'full' as const, label: 'All' }]} />
                        )}
                      </td>
                      <td className="num">{fmtMoney(it.enter_amount)}</td>
                      <td className="num">{fmtMoney(it.amount)}</td>
                      <td>{it.paid ? <span className="tag tag-settled">Settled</span> : <span className="tag tag-open">Open</span>}</td>
                      <td className="col-act">
                        {it.paid
                          ? <span className="row-lock" title="Settled — reopen its settlement to edit">🔒</span>
                          : <>
                              <button type="button" className="icon-btn" title="Edit" onClick={() => setItemDlg({ open: true, id: it.id })}>✎</button>
                              <button type="button" className="icon-btn" data-del title="Delete" onClick={() => deleteItem(it.id)}>✕</button>
                            </>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── Insights ── */}
        <section className="card">
          <div className="card-head">
            <h2>Insikter <span className="card-en">· Insights</span></h2>
            <div className="card-actions">
              <Segmented value={insightsPeriod} onChange={setInsightsPeriod} ariaLabel="Insights period"
                options={[{ v: 'month' as const, label: 'This month' }, { v: '3m' as const, label: '3 mo' }, { v: 'all' as const, label: 'All' }]} />
            </div>
          </div>
          {!periodItems.length ? (
            <p className="empty">{items.length ? 'No spending in this period.' : 'No spending to analyse yet. Import a statement to see where the money goes.'}</p>
          ) : (
            <>
              {groc && groc.total > 0 && (
                <div className="insight-highlight">
                  <span className="ih-icon" aria-hidden="true">🛒</span>
                  <div className="ih-main">
                    <span className="ih-label">Groceries</span>
                    <span className="ih-amount">{fmtMoney(groc.total)}</span>
                    <span className="ih-sub">{grocPct}% of shared spending · {groc.count} purchase{groc.count === 1 ? '' : 's'}</span>
                  </div>
                </div>
              )}
              <h3 className="insight-h">Spending by category</h3>
              <div className="bars">
                {cats.map(c => {
                  const max = cats.length ? cats[0].total : 0
                  const pct = max > 0 ? Math.max(2, Math.round(c.total / max * 100)) : 0
                  return (
                    <div key={c.key} className={'bar-row' + (c.key === 'groceries' ? ' is-groceries' : '')}>
                      <span className="bar-label">{c.label}</span>
                      <span className="bar-track"><span className="bar-fill" style={{ width: pct + '%' }} /></span>
                      <span className="bar-val num">{fmtMoney(c.total)}</span>
                    </div>
                  )
                })}
              </div>
              {byMonth.length > 1 && (() => {
                const maxM = byMonth.reduce((m, x) => Math.max(m, x.total), 0)
                return (
                  <>
                    <h3 className="insight-h">Groceries by month</h3>
                    <div className="bars">
                      {byMonth.map(r => {
                        const pct = maxM > 0 ? Math.max(2, Math.round(r.total / maxM * 100)) : 0
                        return (
                          <div key={r.month} className="bar-row is-groceries">
                            <span className="bar-label">{r.label}</span>
                            <span className="bar-track"><span className="bar-fill" style={{ width: pct + '%' }} /></span>
                            <span className="bar-val num">{fmtMoney(r.total)}</span>
                          </div>
                        )
                      })}
                    </div>
                  </>
                )
              })()}
            </>
          )}
        </section>

        {/* ── Settlement history ── */}
        <section className="card">
          <div className="card-head">
            <h2>Tidigare avslut <span className="card-en">· History</span></h2>
            <span className="count-pill">{payments.length}</span>
          </div>
          {!payments.length ? (
            <p className="empty">No settlements yet. Settle the open items above to close a month.</p>
          ) : (
            payments.map(p => {
              const linked = itemsByPayment[p.id] || []
              const when = (p.created_at || '').slice(0, 10)
              return (
                <details key={p.id} className="history-item">
                  <summary>
                    <span className="history-period">{p.period_label || when}</span>
                    <span className="history-transfer">{p.from_person && p.amount > 0 ? <>{nameOf(p.from_person)} → {nameOf(p.to_person)} · <strong>{fmtMoney(p.amount)}</strong></> : 'Even — no transfer'}</span>
                    <span className="history-meta">{linked.length} item{linked.length === 1 ? '' : 's'}</span>
                  </summary>
                  <ul className="history-list">
                    {linked.map(it => (
                      <li key={it.id}><span className="hl-date">{it.date_purchased || when}</span><span className="hl-desc">{it.description}</span><span className="hl-amt num">{fmtMoney(it.amount)}</span></li>
                    ))}
                  </ul>
                  {p.note && <p className="history-note">{p.note}</p>}
                  <div className="history-actions"><button type="button" className="link-btn" onClick={() => reopen(p.id)}>Reopen settlement</button></div>
                </details>
              )
            })
          )}
        </section>

      </main>

      <ItemDialog open={itemDlg.open} id={itemDlg.id} items={items} settings={settings} defaultClass={defaultClass} onSave={handleSaveItem} onClose={() => setItemDlg({ open: false, id: null })} />
      <SettleDialog open={settleDlg} openItems={open} settings={settings} onConfirm={confirmSettle} onClose={() => setSettleDlg(false)} />
      <SettingsDialog open={settingsDlg} settings={settings} onSave={handleSaveSettings} onClose={() => setSettingsDlg(false)} onExport={handleExport} onImport={handleImport} />

      <div className={'ma-toast' + (toast.show ? ' show' : '')} role="status" aria-live="polite">{toast.msg}</div>
    </div>
  )
}
