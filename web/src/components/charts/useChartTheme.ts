import { useEffect, useMemo, useState } from 'react'

// The charts paint with the same design tokens as everything else (forest
// accent, warm paper, rules) so they stay on-identity in both themes. We read
// the resolved CSS custom properties off <html> and re-read whenever the
// data-theme attribute flips — mirroring the vanilla charts.js MutationObserver.

export interface ChartTheme {
  accent: string
  accentLight: string
  warn: string
  warnLight: string
  grid: string
  tick: string
  ink: string
  inkMid: string
  paperCard: string
}

const DEFAULT_TOKENS: Record<keyof ChartTheme, string> = {
  accent: '--accent',
  accentLight: '--accent-light',
  warn: '--warn',
  warnLight: '--warn-light',
  grid: '--rule',
  tick: '--ink-soft',
  ink: '--ink',
  inkMid: '--ink-mid',
  paperCard: '--paper-card',
}

// Every chart re-reads its tokens off the same signal: bump a counter once
// after mount (in case a scoped root, e.g. `.bk-root`, only exists in the
// DOM after the first commit) and again on every data-theme flip.
function useThemeTick(): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const id = requestAnimationFrame(() => setTick((t) => t + 1))
    const observer = new MutationObserver(() => setTick((t) => t + 1))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      cancelAnimationFrame(id)
      observer.disconnect()
    }
  }, [])
  return tick
}

/**
 * Resolve a map of CSS custom properties, re-reading after mount and on every
 * data-theme flip. `scope` is a selector for the element to read them off —
 * for palettes that live on a page-level root like `.bk-root` / `.hb-root`
 * rather than `:root` — falling back to `<html>` if it doesn't match.
 */
export function useChartTokens<T extends Record<string, string>>(
  tokens: T,
  opts?: { scope?: string; fallback?: Partial<Record<keyof T, string>> },
): Record<keyof T, string> {
  const tick = useThemeTick()
  const scope = opts?.scope
  const fallback = opts?.fallback
  return useMemo(() => {
    const root = (scope && document.querySelector(scope)) || document.documentElement
    const cs = getComputedStyle(root)
    const out = {} as Record<keyof T, string>
    for (const key of Object.keys(tokens) as (keyof T)[]) {
      out[key] = cs.getPropertyValue(tokens[key]).trim() || fallback?.[key] || ''
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, tokens, scope, fallback])
}

export function useChartTheme(): ChartTheme {
  return useChartTokens(DEFAULT_TOKENS)
}
