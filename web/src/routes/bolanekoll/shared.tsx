import { type ReactNode } from 'react'
import { motion } from 'motion/react'
import { Money, Percent } from '../../components/AnimatedNumber'
import { CURRENCY_SUFFIX } from '../../lib/format'
import { monthKey, monthLabel } from '../../lib/mortgage'
import type { Payment, CsvResult, ColMapping } from '../../lib/mortgage'

// A <tr> can't animate its own height, so revealed rows animate it inside each
// cell instead: the td keeps zero vertical padding (see .cell-pad in CSS) and
// this wrapper tweens the content 0 ↔ auto, so the whole row genuinely grows
// and shrinks rather than popping in at full height with only a fade.
export function CellReveal({ reduce, children }: { reduce: boolean | null; children?: ReactNode }) {
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

// Kind 'payment' is the bank's per-part "Betalning" — the TOTAL debited,
// ränta included. Kind 'amortization' is genuine principal (manual rows,
// insatser), so it keeps the label 'Amortering'.
const KIND_LABELS: Record<string, string> = { interest: 'Ränta', amortization: 'Amortering', payment: 'Betalning', down_payment: 'Kontantinsats', loan: 'Lån', fee: 'Avgift', other: 'Övrigt' }
export function kindLabel(k: string): string { return KIND_LABELS[k] || k || '—' }

// Payments ledger discloses by calendar month rather than a fixed row page
// (plan 115): one bucket per YYYY-MM, newest first. A legacy row with no
// usable date lands in one shared fallback bucket instead of vanishing.
export interface PayBucket { key: string; label: string; rows: Payment[] }

// Groups the ledger into month buckets WITHOUT re-sorting the rows themselves:
// each bucket keeps its rows in the order they arrived, so the store's
// newest-first date order and created_at tie-break survive within a month. The
// dated buckets are then ordered newest month first by their YYYY-MM key —
// chronological because the keys are zero-padded — so the newest populated
// month leads regardless of the caller's row order (the store already delivers
// newest-first; deriving it here keeps the disclosure correct even if it
// doesn't). A calendar month with zero matching rows never produces an empty
// bucket, so "one more month" always reveals real data. Undated rows form one
// shared fallback bucket appended last, after every dated month, instead of
// vanishing.
export function buildPayBuckets(rows: Payment[]): PayBucket[] {
  const byKey = new Map<string, PayBucket>()
  const undated: Payment[] = []
  for (const p of rows) {
    const mk = monthKey(p.date)
    if (!mk) { undated.push(p); continue }
    let bucket = byKey.get(mk)
    if (!bucket) { bucket = { key: mk, label: monthLabel(mk), rows: [] }; byKey.set(mk, bucket) }
    bucket.rows.push(p)
  }
  const buckets = [...byKey.values()].sort((a, b) => b.key.localeCompare(a.key))
  if (undated.length) buckets.push({ key: '', label: monthLabel(''), rows: undated })
  return buckets
}

export function periodFrom(period: string): string | null {
  const d = new Date(), p = (n: number) => (n < 10 ? '0' : '') + n
  if (period === 'ytd') return d.getFullYear() + '-01-01'
  if (period === '12m') { d.setFullYear(d.getFullYear() - 1); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) }
  return null
}
export function monthsToWhen(months: number | null): string {
  if (months == null) return '—'
  if (months <= 0) return 'nu · now'
  const d = new Date(); d.setMonth(d.getMonth() + months)
  const s = d.toLocaleDateString('sv-SE', { month: 'short', year: 'numeric' })
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// ── Sub-types ────────────────────────────────────────────────────────────────

export interface TriageRow {
  classification: 'include' | 'skip'
  specText: string; date: string; kind: Payment['kind']; amount: number; balance_after: number | null
  hasAmount: boolean; loan_part_id: string | null; partMatched: boolean; duplicate: boolean
  // Forecast reconcile (plan 23): how this interest row compares to the
  // expected charge — predicted:true when it will supersede a logged
  // source:'predicted' row, false for the read-only ✓/⚠ badge. null = n/a.
  recon: { drift: number; ok: boolean; predicted: boolean } | null
}
export interface ImportCfg {
  file: File; parsed: CsvResult; mapping: ColMapping; importPart: string
  triage: TriageRow[]; queue: File[]; qIdx: number
}

// ── Money formatter bound to currency at module scope via a mutable ref ──────
// (formatMoney needs the active currency; keep a module-level setter updated by
// the component so plain helpers can format without threading currency through.)
export const currencyState = { current: 'SEK' }
export function fmtMoney(n: number): string {
  const suffix = CURRENCY_SUFFIX[currencyState.current] || 'kr'
  return (Math.round(Number(n) || 0)).toLocaleString('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' ' + suffix
}
export function fmtPct(n: number): string { return (Number(n) || 0).toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' %' }

// Animated equivalents for the SUMMARY figures (dashboard, bridge, insights).
// Data-table cells, the import triage and prose keep the plain string formatters
// above (long ledgers shouldn't roll on every keystroke).
export function M(value: number, signed?: boolean, rollIn?: boolean) {
  return <Money value={value} currencySuffix={CURRENCY_SUFFIX[currencyState.current] || 'kr'} signed={signed} rollIn={rollIn} />
}
export function P(value: number, rollIn?: boolean) { return <Percent value={value} decimals={2} space locale="sv-SE" rollIn={rollIn} /> }
