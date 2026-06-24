import { useMemo } from 'react'
import { ParentSize } from '@visx/responsive'
import type { Inputs } from '../../lib/calc'
import { equitySeries } from './chartData'
import { useChartTheme } from './useChartTheme'
import LineAreaChart, { type SeriesDef } from './LineAreaChart'

/** Equity (kr) accumulating as the new mortgage amortises, capped at price. */
export default function EquityChart({ inputs, compact }: { inputs: Inputs; compact?: boolean }) {
  const theme = useChartTheme()
  const data = useMemo(() => equitySeries(inputs), [inputs])

  const series: SeriesDef[] = [
    { key: 'equity', label: 'Equity', color: theme.accent, values: data.map((p) => p.equity), area: true, strokeWidth: 2.5 },
  ]

  return (
    <ParentSize>
      {({ width, height }) => (
        <LineAreaChart
          width={width}
          height={height}
          compact={compact}
          theme={theme}
          idPrefix="equity"
          xValues={data.map((p) => p.year)}
          series={series}
          formatXAxis={(x) => String(x)}
          formatYAxis={(y) => (y / 1e6).toFixed(1) + ' Mkr'}
          formatXTooltip={(x) => `Year ${x}`}
          ariaLabel="Equity growth: equity in kronor building up year by year"
        />
      )}
    </ParentSize>
  )
}
