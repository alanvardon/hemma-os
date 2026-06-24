import { useChartTheme, type ChartTheme } from './useChartTheme'

export interface LegendItem {
  label: string
  token: keyof ChartTheme
  dashed?: boolean
}

/** Small swatch legend for the fullscreen charts, coloured from the live theme. */
export default function ChartLegend({ items }: { items: LegendItem[] }) {
  const theme = useChartTheme()
  return (
    <div className="chart-legend">
      {items.map((it) => (
        <span key={it.label} className="chart-legend-item">
          <span
            className={it.dashed ? 'chart-legend-swatch dashed' : 'chart-legend-swatch'}
            style={{ background: it.dashed ? 'transparent' : theme[it.token], borderColor: theme[it.token] }}
          />
          {it.label}
        </span>
      ))}
    </div>
  )
}
