import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ChevronRight, EllipsisVertical, Pencil, Settings2, X } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useToolPageActive } from '../lib/toolTransition'
import {
  defaultSettings, otherPerson, parseCsv, autoMapColumns,
  computeOwed, personalSums, classifyToItemFields, makeItem, netBalance,
  monthKey,
  spendByCategory, grocerySpendByMonth, fillMonthGaps,
} from '../lib/manadsavslut'
import type { Item, Payment, MonthEndSettings, Person, Treatment, ColMapping } from '../lib/manadsavslut'
import * as Store from '../lib/manadsavslut-store'
import { todayISO } from '../lib/date'
import Segmented from '../components/Segmented'
import Collapse from '../components/Collapse'
import FileDropzone from '../components/FileDropzone'
import GroceryTrendChart from '../components/charts/GroceryTrendChart'
import Icon from '../components/Icon'
import PageHeader from '../components/PageHeader'
import ThemeToggle from '../components/ThemeToggle'
import { usePersonNames } from '../components/usePersonNames'
import { useSaveFlash } from '../components/useSaveFlash'
import { useToast } from '../components/useToast'
import ItemDialog from './manadsavslut/ItemDialog'
import SettleDialog from './manadsavslut/SettleDialog'
import SettingsDialog from './manadsavslut/SettingsDialog'
import { fmtMoney, M, clean, cellAt, deriveTriage, currencyState, type TriageRow, type ImportCfg } from './manadsavslut/shared'

// ── Main component ─────────────────────────────────────────────────────────

export default function Manadsavslut() {
  const active = useToolPageActive('/manadsavslut')
  const reduceMotion = useReducedMotion()
  useLayoutEffect(() => { document.documentElement.classList.remove('calc-layout') }, [])

  const [items, setItems] = useState<Item[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [settings, setSettings] = useState<MonthEndSettings>(defaultSettings())

  const { toast, showToast } = useToast()
  const { saveVisible: saved, flashSaved } = useSaveFlash()

  const [defaultClass, setDefaultClass] = useState<Treatment>('split')
  const [currentFilter, setCurrentFilter] = useState<'open' | 'pending' | 'all' | 'a' | 'b'>('open')
  const [insightsPeriod, setInsightsPeriod] = useState<'month' | '3m' | 'all'>('all')
  const [openSettlements, setOpenSettlements] = useState<Set<string>>(new Set())
  const [openCarveouts, setOpenCarveouts] = useState<Set<string>>(new Set())
  function toggleSettlement(id: string) {
    setOpenSettlements(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })
  }
  function toggleCarveout(id: string) {
    setOpenCarveouts(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })
  }

  const [isDragging, setIsDragging] = useState(false)
  const [importCfg, setImportCfg] = useState<ImportCfg | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [itemDlg, setItemDlg] = useState<{ open: boolean; id: string | null }>({ open: false, id: null })
  const [settleDlg, setSettleDlg] = useState(false)
  const [settingsDlg, setSettingsDlg] = useState(false)

  currencyState.current = settings.currency || 'SEK'
  const { a: aName, b: bName, nameOf } = usePersonNames(settings.person_a_name, settings.person_b_name)


  const refresh = useCallback(async () => {
    const [its, pays, sett] = await Promise.all([Store.listItems(), Store.listPayments(), Store.getSettings()])
    setItems(its); setPayments(pays); setSettings(sett); setDefaultClass(sett.default_split ? 'split' : 'full')
  }, [])
  useEffect(() => { refresh() }, [refresh])
  useEffect(() => { document.title = 'Månadsavslut — Hemma·OS' }, [])

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
    let add = 0, excl = 0, refundIncl = 0, invalid = 0, dup = 0, pend = 0
    importCfg.triage.forEach(t => {
      if (t.kind === 'noamount') { invalid++; return }
      if (t.classification === 'exclude') { excl++; return }
      add++; if (t.classification === 'pending') pend++; if (t.kind === 'refund') refundIncl++; if (t.duplicate) dup++
    })
    const parts = [add + ' item' + (add === 1 ? '' : 's') + ' to add']
    if (refundIncl) parts.push(refundIncl + ' refund' + (refundIncl === 1 ? '' : 's') + ' included')
    if (pend) parts.push(pend + ' to ask later')
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
        enter_amount: t.charge, split: fields.split, pending: fields.pending, fronted_by: importCfg.frontedBy, owed_by: fields.owed_by, source: 'import:' + importCfg.file.name,
      }))
    })
    if (!drafts.length) { showToast('Nothing selected to add.'); return }
    try {
      const savedRows = await Store.addItems(drafts)
      cancelImport(); await refresh(); flashSaved()
      showToast('Added ' + savedRows.length + ' item' + (savedRows.length === 1 ? '' : 's') + '.')
    } catch (err) { saveErr(err) }
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  // "Ask later" items have no agreed split yet, so they're excluded from the
  // balance and the settle scope, and only surfaced as an "awaiting a decision" count.
  const open = useMemo(() => items.filter(it => !it.paid && !it.pending), [items])
  const pendingCount = useMemo(() => items.filter(it => !it.paid && it.pending).length, [items])
  const bal = useMemo(() => netBalance(open), [open])

  const filteredItems = useMemo(() => items.filter(it => {
    if (currentFilter === 'open') return !it.paid
    if (currentFilter === 'pending') return !it.paid && it.pending
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
  // A failed cloud write now throws (the pre-Supabase store never did); report it
  // via a toast instead of leaving an unhandled rejection + a half-updated UI.
  function saveErr(err: unknown) {
    showToast(err instanceof Error && err.message ? 'Couldn’t save — ' + err.message : 'Couldn’t save — you may be offline.')
  }
  async function handleSaveItem(rec: Omit<Item, 'id' | 'created_at'>) {
    try {
      if (itemDlg.id) await Store.updateItem(itemDlg.id, { date_purchased: rec.date_purchased, description: rec.description, enter_amount: rec.enter_amount, split: rec.split, amount: rec.amount, fronted_by: rec.fronted_by, owed_by: rec.owed_by, note: rec.note, personal_items: rec.personal_items, personal_a: rec.personal_a, personal_b: rec.personal_b })
      else await Store.addItem(rec)
      await refresh(); flashSaved(); setItemDlg({ open: false, id: null }); showToast(itemDlg.id ? 'Item updated.' : 'Item added.')
    } catch (err) { saveErr(err) }
  }
  async function deleteItem(id: string) { if (!confirm('Delete this item?')) return; try { await Store.removeItem(id); await refresh(); flashSaved(); showToast('Item deleted.') } catch (err) { saveErr(err) } }
  // Picking a side both sets the type AND resolves any pending flag in one write.
  async function toggleType(it: Item, split: boolean) { try { await Store.updateItem(it.id, { split, amount: computeOwed(it.enter_amount, split, it.fronted_by, it.personal_a, it.personal_b), pending: false }); await refresh(); flashSaved() } catch (err) { saveErr(err) } }
  // Park a decided item as "ask later" (the existing-item flag path).
  async function flagPending(it: Item) { try { await Store.updateItem(it.id, { pending: true }); await refresh(); flashSaved() } catch (err) { saveErr(err) } }
  async function clearOpen() {
    const openItems = items.filter(it => !it.paid)
    const openIds = openItems.map(it => it.id)
    if (!openIds.length) { showToast('No open items to delete.'); return }
    const pend = openItems.filter(it => it.pending).length
    const pendNote = pend ? ' (including ' + pend + ' “ask later” item' + (pend === 1 ? '' : 's') + ')' : ''
    if (!confirm('Delete all ' + openIds.length + ' open item' + (openIds.length === 1 ? '' : 's') + pendNote + '? Settled items are kept. This can’t be undone.')) return
    try { const n = await Store.removeItems(openIds); await refresh(); flashSaved(); showToast('Deleted ' + n + ' open item' + (n === 1 ? '' : 's') + '.') } catch (err) { saveErr(err) }
  }
  async function confirmSettle(draft: Omit<Payment, 'id' | 'created_at'>) {
    try {
      const p = await Store.settle(draft); setSettleDlg(false); await refresh(); flashSaved()
      showToast(p.amount > 0 ? 'Settled — ' + fmtMoney(p.amount) + ' closed.' : 'Items closed.')
    } catch (err) { saveErr(err) }
  }
  async function reopen(id: string) { if (!confirm('Reopen this settlement? Its items become open again.')) return; try { await Store.removePayment(id); await refresh(); flashSaved(); showToast('Settlement reopened.') } catch (err) { saveErr(err) } }
  async function handleSaveSettings(patch: Partial<MonthEndSettings>) { try { await Store.saveSettings(patch); await refresh(); flashSaved(); setSettingsDlg(false); showToast('Settings saved.') } catch (err) { saveErr(err) } }

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
  const pendingNote = pendingCount ? ' · ' + pendingCount + ' awaiting a decision' : ''
  // balValue null → render an em-dash; a number → an animated figure.
  let balLabel: string, balValue: number | null, balSub: string
  if (!open.length && pendingCount) { balLabel = 'Nothing to settle yet'; balValue = null; balSub = pendingCount + ' awaiting a decision' }
  else if (!open.length) { balLabel = 'All settled'; balValue = null; balSub = 'Nothing outstanding.' }
  else if (!bal.from || bal.amount <= 0) { balLabel = 'Even'; balValue = 0; balSub = open.length + ' open item' + (open.length === 1 ? '' : 's') + ' · they cancel out' + pendingNote }
  else { balLabel = nameOf(bal.from) + ' owes ' + nameOf(bal.to); balValue = bal.amount; balSub = 'across ' + open.length + ' open item' + (open.length === 1 ? '' : 's') + pendingNote }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={'ma-root' + (active ? ' vt-page' : '')}>
      <PageHeader
        backTo="/manadsavslut"
        title="Månadsavslut"
        tagline="Reconcile shared spending and settle up — the month-end close"
        saveVisible={saved}
        actions={<>
          <button className="btn btn-ghost theme-toggle-btn" onClick={() => setSettingsDlg(true)} title="Settings" aria-label="Settings"><Icon icon={Settings2} size={18} /></button>
          <ThemeToggle />
        </>}
      />

      <main className="wrap">

        {/* ── Outstanding balance + settle ── */}
        {items.length > 0 && (
        <section className="card balance-card">
          <div className="balance-main">
            <p className="balance-label">{balLabel}</p>
            <p className="balance-amount">{balValue == null ? '—' : M(balValue)}</p>
            <p className="balance-sub">{balSub}</p>
          </div>
          <button type="button" className="btn btn-primary balance-settle" disabled={!open.length} onClick={() => setSettleDlg(true)}>Settle up</button>
        </section>
        )}

        {/* ── Import a card statement ── */}
        <section className="card import-card">
          <div className="card-head"><h2>Importera kontoutdrag <span className="card-en">· Import a statement</span></h2></div>
          {!importCfg ? (
            <>
            <FileDropzone isDragging={isDragging} onDragChange={setIsDragging} inputRef={fileInputRef}
              onFiles={files => { if (files[0]) handleFile(files[0]) }} accept=".csv,text/csv,text/plain">
              <p className="dropzone-lead">Drop a card-statement <strong>.csv</strong> here, or <span className="link-btn">browse</span>.</p>
              <p className="dropzone-hint">Swedish or English headers · comma or semicolon · we map the columns for you.</p>
            </FileDropzone>
            {!items.length && (
              <div className="import-secondary">
                <span className="import-or">or</span>
                <button type="button" className="btn btn-ghost" onClick={() => setItemDlg({ open: true, id: null })}>+ Add item manually</button>
              </div>
            )}
            </>
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
                  <Segmented responsive value={defaultClass} onChange={v => { setDefaultClass(v); setAllClass(v) }} options={[{ v: 'split' as Treatment, label: 'Split 50/50' }, { v: 'full' as Treatment, label: 'Owes all' }, { v: 'pending' as Treatment, label: 'Ask later' }, { v: 'exclude' as Treatment, label: 'Exclude' }]} />
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
                      const rowClass = !isAmt ? 'is-excluded' : t.duplicate ? 'is-dup' : t.classification === 'exclude' ? 'is-excluded' : t.classification === 'pending' ? 'is-pending' : ''
                      return (
                        <tr key={i} className={rowClass}>
                          <td className="col-treat">
                            {isAmt ? (
                              <Segmented small responsive value={t.classification} onChange={v => setImportCfg(cfg => cfg ? { ...cfg, triage: cfg.triage.map((r, j) => j === i ? { ...r, classification: v } : r) } : cfg)}
                                options={[{ v: 'split' as Treatment, label: 'Split' }, { v: 'full' as Treatment, label: 'All' }, { v: 'pending' as Treatment, label: 'Ask later' }, { v: 'exclude' as Treatment, label: 'Skip' }]} />
                            ) : <span className="treat-na">no amount</span>}
                          </td>
                          <td className="col-date">{cellAt(row, importCfg.mapping.date_purchased)}</td>
                          <td>
                            {cellAt(row, importCfg.mapping.description)}
                            {t.kind === 'refund' && <span className="row-flag row-flag-refund">refund</span>}
                            {isAmt && t.classification === 'pending' && <span className="row-flag row-flag-pending">ask later</span>}
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

        {items.length > 0 && (<>
        {/* ── Items ── */}
        <section className="card">
          <div className="card-head">
            <h2>Poster <span className="card-en">· Items</span></h2>
            <span className="count-pill">{filteredItems.length}</span>
            <div className="card-actions">
              <Segmented value={currentFilter} onChange={setCurrentFilter} ariaLabel="Filter items"
                options={[{ v: 'open' as const, label: 'Open' }, { v: 'pending' as const, label: 'Ask later' }, { v: 'all' as const, label: 'All' }, { v: 'a' as const, label: aName }, { v: 'b' as const, label: bName }]} />
              <button type="button" className="btn btn-ghost" onClick={() => setItemDlg({ open: true, id: null })}>+ Add item</button>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger className="icon-btn" aria-label="More item actions" title="More actions">
                  <Icon icon={EllipsisVertical} size={16} />
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content className="kebab-menu" align="end" sideOffset={6}>
                    <DropdownMenu.Item className="kebab-item kebab-danger" disabled={!items.some(it => !it.paid)} onSelect={clearOpen}>
                      Delete all open
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
          </div>
          <motion.div key={currentFilter} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.13, ease: [0.22, 1, 0.36, 1] }}>
            {!filteredItems.length ? (
              <p className="empty">{items.length ? 'No items match this filter.' : 'No items yet. Import a statement above, or add one manually.'}</p>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th className="col-date">Date</th><th>Item</th><th>Paid by</th><th>Owes</th><th>Type</th><th className="num">Charge</th><th className="num">Owed</th><th>Status</th><th className="col-act"></th></tr></thead>
                  <tbody>
                    {filteredItems.map(it => (
                      <tr key={it.id} className={it.paid ? 'is-settled' : it.pending ? 'is-pending' : ''}>
                        <td className="col-date">{it.date_purchased}</td>
                        <td>{it.description}{it.note && <span className="row-note"> {it.note}</span>}{it.personal_items?.length > 0 && <span className="personal-flag" title="Has personal items carved out before the split">• personal</span>}</td>
                        <td>{nameOf(it.fronted_by)}</td>
                        <td>{nameOf(it.owed_by)}</td>
                        <td className="col-type">
                          {it.paid ? (it.split ? 'Split' : 'All') : (
                            // Pending → toggle shows NEITHER side active (a choice is owed); picking
                            // either resolves it. A decided open row also gets an ⏰ to re-park it.
                            <>
                              <Segmented small value={it.pending ? '' : (it.split ? 'split' : 'full')} onChange={v => toggleType(it, v === 'split')} options={[{ v: 'split' as const, label: 'Split' }, { v: 'full' as const, label: 'All' }]} />
                              {!it.pending && <button type="button" className="icon-btn ask-btn" title="Ask later" aria-label="Ask later" onClick={() => flagPending(it)}>⏰</button>}
                            </>
                          )}
                        </td>
                        <td className="num">{fmtMoney(it.enter_amount)}</td>
                        <td className="num">{fmtMoney(it.amount)}</td>
                        <td>{it.paid ? <span className="tag tag-settled">Settled</span> : it.pending ? <span className="tag tag-pending">Ask later</span> : <span className="tag tag-open">Open</span>}</td>
                        <td className="col-act">
                          {it.paid
                            ? <span className="row-lock" title="Settled — reopen its settlement to edit">🔒</span>
                            : <>
                                <button type="button" className="icon-btn" title="Edit" aria-label="Edit" onClick={() => setItemDlg({ open: true, id: it.id })}><Icon icon={Pencil} /></button>
                                <button type="button" className="icon-btn" data-del title="Delete" aria-label="Delete" onClick={() => deleteItem(it.id)}><Icon icon={X} /></button>
                              </>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </motion.div>
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
                    <span className="ih-amount">{M(groc.total)}</span>
                    <span className="ih-sub">{grocPct}% of shared spending · {groc.count} purchase{groc.count === 1 ? '' : 's'}</span>
                  </div>
                </div>
              )}
              <h3 className="insight-h">Spending by category</h3>
              <div className="bars">
                {cats.map((c, i) => {
                  const max = cats.length ? cats[0].total : 0
                  const pct = max > 0 ? Math.max(2, Math.round(c.total / max * 100)) : 0
                  // Colour by rank from the shared data-viz ramp — largest is the
                  // strongest green, stepping down the staircase; never plain grey
                  // for real data (plan 63). cats is already sorted largest-first.
                  const barColor = 'var(--cat-' + (Math.min(i, 7) + 1) + ')'
                  return (
                    <div key={c.key} className="bar-row">
                      <span className="bar-label">{c.label}</span>
                      <span className="bar-track"><span className="bar-fill" style={{ width: pct + '%', background: barColor }} /></span>
                      <span className="bar-val num">{M(c.total)}</span>
                    </div>
                  )
                })}
              </div>
              {byMonth.length > 1 && (
                <>
                  <h3 className="insight-h">Groceries by month</h3>
                  <GroceryTrendChart data={byMonth} formatMoney={fmtMoney} />
                </>
              )}
            </>
          )}
        </section>
        </>)}

        {/* ── Settlement history ── */}
        <section className="card">
          <div className="card-head">
            <h2>Tidigare avslut <span className="card-en">· History</span></h2>
            <span className="count-pill">{payments.length}</span>
          </div>
          {!payments.length && <p className="empty">No settlements yet. Once you settle a month’s shared spending, it’s archived here.</p>}
          {/* Settling and reopening add/remove whole entries — animate the row
              in/out so the section doesn't jump when the list changes. */}
          <AnimatePresence initial={false}>
            {payments.map(p => {
              const linked = itemsByPayment[p.id] || []
              const when = (p.created_at || '').slice(0, 10)
              const gross = linked.reduce((s, it) => s + (it.enter_amount ?? 0), 0)
              const isOpen = openSettlements.has(p.id)
              return (
                <motion.div
                  key={p.id}
                  className="history-anim"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={reduceMotion ? { duration: 0 } : { duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                >
                <div className={'history-item' + (isOpen ? ' is-open' : '')}>
                  <button type="button" className="history-summary" aria-expanded={isOpen} onClick={() => toggleSettlement(p.id)}>
                    <span className="history-period">{when && p.period_label ? <>{when} · {p.period_label}</> : p.period_label || when}</span>
                    <span className="history-transfer">{p.from_person && p.amount > 0 ? <>{nameOf(p.from_person)} → {nameOf(p.to_person)} · <strong>{fmtMoney(p.amount)}</strong></> : 'Even — no transfer'}</span>
                    <span className="history-meta">{linked.length} item{linked.length === 1 ? '' : 's'} · {fmtMoney(gross)}</span>
                  </button>
                  <Collapse open={isOpen}>
                  <ul className="history-list">
                    {linked.map(it => {
                      const entries = it.personal_items || []
                      const psums = personalSums(entries)
                      const rowInner = (
                        <>
                          <span className="hl-date">{it.date_purchased || when}</span>
                          <span className="hl-desc">{it.description}</span>
                          <span className="hl-payer">{nameOf(it.fronted_by)} paid {fmtMoney(it.enter_amount)}</span>
                          {entries.length > 0 && (
                            <span className="hl-personal">(personal: {psums.a > 0 && (nameOf('a') + ' ' + fmtMoney(psums.a))}{psums.a > 0 && psums.b > 0 ? ' · ' : ''}{psums.b > 0 && (nameOf('b') + ' ' + fmtMoney(psums.b))})</span>
                          )}
                          <span className="hl-arrow">→</span>
                          <span className="hl-amt num">{nameOf(it.owed_by)} owes {fmtMoney(it.amount)}</span>
                          <span className="hl-type">{it.split ? 'Split' : 'All'}</span>
                        </>
                      )
                      const isCarveOpen = openCarveouts.has(it.id)
                      return entries.length > 0 ? (
                        // Has a carve-out: collapse to the overview row; click to reveal each entry.
                        <li key={it.id} className={'hl-has-personal' + (isCarveOpen ? ' is-open' : '')}>
                          <button type="button" className="hl-row hl-toggle" aria-expanded={isCarveOpen} onClick={() => toggleCarveout(it.id)}>
                            {rowInner}
                            <motion.span
                              className="hl-expand"
                              aria-hidden
                              animate={{ rotate: isCarveOpen ? 90 : 0 }}
                              transition={{ duration: reduceMotion ? 0 : 0.15 }}
                            ><Icon icon={ChevronRight} size={12} /></motion.span>
                          </button>
                          <Collapse open={isCarveOpen}>
                            <ul className="hl-sub">
                              {entries.map((e, i) => (
                                <li key={i}>
                                  <span className="pe-person">{nameOf(e.person)}</span>
                                  <span className="pe-amount num">{fmtMoney(e.amount)}</span>
                                  {e.note && <span className="pe-note">{e.note}</span>}
                                </li>
                              ))}
                            </ul>
                          </Collapse>
                        </li>
                      ) : (
                        <li key={it.id} className="hl-row">{rowInner}</li>
                      )
                    })}
                  </ul>
                  {p.note && <p className="history-note">{p.note}</p>}
                  <div className="history-actions"><button type="button" className="link-btn" onClick={() => reopen(p.id)}>Reopen settlement</button></div>
                  </Collapse>
                </div>
                </motion.div>
              )
            })}
          </AnimatePresence>
        </section>

      </main>

      <ItemDialog open={itemDlg.open} id={itemDlg.id} items={items} settings={settings} defaultClass={defaultClass} onSave={handleSaveItem} onClose={() => setItemDlg({ open: false, id: null })} />
      <SettleDialog open={settleDlg} openItems={open} pendingCount={pendingCount} settings={settings} onConfirm={confirmSettle} onClose={() => setSettleDlg(false)} />
      <SettingsDialog open={settingsDlg} settings={settings} onSave={handleSaveSettings} onClose={() => setSettingsDlg(false)} onExport={handleExport} onImport={handleImport} />

      <div className={'ma-toast' + (toast.show ? ' show' : '')} role="status" aria-live="polite">{toast.msg}</div>
    </div>
  )
}
