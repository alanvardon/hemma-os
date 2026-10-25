// loner-labels.ts — Swedish display helpers shared by Löner and the compact
// "Löner för <månad>" row in Hushållsbudget (plan 139). Display only: no
// financial logic (that lives in lib/loner.ts and lib/hushallsbudget.ts).
import { money as fmt } from '../lib/hushallsbudget'
import type { SalarySubmission } from '../lib/hushallsbudget'
import type { MonthView, Slot } from '../lib/loner'

const MONTHS_SV = [
  'januari', 'februari', 'mars', 'april', 'maj', 'juni',
  'juli', 'augusti', 'september', 'oktober', 'november', 'december',
]
const MONTHS_SHORT_SV = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec']

export function currentMonth(): string { return new Date().toISOString().slice(0, 7) } // YYYY-MM

/** "oktober 2026". */
export function monthLabel(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym || '')
  if (!m) return ym || '—'
  return (MONTHS_SV[parseInt(m[2], 10) - 1] || '?') + ' ' + m[1]
}

/** "3 okt" from an ISO date or timestamp; '' when unparseable. Display only. */
export function shortDate(iso: string | null | undefined): string {
  const date = iso ? new Date(iso) : null
  if (!date || Number.isNaN(date.getTime())) return ''
  return date.getDate() + ' ' + MONTHS_SHORT_SV[date.getMonth()]
}

/** True when the row was edited after it was created (D4): updated_at later
    than created_at by more than 60 s, absorbing insert/trigger skew. */
export function wasEdited(row: SalarySubmission): boolean {
  if (!row.updated_at || !row.created_at) return false
  const updated = Date.parse(row.updated_at)
  const created = Date.parse(row.created_at)
  return Number.isFinite(updated) && Number.isFinite(created) && updated - created > 60_000
}

/** Swedish genitive: "Sams", but "Lars" and "Max" stay as they are. */
export function genitive(name: string): string {
  return /[sxz]$/i.test(name) ? name : name + 's'
}

/** "Anna betalar Bo 4 250 kr" / "Jämnt — ingen överföring". Full precision
    stays in the row; the whole-krona rounding is fmt's. */
export function transferSentence(row: SalarySubmission): string {
  if ((row.transfer_amount || 0) < 0.5) return 'Jämnt — ingen överföring'
  const from = row.transfer_from === 'b' ? (row.person_b_name || 'B') : (row.person_a_name || 'A')
  const to = row.transfer_to === 'b' ? (row.person_b_name || 'B') : (row.person_a_name || 'A')
  return `${from} betalar ${to} ${fmt(row.transfer_amount)}`
}

/** Short month status for chips and the Hushållsbudget row. Never carries a
    transfer figure for a month that is not complete. */
export function monthStatusText(view: MonthView, nameOf: (slot: Slot) => string): string {
  switch (view.status) {
    case 'complete': return 'Klar'
    case 'zero_total': return 'Summan är 0 kr'
    case 'waiting': {
      const missing = (['a', 'b'] as const).filter((slot) => !view.halves[slot])
      return missing.length === 1 ? `Väntar på ${nameOf(missing[0])}` : 'Väntar på att månaden slutförs'
    }
    default: return 'Ej inskickad'
  }
}
