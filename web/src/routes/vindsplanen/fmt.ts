/** Swedish number with a fixed number of decimals. */
export const fmt = (v: number, d = 2): string => v.toLocaleString('sv-SE', { minimumFractionDigits: d, maximumFractionDigits: d })
