import { useEffect, useMemo, useRef, useState } from 'react'
import type { RatePoint } from '../../lib/riksbank'
import { useChartTheme } from './useChartTheme'
import LineAreaChart, { type SeriesDef } from './LineAreaChart'
import ChartParentSize from './ChartParentSize'

const DAY_MS = 86400000
const YEAR_MS = 365.25 * DAY_MS

const fmtPctSv = (v: number, decimals = 2): string =>
  v.toLocaleString('sv-SE', { maximumFractionDigits: decimals }) + ' %'

const fmtDateSv = (ts: number): string =>
  new Date(ts).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short', year: 'numeric' })

const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

interface Window { start: number; end: number; yMin: number }

// Ease the visible window (x-domain + y floor) toward `target` with rAF, so
// picking 5 år / Allt zooms the timeline in/out instead of cutting. Starts
// from whatever is currently displayed, so mid-flight toggles don't jump.
function useAnimatedWindow(target: Window, reduce: boolean, durationMs = 460): Window {
  const [win, setWin] = useState(target)
  const winRef = useRef(target)
  const rafRef = useRef(0)
  winRef.current = win

  useEffect(() => {
    if (reduce) { setWin(target); return }
    const from = winRef.current
    let start = 0
    const tick = (now: number) => {
      if (!start) start = now
      const e = easeInOutCubic(Math.min(1, (now - start) / durationMs))
      setWin({
        start: from.start + (target.start - from.start) * e,
        end: from.end + (target.end - from.end) * e,
        yMin: from.yMin + (target.yMin - from.yMin) * e,
      })
      if ((now - start) < durationMs) rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.start, target.end, target.yMin, reduce])

  return win
}

/**
 * Styrränta step chart (plan 70). Always holds the full change history; the
 * `range` prop only moves the animated x-domain window, so 5 år ⇄ Allt zooms.
 */
export default function RiksbankChart({
  changes,
  range,
  reduceMotion = false,
  compact,
}: {
  changes: RatePoint[]
  range: '5y' | 'all'
  reduceMotion?: boolean
  compact?: boolean
}) {
  const theme = useChartTheme()

  const { xValues, values, nowTs } = useMemo(() => {
    const xs = changes.map((c) => new Date(c.date + 'T00:00:00').getTime())
    const now = Date.now()
    const vs = changes.map((c) => c.value)
    // Extend the last step to today so the line reaches the right edge.
    if (xs.length && xs[xs.length - 1] < now - DAY_MS) {
      xs.push(now)
      vs.push(changes[changes.length - 1]?.value ?? 0)
    }
    return { xValues: xs, values: vs, nowTs: now }
  }, [changes])

  // Target window per range. yMin dips below zero only when the window spans
  // the minusränta years, so the y-floor animates too.
  const target = useMemo<Window>(() => {
    const end = xValues[xValues.length - 1] ?? nowTs
    const start = range === 'all' ? (xValues[0] ?? end) : nowTs - 5 * YEAR_MS
    let min = 0
    for (let i = 0; i < xValues.length; i++) if (xValues[i] >= start && values[i] < min) min = values[i]
    return { start, end, yMin: min < 0 ? min - 0.25 : 0 }
  }, [range, xValues, values, nowTs])

  const win = useAnimatedWindow(target, reduceMotion)

  const series: SeriesDef[] = [
    { key: 'rate', label: 'Styrränta', color: theme.accent, values, strokeWidth: 2 },
  ]

  // 1 jan ticks inside the current window, thinned to the available width.
  const yearTicks = (width: number): number[] => {
    const first = new Date(win.start).getFullYear() + 1
    const last = new Date(win.end).getFullYear()
    const years: number[] = []
    for (let y = first; y <= last; y++) {
      const t = new Date(y, 0, 1).getTime()
      if (t >= win.start && t <= win.end) years.push(t)
    }
    const step = Math.max(1, Math.ceil(years.length / Math.max(3, Math.floor(width / 90))))
    return years.filter((_, i) => i % step === 0)
  }

  return (
    <ChartParentSize>
      {({ width, height }) => (
        <LineAreaChart
          width={width}
          height={height}
          compact={compact}
          theme={theme}
          idPrefix="riksbank"
          curve="step"
          xValues={xValues}
          series={series}
          yMin={win.yMin}
          xDomain={[win.start, win.end]}
          xTickValues={yearTicks(width)}
          formatXAxis={(x) => String(new Date(x).getFullYear())}
          formatYAxis={(y) => fmtPctSv(y, 1)}
          formatXTooltip={fmtDateSv}
          formatYTooltip={(y) => fmtPctSv(y)}
          ariaLabel="Styrränta över tid: policy rate changes since 2010"
        />
      )}
    </ChartParentSize>
  )
}
