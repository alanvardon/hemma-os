import { useMemo, useCallback, type ReactNode } from 'react'
import { Group } from '@visx/group'
import { scaleLinear } from '@visx/scale'
import { LinePath, AreaClosed, Line, Bar } from '@visx/shape'
import { AxisBottom, AxisLeft } from '@visx/axis'
import { GridRows } from '@visx/grid'
import { LinearGradient } from '@visx/gradient'
import { curveMonotoneX } from '@visx/curve'
import { useTooltip } from '@visx/tooltip'
import { localPoint } from '@visx/event'
import type { ChartTheme } from './useChartTheme'

export interface SeriesDef {
  key: string
  label: string
  color: string
  values: (number | null)[] // aligned 1:1 with xValues
  area?: boolean // draw a gradient area under the line
  dashed?: boolean
  strokeWidth?: number
}

interface Props {
  width: number
  height: number
  compact?: boolean
  theme: ChartTheme
  /** Unique per chart instance — namespaces the gradient defs. */
  idPrefix: string
  xValues: number[]
  series: SeriesDef[]
  yMin?: number
  marker?: { x: number; label?: string }
  formatXAxis?: (x: number) => string
  formatYAxis?: (y: number) => string
  formatXTooltip?: (x: number) => string
  formatYTooltip?: (y: number) => string
  ariaLabel: string
}

interface TipDatum {
  index: number
  x: number
}

export default function LineAreaChart({
  width,
  height,
  compact = false,
  theme,
  idPrefix,
  xValues,
  series,
  yMin = 0,
  marker,
  formatXAxis = (x) => String(x),
  formatYAxis = (y) => String(y),
  formatXTooltip,
  formatYTooltip = (y) => Math.round(y).toLocaleString('sv-SE') + ' kr',
  ariaLabel,
}: Props) {
  const m = compact
    ? { top: 4, right: 4, bottom: 4, left: 4 }
    : { top: 16, right: 22, bottom: 38, left: 60 }
  const innerW = Math.max(0, width - m.left - m.right)
  const innerH = Math.max(0, height - m.top - m.bottom)

  const xMin = xValues[0] ?? 0
  const xMax = xValues[xValues.length - 1] ?? 1
  const yMax = useMemo(() => {
    let max = 0
    for (const s of series) for (const v of s.values) if (v != null && v > max) max = v
    return max * 1.06 || 1
  }, [series])

  const xScale = useMemo(
    () => scaleLinear<number>({ domain: [xMin, xMax], range: [0, innerW] }),
    [xMin, xMax, innerW],
  )
  const yScale = useMemo(
    () => scaleLinear<number>({ domain: [yMin, yMax], range: [innerH, 0], nice: !compact }),
    [yMin, yMax, innerH, compact],
  )

  const {
    tooltipData,
    tooltipLeft,
    tooltipTop,
    tooltipOpen,
    showTooltip,
    hideTooltip,
  } = useTooltip<TipDatum>()

  const handleMove = useCallback(
    (event: React.MouseEvent | React.TouchEvent) => {
      const point = localPoint(event)
      if (!point) return
      const xVal = xScale.invert(point.x - m.left)
      // nearest index in xValues
      let nearest = 0
      let best = Infinity
      for (let i = 0; i < xValues.length; i++) {
        const d = Math.abs(xValues[i] - xVal)
        if (d < best) {
          best = d
          nearest = i
        }
      }
      showTooltip({
        tooltipData: { index: nearest, x: xValues[nearest] },
        tooltipLeft: m.left + xScale(xValues[nearest]),
        tooltipTop: point.y,
      })
    },
    [xScale, xValues, m.left, showTooltip],
  )

  if (width < 10) return null

  return (
    <div style={{ position: 'relative', width, height }}>
      <svg width={width} height={height} role="img" aria-label={ariaLabel}>
        <Group left={m.left} top={m.top}>
          {!compact && (
            <GridRows scale={yScale} width={innerW} height={innerH} stroke={theme.grid} strokeWidth={0.5} numTicks={5} />
          )}

          {series.map((s) =>
            s.area ? (
              <LinearGradient
                key={`grad-${s.key}`}
                id={`${idPrefix}-${s.key}-grad`}
                from={s.color}
                to={s.color}
                fromOpacity={0.22}
                toOpacity={0}
              />
            ) : null,
          )}

          {series.map((s) =>
            s.area ? (
              <AreaClosed<number>
                key={`area-${s.key}`}
                data={xValues}
                x={(_, i) => xScale(xValues[i])}
                y={(_, i) => yScale(s.values[i] ?? 0)}
                yScale={yScale}
                defined={(_, i) => s.values[i] != null}
                curve={curveMonotoneX}
                fill={`url(#${idPrefix}-${s.key}-grad)`}
                stroke="transparent"
              />
            ) : null,
          )}

          {series.map((s) => (
            <LinePath<number>
              key={`line-${s.key}`}
              data={xValues}
              x={(_, i) => xScale(xValues[i])}
              y={(_, i) => yScale(s.values[i] ?? 0)}
              defined={(_, i) => s.values[i] != null}
              curve={curveMonotoneX}
              stroke={s.color}
              strokeWidth={s.strokeWidth ?? 2}
              strokeDasharray={s.dashed ? '6 4' : undefined}
              strokeLinecap="round"
            />
          ))}

          {marker && (
            <Line
              from={{ x: xScale(marker.x), y: 0 }}
              to={{ x: xScale(marker.x), y: innerH }}
              stroke={theme.accent}
              strokeWidth={1.5}
              strokeDasharray="3 3"
              opacity={0.7}
            />
          )}

          {!compact && (
            <>
              <AxisLeft
                scale={yScale}
                numTicks={5}
                stroke={theme.grid}
                tickStroke={theme.grid}
                tickFormat={(v) => formatYAxis(Number(v))}
                tickLabelProps={() => ({ fill: theme.tick, fontSize: 11, fontFamily: 'Inter', textAnchor: 'end', dx: -4, dy: 3 })}
              />
              <AxisBottom
                scale={xScale}
                top={innerH}
                numTicks={Math.min(8, xValues.length)}
                stroke={theme.grid}
                tickStroke={theme.grid}
                tickFormat={(v) => formatXAxis(Number(v))}
                tickLabelProps={() => ({ fill: theme.tick, fontSize: 11, fontFamily: 'Inter', textAnchor: 'middle', dy: 4 })}
              />
            </>
          )}

          {/* Tooltip crosshair + points (full mode only) */}
          {!compact && tooltipOpen && tooltipData && (
            <>
              <Line
                from={{ x: xScale(tooltipData.x), y: 0 }}
                to={{ x: xScale(tooltipData.x), y: innerH }}
                stroke={theme.inkMid}
                strokeWidth={1}
                strokeDasharray="2 3"
                opacity={0.5}
                pointerEvents="none"
              />
              {series.map((s) => {
                const v = s.values[tooltipData.index]
                if (v == null) return null
                return (
                  <circle
                    key={`dot-${s.key}`}
                    cx={xScale(tooltipData.x)}
                    cy={yScale(v)}
                    r={4}
                    fill={s.color}
                    stroke={theme.paperCard}
                    strokeWidth={2}
                    pointerEvents="none"
                  />
                )
              })}
            </>
          )}

          {/* Mouse capture (full mode only) */}
          {!compact && (
            <Bar
              x={0}
              y={0}
              width={innerW}
              height={innerH}
              fill="transparent"
              onMouseMove={handleMove}
              onMouseLeave={hideTooltip}
              onTouchMove={handleMove}
              onTouchEnd={hideTooltip}
            />
          )}
        </Group>
      </svg>

      {!compact && tooltipOpen && tooltipData && (
        <div
          className="chart-tooltip"
          style={{
            left: Math.min(Math.max(tooltipLeft ?? 0, 8), width - 8),
            top: Math.max((tooltipTop ?? 0) - 12, 8),
          }}
        >
          <div className="chart-tooltip-title">
            {formatXTooltip ? formatXTooltip(tooltipData.x) : tooltipData.x}
          </div>
          {series.map((s) => {
            const v = s.values[tooltipData.index]
            if (v == null) return null
            return (
              <div key={`tt-${s.key}`} className="chart-tooltip-row">
                <span className="chart-tooltip-swatch" style={{ background: s.color }} />
                <span className="chart-tooltip-label">{s.label}</span>
                <span className="chart-tooltip-val">{formatYTooltip(v)}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export type { ReactNode }
