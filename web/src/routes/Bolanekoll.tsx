import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ChevronRight, Copy, EllipsisVertical, Flag, Pencil, Settings2, X } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import EquityStackChart, { type EquityPoint } from '../components/charts/EquityStackChart'
import Collapse from '../components/Collapse'
import FileDropzone from '../components/FileDropzone'
import Icon from '../components/Icon'
import PageHeader from '../components/PageHeader'
import ThemeToggle from '../components/ThemeToggle'
import Segmented from '../components/Segmented'
import { usePersonNames } from '../components/usePersonNames'
import { useSaveFlash } from '../components/useSaveFlash'
import { useToast } from '../components/useToast'
import { useToolPageActive } from '../lib/toolTransition'
import {
  defaultSettings, parseCsv, parseAmount, autoMapColumns, classifyKind,
  makePayment, flagDuplicates, assignPaymentsToPart,
  partBalance, totalBalance, totalAmortized, totalInterest, ranteavdrag,
  propertyValue, equity, loanToValue, otherOwner,
  purchasePrice, costBasisEquity, costBasisOwnedPct, costBasisSplit, derivedDeposit, insatsPayments,
  effectiveRatePeriod, bindingStatus, groupLoanParts, weightedAvgRate, amorteringskravStatus,
  equityTimeline, equityBridge, projectMilestones, monthlyAmortizationRate, monthlyCost,
  paymentsToCsv, headerSignature, mappingToNames, applyPreset, reconcileBalance,
  contributionSplit, settlement, todayISO,
} from '../lib/mortgage'
import type { LoanPart, LoanPartGroup, RatePeriod, Payment, Valuation, Contribution, MortgageSettings, CsvResult, ColMapping, Owner, PaidBy } from '../lib/mortgage'
import * as Store from '../lib/mortgage-store'
import PartDialog from './bolanekoll/PartDialog'
import ValuationDialog from './bolanekoll/ValuationDialog'
import PaymentDialog from './bolanekoll/PaymentDialog'
import CopyToPartsDialog from './bolanekoll/CopyToPartsDialog'
import InsatsSplitDialog from './bolanekoll/InsatsSplitDialog'
import ContribDialog from './bolanekoll/ContribDialog'
import SettingsDialog from './bolanekoll/SettingsDialog'
import { CellReveal, kindLabel, PAY_PAGE, periodFrom, monthsToWhen, fmtMoney, fmtPct, M, P, currencyState, type TriageRow, type ImportCfg } from './bolanekoll/shared'

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

  currencyState.current = settings.currency || 'SEK'

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

  const { nameOf } = usePersonNames(settings.owner_a_name, settings.owner_b_name)

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
      <button type="button" className="icon-btn" title="Edit" aria-label="Edit" onClick={() => setPartDlg({ open: true, id: p.id })}><Icon icon={Pencil} /></button>
      <button type="button" className="icon-btn" data-del-part title="Delete" aria-label="Delete" onClick={() => { if (confirm('Delete this loan part and all its payments? This can’t be undone.')) handleDeletePart(p.id) }}><Icon icon={X} /></button>
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
          <button className="btn btn-ghost theme-toggle-btn" onClick={() => setSettingsDlg(true)} title="Settings" aria-label="Settings"><Icon icon={Settings2} size={18} /></button>
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
                {lastCost && <div className="metric-chip"><span className="metric-label">{settings.ranteavdrag ? 'Latest mo · net' : 'Latest mo'}</span><span className="metric-val">{M(lastCost.net)}</span></div>}
                {blended > 0 && <div className="metric-chip is-accent"><span className="metric-label">Blended rate</span><span className="metric-val">{P(blended)}</span></div>}
                {krav.has_value && <div className="metric-chip"><span className="metric-label">Amort.krav (est.)</span><span className="metric-val">{krav.exempt ? 'None · LTV ≤ 50 %' : krav.required_pct + ' % · ' + fmtMoney(krav.required_annual) + '/år'}</span></div>}
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
            <FileDropzone isDragging={isDragging} onDragChange={setIsDragging} inputRef={fileInputRef}
              onFiles={handleFiles} accept=".csv,text/csv,text/plain" multiple>
              <p className="dropzone-lead">Drop one or more mortgage <strong>.csv</strong> files here, or <span className="link-btn">browse</span>.</p>
              <p className="dropzone-hint">One file per loan part · we map the columns and step through them one at a time.</p>
            </FileDropzone>
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
                              ><Icon icon={ChevronRight} size={12} /></motion.span>
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
                    ><Icon icon={ChevronRight} size={12} /></motion.span> Avslutade <span className="count-pill">{archivedParts.length}</span>
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
                          <button type="button" className="icon-btn" title="Edit" aria-label="Edit" onClick={() => setValDlg({ open: true, id: v.id })}><Icon icon={Pencil} /></button>
                          <button type="button" className="icon-btn" data-del-val title="Delete" aria-label="Delete" onClick={() => { if (confirm('Delete this valuation?')) handleDeleteVal(v.id) }}><Icon icon={X} /></button>
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
              <DropdownMenu.Root>
                <DropdownMenu.Trigger className="icon-btn" aria-label="More payment actions" title="More actions">
                  <Icon icon={EllipsisVertical} size={16} />
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content className="kebab-menu" align="end" sideOffset={6}>
                    <DropdownMenu.Item className="kebab-item kebab-danger" disabled={!filteredPayments.length} onSelect={clearPayments}>
                      {paymentFilter === 'all' ? 'Delete all' : 'Delete ' + partNameById(paymentFilter)}
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
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
                              ><Icon icon={ChevronRight} size={12} /></motion.button>
                            )}
                            {p.date || '—'}
                          </td>
                          <td>{partNameById(p.loan_part_id)}</td>
                          <td><span className={'kind-tag kind-' + (p.kind || 'other')}>{kindLabel(p.kind)}</span>{p.is_insats && <span className="row-flag row-flag-insats">insats</span>}</td>
                          <td className="num">{fmtMoney(p.amount)}</td>
                          <td className="num">{p.balance_after != null ? fmtMoney(p.balance_after) : '—'}</td>
                          <td className="col-act">
                            <button type="button" className={'icon-btn' + (p.is_insats ? ' is-on' : '')} title={settings.track_contributions ? (p.is_insats ? 'Edit insats split' : 'Flag as insats & split') : (p.is_insats ? 'Unflag insats' : 'Flag as insats')} aria-label={p.is_insats ? 'Unflag insats' : 'Flag as insats'} onClick={() => handleStarClick(p)}><Flag size={16} strokeWidth={1.75} fill={p.is_insats ? 'currentColor' : 'none'} aria-hidden /></button>
                            <button type="button" className="icon-btn" title="Edit" aria-label="Edit" onClick={() => setPayDlg({ open: true, id: p.id })}><Icon icon={Pencil} /></button>
                            {parts.length > 1 && (
                              <button type="button" className="icon-btn" title="Copy to parts" aria-label="Copy to parts" onClick={() => setCopyDlg({ open: true, source: p })}><Icon icon={Copy} /></button>
                            )}
                            <button type="button" className="icon-btn" data-del-pay title="Delete" aria-label="Delete" onClick={() => { if (confirm('Delete this payment?')) handleDeletePay(p.id) }}><Icon icon={X} /></button>
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
                          <button type="button" className="icon-btn" title="Edit" aria-label="Edit" onClick={() => setContDlg({ open: true, id: c.id })}><Icon icon={Pencil} /></button>
                          <button type="button" className="icon-btn" title="Delete" aria-label="Delete" onClick={() => { if (confirm('Delete this contribution?')) handleDeleteCont(c.id) }}><Icon icon={X} /></button>
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
