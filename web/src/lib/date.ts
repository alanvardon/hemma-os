// Shared date helpers — kept apart from the tool-specific math libs.

/** Today's local date as YYYY-MM-DD. */
export function todayISO(): string {
  const d = new Date(), p = (n: number) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

/** Whole days from `today` to `target` (both YYYY-MM-DD); null on bad input. */
export function daysUntil(target: string, today: string): number | null {
  const dt = new Date(target + 'T00:00:00'), dn = new Date(today + 'T00:00:00')
  if (isNaN(dt.getTime()) || isNaN(dn.getTime())) return null
  return Math.round((dt.getTime() - dn.getTime()) / 86400000)
}

/** `iso` shifted by whole years, as YYYY-MM-DD. Leap-day overflow rolls
 * forward the way Date does (2028-02-29 − 5 år → 2023-03-01). */
export function addYearsISO(iso: string, years: number): string {
  const d = new Date(iso + 'T00:00:00')
  d.setFullYear(d.getFullYear() + years)
  const p = (n: number) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}
