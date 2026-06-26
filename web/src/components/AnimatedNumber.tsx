import NumberFlow from '@number-flow/react'

// Animated figure components. NumberFlow rolls the digits whenever `value`
// changes (typing an input, dragging the stress slider, loading a scenario).
// It honours prefers-reduced-motion automatically (respectMotionPreference
// defaults to true), so no manual gating is needed here.

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
  className?: string
}

/**
 * SEK figure matching the legacy `fmt()` output ("30 623 kr", sv-SE grouping).
 * sv-SE currency formatting yields "kr" after the number, so this is a 1:1
 * visual replacement for the old `fmt(n)` strings. Pass `currencySuffix` to
 * render an explicit unit (other currencies) instead of the Intl SEK style.
 */
export function Money({ value, signed, prefix, suffix, currencySuffix, className }: MoneyProps) {
  const signFmt = signed ? { signDisplay: 'exceptZero' as const } : {}
  if (currencySuffix != null) {
    return (
      <NumberFlow
        value={value}
        locales="sv-SE"
        format={{ maximumFractionDigits: 0, ...signFmt }}
        prefix={prefix}
        suffix={(suffix ?? '') + ' ' + currencySuffix}
        className={className}
      />
    )
  }
  return (
    <NumberFlow
      value={value}
      locales="sv-SE"
      format={{ style: 'currency', currency: 'SEK', maximumFractionDigits: 0, ...signFmt }}
      prefix={prefix}
      suffix={suffix}
      className={className}
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
}

/**
 * Percentage figure. Defaults to the legacy `pct()` output ("21.1%", one
 * decimal, en-US dot, no space) so existing call sites are unchanged; pass
 * `decimals`/`space`/`locale`/`signed` for tools that format differently (e.g.
 * Konsult's "62 %", Bolånekoll's "3,54 %", Löneväxling's signed "+12 %").
 */
export function Percent({ value, decimals = 1, space, signed, locale = 'en-US', className }: PercentProps) {
  return (
    <NumberFlow
      value={value}
      locales={locale}
      format={{
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
        ...(signed ? { signDisplay: 'exceptZero' as const } : {}),
      }}
      suffix={(space ? ' ' : '') + '%'}
      className={className}
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
}

/**
 * Plain grouped number (no currency), e.g. billable hours "1 800 h".
 * sv-SE grouping matches the legacy `formatWithSpaces`.
 */
export function Num({ value, decimals = 0, suffix, prefix, locale = 'sv-SE', className }: NumProps) {
  return (
    <NumberFlow
      value={value}
      locales={locale}
      format={{ minimumFractionDigits: decimals, maximumFractionDigits: decimals }}
      prefix={prefix}
      suffix={suffix}
      className={className}
    />
  )
}
