import { useEffect, useState } from 'react'
import NumberFlow from '@number-flow/react'
import { isVtActive, subscribeVtSettled } from '../lib/viewTransition'

// Animated figure components. NumberFlow rolls the digits whenever `value`
// changes (typing an input, dragging the stress slider, loading a scenario).
// It honours prefers-reduced-motion automatically (respectMotionPreference
// defaults to true), so no manual gating is needed here.

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

// True once no hub-pan whoosh is in flight. While a transition is active,
// callers pass this to NumberFlow's `animated` prop so entrance figures don't
// roll underneath/behind it (either an explicit `rollIn`, or a figure whose
// value just changes as a route's data hydrates) — value changes still land,
// just silently, then the figure is live for real (typed/dragged) changes
// once settled. Mirrors the same lifecycle viewTransition.ts already uses to
// clear `data-vt-dir` (tied to the VT's `.finished`, with a timer fallback for
// paths with no real VT), so it can't get stuck un-animated.
function useVtSettled(): boolean {
  const [settled, setSettled] = useState(() => !isVtActive())
  useEffect(() => {
    if (settled) return
    return subscribeVtSettled(() => setSettled(true))
  }, [settled])
  return settled
}

// Opt-in mount roll-in: start at 0, animate to `value` once settled (see
// useVtSettled) on first paint. Skipped under prefers-reduced-motion. When
// `rollIn` is false (default), returns `value` directly so NumberFlow sees
// reactive changes as before.
function useRollIn(value: number, rollIn: boolean | undefined, settled: boolean): number {
  const [display, setDisplay] = useState(() => (rollIn && !prefersReducedMotion() ? 0 : value))
  useEffect(() => {
    if (rollIn && !settled) return
    setDisplay(value)
  }, [value, settled, rollIn])
  return rollIn ? display : value
}

interface MoneyProps {
  value: number
  /** Render a leading "+" for positives / "−" for negatives (P&L, cash balance). */
  signed?: boolean
  /** Static prefix glued before the figure — used for "less …" cost rows ("−"). */
  prefix?: string
  /** Trailing unit, e.g. "/mo" or "/yr". */
  suffix?: string
  /**
   * Render "<sv-SE number> <currencySuffix>" instead of the Intl SEK currency
   * style — for the multi-currency tools (Bolånekoll: kr/€/$/£), matching their
   * own `fmtMoney`. When omitted, the default SEK currency formatting is used.
   */
  currencySuffix?: string
  /**
   * Max decimal places in `currencySuffix` mode (min stays 0, so trailing zeros
   * drop). Default 0 (whole kronor); pass 2 for öre-aware tools (Månadsavslut).
   */
  maxDecimals?: number
  className?: string
  /** Mount at 0 and roll to `value` on first paint (hero figures only). */
  rollIn?: boolean
}

/**
 * SEK figure matching the legacy `fmt()` output ("30 623 kr", sv-SE grouping).
 * sv-SE currency formatting yields "kr" after the number, so this is a 1:1
 * visual replacement for the old `fmt(n)` strings. Pass `currencySuffix` to
 * render an explicit unit (other currencies) instead of the Intl SEK style.
 */
export function Money({ value, signed, prefix, suffix, currencySuffix, maxDecimals = 0, className, rollIn }: MoneyProps) {
  const settled = useVtSettled()
  const display = useRollIn(value, rollIn, settled)
  const signFmt = signed ? { signDisplay: 'exceptZero' as const } : {}
  if (currencySuffix != null) {
    return (
      <NumberFlow
        value={display}
        locales="sv-SE"
        format={{ minimumFractionDigits: 0, maximumFractionDigits: maxDecimals, ...signFmt }}
        prefix={prefix}
        suffix={(suffix ?? '') + ' ' + currencySuffix}
        className={className}
        animated={settled}
      />
    )
  }
  return (
    <NumberFlow
      value={display}
      locales="sv-SE"
      format={{ style: 'currency', currency: 'SEK', maximumFractionDigits: 0, ...signFmt }}
      prefix={prefix}
      suffix={suffix}
      className={className}
      animated={settled}
    />
  )
}

interface PercentProps {
  value: number
  /** Decimal places (default 1, matching the legacy `pct()`). */
  decimals?: number
  /** Insert a space before the % sign ("62 %" vs "62%"). */
  space?: boolean
  /** Render a leading "+"/"-" for positives/negatives (leverage, spread). */
  signed?: boolean
  /** Locale — default en-US keeps a dot decimal separator like `toFixed`. */
  locale?: string
  className?: string
  /** Mount at 0 and roll to `value` on first paint (hero figures only). */
  rollIn?: boolean
}

/**
 * Percentage figure. Defaults to the legacy `pct()` output ("21.1%", one
 * decimal, en-US dot, no space) so existing call sites are unchanged; pass
 * `decimals`/`space`/`locale`/`signed` for tools that format differently (e.g.
 * Konsult's "62 %", Bolånekoll's "3,54 %", Löneväxling's signed "+12 %").
 */
export function Percent({ value, decimals = 1, space, signed, locale = 'en-US', className, rollIn }: PercentProps) {
  const settled = useVtSettled()
  const display = useRollIn(value, rollIn, settled)
  return (
    <NumberFlow
      value={display}
      locales={locale}
      format={{
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
        ...(signed ? { signDisplay: 'exceptZero' as const } : {}),
      }}
      suffix={(space ? ' ' : '') + '%'}
      className={className}
      animated={settled}
    />
  )
}

interface NumProps {
  value: number
  /** Decimal places (default 0). */
  decimals?: number
  /** Trailing unit, e.g. " h" (use a non-breaking space to keep it attached). */
  suffix?: string
  prefix?: string
  /** Locale — default sv-SE gives space-grouped thousands like `formatWithSpaces`. */
  locale?: string
  className?: string
  /** Mount at 0 and roll to `value` on first paint (hero figures only). */
  rollIn?: boolean
}

/**
 * Plain grouped number (no currency), e.g. billable hours "1 800 h".
 * sv-SE grouping matches the legacy `formatWithSpaces`.
 */
export function Num({ value, decimals = 0, suffix, prefix, locale = 'sv-SE', className, rollIn }: NumProps) {
  const settled = useVtSettled()
  const display = useRollIn(value, rollIn, settled)
  return (
    <NumberFlow
      value={display}
      locales={locale}
      format={{ minimumFractionDigits: decimals, maximumFractionDigits: decimals }}
      prefix={prefix}
      suffix={suffix}
      className={className}
      animated={settled}
    />
  )
}

interface MoneyCompactProps {
  value: number
  /** Prefix "+" for positives (cash balance). */
  signed?: boolean
  /** Mount at 0 and roll to `value` on first paint (scenario card chips). */
  rollIn?: boolean
}

/**
 * Compact animated money matching `fmtCompact()` — animates the mantissa while
 * keeping the Swedish abbreviated unit (tkr/mnkr/kr) so dense cards don't overflow.
 * Scale is determined by the final `value`; the animated mantissa rolls 0 → final.
 */
export function MoneyCompact({ value, signed = false, rollIn }: MoneyCompactProps) {
  const settled = useVtSettled()
  const display = useRollIn(value, rollIn, settled)
  const abs = Math.abs(value)
  let divisor: number, suffix: string
  if (abs >= 1_000_000) { divisor = 1_000_000; suffix = ' mnkr' }
  else if (abs >= 1_000) { divisor = 1_000; suffix = ' tkr' }
  else { divisor = 1; suffix = ' kr' }
  return (
    <NumberFlow
      value={display / divisor}
      locales="sv-SE"
      format={{
        minimumFractionDigits: 0,
        maximumFractionDigits: abs < 10 * divisor ? 1 : 0,
        ...(signed ? { signDisplay: 'exceptZero' as const } : {}),
      }}
      suffix={suffix}
      animated={settled}
    />
  )
}
