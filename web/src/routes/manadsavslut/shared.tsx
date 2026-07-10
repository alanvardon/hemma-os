import { parseAmount, inferSpendSign, flagDuplicates } from '../../lib/manadsavslut'
import type { Item, Person, Treatment, CsvResult, ColMapping } from '../../lib/manadsavslut'
import { Money } from '../../components/AnimatedNumber'
import { CURRENCY_SUFFIX } from '../../lib/format'

// ── Formatters (faithful to manadsavslut.js) ─────────────────────────────────

export const currencyState = { current: 'SEK' }
export function fmtMoney(n: number): string {
  const num = Number(n) || 0
  const hasOre = Math.abs(num - Math.round(num)) > 0.005
  const suffix = CURRENCY_SUFFIX[currencyState.current] || 'kr'
  return num.toLocaleString('sv-SE', { minimumFractionDigits: hasOre ? 2 : 0, maximumFractionDigits: 2 }) + ' ' + suffix
}
// Animated equivalent for the SUMMARY figures (balance headline, insight amount,
// category bar values) — these are heroes, so they round to whole kr (see
// formatHeroKr's contract in lib/format.ts). Data tables, the triage and the
// settlement transfer line keep exact öre via fmtMoney / Money maxDecimals={2}.
export function M(value: number) {
  return <Money value={value} currencySuffix={CURRENCY_SUFFIX[currencyState.current] || 'kr'} />
}
export const clean = (v: unknown) => String(v == null ? '' : v).trim()
export const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100
export function defaultPeriodLabel(): string {
  try { const s = new Date().toLocaleDateString('sv-SE', { month: 'long', year: 'numeric' }); return s.charAt(0).toUpperCase() + s.slice(1) } catch { return '' }
}

// ── Triage (import) ──────────────────────────────────────────────────────────

export interface TriageRow { classification: Treatment; kind: 'charge' | 'refund' | 'noamount'; charge: number; duplicate: boolean }
export interface ImportCfg { file: File; parsed: CsvResult; mapping: ColMapping; frontedBy: Person; triage: TriageRow[] }

export function cellAt(row: string[], idx: number | null): string { return idx == null ? '' : (row[idx] == null ? '' : row[idx]) }

// Derive { kind, charge, duplicate } for each parsed row against the current
// mapping + chosen card. Classification is preserved by the caller.
export function deriveTriage(parsed: CsvResult, mapping: ColMapping, frontedBy: Person, existing: Item[]): Omit<TriageRow, 'classification'>[] {
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
