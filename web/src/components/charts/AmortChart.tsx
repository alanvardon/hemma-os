import { useMemo } from 'react'
import { ParentSize } from '@visx/responsive'
import type { Inputs } from '../../lib/calc'
import { amortSeries } from './chartData'
import { useChartTheme } from './useChartTheme'
import LineAreaChart, { type SeriesDef } from './LineAreaChart'

/** Remaining-balance payoff comparison: new vs current mortgage over time. */
export default function AmortChart({ inputs, compact }: { inputs: Inputs; compact?: boolean }) {
  const theme = useChartTheme()
  const data = useMemo(() => amortSeries(inputs), [inputs])

  const series: SeriesDef[] = [
    { key: 'next', label: 'New mortgage', color: theme.accent, values: data.next, area: true, strokeWidth: 2.5 },
    { key: 'current', label: 'Current mortgage', color: theme.warnLight, values: data.current, dashed: true, strokeWidth: 2 },
  ]

  return (
    <ParentSize>
      {({ width, height }) => (
        <LineAreaChart
          width={width}
          height={height}
          compact={compact}
          theme={theme}
          idPrefix="amort"
          xValues={data.years}
          series={series}
          formatXAxis={(x) => String(x)}
          formatYAxis={(y) => (y / 1e6).toFixed(1) + ' Mkr'}
          formatXTooltip={(x) => `Year ${x}`}
          ariaLabel="Mortgage payoff: new versus current mortgage balance over the years"
        />
      )}
    </ParentSize>
  )
}
