import { useCallback, useMemo } from 'react'
import { Group } from '@visx/group'
import { scaleLinear } from '@visx/scale'
import { Area, LinePath, Line, Bar } from '@visx/shape'
import { AxisBottom, AxisLeft } from '@visx/axis'
import { GridRows } from '@visx/grid'
import { curveMonotoneX } from '@visx/curve'
import { useTooltip } from '@visx/tooltip'
import { localPoint } from '@visx/event'
import { ParentSize } from '@visx/responsive'
import { useChartTokens } from './useChartTheme'

// Stacked-area equivalent of the old Chart.js "ownership vs bank over time"
// chart: my equity (bottom) → partner's equity → the bank (top), so the upper
// edge traces the property value. visx in the same editorial idiom as the
// Bostadskalkyl charts — real axes, an index crosshair tooltip listing all
// three bands plus the total, theme-reactive colours read off `.bk-root`.

export interface EquityPoint {
  label: string
  mine: number
  partner: number
  bank: number
}

interface SeriesMeta {
  key: 'mine' | 'partner' | 'bank'
  label: string
  color: string
}

export default function EquityStackChart({
  data,
  mineLabel,
  partnerLabel,
  bankLabel,
  formatMoney,
}: {
  data: EquityPoint[]
  mineLabel: string
  partnerLabel: string
  bankLabel: string
  formatMoney: (n: number) => string
}) {
  const theme = useBkChartTheme()
  const series: SeriesMeta[] = [
    { key: 'mine', label: mineLabel, color: theme.mine },
    { key: 'partner', label: partnerLabel, color: theme.partner },
    { key: 'bank', label: bankLabel, color: theme.bank },
  ]
  return (
    <div className="bk-chart">
      <div className="bk-chart-legend">
        {series.map((s) => (
          <span className="bk-chart-key" key={s.key}>
            <span className="bk-chart-swatch" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <div className="bk-chart-canvas">
        <ParentSize>
          {({ width, height }) => (
            <StackSvg width={width} height={height} data={data} series={series} theme={theme} formatMoney={formatMoney} />
          )}
        </ParentSize>
      </div>
    </div>
  )
}

interface CumRow {
  mine0: number; mine1: number
  partner0: number; partner1: number
  bank0: number; bank1: number
  total: number
}

function StackSvg({
  width,
  height,
  data,
  series,
  theme,
  formatMoney,
}: {
  width: number
  height: number
  data: EquityPoint[]
  series: SeriesMeta[]
  theme: BkChartTheme
  formatMoney: (n: number) => string
}) {
  const m = { top: 12, right: 18, bottom: 34, left: 56 }
  const innerW = Math.max(0, width - m.left - m.right)
  const innerH = Math.max(0, height - m.top - m.bottom)
  const n = data.length

  const cum = useMemo<CumRow[]>(
    () =>
      data.map((d) => {
        const a = Math.max(0, d.mine), b = Math.max(0, d.partner), c = Math.max(0, d.bank)
        return { mine0: 0, mine1: a, partner0: a, partner1: a + b, bank0: a + b, bank1: a + b + c, total: a + b + c }
      }),
    [data],
  )
  const yMax = useMemo(() => (cum.reduce((mx, r) => Math.max(mx, r.total), 0) || 1) * 1.06, [cum])

  const xScale = useMemo(
    () => scaleLinear<number>({ domain: [0, Math.max(1, n - 1)], range: [0, innerW] }),
    [n, innerW],
  )
  const yScale = useMemo(
    () => scaleLinear<number>({ domain: [0, yMax], range: [innerH, 0], nice: true }),
    [yMax, innerH],
  )

  const { tooltipData, tooltipLeft, tooltipTop, tooltipOpen, showTooltip, hideTooltip } = useTooltip<number>()

  const handleMove = useCallback(
    (event: React.MouseEvent | React.TouchEvent) => {
      const point = localPoint(event)
      if (!point) return
      const idx = Math.max(0, Math.min(n - 1, Math.round(xScale.invert(point.x - m.left))))
      showTooltip({ tooltipData: idx, tooltipLeft: m.left + xScale(idx), tooltipTop: point.y })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [xScale, n, showTooltip],
  )

  if (width < 10) return null

  // Bottom-to-top bands, keyed to the same colour order as the legend/series.
  const bands = [
    { key: 'mine', color: series[0].color, y0: (r: CumRow) => r.mine0, y1: (r: CumRow) => r.mine1 },
    { key: 'partner', color: series[1].color, y0: (r: CumRow) => r.partner0, y1: (r: CumRow) => r.partner1 },
    { key: 'bank', color: series[2].color, y0: (r: CumRow) => r.bank0, y1: (r: CumRow) => r.bank1 },
  ]
  const labelAt = (i: number) => data[Math.round(i)]?.label ?? ''

  return (
    <div style={{ position: 'relative', width, height }}>
      <svg width={width} height={height} role="img" aria-label="Equity vs bank over time">
        <Group left={m.left} top={m.top}>
          <GridRows scale={yScale} width={innerW} height={innerH} stroke={theme.grid} strokeWidth={0.5} numTicks={5} />

          {bands.map((band) => (
            <Area<CumRow>
              key={`a-${band.key}`}
              data={cum}
              x={(_, i) => xScale(i)}
              y0={(r) => yScale(band.y0(r))}
              y1={(r) => yScale(band.y1(r))}
              curve={curveMonotoneX}
              fill={band.color}
              fillOpacity={0.3}
              stroke="transparent"
            />
          ))}

          {bands.map((band) => (
            <LinePath<CumRow>
              key={`l-${band.key}`}
              data={cum}
              x={(_, i) => xScale(i)}
              y={(r) => yScale(band.y1(r))}
              curve={curveMonotoneX}
              stroke={band.color}
              strokeWidth={1.6}
              strokeLinecap="round"
            />
          ))}

          <AxisLeft
            scale={yScale}
            numTicks={5}
            stroke={theme.grid}
            tickStroke={theme.grid}
            tickFormat={(v) => Math.round(Number(v) / 1000) + 'k'}
            tickLabelProps={() => ({ fill: theme.tick, fontSize: 11, fontFamily: 'Inter', textAnchor: 'end', dx: -4, dy: 3 })}
          />
          <AxisBottom
            scale={xScale}
            top={innerH}
            numTicks={Math.min(8, n)}
            stroke={theme.grid}
            tickStroke={theme.grid}
            tickFormat={(v) => labelAt(Number(v))}
            tickLabelProps={() => ({ fill: theme.tick, fontSize: 11, fontFamily: 'Inter', textAnchor: 'middle', dy: 4 })}
          />

          {tooltipOpen && tooltipData != null && (
            <>
              <Line
                from={{ x: xScale(tooltipData), y: 0 }}
                to={{ x: xScale(tooltipData), y: innerH }}
                stroke={theme.inkMid}
                strokeWidth={1}
                strokeDasharray="2 3"
                opacity={0.5}
                pointerEvents="none"
              />
              {bands.map((band) => (
                <circle
                  key={`d-${band.key}`}
                  cx={xScale(tooltipData)}
                  cy={yScale(band.y1(cum[tooltipData]))}
                  r={3.5}
                  fill={band.color}
                  stroke={theme.paperCard}
                  strokeWidth={2}
                  pointerEvents="none"
                />
              ))}
            </>
          )}

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
        </Group>
      </svg>

      {tooltipOpen && tooltipData != null && (
        <div
          className="chart-tooltip"
          style={{
            left: Math.min(Math.max(tooltipLeft ?? 0, 8), width - 8),
            top: Math.max((tooltipTop ?? 0) - 12, 8),
          }}
        >
          <div className="chart-tooltip-title">{data[tooltipData]?.label}</div>
          {series.map((s) => (
            <div key={s.key} className="chart-tooltip-row">
              <span className="chart-tooltip-swatch" style={{ background: s.color }} />
              <span className="chart-tooltip-label">{s.label}</span>
              <span className="chart-tooltip-val">{formatMoney(Math.max(0, data[tooltipData][s.key]))}</span>
            </div>
          ))}
          <div className="chart-tooltip-row chart-tooltip-total">
            <span className="chart-tooltip-swatch" style={{ background: 'transparent' }} />
            <span className="chart-tooltip-label">Totalt · värde</span>
            <span className="chart-tooltip-val">{formatMoney(cum[tooltipData].total)}</span>
          </div>
        </div>
      )}
    </div>
  )
}

type BkChartTheme = Record<keyof typeof BK_TOKENS, string>

// The --chart-* tokens live on the `.bk-root` scope, not :root.
const BK_TOKENS = {
  grid: '--rule',
  tick: '--ink-soft',
  inkMid: '--ink-mid',
  paperCard: '--paper-card',
  mine: '--chart-mine',
  partner: '--chart-partner',
  bank: '--chart-bank',
}

const BK_FALLBACKS: BkChartTheme = {
  grid: '#e7e2d9',
  tick: '#8a8175',
  inkMid: '#5b5347',
  paperCard: '#ffffff',
  mine: '#357a4c',
  partner: '#3d7e94',
  bank: '#c08a44',
}

function useBkChartTheme(): BkChartTheme {
  return useChartTokens(BK_TOKENS, { scope: '.bk-root', fallback: BK_FALLBACKS })
}
