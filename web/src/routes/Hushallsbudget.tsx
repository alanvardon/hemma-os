import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Maximize2 } from 'lucide-react'
import { useToolPageActive } from '../lib/toolTransition'
import {
  applyMortgageSync, defaultState, computeBudget, formatWithSpaces, parseFormatted, money as fmt,
} from '../lib/hushallsbudget'
import type { BudgetState, BudgetResult, Owner, Row } from '../lib/hushallsbudget'
import { loadBudget, saveBudget } from '../lib/hushallsbudget-store'
import { reportPersistenceError } from '../lib/persistence-error'
import { mortgageMonthlyFigures } from '../lib/mortgage'
import { loadMortgageSyncSnapshot } from '../lib/mortgage-store'
import { todayISO } from '../lib/date'
import * as salaryStore from '../lib/salary-store'
import * as salaryDraftsStore from '../lib/salary-drafts-store'
import { buildMonthViews } from '../lib/loner'
import type { MonthView } from '../lib/loner'
import { Money, Percent } from '../components/AnimatedNumber'
import BudgetDonutChart, { type DonutSegment } from '../components/charts/BudgetDonutChart'
import EditableName from '../components/EditableName'
import Icon from '../components/Icon'
import PageHeader from '../components/PageHeader'
import ThemeToggle from '../components/ThemeToggle'
import { useSaveFlash } from '../components/useSaveFlash'
import { useToast } from '../components/useToast'
import { useConfirm } from '../components/useConfirm'
import { usePersonIdentity } from '../components/usePersonIdentity'
import { PersonLabel } from '../components/PersonBadge'
import { openHouseholdDialog } from '../components/HouseholdMenu'
import { currentMonth, monthLabel, monthStatusText } from './loner-labels'

// ── Module helpers (faithful to budget.js) ───────────────────────────────────

const CAT_TOKENS = ['--cat-1', '--cat-2', '--cat-3', '--cat-4', '--cat-5', '--cat-6', '--cat-7', '--cat-8']

// Animated summary figures (NumberFlow). These roll the digits as you edit the
// budget; the plain fmt()/fmtSigned() strings above stay for prose, modal data
// and the input-column subtotals — only the summary surface animates, matching
// the Bostadskalkyl pilot. `M` is the kronor figure (visual twin of fmt());
// pass { signed } for the signed payoff figures and { prefix: '−' } for the
// "less …" deduction rows.
function M(value: number, opts?: { signed?: boolean; prefix?: string }) {
  return <Money value={value} signed={opts?.signed} prefix={opts?.prefix} />
}
function Pct1(value: number) {
  return <Percent value={value} decimals={1} />
}

// Slices for the "where the pot goes" donut, in the same order/colours as the
// legacy Chart.js doughnut (joint categories first, then each person's costs,
// savings and the leftover). Zero-value slices are dropped.
function buildDonutSegments(result: BudgetResult, nameA: string, nameB: string): DonutSegment[] {
  const segs: DonutSegment[] = []
  ;(result.jointCategories || []).forEach((c, i) => {
    segs.push({ label: c.name || 'Category', value: c.amount, token: CAT_TOKENS[i % CAT_TOKENS.length] })
  })
  segs.push({ label: nameA + ' costs', value: result.costsA, token: '--accent-light' })
  segs.push({ label: nameB + ' costs', value: result.costsB, token: '--copper' })
  segs.push({ label: 'Savings', value: result.totalSavings, token: '--warn-light' })
  segs.push({ label: 'Left over', value: Math.max(0, result.surplus), token: '--ink-faint' })
  // Sort largest-first so the arc order and the legend table both read
  // top-down by size — you can scan it (plan 63). pieSortValues is null in the
  // chart, so the arc order follows this array 1:1.
  return segs.filter((s) => s.value > 0).sort((a, b) => b.value - a.value)
}

// Closest row to insert before, given a list element and a pointer Y (drag-and-drop).
function dragAfterRow(listEl: HTMLElement, y: number): HTMLElement | null {
  const rows = Array.prototype.slice.call(listEl.querySelectorAll('.b-row:not(.dragging)')) as HTMLElement[]
  let closest: HTMLElement | null = null, closestOffset = Number.NEGATIVE_INFINITY
  rows.forEach((child) => {
    const box = child.getBoundingClientRect()
    const offset = y - box.top - box.height / 2
    if (offset < 0 && offset > closestOffset) { closestOffset = offset; closest = child }
  })
  return closest
}

// ── Money input — formats with spaces, reformats on blur (no live reformat) ───
function AmountInput({ value, onChange, className, ariaLabel }: {
  value: number; onChange: (n: number) => void; className: string; ariaLabel: string
}) {
  const [buf, setBuf] = useState(() => formatWithSpaces(value))
  const [focused, setFocused] = useState(false)
  useEffect(() => { if (!focused) setBuf(formatWithSpaces(value)) }, [value, focused])
  return (
    <input
      type="text" inputMode="numeric" className={className} aria-label={ariaLabel} value={buf}
      onFocus={() => setFocused(true)}
      onChange={(e) => { setBuf(e.target.value); onChange(parseFormatted(e.target.value)) }}
      onBlur={() => { setFocused(false); setBuf(formatWithSpaces(parseFormatted(buf))) }}
    />
  )
}

// ── Editable budget row (income / cost / saving) ─────────────────────────────
function EditableRow({ row, draggable, dragging, autoFocusLabel, onLabel, onAmount, onRemove, onDragStart, onDragEnd }: {
  row: Row; draggable?: boolean; dragging?: boolean; autoFocusLabel?: boolean
  onLabel: (v: string) => void; onAmount: (n: number) => void; onRemove: () => void
  onDragStart?: (e: React.DragEvent) => void; onDragEnd?: () => void
}) {
  return (
    <div className={'b-row' + (draggable ? ' b-draggable' : '') + (dragging ? ' dragging' : '')}>
      {draggable && (
        <span className="b-drag-handle" draggable aria-hidden="true" onDragStart={onDragStart} onDragEnd={onDragEnd}>⠿</span>
      )}
      <EditableName
        value={row.label} placeholder="What is it?" ariaLabel="Name" inputClassName="b-row-label"
        autoEdit={autoFocusLabel} onCommit={onLabel}
      />
      <AmountInput value={row.amount || 0} onChange={onAmount} className="b-row-amount" ariaLabel="Amount, kr per month" />
      <button type="button" className="b-row-remove" aria-label="Remove row" onClick={onRemove}>×</button>
    </div>
  )
}

// ── Fullscreen chart overlay ─────────────────────────────────────────────────
function ChartOverlay({ open, onClose, segments, totalIncome }: {
  open: boolean; onClose: () => void; segments: DonutSegment[]; totalIncome: number
}) {
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="chart-overlay" role="dialog" aria-modal="true" aria-label="Where the pot goes — full screen"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="chart-overlay-inner">
        <div className="chart-overlay-head">
          <span className="chart-overlay-title">Where the pot goes</span>
          <button type="button" className="chart-expand-btn chart-overlay-close" title="Close" aria-label="Close full screen" onClick={onClose}>×</button>
        </div>
        <div className="chart-overlay-stage">
          <BudgetDonutChart segments={segments} formatMoney={fmt} centerLabel="In the pot" centerValue={totalIncome} variant="full" />
        </div>
      </div>
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────────────────
export default function Hushallsbudget() {
  const active = useToolPageActive('/hushallsbudget')
  useLayoutEffect(() => { document.documentElement.classList.remove('calc-layout') }, [])

  const [state, setState] = useState<BudgetState>(defaultState)
  const { toast, showToast } = useToast()
  const confirm = useConfirm()
  const { saveVisible, flashSaved } = useSaveFlash()
  const [justAddedId, setJustAddedId] = useState<string | null>(null)
  const [justAddedCatId, setJustAddedCatId] = useState<string | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverCatId, setDragOverCatId] = useState<string | null>(null)

  const [chartOpen, setChartOpen] = useState(false)
  const mortgageFiguresRef = useRef<{ ranta: number; amortering: number } | null>(null)
  // Plan 126 §7 — how many funded lånedelar had no räntevillkor covering the
  // day we synced on. > 0 means the sync was deliberately skipped, so the user
  // must be told the Bolån rows below are the previous ones, not today's.
  const [mortgageRateGapParts, setMortgageRateGapParts] = useState(0)

  // Plan 139 — the current month's salary status, shown as a compact row that
  // links to Löner (where salaries are now submitted, edited and exported).
  const [salaryMonth, setSalaryMonth] = useState<MonthView | null>(null)
  useEffect(() => {
    let alive = true
    const cur = currentMonth()
    Promise.all([salaryStore.list(), salaryDraftsStore.listDrafts(cur)]).then(([rows, pending]) => {
      if (alive) setSalaryMonth(buildMonthViews(rows, pending, cur).find((v) => v.month === cur) ?? null)
    }).catch(() => { /* status row simply stays hidden */ })
    return () => { alive = false }
  }, [])

  // Load the persisted budget once on mount (now async — localStorage today,
  // cloud after the swap). `loadedRef` holds the exact object we hydrated with
  // so the save effect below can tell a load apart from a user edit and skip
  // saving the freshly-loaded (or placeholder default) state straight back.
  const loadedRef = useRef<BudgetState | null>(null)
  useEffect(() => {
    let alive = true
    // Plan 126 §7 — ONE captured day for the whole sync, so the balance, the
    // blended rate and the amortisation history can never be read on two sides
    // of midnight.
    const asOf = todayISO()
    Promise.all([
      loadBudget(),
      loadMortgageSyncSnapshot().catch(() => null),
    ]).then(([loaded, mortgageSnapshot]) => {
      if (!alive) return
      const sync = mortgageSnapshot
        ? mortgageMonthlyFigures(mortgageSnapshot.parts, mortgageSnapshot.periods, mortgageSnapshot.payments, asOf)
        : null
      mortgageFiguresRef.current = sync?.status === 'ok' ? sync.figures : null
      setMortgageRateGapParts(sync?.status === 'missing-current-rate' ? sync.loan_part_ids.length : 0)
      setState((prev) => {
        const base = (loadedRef.current = loaded ?? prev)
        // Two no-write outcomes, both of which must return `base` ITSELF: a null
        // snapshot (the live read failed) and 'missing-current-rate' (no rate
        // period covers today, so no honest figure exists). The debounced save
        // effect below fires on `state !== loadedRef.current`, so returning a
        // structurally equal clone here would persist on mere navigation —
        // exactly the write this stage exists to prevent.
        if (!sync || sync.status === 'missing-current-rate') return base
        // 'empty' means the mortgage genuinely has nothing to sync, so obsolete
        // synced rows are removed; applyMortgageSync itself returns `base`
        // unchanged when there were none.
        return applyMortgageSync(base, sync.status === 'ok' ? sync.figures : null)
      })
    })
    return () => { alive = false }
  }, [])

  // Persist (debounced) + flash "Saved ✓". Skip until the initial load lands,
  // and skip the load-induced render itself (state === the object we loaded).
  useEffect(() => {
    if (loadedRef.current === null || state === loadedRef.current) return
    const t = setTimeout(() => {
      void saveBudget(state).then(flashSaved).catch(reportPersistenceError)
    }, 250)
    return () => clearTimeout(t)
  }, [state, flashSaved])

  useEffect(() => { document.title = 'Hushållsbudget — Hemma·OS' }, [])

  const r = useMemo(() => computeBudget(state), [state])
  // Plan 111: once the household binds Hushållsbudget's A/B slots to its canonical
  // people, those names become the live display names and the signed-in slot is
  // marked "Du". An unmapped/unbound household keeps its legacy people[] names and
  // shows no Du. Column ORDER (A then B) never changes.
  const identityView = usePersonIdentity()
  const boundA = identityView.personFor('hushallsbudget', 'a')
  const boundB = identityView.personFor('hushallsbudget', 'b')
  const toolBound = !!boundA && !!boundB
  const mySlot = identityView.myToolSlot('hushallsbudget')
  const isSelf = (o: 'a' | 'b') => mySlot === o
  const isOther = (o: 'a' | 'b') => mySlot != null && mySlot !== o
  const nameA = toolBound ? boundA.display_name : (state.people[0] || 'A')
  const nameB = toolBound ? boundB.display_name : (state.people[1] || 'B')
  const personName = (owner: Owner) => owner === 'a' ? nameA : owner === 'b' ? nameB : 'Together'
  const personHead = (owner: 'a' | 'b') => (
    <PersonLabel name={owner === 'a' ? nameA : nameB} self={isSelf(owner)} other={isOther(owner)} />
  )

  // ── Immutable state mutation helper ────────────────────────────────────────
  const mutate = useCallback((fn: (draft: BudgetState) => void) => {
    setState((prev) => { const next = structuredClone(prev); fn(next); return next })
  }, [])

  function listFor(s: BudgetState, kind: 'income' | 'cost' | 'saving'): Row[] {
    return kind === 'income' ? s.incomes : kind === 'cost' ? s.costs : s.savings
  }

  function addRow(kind: 'income' | 'cost' | 'saving', owner: Owner, category?: string) {
    let newId = ''
    mutate((s) => {
      s.seq = (s.seq || 1000) + 1
      newId = 'r' + s.seq
      const row: Row = { id: newId, label: '', amount: 0, owner }
      if (category) row.category = category
      listFor(s, kind).push(row)
    })
    setJustAddedId(newId)
  }
  function setRowLabel(kind: 'income' | 'cost' | 'saving', id: string, label: string) {
    mutate((s) => { const row = listFor(s, kind).find((x) => x.id === id); if (row) row.label = label })
  }
  function setRowAmount(kind: 'income' | 'cost' | 'saving', id: string, amount: number) {
    mutate((s) => { const row = listFor(s, kind).find((x) => x.id === id); if (row) row.amount = amount })
  }
  function removeRow(kind: 'income' | 'cost' | 'saving', id: string) {
    mutate((s) => { const list = listFor(s, kind); const i = list.findIndex((x) => x.id === id); if (i >= 0) list.splice(i, 1) })
  }

  function disableMortgageSync() {
    mutate((s) => {
      s.mortgageSyncOff = true
      s.costs = s.costs.filter((row) => row.source !== 'bolanekoll')
    })
  }

  function enableMortgageSync() {
    const figures = mortgageFiguresRef.current
    if (!figures) return
    mutate((s) => {
      s.mortgageSyncOff = false
      s.costs = applyMortgageSync(s, figures).costs
    })
  }

  // ── Categories ─────────────────────────────────────────────────────────────
  function addCategory() {
    let id = ''
    mutate((s) => { s.catSeq = (s.catSeq || 0) + 1; id = 'c-' + s.catSeq; s.categories.push({ id, name: '' }) })
    setJustAddedCatId(id)
  }
  function setCategoryName(catId: string, name: string) {
    mutate((s) => { const c = s.categories.find((x) => x.id === catId); if (c) c.name = name })
  }
  async function removeCategory(catId: string) {
    const cats = state.categories || []
    if (cats.length <= 1) { showToast('Keep at least one category.'); return }
    const idx = cats.findIndex((c) => c.id === catId)
    if (idx < 0) return
    const fallback = cats[idx === 0 ? 1 : 0]
    const count = state.costs.filter((rw) => rw.owner === 'joint' && rw.category === catId).length
    if (count > 0 && !(await confirm({ title: 'Remove "' + (cats[idx].name || 'this category') + '"?', message: 'Its ' + count + ' row(s) move to "' + (fallback.name || 'another category') + '".', confirmLabel: 'Ta bort' }))) return
    mutate((s) => {
      s.costs.forEach((rw) => { if (rw.owner === 'joint' && rw.category === catId) rw.category = fallback.id })
      const i = s.categories.findIndex((c) => c.id === catId)
      if (i >= 0) s.categories.splice(i, 1)
    })
  }

  // ── Drag & drop joint cost rows between categories ─────────────────────────
  function onRowDragStart(e: React.DragEvent, rowId: string) {
    setDraggingId(rowId)
    e.dataTransfer.effectAllowed = 'move'
    try { e.dataTransfer.setData('text/plain', rowId) } catch { /* some browsers */ }
    const rowEl = (e.currentTarget as HTMLElement).closest('.b-row') as HTMLElement | null
    if (rowEl && e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(rowEl, 12, 12)
  }
  function onRowDragEnd() { setDraggingId(null); setDragOverCatId(null) }
  function onCatDragOver(e: React.DragEvent, catId: string) {
    if (!draggingId) return
    e.preventDefault(); e.dataTransfer.dropEffect = 'move'
    if (dragOverCatId !== catId) setDragOverCatId(catId)
  }
  function onCatDrop(e: React.DragEvent, catId: string) {
    if (!draggingId) return
    e.preventDefault()
    const before = dragAfterRow(e.currentTarget as HTMLElement, e.clientY)
    const beforeId = before ? before.dataset.id || null : null
    moveRowToCategory(catId, beforeId)
    setDragOverCatId(null)
  }
  function moveRowToCategory(catId: string, beforeId: string | null) {
    const id = draggingId
    if (!id) return
    mutate((s) => {
      const idx = s.costs.findIndex((rw) => rw.id === id)
      if (idx < 0) return
      const moved = s.costs.splice(idx, 1)[0]
      moved.owner = 'joint'; moved.category = catId
      if (beforeId && beforeId !== id) {
        const bIdx = s.costs.findIndex((rw) => rw.id === beforeId)
        if (bIdx < 0) s.costs.push(moved); else s.costs.splice(bIdx, 0, moved)
      } else { s.costs.push(moved) }
    })
    setDraggingId(null)
  }

  // ── Reset ──────────────────────────────────────────────────────────────────
  async function reset() {
    if (!(await confirm({ title: 'Reset the budget to the example data?', message: 'Your current rows will be replaced.', confirmLabel: 'Reset' }))) return
    setState(defaultState())
  }

  // ── Derived display ────────────────────────────────────────────────────────
  const total = r.totalIncome || 1
  const flowPcts = {
    joint: r.costsJoint / total,
    own: (r.costsA + r.costsB) / total,
    sav: r.totalSavings / total,
    left: Math.max(0, r.surplus) / total,
  }
  const pctW = (v: number) => (Math.max(0, Math.min(1, v)) * 100).toFixed(1) + '%'
  const householdLeft = r.personA.leftover + r.personB.leftover
  const posNeg = (n: number) => (n > 0 ? ' positive' : n < 0 ? ' negative' : '')

  const jointCosts = (catId: string) => state.costs.filter((rw) => rw.owner === 'joint' && rw.category === catId)
  const ownRows = (rows: Row[], owner: 'a' | 'b') => rows.filter((rw) => rw.owner === owner)
  const incomeRows = (owner: 'a' | 'b') => state.incomes.filter((rw) => (owner === 'b' ? rw.owner === 'b' : rw.owner !== 'b'))
  const catAmount = (catId: string) => (r.jointCategories.find((c) => c.id === catId)?.amount) ?? 0
  const donutSegments = buildDonutSegments(r, nameA, nameB)

  return (
    <div className={'hb-root' + (active ? ' vt-page' : '')}>
      <PageHeader
        backTo="/hushallsbudget"
        title="Hushållsbudget"
        tagline={<>One pot, split evenly — joint &amp; individual costs for two</>}
        saveVisible={saveVisible}
        actions={<>
          <ThemeToggle />
          <button className="btn btn-ghost" title="Reset to the example budget" onClick={reset}>Reset</button>
        </>}
      />

      <div className="layout">
        {/* ── INPUTS ── */}
        <div className="inputs-col">

          {/* Section 1: The pot */}
          <div className="section">
            <div className="section-label">
              <span className="section-num">1</span>
              <span className="section-title">The pot — pool &amp; split</span>
            </div>
            <p className="section-note">
              Every krona you both earn goes into one pot. It's split evenly so you each
              end the month with the same income, then joint costs come off 50/50 and your
              own costs come off your own share.
            </p>

            {toolBound ? (
              <div className="who-row who-row-bound">
                <div className="who-bound-people">
                  <span className="who-bound-name">{personHead('a')}</span>
                  <span className="who-amp">&amp;</span>
                  <span className="who-bound-name">{personHead('b')}</span>
                </div>
                <button type="button" className="link-btn who-manage" onClick={openHouseholdDialog}>
                  Hantera personer i Hushåll →
                </button>
              </div>
            ) : (
              <div className="who-row">
                <div className="who-field">
                  <label htmlFor="personAName">Person A</label>
                  <input type="text" id="personAName" value={state.people[0]} maxLength={20} autoComplete="off"
                    onChange={(e) => mutate((s) => { s.people[0] = e.target.value })}
                    onBlur={(e) => { if (!e.target.value.trim()) mutate((s) => { s.people[0] = 'Person A' }) }} />
                </div>
                <span className="who-amp">&amp;</span>
                <div className="who-field">
                  <label htmlFor="personBName">Person B</label>
                  <input type="text" id="personBName" value={state.people[1]} maxLength={20} autoComplete="off"
                    onChange={(e) => mutate((s) => { s.people[1] = e.target.value })}
                    onBlur={(e) => { if (!e.target.value.trim()) mutate((s) => { s.people[1] = 'Person B' }) }} />
                </div>
              </div>
            )}

            <div className="income-cols">
              {(['a', 'b'] as const).map((owner) => (
                <div className="income-col" key={owner}>
                  <div className="income-col-head">
                    <span className="income-col-name">{personHead(owner)}</span>
                    <span className="income-col-sub">{fmt(owner === 'a' ? r.incomeA : r.incomeB)}</span>
                  </div>
                  <div className="income-list">
                    {incomeRows(owner).map((row) => (
                      <EditableRow key={row.id} row={row} autoFocusLabel={row.id === justAddedId}
                        onLabel={(v) => setRowLabel('income', row.id, v)}
                        onAmount={(n) => setRowAmount('income', row.id, n)}
                        onRemove={() => removeRow('income', row.id)} />
                    ))}
                  </div>
                  <button type="button" className="btn btn-ghost row-add-btn" onClick={() => addRow('income', owner)}>+ Add income</button>
                </div>
              ))}
            </div>

            <div className="pot-box">
              <div className="pot-flow">
                <div className="pot-flow-item">
                  <span className="pot-flow-label">{personName('a')} pays in</span>
                  <span className="pot-flow-val">{M(r.incomeA)}</span>
                </div>
                <span className="pot-plus">+</span>
                <div className="pot-flow-item">
                  <span className="pot-flow-label">{personName('b')} pays in</span>
                  <span className="pot-flow-val">{M(r.incomeB)}</span>
                </div>
              </div>
              <div className="pot-total-row">
                <span className="pot-total-label">In the pot</span>
                <span className="pot-total-val">{M(r.totalIncome)}</span>
              </div>
              <div className="pot-split-row">
                <span className="pot-split-label">Split evenly, you each take home</span>
                <span className="pot-split-val">{M(r.equalShare)}</span>
              </div>
              <div className={'pot-transfer' + (r.transfer.amount < 0.5 ? ' even' : '')}>
                <span className="pot-transfer-icon" aria-hidden="true">⇄</span>
                <span className="pot-transfer-text">
                  {r.transfer.amount < 0.5
                    ? 'Incomes are already even — nothing to transfer'
                    : <>
                        <strong>{personName(r.transfer.from)}</strong> pays <strong>{personName(r.transfer.to)}</strong>{' '}
                        <strong className="pot-transfer-amount">{M(r.transfer.amount)}</strong>
                      </>}
                </span>
              </div>
              {r.incomeJoint > 0 && (
                <p className="pot-transfer-note">Joint income ({fmt(r.incomeJoint)}) is then shared 50/50 on top — you each take home {fmt(r.equalShare)}.</p>
              )}
            </div>

            {salaryMonth && (
              <div className="salary-link-row">
                <span>Löner för {monthLabel(currentMonth())}: <strong>{monthStatusText(salaryMonth, (slot) => (slot === 'a' ? nameA : nameB))}</strong></span>
                <Link className="link-btn" to="/loner">Öppna Löner</Link>
              </div>
            )}
          </div>

          {/* Section 2: Costs */}
          <div className="section">
            <div className="section-label">
              <span className="section-num">2</span>
              <span className="section-title">Costs</span>
              <span className="section-total">{fmt(r.totalCosts)}</span>
            </div>
            <p className="section-note">
              <strong>Joint</strong> costs are split 50/50 from the pot — sort them into
              categories and drag rows between them. Each person's <strong>own</strong>
              costs come out of their own share.
            </p>

            <p className="owner-split-label">Joint costs <span className="owner-block-tag">split 50/50</span></p>
            {/* Plan 126 §7 — the synk was skipped because no ränteperiod covers
                today for at least one funded lånedel. Say what did NOT happen
                and that the figures below are the previous ones, so nobody
                budgets on them believing they are current. Silent when the user
                has switched the synk off: nothing was going to update anyway. */}
            {mortgageRateGapParts > 0 && !state.mortgageSyncOff && (
              <div className="bolan-warn" role="status">
                <span>
                  <b>Bolånesiffrorna kunde inte uppdateras.</b>{' '}
                  {mortgageRateGapParts === 1 ? 'En lånedel' : mortgageRateGapParts + ' lånedelar'} saknar räntevillkor för idag — tidigare värden behålls.
                </span>
                <a className="link-btn" href="#/bolanekoll">Öppna Bolånekoll</a>
              </div>
            )}
            {state.costs.some((row) => row.source === 'bolanekoll') && (
              <div className="cat-card bolan-card">
                <div className="cat-head">
                  <span className="cat-name-static">Bolån <span className="bolan-src">· från <a href="#/bolanekoll">Bolånekoll</a> →</span></span>
                  <span className="cat-sub">{fmt(r.jointCategories.find((category) => category.id === '_bolan')?.amount ?? 0)}</span>
                </div>
                <div className="b-list">
                  {state.costs.filter((row) => row.source === 'bolanekoll').map((row) => (
                    <div key={row.id} className="b-row bolan-row">
                      <span className="b-label-static">{row.label}</span>
                      <span className="b-amount-static">{fmt(row.amount)}</span>
                    </div>
                  ))}
                </div>
                <button type="button" className="link-btn bolan-off" onClick={disableMortgageSync}>Stäng av synk</button>
              </div>
            )}
            {state.mortgageSyncOff && mortgageFiguresRef.current && (
              <div className="bolan-ghost">
                <span>Bolån-synk är avstängd</span>
                <button type="button" className="link-btn" onClick={enableMortgageSync}>Slå på igen</button>
              </div>
            )}
            {state.costs.some((row) => row.source === 'bolanekoll') && !state.bolanHintDismissed && state.costs.some((row) => row.owner === 'joint' && !row.source && /bolån|mortgage/i.test(row.label)) && (
              <div className="bolan-hint">
                <span>Din manuella bolånerad räknas också med i totalen — ta bort den om den nu dubblas.</span>
                <button type="button" className="link-btn" onClick={() => mutate((s) => { s.bolanHintDismissed = true })}>Ok, göm</button>
              </div>
            )}
            <div className="cat-cards">
              {state.categories.map((cat) => (
                <div key={cat.id} className={'cat-card' + (dragOverCatId === cat.id ? ' drag-over' : '')}
                  onDragOver={(e) => onCatDragOver(e, cat.id)} onDragLeave={() => setDragOverCatId((c) => (c === cat.id ? null : c))}>
                  <div className="cat-head">
                    <EditableName value={cat.name} placeholder="Category name" ariaLabel="Category name" inputClassName="cat-name"
                      autoEdit={cat.id === justAddedCatId} onCommit={(v) => setCategoryName(cat.id, v)} />
                    <span className="cat-sub">{fmt(catAmount(cat.id))}</span>
                    <button type="button" className="cat-remove" aria-label="Remove category" onClick={() => removeCategory(cat.id)}>×</button>
                  </div>
                  <div className="b-list cat-list" data-cat-id={cat.id}
                    onDragOver={(e) => onCatDragOver(e, cat.id)} onDrop={(e) => onCatDrop(e, cat.id)}>
                    {jointCosts(cat.id).map((row) => (
                      <EditableRow key={row.id} row={row} draggable dragging={draggingId === row.id} autoFocusLabel={row.id === justAddedId}
                        onLabel={(v) => setRowLabel('cost', row.id, v)}
                        onAmount={(n) => setRowAmount('cost', row.id, n)}
                        onRemove={() => removeRow('cost', row.id)}
                        onDragStart={(e) => onRowDragStart(e, row.id)} onDragEnd={onRowDragEnd} />
                    ))}
                  </div>
                  <button type="button" className="btn btn-ghost row-add-btn" onClick={() => addRow('cost', 'joint', cat.id)}>+ Add cost</button>
                </div>
              ))}
            </div>
            <button type="button" className="btn btn-ghost row-add-btn add-cat-btn" onClick={addCategory}>+ Add category</button>

            <p className="owner-split-label">Individual costs</p>
            <div className="owner-cols">
              {(['a', 'b'] as const).map((owner) => (
                <div className="owner-col" key={owner}>
                  <div className="owner-block-head">
                    <span className="owner-block-title">{personHead(owner)}</span>
                    <span className="owner-block-sub">{fmt(owner === 'a' ? r.costsA : r.costsB)}</span>
                  </div>
                  <div className="b-list">
                    {ownRows(state.costs, owner).map((row) => (
                      <EditableRow key={row.id} row={row} autoFocusLabel={row.id === justAddedId}
                        onLabel={(v) => setRowLabel('cost', row.id, v)}
                        onAmount={(n) => setRowAmount('cost', row.id, n)}
                        onRemove={() => removeRow('cost', row.id)} />
                    ))}
                  </div>
                  <button type="button" className="btn btn-ghost row-add-btn" onClick={() => addRow('cost', owner)}>+ Add</button>
                </div>
              ))}
            </div>
          </div>

          {/* Section 3: Savings */}
          <div className="section">
            <div className="section-label">
              <span className="section-num">3</span>
              <span className="section-title">Savings &amp; pension</span>
              <span className="section-total">{fmt(r.totalSavings)}</span>
            </div>
            <p className="section-note">
              What each of you sets aside every month — pension, ISK and buffer.
              These come out of your own take-home share.
            </p>

            <div className="owner-cols">
              {(['a', 'b'] as const).map((owner) => (
                <div className="owner-col" key={owner}>
                  <div className="owner-block-head">
                    <span className="owner-block-title">{personHead(owner)}</span>
                    <span className="owner-block-sub">{fmt(owner === 'a' ? r.savingsA : r.savingsB)}</span>
                  </div>
                  <div className="b-list">
                    {ownRows(state.savings, owner).map((row) => (
                      <EditableRow key={row.id} row={row} autoFocusLabel={row.id === justAddedId}
                        onLabel={(v) => setRowLabel('saving', row.id, v)}
                        onAmount={(n) => setRowAmount('saving', row.id, n)}
                        onRemove={() => removeRow('saving', row.id)} />
                    ))}
                  </div>
                  <button type="button" className="btn btn-ghost row-add-btn" onClick={() => addRow('saving', owner)}>+ Add</button>
                </div>
              ))}
            </div>
          </div>

        </div>

        {/* ── SUMMARY ── */}
        <div className="summary-col">
          <p className="summary-title">Summary</p>

          <div className="sum-card sum-card-hero">
            <div className="sum-card-title">Left over after everything</div>
            <div className={'sum-big' + posNeg(r.surplus)}>{M(r.surplus, { signed: true })}</div>
            <div className="sum-card-subtitle">across the whole household, each month</div>
            <div className="flow-bar" role="img" aria-label="How the pot is spent">
              <span className="flow-seg flow-joint" style={{ width: pctW(flowPcts.joint) }} />
              <span className="flow-seg flow-own" style={{ width: pctW(flowPcts.own) }} />
              <span className="flow-seg flow-sav" style={{ width: pctW(flowPcts.sav) }} />
              <span className="flow-seg flow-left" style={{ width: pctW(flowPcts.left) }} />
            </div>
            <div className="flow-legend">
              <span className="flow-key"><span className="flow-dot flow-joint" />Joint <em>{M(r.costsJoint)}</em></span>
              <span className="flow-key"><span className="flow-dot flow-own" />Own <em>{M(r.costsA + r.costsB)}</em></span>
              <span className="flow-key"><span className="flow-dot flow-sav" />Savings <em>{M(r.totalSavings)}</em></span>
              <span className="flow-key"><span className="flow-dot flow-left" />Left <em>{M(Math.max(0, r.surplus))}</em></span>
            </div>
            <div className="sum-rows">
              <div className="sum-row"><span className="sum-row-label">Total income</span><span className="sum-row-val">{M(r.totalIncome)}</span></div>
              <div className="sum-row"><span className="sum-row-label">Total costs</span><span className="sum-row-val">{M(r.totalCosts)}</span></div>
              <div className="sum-row"><span className="sum-row-label">Total savings</span><span className="sum-row-val">{M(r.totalSavings)}</span></div>
            </div>
          </div>

          <div className="sum-card">
            <div className="sum-card-title">Each of you, after the split</div>
            <div className="compare-grid">
              <span className="compare-corner" aria-hidden="true" />
              <span className={'compare-head' + (isSelf('a') ? ' is-self' : '')}>{personHead('a')}</span>
              <span className={'compare-head' + (isSelf('b') ? ' is-self' : '')}>{personHead('b')}</span>

              <span className="compare-label">Take-home</span>
              <span className="compare-val">{M(r.personA.ownIncome + r.personA.potNet)}</span>
              <span className="compare-val">{M(r.personB.ownIncome + r.personB.potNet)}</span>

              <span className="compare-label">Joint costs ½</span>
              <span className="compare-val">{M(r.personA.jointCostShare, { prefix: '−' })}</span>
              <span className="compare-val">{M(r.personB.jointCostShare, { prefix: '−' })}</span>

              <span className="compare-label">Own costs</span>
              <span className="compare-val">{M(r.personA.ownCosts, { prefix: '−' })}</span>
              <span className="compare-val">{M(r.personB.ownCosts, { prefix: '−' })}</span>

              <span className="compare-label">Savings</span>
              <span className="compare-val">{M(r.personA.jointSavingsShare + r.personA.ownSavings, { prefix: '−' })}</span>
              <span className="compare-val">{M(r.personB.jointSavingsShare + r.personB.ownSavings, { prefix: '−' })}</span>

              <span className="compare-label compare-foot-label">Left to spend</span>
              <span className={'compare-val compare-foot' + posNeg(r.personA.leftover)}>{M(r.personA.leftover, { signed: true })}</span>
              <span className={'compare-val compare-foot' + posNeg(r.personB.leftover)}>{M(r.personB.leftover, { signed: true })}</span>
            </div>
            <div className="compare-household">
              <span className="compare-household-label">Household cashflow</span>
              <span className={'compare-household-val' + posNeg(householdLeft)}>{M(householdLeft, { signed: true })}</span>
            </div>
          </div>

          <hr className="sum-divider" />

          <div className="sum-card">
            <div className="sum-card-title">The pot</div>
            <div className="sum-big">{M(r.equalShare)}</div>
            <div className="sum-card-subtitle">take-home each, after the split</div>
            <div className="sum-rows">
              <div className="sum-row"><span className="sum-row-label">{personHead("a")}</span><span className="sum-row-val">{M(r.incomeA)}</span></div>
              <div className="sum-row"><span className="sum-row-label">{personHead("b")}</span><span className="sum-row-val">{M(r.incomeB)}</span></div>
            </div>
          </div>

          <div className="sum-card">
            <div className="sum-card-title chart-head">
              Where the pot goes
              <button type="button" className="chart-expand-btn" title="View full screen" aria-label="View chart full screen" onClick={() => setChartOpen(true)}><Icon icon={Maximize2} size={15} /></button>
            </div>
            <div className="chart-wrap">
              <BudgetDonutChart segments={donutSegments} formatMoney={fmt} centerLabel="In the pot" centerValue={r.totalIncome} />
            </div>
          </div>

          <div className="sum-card">
            <div className="sum-card-title">Savings rate</div>
            <div className="sum-big positive">{Pct1(r.savingsRate * 100)}</div>
            <div className="sum-card-subtitle">of total household income</div>
            <div className="sum-rows">
              <div className="sum-row"><span className="sum-row-label">{personHead("a")}</span><span className="sum-row-val">{M(r.savingsA)}</span></div>
              <div className="sum-row"><span className="sum-row-label">{personHead("b")}</span><span className="sum-row-val">{M(r.savingsB)}</span></div>
            </div>
          </div>

        </div>
      </div>

      {/* Mobile key-figures bar */}
      <div className="mobile-bar">
        <div className="mobile-bar-inner">
          <div className="mobile-stat">
            <span className="mobile-stat-label">Take-home each</span>
            <span className="mobile-stat-val">{M(r.equalShare)}</span>
          </div>
          <div className="mobile-stat">
            <span className="mobile-stat-label">Left over</span>
            <span className={'mobile-stat-val' + posNeg(r.surplus)}>{M(r.surplus, { signed: true })}</span>
          </div>
        </div>
      </div>

      <ChartOverlay open={chartOpen} onClose={() => setChartOpen(false)} segments={donutSegments} totalIncome={r.totalIncome} />
      <div className={'hb-toast' + (toast.show ? ' show' : '')} role="status" aria-live="polite">{toast.msg}</div>
    </div>
  )
}
