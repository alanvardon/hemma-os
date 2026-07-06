// sv-SE money / number formatters — ported verbatim from calc.js.
// Kept separate from calc.ts so the math layer returns numbers only.

/** Rounded SEK with a trailing " kr", sv-SE grouping. */
export function fmt(n: number): string {
  return Math.round(n).toLocaleString('sv-SE') + ' kr'
}

/** One-decimal percent, e.g. 10 → "10.0%". */
export function pct(n: number): string {
  return n.toFixed(1) + '%'
}

/** Rounded integer with space thousands separators, e.g. 5850000 → "5 850 000". */
export function formatWithSpaces(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

/** Rounded amount with space thousands separators + a suffix, e.g. "5 850 000 kr". */
export function money(n: number, suffix = ' kr'): string {
  return formatWithSpaces(n) + suffix
}

/**
 * Compact sv-SE money for the dense scenario chips — uses the Swedish finance
 * abbreviations "tkr" (tusen kronor) and "mnkr" (miljoner kronor) so six figures
 * stay tight: 4 200 000 → "4,2 mnkr", 120 000 → "120 tkr", 950 → "950 kr".
 * Values under 10 of their unit keep one decimal (4,5 tkr); above, they round to
 * a whole unit (120 tkr). `signed` prefixes "+"/"−" for ± figures (cash balance).
 */
export function fmtCompact(n: number, signed = false): string {
  const abs = Math.abs(n)
  const sign = n < 0 ? '−' : signed && n > 0 ? '+' : ''
  const body = (v: number, unit: string): string =>
    v.toLocaleString('sv-SE', { maximumFractionDigits: v < 10 ? 1 : 0 }) + unit
  if (abs >= 1_000_000) return sign + body(abs / 1_000_000, ' mnkr')
  if (abs >= 1_000) return sign + body(abs / 1_000, ' tkr')
  return sign + Math.round(abs).toLocaleString('sv-SE') + ' kr'
}

/** Parse a user-entered value: strip spaces, treat comma as decimal, NaN → 0. */
export function parseFormatted(str: string | number): number {
  return parseFloat(String(str).replace(/\s/g, '').replace(/,/g, '.')) || 0
}

/** Display suffix per supported currency code; unknown codes fall back to "kr". */
export const CURRENCY_SUFFIX: Record<string, string> = { SEK: 'kr', NOK: 'kr', DKK: 'kr', EUR: '€', USD: '$', GBP: '£' }
