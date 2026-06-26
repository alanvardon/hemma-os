import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import Chart from 'chart.js/auto'
import { useTheme } from '../App'
import {
  defaultState, computeBudget, buildSubmission, formatWithSpaces, parseFormatted,
} from '../lib/hushallsbudget'
import type { BudgetState, BudgetResult, Owner, Row, SalarySubmission, IncomeItem } from '../lib/hushallsbudget'
import { loadBudget, saveBudget } from '../lib/hushallsbudget-store'
import * as salaryStore from '../lib/salary-store'

// ── Module helpers (faithful to budget.js) ───────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const CAT_TOKENS = ['--cat-1', '--cat-2', '--cat-3', '--cat-4', '--cat-5', '--cat-6', '--cat-7', '--cat-8']

function fmt(n: number): string { return formatWithSpaces(Math.round(n)) + ' kr' }
function fmtSigned(n: number): string {
  const r = Math.round(n)
  return (r > 0 ? '+' : r < 0 ? '−' : '±') + formatWithSpaces(Math.abs(r)) + ' kr'
}

function currentMonth(): string { return new Date().toISOString().slice(0, 7) } // YYYY-MM
function monthLabel(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym || '')
  if (!m) return ym || '—'
  return (MONTHS[parseInt(m[2], 10) - 1] || '?') + ' ' + m[1]
}
function submittedLabel(iso: string | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '')
  if (!m) return '—'
  return parseInt(m[3], 10) + ' ' + (MONTHS[parseInt(m[2], 10) - 1] || '?') + ' ' + m[1]
}
function personFromRow(row: SalarySubmission, key: 'transfer_from' | 'transfer_to'): string {
  return row[key] === 'b' ? (row.person_b_name || 'B') : (row.person_a_name || 'A')
}
function transferText(row: SalarySubmission): string {
  if ((row.transfer_amount || 0) < 0.5) return 'Even — no transfer'
  return personFromRow(row, 'transfer_from') + ' → ' + personFromRow(row, 'transfer_to') + '  ' + fmt(row.transfer_amount)
}
// Signed settle-up for a row: positive = A pays B, negative = B pays A.
function signedTransfer(row: SalarySubmission): number {
  const amt = row.transfer_amount || 0
  return row.transfer_from === 'b' ? -amt : amt
}
function netText(net: number, nameA: string, nameB: string): string {
  if (Math.abs(net) < 0.5) return 'Even over the year'
  return (net > 0 ? nameA + ' → ' + nameB : nameB + ' → ' + nameA) + '  ' + fmt(Math.abs(net))
}
function sumItems(list: IncomeItem[]): number {
  return list.reduce((t, it) => t + (it.amount || 0), 0)
}

// Keep Tab focus inside an open dialog (visible focusables only).
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
function trapTab(container: HTMLElement | null, e: KeyboardEvent) {
  if (!container || e.key !== 'Tab') return
  const nodes = Array.prototype.filter.call(container.querySelectorAll(FOCUSABLE), (el: HTMLElement) => el.offsetParent !== null) as HTMLElement[]
  if (!nodes.length) return
  const first = nodes[0], last = nodes[nodes.length - 1]
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
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
      <input
        type="text" className="b-row-label" value={row.label} placeholder="What is it?" aria-label="Name"
        autoFocus={autoFocusLabel} onChange={(e) => onLabel(e.target.value)}
      />
      <AmountInput value={row.amount || 0} onChange={onAmount} className="b-row-amount" ariaLabel="Amount, kr per month" />
      <button type="button" className="b-row-remove" aria-label="Remove row" onClick={onRemove}>×</button>
    </div>
  )
}

// ── Doughnut chart — where the pot goes ──────────────────────────────────────
function DoughnutChart({ result, nameA, nameB }: { result: BudgetResult; nameA: string; nameB: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<Chart | null>(null)
  const { theme } = useTheme()
  useEffect(() => {
    if (!canvasRef.current) return
    // Defer one frame so the theme's data-theme attribute (set by App's effect)
    // is applied before we read the CSS tokens.
    const raf = requestAnimationFrame(() => {
      const canvas = canvasRef.current
      if (!canvas) return
      const root = document.querySelector('.hb-root') || document.documentElement
      const cs = getComputedStyle(root)
      const segs: { label: string; val: number; token: string }[] = []
      ;(result.jointCategories || []).forEach((c, i) => {
        segs.push({ label: c.name || 'Category', val: c.amount, token: CAT_TOKENS[i % CAT_TOKENS.length] })
      })
      segs.push({ label: nameA + ' costs', val: result.costsA, token: '--accent-light' })
      segs.push({ label: nameB + ' costs', val: result.costsB, token: '--copper' })
      segs.push({ label: 'Savings', val: result.totalSavings, token: '--warn-light' })
      segs.push({ label: 'Left over', val: Math.max(0, result.surplus), token: '--ink-faint' })
      const labels: string[] = [], data: number[] = [], colors: string[] = []
      segs.forEach((s) => {
        if (s.val > 0) { labels.push(s.label); data.push(s.val); colors.push(cs.getPropertyValue(s.token).trim()) }
      })
      const paperCard = cs.getPropertyValue('--paper-card').trim()
      const inkMid = cs.getPropertyValue('--ink-mid').trim()
      chartRef.current = new Chart(canvas, {
        type: 'doughnut',
        data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: paperCard, borderWidth: 2, hoverOffset: 6 }] },
        options: {
          responsive: true, maintainAspectRatio: false, cutout: '62%',
          plugins: {
            legend: { position: 'bottom', labels: { color: inkMid, boxWidth: 9, boxHeight: 9, padding: 10, font: { family: 'Inter', size: 11 } } },
            tooltip: { callbacks: { label: (ctx) => ' ' + fmt(Number(ctx.parsed)) } },
          },
        },
      })
    })
    return () => { cancelAnimationFrame(raf); chartRef.current?.destroy(); chartRef.current = null }
  }, [result, theme, nameA, nameB])
  return <canvas ref={canvasRef} />
}

// ── Modal shell — overlay, ESC, focus trap, scroll lock, close animation ─────
function Modal({ open, onClose, ariaLabel, children }: {
  open: boolean; onClose: () => void; ariaLabel: string; children: React.ReactNode
}) {
  const [mounted, setMounted] = useState(open)
  const [closing, setClosing] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => { if (open) { setMounted(true); setClosing(false) } }, [open])
  useEffect(() => {
    if (!open && mounted) {
      setClosing(true)
      const t = setTimeout(() => { setMounted(false); setClosing(false) }, 200)
      return () => clearTimeout(t)
    }
  }, [open, mounted])

  useEffect(() => {
    if (!mounted) return
    document.documentElement.classList.add('modal-open')
    return () => { document.documentElement.classList.remove('modal-open') }
  }, [mounted])

  useEffect(() => {
    if (!mounted) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
      trapTab(cardRef.current, e)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [mounted, onClose])

  if (!mounted) return null
  return (
    <div className={'modal-overlay' + (closing ? ' closing' : '')} role="dialog" aria-modal="true" aria-label={ariaLabel}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal-card" ref={cardRef}>{children}</div>
    </div>
  )
}

// ── Submit this month's salaries ─────────────────────────────────────────────
interface SalaryItem { uid: number; label: string; amount: number }

function SalaryModal({ open, onClose, people, incomes, flashSaved, onHistoryChanged }: {
  open: boolean; onClose: () => void; people: string[]; incomes: Row[]
  flashSaved: () => void; onHistoryChanged: () => void
}) {
  const [month, setMonth] = useState(currentMonth())
  const [note, setNote] = useState('')
  const [itemsA, setItemsA] = useState<SalaryItem[]>([])
  const [itemsB, setItemsB] = useState<SalaryItem[]>([])
  const uid = useRef(0)
  const firstAmountRef = useRef<HTMLInputElement>(null)

  // Read-only snapshot of the static baseline income rows for a person, used to
  // pre-fill the modal. The user can then tweak amounts and add extra income
  // (barnbidrag, tax rebate…) without touching the baseline.
  const incomesRef = useRef(incomes)
  incomesRef.current = incomes
  const prefillItems = (owner: 'a' | 'b'): SalaryItem[] => {
    const src = incomesRef.current
      .filter((row) => (owner === 'b' ? row.owner === 'b' : row.owner !== 'b'))
      .map((row) => ({ label: row.label, amount: row.amount }))
    return (src.length ? src : [{ label: 'Lön / Salary', amount: 0 }]).map((it) => ({ uid: uid.current++, label: it.label, amount: it.amount }))
  }

  // Reset the form whenever it opens — prefill from the live budget baseline.
  useEffect(() => {
    if (!open) return
    setMonth(currentMonth())
    setNote('')
    setItemsA(prefillItems('a'))
    setItemsB(prefillItems('b'))
    const t = setTimeout(() => { firstAmountRef.current?.focus(); firstAmountRef.current?.select() }, 30)
    return () => clearTimeout(t)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const nameA = people[0] || 'A', nameB = people[1] || 'B'
  const incomeA = sumItems(itemsA), incomeB = sumItems(itemsB)
  const preview = computeBudget({ incomes: [{ id: 'a', label: '', amount: incomeA, owner: 'a' }, { id: 'b', label: '', amount: incomeB, owner: 'b' }] })
  const tr = preview.transfer

  function patchItem(owner: 'a' | 'b', uidv: number, patch: Partial<SalaryItem>) {
    const setter = owner === 'a' ? setItemsA : setItemsB
    setter((list) => list.map((it) => (it.uid === uidv ? { ...it, ...patch } : it)))
  }
  function addItem(owner: 'a' | 'b') {
    const setter = owner === 'a' ? setItemsA : setItemsB
    setter((list) => [...list, { uid: uid.current++, label: '', amount: 0 }])
  }
  function removeItem(owner: 'a' | 'b', uidv: number) {
    const setter = owner === 'a' ? setItemsA : setItemsB
    setter((list) => list.filter((it) => it.uid !== uidv))
  }

  async function submit() {
    if (incomeA + incomeB <= 0) return
    const record = buildSubmission({
      month: month || currentMonth(),
      incomesA: itemsA.map((it) => ({ label: it.label.trim(), amount: it.amount })).filter((it) => it.label || it.amount),
      incomesB: itemsB.map((it) => ({ label: it.label.trim(), amount: it.amount })).filter((it) => it.label || it.amount),
      personAName: people[0], personBName: people[1], note: note.trim(),
    })
    const rows = await salaryStore.list()
    const dupe = rows.some((r) => r.month === record.month)
    if (dupe && !confirm('You’ve already logged ' + monthLabel(record.month) + '. Add another entry for it?')) return
    await salaryStore.add(record)
    onClose(); flashSaved(); onHistoryChanged()
  }

  // Plain helper (NOT a component) so the inputs keep focus across renders.
  const itemColumn = (owner: 'a' | 'b', items: SalaryItem[]) => (
    <div className="income-col">
      <div className="income-col-head">
        <span className="income-col-name">{owner === 'a' ? nameA : nameB}</span>
        <span className="income-col-sub">{fmt(owner === 'a' ? incomeA : incomeB)}</span>
      </div>
      <div className="sal-list">
        {items.map((it, i) => (
          <div className="sal-row" key={it.uid}>
            <input
              type="text" className="sal-row-label" value={it.label} placeholder="e.g. Lön, Barnbidrag, skatt" aria-label="Income name"
              onChange={(e) => patchItem(owner, it.uid, { label: e.target.value })}
            />
            <AmountInputRef
              inputRef={owner === 'a' && i === 0 ? firstAmountRef : undefined}
              value={it.amount} onChange={(n) => patchItem(owner, it.uid, { amount: n })}
              className="sal-row-amount" ariaLabel="Amount, kr"
            />
            <button type="button" className="sal-row-remove" aria-label="Remove income" onClick={() => removeItem(owner, it.uid)}>×</button>
          </div>
        ))}
      </div>
      <button type="button" className="btn btn-ghost row-add-btn" onClick={() => addItem(owner)}>+ Add income</button>
    </div>
  )

  return (
    <Modal open={open} onClose={onClose} ariaLabel="Submit this month’s salaries">
      <div className="modal-head">
        <span className="modal-title">Submit this month’s salaries</span>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <div className="modal-body">
        <p className="modal-note">
          Enter what you each actually earned this month. It's logged separately —
          your budget baseline above stays exactly as it is.
        </p>
        <div className="field">
          <label htmlFor="salaryMonth">Month</label>
          <input type="month" id="salaryMonth" value={month} onChange={(e) => setMonth(e.target.value)} />
        </div>
        <p className="field-label">Income this month — salary plus barnbidrag, tax rebates, anything else</p>
        <div className="income-cols salary-income-cols">
          {itemColumn('a', itemsA)}
          {itemColumn('b', itemsB)}
        </div>
        <div className="field">
          <label htmlFor="salaryNote">Note <span className="field-optional">(optional)</span></label>
          <input type="text" id="salaryNote" value={note} placeholder="e.g. bonus, parental leave…" autoComplete="off" onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="salary-preview">
          {tr.amount < 0.5
            ? <>Even — nothing to transfer. You each take home {fmt(preview.equalShare)}.</>
            : <>
                <strong>{tr.from === 'a' ? nameA : nameB}</strong> pays <strong>{tr.to === 'a' ? nameA : nameB}</strong>{' '}
                <strong className="pot-transfer-amount">{fmt(tr.amount)}</strong>
                {' · each takes home ' + fmt(preview.equalShare)}
              </>}
        </div>
      </div>
      <div className="modal-foot">
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={incomeA + incomeB <= 0} onClick={submit}>Confirm &amp; save</button>
      </div>
    </Modal>
  )
}

// AmountInput variant that exposes a ref to the underlying input (for focus).
function AmountInputRef({ value, onChange, className, ariaLabel, inputRef }: {
  value: number; onChange: (n: number) => void; className: string; ariaLabel: string
  inputRef?: React.RefObject<HTMLInputElement | null>
}) {
  const [buf, setBuf] = useState(() => formatWithSpaces(value))
  const [focused, setFocused] = useState(false)
  useEffect(() => { if (!focused) setBuf(formatWithSpaces(value)) }, [value, focused])
  return (
    <input
      ref={inputRef} type="text" inputMode="numeric" className={className} aria-label={ariaLabel} value={buf}
      onFocus={() => setFocused(true)}
      onChange={(e) => { setBuf(e.target.value); onChange(parseFormatted(e.target.value)) }}
      onBlur={() => { setFocused(false); setBuf(formatWithSpaces(parseFormatted(buf))) }}
    />
  )
}

// ── Submitted salary history ─────────────────────────────────────────────────
function HistoryModal({ open, onClose, rows, onReload, flashSaved }: {
  open: boolean; onClose: () => void; rows: SalarySubmission[]; onReload: () => void; flashSaved: () => void
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const importInputRef = useRef<HTMLInputElement>(null)

  const year = rows.length ? String(rows[0].month || currentMonth()).slice(0, 4) : ''
  const yr = rows.filter((r) => String(r.month || '').slice(0, 4) === year)
  const nameA = yr[0]?.person_a_name || 'A', nameB = yr[0]?.person_b_name || 'B'
  let totalA = 0, totalB = 0, net = 0
  yr.forEach((r) => { totalA += r.income_a || 0; totalB += r.income_b || 0; net += signedTransfer(r) })

  async function del(id: string | undefined) {
    if (!id) return
    if (!confirm('Delete this submission? This can’t be undone.')) return
    await salaryStore.remove(id); onReload()
  }
  function download(filename: string, text: string, type: string) {
    const blob = new Blob([text], { type })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = filename
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url)
  }
  async function exportJSON() { download('salary-submissions.json', await salaryStore.exportJSON(), 'application/json') }
  async function exportCSV() { download('salary-submissions.csv', await salaryStore.exportCSV(), 'text/csv') }
  function onImportFile(file: File | undefined) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      salaryStore.importJSON(String(reader.result)).then((added) => {
        onReload(); flashSaved()
        alert(added > 0
          ? 'Imported ' + added + ' submission' + (added === 1 ? '' : 's') + '.'
          : 'Nothing new to import — those entries are already saved.')
      }).catch((err) => alert('Import failed: ' + (err && err.message ? err.message : 'unknown error')))
    }
    reader.readAsText(file)
  }

  function detailRow(label: string, value: string) {
    return <div className="detail-row"><span className="detail-label">{label}</span><span className="detail-val">{value}</span></div>
  }

  return (
    <Modal open={open} onClose={onClose} ariaLabel="Submitted months">
      <div className="modal-head">
        <span className="modal-title">Submitted months</span>
        <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <div className="modal-body">
        {yr.length > 0 && (
          <div className="year-summary">
            <div className="year-summary-head">
              <span className="year-summary-title">{year} so far</span>
              <span className="year-summary-count">{yr.length + (yr.length === 1 ? ' month' : ' months')}</span>
            </div>
            {detailRow(nameA + ' income', fmt(totalA))}
            {detailRow(nameB + ' income', fmt(totalB))}
            {detailRow('Net settle-up', netText(net, nameA, nameB))}
          </div>
        )}
        <div className="history-list">
          {rows.length === 0 ? (
            <p className="history-empty">No months submitted yet — use “Submit this month’s salaries” to log one.</p>
          ) : rows.map((row) => {
            const open = !!expanded[row.id || '']
            const items = Array.isArray(row.income_items) ? row.income_items : []
            return (
              <div className={'history-item' + (open ? ' open' : '')} key={row.id}>
                <div className="history-head">
                  <button type="button" className="history-toggle" aria-expanded={open}
                    onClick={() => setExpanded((e) => ({ ...e, [row.id || '']: !open }))}>
                    <span className="history-month">{monthLabel(row.month)}</span>
                    <span className="history-amount">{transferText(row)}</span>
                    <span className="history-chevron" aria-hidden="true">⌄</span>
                  </button>
                  <button type="button" className="history-delete" aria-label="Delete this submission" onClick={() => del(row.id)}>×</button>
                </div>
                <div className="history-detail">
                  <div className="history-detail-inner">
                    {detailRow('Submitted', submittedLabel(row.created_at))}
                    {detailRow((row.person_a_name || 'A') + ' total', fmt(row.income_a || 0))}
                    {detailRow((row.person_b_name || 'B') + ' total', fmt(row.income_b || 0))}
                    {detailRow('Each takes home', fmt(row.equal_share || 0))}
                    {detailRow('Transfer', transferText(row))}
                    {(['a', 'b'] as const).map((owner) => {
                      const its = items.filter((it) => it.owner === owner)
                      if (!its.length) return null
                      return (
                        <div key={owner}>
                          <div className="detail-subhead">{(owner === 'b' ? (row.person_b_name || 'B') : (row.person_a_name || 'A')) + ' income'}</div>
                          {its.map((it, i) => detailRowKeyed(i, it.label || 'Income', fmt(it.amount || 0)))}
                        </div>
                      )
                    })}
                    {row.note && (
                      <>
                        <div className="detail-subhead">Note</div>
                        <p className="detail-note">{row.note}</p>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
      <div className="modal-foot modal-foot-split">
        <div className="modal-foot-actions">
          <button type="button" className="btn btn-ghost" onClick={() => importInputRef.current?.click()}>Import…</button>
          <button type="button" className="btn btn-ghost" onClick={exportCSV}>CSV</button>
          <button type="button" className="btn btn-ghost" onClick={exportJSON}>JSON</button>
        </div>
        <button type="button" className="btn" onClick={onClose}>Close</button>
        <input ref={importInputRef} type="file" accept="application/json,.json" hidden
          onChange={(e) => { onImportFile(e.target.files?.[0]); e.target.value = '' }} />
      </div>
    </Modal>
  )
}

function detailRowKeyed(key: number, label: string, value: string) {
  return <div className="detail-row" key={key}><span className="detail-label">{label}</span><span className="detail-val">{value}</span></div>
}

// ── Fullscreen chart overlay ─────────────────────────────────────────────────
function ChartOverlay({ open, onClose, result, nameA, nameB }: {
  open: boolean; onClose: () => void; result: BudgetResult; nameA: string; nameB: string
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
          <DoughnutChart result={result} nameA={nameA} nameB={nameB} />
        </div>
      </div>
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────────────────
export default function Hushallsbudget() {
  const { theme, toggleTheme } = useTheme()
  useLayoutEffect(() => { document.documentElement.classList.remove('calc-layout') }, [])

  const [state, setState] = useState<BudgetState>(() => loadBudget() || defaultState())
  const [saved, setSaved] = useState(false)
  const [justAddedId, setJustAddedId] = useState<string | null>(null)
  const [justAddedCatId, setJustAddedCatId] = useState<string | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverCatId, setDragOverCatId] = useState<string | null>(null)

  const [salaryOpen, setSalaryOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyRows, setHistoryRows] = useState<SalarySubmission[]>([])
  const [chartOpen, setChartOpen] = useState(false)

  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  function flashSaved() { setSaved(true); clearTimeout(savedTimer.current); savedTimer.current = setTimeout(() => setSaved(false), 1400) }

  // Persist (debounced) + flash "Saved ✓"; skip the initial mount.
  const firstRender = useRef(true)
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return }
    const t = setTimeout(() => { saveBudget(state); flashSaved() }, 250)
    return () => clearTimeout(t)
  }, [state])

  useEffect(() => { document.title = 'Hushållsbudget — Hemma' }, [])

  const r = useMemo(() => computeBudget(state), [state])
  const nameA = state.people[0] || 'A', nameB = state.people[1] || 'B'
  const personName = (owner: Owner) => owner === 'a' ? nameA : owner === 'b' ? nameB : 'Together'

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

  // ── Categories ─────────────────────────────────────────────────────────────
  function addCategory() {
    let id = ''
    mutate((s) => { s.catSeq = (s.catSeq || 0) + 1; id = 'c-' + s.catSeq; s.categories.push({ id, name: '' }) })
    setJustAddedCatId(id)
  }
  function setCategoryName(catId: string, name: string) {
    mutate((s) => { const c = s.categories.find((x) => x.id === catId); if (c) c.name = name })
  }
  function removeCategory(catId: string) {
    const cats = state.categories || []
    if (cats.length <= 1) { alert('Keep at least one category.'); return }
    const idx = cats.findIndex((c) => c.id === catId)
    if (idx < 0) return
    const fallback = cats[idx === 0 ? 1 : 0]
    const count = state.costs.filter((rw) => rw.owner === 'joint' && rw.category === catId).length
    if (count > 0 && !confirm('Remove "' + (cats[idx].name || 'this category') + '"? Its ' + count + ' row(s) move to "' + (fallback.name || 'another category') + '".')) return
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
  function reset() {
    if (!confirm('Reset the budget to the example data? Your current rows will be replaced.')) return
    setState(defaultState())
  }

  // ── Salary history ─────────────────────────────────────────────────────────
  const reloadHistory = useCallback(() => { salaryStore.list().then(setHistoryRows) }, [])
  function openHistory() { reloadHistory(); setHistoryOpen(true) }

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

  return (
    <div className="hb-root">
      <header className="page-header">
        <div className="header-brand">
          <Link className="hub-link" to="/">‹ Hemma</Link>
          <div>
            <h1>Hushållsbudget</h1>
            <p className="tagline">One pot, split evenly — joint &amp; individual costs for two</p>
          </div>
        </div>
        <div className="header-actions">
          <span className={'save-state' + (saved ? ' show' : '')}>Saved ✓</span>
          <button className="btn btn-ghost theme-toggle-btn" title="Toggle dark mode" aria-label="Toggle dark mode" onClick={toggleTheme}>{theme === 'dark' ? '☾' : '☀'}</button>
          <button className="btn btn-ghost" title="Reset to the example budget" onClick={reset}>Reset</button>
        </div>
      </header>

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

            <div className="who-row">
              <div className="who-field">
                <label htmlFor="personAName">Person 1</label>
                <input type="text" id="personAName" value={state.people[0]} maxLength={20} autoComplete="off"
                  onChange={(e) => mutate((s) => { s.people[0] = e.target.value })}
                  onBlur={(e) => { if (!e.target.value.trim()) mutate((s) => { s.people[0] = 'A' }) }} />
              </div>
              <span className="who-amp">&amp;</span>
              <div className="who-field">
                <label htmlFor="personBName">Person 2</label>
                <input type="text" id="personBName" value={state.people[1]} maxLength={20} autoComplete="off"
                  onChange={(e) => mutate((s) => { s.people[1] = e.target.value })}
                  onBlur={(e) => { if (!e.target.value.trim()) mutate((s) => { s.people[1] = 'B' }) }} />
              </div>
            </div>

            <div className="income-cols">
              {(['a', 'b'] as const).map((owner) => (
                <div className="income-col" key={owner}>
                  <div className="income-col-head">
                    <span className="income-col-name">{personName(owner)}</span>
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
                  <span className="pot-flow-val">{fmt(r.incomeA)}</span>
                </div>
                <span className="pot-plus">+</span>
                <div className="pot-flow-item">
                  <span className="pot-flow-label">{personName('b')} pays in</span>
                  <span className="pot-flow-val">{fmt(r.incomeB)}</span>
                </div>
              </div>
              <div className="pot-total-row">
                <span className="pot-total-label">In the pot</span>
                <span className="pot-total-val">{fmt(r.totalIncome)}</span>
              </div>
              <div className="pot-split-row">
                <span className="pot-split-label">Split evenly, you each take home</span>
                <span className="pot-split-val">{fmt(r.equalShare)}</span>
              </div>
              <div className={'pot-transfer' + (r.transfer.amount < 0.5 ? ' even' : '')}>
                <span className="pot-transfer-icon" aria-hidden="true">⇄</span>
                <span className="pot-transfer-text">
                  {r.transfer.amount < 0.5
                    ? 'Incomes are already even — nothing to transfer'
                    : <>
                        <strong>{personName(r.transfer.from)}</strong> pays <strong>{personName(r.transfer.to)}</strong>{' '}
                        <strong className="pot-transfer-amount">{fmt(r.transfer.amount)}</strong>
                      </>}
                </span>
              </div>
              {r.incomeJoint > 0 && (
                <p className="pot-transfer-note">Joint income ({fmt(r.incomeJoint)}) is then shared 50/50 on top — you each take home {fmt(r.equalShare)}.</p>
              )}
            </div>

            <div className="pot-actions">
              <button type="button" className="btn btn-primary" onClick={() => setSalaryOpen(true)}>Submit this month’s salaries</button>
              <button type="button" className="btn btn-ghost" onClick={openHistory}>History</button>
            </div>
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
            <div className="cat-cards">
              {state.categories.map((cat) => (
                <div key={cat.id} className={'cat-card' + (dragOverCatId === cat.id ? ' drag-over' : '')}
                  onDragOver={(e) => onCatDragOver(e, cat.id)} onDragLeave={() => setDragOverCatId((c) => (c === cat.id ? null : c))}>
                  <div className="cat-head">
                    <input type="text" className="cat-name" value={cat.name} placeholder="Category name" aria-label="Category name"
                      autoFocus={cat.id === justAddedCatId} onChange={(e) => setCategoryName(cat.id, e.target.value)} />
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
                    <span className="owner-block-title">{personName(owner)}</span>
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
                    <span className="owner-block-title">{personName(owner)}</span>
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
            <div className={'sum-big' + posNeg(r.surplus)}>{fmtSigned(r.surplus)}</div>
            <div className="sum-card-subtitle">across the whole household, each month</div>
            <div className="flow-bar" role="img" aria-label="How the pot is spent">
              <span className="flow-seg flow-joint" style={{ width: pctW(flowPcts.joint) }} />
              <span className="flow-seg flow-own" style={{ width: pctW(flowPcts.own) }} />
              <span className="flow-seg flow-sav" style={{ width: pctW(flowPcts.sav) }} />
              <span className="flow-seg flow-left" style={{ width: pctW(flowPcts.left) }} />
            </div>
            <div className="flow-legend">
              <span className="flow-key"><span className="flow-dot flow-joint" />Joint <em>{fmt(r.costsJoint)}</em></span>
              <span className="flow-key"><span className="flow-dot flow-own" />Own <em>{fmt(r.costsA + r.costsB)}</em></span>
              <span className="flow-key"><span className="flow-dot flow-sav" />Savings <em>{fmt(r.totalSavings)}</em></span>
              <span className="flow-key"><span className="flow-dot flow-left" />Left <em>{fmt(Math.max(0, r.surplus))}</em></span>
            </div>
            <div className="sum-rows">
              <div className="sum-row"><span className="sum-row-label">Total income</span><span className="sum-row-val">{fmt(r.totalIncome)}</span></div>
              <div className="sum-row"><span className="sum-row-label">Total costs</span><span className="sum-row-val">{fmt(r.totalCosts)}</span></div>
              <div className="sum-row"><span className="sum-row-label">Total savings</span><span className="sum-row-val">{fmt(r.totalSavings)}</span></div>
            </div>
          </div>

          <div className="sum-card">
            <div className="sum-card-title">Each of you, after the split</div>
            <div className="compare-grid">
              <span className="compare-corner" aria-hidden="true" />
              <span className="compare-head">{nameA}</span>
              <span className="compare-head">{nameB}</span>

              <span className="compare-label">Take-home</span>
              <span className="compare-val">{fmt(r.personA.ownIncome + r.personA.potNet)}</span>
              <span className="compare-val">{fmt(r.personB.ownIncome + r.personB.potNet)}</span>

              <span className="compare-label">Joint costs ½</span>
              <span className="compare-val">−{fmt(r.personA.jointCostShare)}</span>
              <span className="compare-val">−{fmt(r.personB.jointCostShare)}</span>

              <span className="compare-label">Own costs</span>
              <span className="compare-val">−{fmt(r.personA.ownCosts)}</span>
              <span className="compare-val">−{fmt(r.personB.ownCosts)}</span>

              <span className="compare-label">Savings</span>
              <span className="compare-val">−{fmt(r.personA.jointSavingsShare + r.personA.ownSavings)}</span>
              <span className="compare-val">−{fmt(r.personB.jointSavingsShare + r.personB.ownSavings)}</span>

              <span className="compare-label compare-foot-label">Left to spend</span>
              <span className={'compare-val compare-foot' + posNeg(r.personA.leftover)}>{fmtSigned(r.personA.leftover)}</span>
              <span className={'compare-val compare-foot' + posNeg(r.personB.leftover)}>{fmtSigned(r.personB.leftover)}</span>
            </div>
            <div className="compare-household">
              <span className="compare-household-label">Household cashflow</span>
              <span className={'compare-household-val' + posNeg(householdLeft)}>{fmtSigned(householdLeft)}</span>
            </div>
          </div>

          <hr className="sum-divider" />

          <div className="sum-card">
            <div className="sum-card-title">The pot</div>
            <div className="sum-big">{fmt(r.equalShare)}</div>
            <div className="sum-card-subtitle">take-home each, after the split</div>
            <div className="sum-rows">
              <div className="sum-row"><span className="sum-row-label">{nameA}</span><span className="sum-row-val">{fmt(r.incomeA)}</span></div>
              <div className="sum-row"><span className="sum-row-label">{nameB}</span><span className="sum-row-val">{fmt(r.incomeB)}</span></div>
            </div>
          </div>

          <div className="sum-card">
            <div className="sum-card-title chart-head">
              Where the pot goes
              <button type="button" className="chart-expand-btn" title="View full screen" aria-label="View chart full screen" onClick={() => setChartOpen(true)}>⤢</button>
            </div>
            <div className="chart-wrap">
              <DoughnutChart result={r} nameA={nameA} nameB={nameB} />
            </div>
          </div>

          <div className="sum-card">
            <div className="sum-card-title">Savings rate</div>
            <div className="sum-big positive">{(r.savingsRate * 100).toFixed(1)}%</div>
            <div className="sum-card-subtitle">of total household income</div>
            <div className="sum-rows">
              <div className="sum-row"><span className="sum-row-label">{nameA}</span><span className="sum-row-val">{fmt(r.savingsA)}</span></div>
              <div className="sum-row"><span className="sum-row-label">{nameB}</span><span className="sum-row-val">{fmt(r.savingsB)}</span></div>
            </div>
          </div>

        </div>
      </div>

      {/* Mobile key-figures bar */}
      <div className="mobile-bar">
        <div className="mobile-bar-inner">
          <div className="mobile-stat">
            <span className="mobile-stat-label">Take-home each</span>
            <span className="mobile-stat-val">{fmt(r.equalShare)}</span>
          </div>
          <div className="mobile-stat">
            <span className="mobile-stat-label">Left over</span>
            <span className={'mobile-stat-val' + posNeg(r.surplus)}>{fmtSigned(r.surplus)}</span>
          </div>
        </div>
      </div>

      <SalaryModal open={salaryOpen} onClose={() => setSalaryOpen(false)} people={state.people} incomes={state.incomes}
        flashSaved={flashSaved} onHistoryChanged={() => { if (historyOpen) reloadHistory() }} />
      <HistoryModal open={historyOpen} onClose={() => setHistoryOpen(false)} rows={historyRows} onReload={reloadHistory} flashSaved={flashSaved} />
      <ChartOverlay open={chartOpen} onClose={() => setChartOpen(false)} result={r} nameA={nameA} nameB={nameB} />
    </div>
  )
}
