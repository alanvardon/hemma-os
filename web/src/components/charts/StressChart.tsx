import { useMemo } from 'react'
import { ParentSize } from '@visx/responsive'
import type { Inputs } from '../../lib/calc'
import { stressSeries } from './chartData'
import { useChartTheme } from './useChartTheme'
import LineAreaChart, { type SeriesDef } from './LineAreaChart'

/** Total monthly cost across the interest-rate range, with a marker at `rate`. */
export default function StressChart({
  inputs,
  rate,
  compact,
}: {
  inputs: Inputs
  rate?: number
  compact?: boolean
}) {
  const theme = useChartTheme()
  const data = useMemo(() => stressSeries(inputs), [inputs])

  const series: SeriesDef[] = [
    { key: 'total', label: 'Total monthly', color: theme.accent, values: data.map((p) => p.total), area: true, strokeWidth: 2.5 },
    { key: 'afterRelief', label: 'After ränteavdrag', color: theme.accentLight, values: data.map((p) => p.afterRelief), dashed: true, strokeWidth: 2 },
  ]

  return (
    <ParentSize>
      {({ width, height }) => (
        <LineAreaChart
          width={width}
          height={height}
          compact={compact}
          theme={theme}
          idPrefix="stress"
          xValues={data.map((p) => p.rate)}
          series={series}
          marker={rate != null ? { x: rate } : undefined}
          formatXAxis={(x) => x + '%'}
          formatYAxis={(y) => Math.round(y / 1000) + 'k'}
          formatXTooltip={(x) => x.toFixed(2) + '% interest'}
          ariaLabel="Interest-rate stress test: total monthly cost across rates"
        />
      )}
    </ParentSize>
  )
}
