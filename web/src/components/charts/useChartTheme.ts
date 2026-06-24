import { useEffect, useState } from 'react'

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

const TOKENS: Record<keyof ChartTheme, string> = {
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

function readTheme(): ChartTheme {
  const style = getComputedStyle(document.documentElement)
  const out = {} as ChartTheme
  for (const key of Object.keys(TOKENS) as (keyof ChartTheme)[]) {
    out[key] = style.getPropertyValue(TOKENS[key]).trim()
  }
  return out
}

export function useChartTheme(): ChartTheme {
  const [theme, setTheme] = useState<ChartTheme>(readTheme)

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readTheme()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  return theme
}
