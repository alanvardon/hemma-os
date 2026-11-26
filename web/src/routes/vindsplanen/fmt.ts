/** Swedish number with a fixed number of decimals. */
export const fmt = (v: number, d = 2): string => v.toLocaleString('sv-SE', { minimumFractionDigits: d, maximumFractionDigits: d })

/** Whole kronor for display only (sv-SE grouping, non-breaking space before "kr"). Amounts stay at full precision elsewhere. */
export const fmtKr = (v: number): string => `${Math.round(v).toLocaleString('sv-SE', { maximumFractionDigits: 0 })}\u00a0kr`
