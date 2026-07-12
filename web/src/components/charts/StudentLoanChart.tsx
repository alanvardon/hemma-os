import { useMemo } from 'react'
import { ParentSize } from '@visx/responsive'
import { simulateStrategy, type BalancePoint, type StudentLoanInputs, type StudentLoanResult } from '../../lib/studentloan'
import { useChartTheme } from './useChartTheme'
import LineAreaChart, { type SeriesDef } from './LineAreaChart'

// Sample a (possibly sparse, possibly multi-point-per-year) balance series
// onto a shared annual x-axis: for each target year, take the LAST point at
// or before that year (so a same-year payoff drop — two points sharing a
// year, the balance falling to 0 — resolves to the post-payoff value, not the
// pre-payoff one). `null` before the series starts (shouldn't happen here
// since every strategy starts at current_year).
function sampleAtYears(series: BalancePoint[], years: number[]): (number | null)[] {
  return years.map((y) => {
    let val: number | null = null
    for (const p of series) {
      if (p.year <= y) val = p.balance_gbp
      else break
    }
    return val
  })
}

/** Balance-over-time (£) for the three strategies, write-off year marked.
 *  Ride-it-out reuses the engine's own series; pay-now / pay-at-optimal are
 *  derived by re-running the pure `simulateStrategy` export with a lump month
 *  — no duplicate math, same contract the engine already exposes. */
export default function StudentLoanChart({
  inputs,
  result,
  compact,
}: {
  inputs: StudentLoanInputs
  result: StudentLoanResult
  compact?: boolean
}) {
  const theme = useChartTheme()

  const { years, rideValues, nowValues, optimalValues } = useMemo(() => {
    const start = inputs.current_year
    const end = Math.max(start, result.writeoff_year)
    const yrs = Array.from({ length: end - start + 1 }, (_, i) => start + i)

    const nowSeries = simulateStrategy(inputs, 0, true).series
    const optimalSeries =
      result.optimal_month_index != null ? simulateStrategy(inputs, result.optimal_month_index, true).series : null

    return {
      years: yrs,
      rideValues: sampleAtYears(result.balance_series, yrs),
      nowValues: sampleAtYears(nowSeries, yrs),
      optimalValues: optimalSeries ? sampleAtYears(optimalSeries, yrs) : null,
    }
  }, [inputs, result])

  const series: SeriesDef[] = [
    { key: 'ride', label: 'Ride it out', color: theme.accent, values: rideValues, area: true, strokeWidth: 2.5 },
    { key: 'now', label: 'Pay off now', color: theme.warn, values: nowValues, dashed: true, strokeWidth: 2 },
  ]
  if (optimalValues) {
    series.push({
      key: 'optimal',
      label: 'Pay off at optimal date',
      color: theme.accentLight,
      values: optimalValues,
      dashed: true,
      strokeWidth: 2,
    })
  }

  return (
    <ParentSize>
      {({ width, height }) => (
        <LineAreaChart
          width={width}
          height={height}
          compact={compact}
          theme={theme}
          idPrefix="studentloan"
          xValues={years}
          series={series}
          marker={{ x: result.writeoff_year }}
          formatXAxis={(x) => String(x)}
          formatYAxis={(y) => '£' + Math.round(y / 1000) + 'k'}
          formatXTooltip={(x) => `Year ${x}`}
          formatYTooltip={(y) => '£' + Math.round(y).toLocaleString('en-GB')}
          ariaLabel="Loan balance over time: ride it out vs pay off now vs pay off at the optimal date, write-off year marked"
        />
      )}
    </ParentSize>
  )
}
