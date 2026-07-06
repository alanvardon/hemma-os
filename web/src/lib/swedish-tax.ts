// Shared Swedish 2026 personal-tax constants + math, used by both Konsultkalkyl
// (contractor take-home) and Löneväxling (pension-sacrifice take-home). Both
// files independently encoded the same grundavdrag/jobbskatteavdrag tables
// before this extraction — see swedish-tax.test.ts for the characterization
// test pinning the pre-extraction outputs.

/** Prisbasbelopp 2026. */
export const PBB_2026 = 59200
export const STATE_TAX_SKIKTGRANS = 643000
export const STATE_TAX_RATE = 0.2

/** Grundavdrag (basic deduction) for a given yearly income. */
export function grundavdrag(income: number, pbb: number = PBB_2026): number {
  const ff = Math.max(0, income)
  let g: number
  if (ff <= 0.99 * pbb) g = 0.423 * pbb
  else if (ff <= 2.72 * pbb) g = 0.423 * pbb + 0.2 * (ff - 0.99 * pbb)
  else if (ff <= 3.11 * pbb) g = 0.77 * pbb
  else if (ff <= 7.88 * pbb) g = 0.77 * pbb - 0.1 * (ff - 3.11 * pbb)
  else g = 0.293 * pbb
  return Math.ceil(g / 100) * 100
}

/** Jobbskatteavdrag (earned income tax credit). */
export function jobbskatteavdrag(
  arbetsinkomst: number,
  ga: number,
  kommunalRate: number,
  pbb: number = PBB_2026,
): number {
  const ai = Math.max(0, arbetsinkomst)
  const PLATEAU = 3.027
  let base: number
  if (ai <= 0.91 * pbb) {
    base = ai
  } else if (ai <= 3.24 * pbb) {
    base = 0.91 * pbb + 0.3874 * (ai - 0.91 * pbb)
  } else if (ai <= 8.08 * pbb) {
    const b2end = 0.91 * pbb + 0.3874 * (3.24 - 0.91) * pbb
    const slope = (PLATEAU * pbb - b2end) / ((8.08 - 3.24) * pbb)
    base = b2end + slope * (ai - 3.24 * pbb)
  } else if (ai <= 13.54 * pbb) {
    base = PLATEAU * pbb
  } else {
    base = PLATEAU * pbb - 0.03 * (ai - 13.54 * pbb)
  }
  return Math.max(0, (base - ga) * kommunalRate)
}
