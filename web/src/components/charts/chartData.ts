// Pure series builders that turn Inputs into the arrays the visx charts draw.
// Kept separate from the chart components (which stay dumb) and from calc.ts
// (which returns scalar figures), and unit-tested alongside the golden figures.

import { buildAmortSchedule, stressAt, type AmortPoint, type Inputs } from '../../lib/calc'

export interface AmortSeries {
  years: number[]
  current: (number | null)[] // null before payoff origin / after schedule ends handled as 0
  next: (number | null)[]
  currentPayoff: number | null // year the current mortgage hits 0 (or term cap)
  nextPayoff: number | null
  maxYear: number
}

// Balance at a given year: exact point if present, 0 once the schedule has
// ended (paid off), else null (shouldn't happen for year 0..maxYear).
function balanceAt(schedule: AmortPoint[], year: number): number | null {
  const pt = schedule.find((p) => p.year === year)
  if (pt) return pt.balance
  return schedule[schedule.length - 1].year < year ? 0 : null
}

function payoffYear(schedule: AmortPoint[]): number | null {
  const pt = schedule.find((p) => p.balance === 0)
  return pt ? pt.year : null
}

/** Current vs new mortgage remaining-balance over time — the payoff comparison. */
export function amortSeries(i: Inputs): AmortSeries {
  const newBalance = Math.max(0, i.newPrice - i.deposit)
  const currentSchedule = buildAmortSchedule(i.currentMortgage, Math.max(i.currentAmortRate, 0.01), [], i.currentTerm)
  const newSchedule = buildAmortSchedule(newBalance, Math.max(i.amortRate, 0.01), [], 60)

  const maxYear = Math.max(
    currentSchedule[currentSchedule.length - 1].year,
    newSchedule[newSchedule.length - 1].year,
  )
  const years = Array.from({ length: maxYear + 1 }, (_, y) => y)

  return {
    years,
    current: years.map((y) => balanceAt(currentSchedule, y)),
    next: years.map((y) => balanceAt(newSchedule, y)),
    currentPayoff: payoffYear(currentSchedule) ?? (i.currentTerm > 0 ? i.currentTerm : null),
    nextPayoff: payoffYear(newSchedule),
    maxYear,
  }
}

export interface EquityPoint {
  year: number
  equity: number // kr of equity (deposit + amortised principal), capped at price
}

/** Equity (kr) building up as the new mortgage amortises, capped at purchase price. */
export function equitySeries(i: Inputs, horizon = 30): EquityPoint[] {
  const loanAmount = Math.max(0, i.newPrice - i.deposit)
  const annualAmort = loanAmount * (i.amortRate / 100)
  const fullYear = annualAmort > 0 ? Math.ceil(loanAmount / annualAmort) : horizon
  const end = Math.min(Math.max(fullYear, 1), horizon)
  return Array.from({ length: end + 1 }, (_, year) => ({
    year,
    equity: Math.min(i.deposit + annualAmort * year, i.newPrice),
  }))
}

export interface StressPoint {
  rate: number // %
  total: number // total monthly cost
  afterRelief: number // after ränteavdrag
}

/** Total monthly cost across the interest-rate range — the stress curve. */
export function stressSeries(i: Inputs, lo = 0.5, hi = 12, step = 0.25): StressPoint[] {
  const points: StressPoint[] = []
  // Avoid float drift on the loop bound by stepping an integer count.
  const count = Math.round((hi - lo) / step)
  for (let n = 0; n <= count; n++) {
    const rate = lo + n * step
    const s = stressAt(i, rate)
    points.push({ rate, total: s.total, afterRelief: s.afterRelief })
  }
  return points
}
