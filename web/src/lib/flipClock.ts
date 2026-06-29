/**
 * Returns the forward-only path of digit values from `from` to `to`,
 * wrapping at `modulo`. Produces the sequence each Solari flap steps through.
 *
 * Examples:
 *   forwardSteps(9, 0) → [0]          (one wrap step)
 *   forwardSteps(5, 0) → [6,7,8,9,0]  (five steps through the wrap)
 *   forwardSteps(3, 5) → [4, 5]
 *   forwardSteps(0, 0) → []
 */
export function forwardSteps(from: number, to: number, modulo = 10): number[] {
  if (from === to) return []
  const steps: number[] = []
  let cur = from
  do {
    cur = (cur + 1) % modulo
    steps.push(cur)
  } while (cur !== to)
  return steps
}

/**
 * Returns the six time digits [h1, h2, m1, m2, s1, s2] for a given Date,
 * e.g. 14:37:52 → [1, 4, 3, 7, 5, 2].
 */
export function getDigits(date: Date): number[] {
  const h = date.getHours()
  const m = date.getMinutes()
  const s = date.getSeconds()
  return [
    Math.floor(h / 10), h % 10,
    Math.floor(m / 10), m % 10,
    Math.floor(s / 10), s % 10,
  ]
}
