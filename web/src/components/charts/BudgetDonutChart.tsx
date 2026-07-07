import { useMemo, useState } from 'react'
import { Pie } from '@visx/shape'
import { Group } from '@visx/group'
import { ParentSize } from '@visx/responsive'
import { useChartTokens } from './useChartTheme'

// Editorial donut for "where the pot goes" — the visx replacement for the old
// Chart.js doughnut. Segment colours come from the budget's own palette
// (--cat-* live on `.hb-root`, not :root), re-read whenever the theme flips.
// Hovering an arc (or its legend chip) dims the rest and pulls that slice's
// label + share into the centre.

export interface DonutSegment {
  label: string
  value: number
  /** CSS custom-property name resolved off `.hb-root`, e.g. '--cat-1'. */
  token: string
}

export default function BudgetDonutChart({
  segments,
  formatMoney,
  centerLabel,
  centerValue,
}: {
  segments: DonutSegment[]
  formatMoney: (n: number) => string
  centerLabel: string
  centerValue: number
}) {
  const [active, setActive] = useState<number | null>(null)

  // Segment colours + the slice stroke (paper) live on the `.hb-root` scope,
  // not :root — resolve them via each segment's own token.
  const tokens = useMemo(() => {
    const map: Record<string, string> = { paper: '--paper-card' }
    segments.forEach((s, i) => (map[`seg${i}`] = s.token))
    return map
  }, [segments])
  const resolved = useChartTokens(tokens, { scope: '.hb-root' })
  const colors = useMemo(
    () => ({
      seg: segments.map((_, i) => resolved[`seg${i}`] || 'var(--ink-faint)'),
      paper: resolved.paper || '#fff',
    }),
    [segments, resolved],
  )

  const total = segments.reduce((t, s) => t + s.value, 0)
  const hovered = active != null ? segments[active] : null
  const shownLabel = hovered ? hovered.label : centerLabel
  const shownValue = hovered ? hovered.value : centerValue
  const shownPct = hovered && total > 0 ? Math.round((hovered.value / total) * 100) : null

  return (
    <div className="hb-donut">
      <div className="hb-donut-canvas">
        <ParentSize>
          {({ width, height }) => {
            if (width < 10 || height < 10) return null
            const radius = Math.min(width, height) / 2
            const inner = radius * 0.62
            // Centre text scales with the ring so it stays inside the hole in
            // the small inline card and grows in the fullscreen view.
            const valueFont = Math.max(13, Math.min(30, radius * 0.22))
            const labelFont = Math.max(9, Math.min(15, radius * 0.1))
            const subFont = Math.max(9, Math.min(13, radius * 0.09))
            return (
              <svg width={width} height={height} role="img" aria-label="Where the pot goes">
                <Group top={height / 2} left={width / 2}>
                  <Pie
                    data={segments}
                    pieValue={(d) => d.value}
                    pieSortValues={null}
                    outerRadius={radius - 2}
                    innerRadius={inner}
                    padAngle={0.014}
                    cornerRadius={3}
                  >
                    {(pie) =>
                      pie.arcs.map((arc, i) => {
                        const dimmed = active != null && active !== i
                        return (
                          <path
                            key={i}
                            d={pie.path(arc) || ''}
                            fill={colors.seg[i]}
                            stroke={colors.paper}
                            strokeWidth={2}
                            opacity={dimmed ? 0.4 : 1}
                            style={{ transition: 'opacity 0.18s ease' }}
                            onMouseEnter={() => setActive(i)}
                            onMouseMove={() => setActive(i)}
                            onMouseLeave={() => setActive(null)}
                          />
                        )
                      })
                    }
                  </Pie>
                  <text
                    textAnchor="middle"
                    className="hb-donut-center-label"
                    style={{ fontSize: labelFont }}
                    y={shownPct != null ? -valueFont * 0.62 : -valueFont * 0.28}
                  >
                    {shownLabel}
                  </text>
                  <text
                    textAnchor="middle"
                    className="hb-donut-center-value"
                    style={{ fontSize: valueFont }}
                    y={shownPct != null ? valueFont * 0.42 : valueFont * 0.5}
                  >
                    {formatMoney(shownValue)}
                  </text>
                  {shownPct != null && (
                    <text
                      textAnchor="middle"
                      className="hb-donut-center-sub"
                      style={{ fontSize: subFont }}
                      y={valueFont * 0.42 + subFont * 1.5}
                    >
                      {shownPct}% of the pot
                    </text>
                  )}
                </Group>
              </svg>
            )
          }}
        </ParentSize>
      </div>
      <div className="hb-donut-legend">
        {segments.map((s, i) => (
          <button
            type="button"
            key={s.label + i}
            className={'hb-donut-key' + (active === i ? ' active' : '')}
            onMouseEnter={() => setActive(i)}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(i)}
            onBlur={() => setActive(null)}
          >
            <span className="hb-donut-swatch" style={{ background: colors.seg[i] }} />
            <span className="hb-donut-key-label">{s.label}</span>
            <span className="hb-donut-key-val">{formatMoney(s.value)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
