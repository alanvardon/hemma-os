// English wording for the rules-check rows from lib/vindsplanen/rules.ts.
// One entry per RuleId and one per reason code, so adding a rule or a reason
// without wording fails the build. Lengths are metres in the core and whole
// centimetres here: a measured value is rounded toward the side that does not
// hide a miss ("199,6 cm" against a 200 cm minimum reads 199, never 200).

import type { RuleId, RuleResult, RuleStatus } from '../../lib/vindsplanen/rules'

type Params = Record<string, number | string>

const nf = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 1 })
const n = (v: unknown): string => nf.format(Number(v))
/** Whole cm, rounded down (for "at least" limits) with a hair of float tolerance. */
const cmDown = (m: unknown): string => nf.format(Math.floor(Number(m) * 100 + 1e-6))
/** Whole cm, rounded up (for "at most" limits). */
const cmUp = (m: unknown): string => nf.format(Math.ceil(Number(m) * 100 - 1e-6))
/** A limit the rule states in metres, as exact cm. */
const cm = (m: unknown): string => n(Math.round(Number(m) * 1000) / 10)
const m2 = (v: unknown): string => nf.format(Math.round(Number(v) * 10) / 10)

export const STATUS_LABEL: Record<RuleStatus, string> = {
  ok: 'OK',
  fail: 'Not OK',
  unknown: 'Can’t tell',
  info: 'Info',
}

const HEIGHT_LIMIT = {
  roof: 'under the roof',
  landing: 'under the top landing',
  below: 'above someone on the existing stairs below',
} as const

const FREE_HEIGHT_REASON = {
  'not-measured': (r: RuleResult) => `Free height over the stairs couldn’t be measured — at least ${cm(r.need)} cm is needed.`,
  boarded: (r: RuleResult) =>
    `Free height ${cmDown(r.have)} cm to the roof, but plasterboard in this bay sits lower, so it can’t be confirmed — at least ${cm(r.need)} cm is needed.`,
} as const

const SILL_REASON = {
  'not-measured': () => 'The sill height isn’t a valid number.',
  'not-placed': (r: RuleResult) =>
    `Sill ${cmUp(r.have)} cm above the floor, but the window has no valid opening in the roof yet (it overlaps another or runs off the slope).`,
  'behind-knee-wall': (r: RuleResult) =>
    `Sill ${cmUp(r.have)} cm starts inside the knee-wall void (the knee wall is ${cm((r.params ?? {}).kneeH)} cm), not in the room. Open the knee wall or raise the window.`,
} as const

const SIZE_REASON = {
  'frame-too-small': (p: Params) =>
    `Frame ${cm(p.frameW)} × ${cm(p.frameH)} cm is too small: the free opening must be at least ${cm(p.needW)} cm wide, ${cm(p.needH)} cm high and ${cm(p.needSum)} cm in width plus height.`,
  'frame-not-free-opening': (p: Params) =>
    `Frame ${cm(p.frameW)} × ${cm(p.frameH)} cm. The free opening is smaller than the frame and depends on the window; it needs at least ${cm(p.needW)} cm wide, ${cm(p.needH)} cm high and ${cm(p.needSum)} cm in width plus height.`,
} as const

const WINDOW = { roof: 'Roof window', gable: 'Gable window' } as const
/** Rows tied to a plan item are headed by the item's name in the panel; the gable window has no item, so it names itself. */
const lead = (r: RuleResult): string => (r.itemId ? '' : `${WINDOW[r.params?.window as keyof typeof WINDOW] ?? 'Window'}: `)

function pick<T>(table: Record<string, T>, key: unknown): T | undefined {
  return typeof key === 'string' ? table[key] : undefined
}

const TEXT: Record<RuleId, (r: RuleResult) => string> = {
  'stair-free-height': (r) => {
    const p = r.params ?? {}
    const reason = pick(FREE_HEIGHT_REASON, p.reason)
    if (reason) return reason(r)
    const where = pick(HEIGHT_LIMIT, p.limit) ?? HEIGHT_LIMIT.roof
    return `Free height ${cmDown(r.have)} cm ${where} — at least ${cm(r.need)} cm needed.`
  },
  'stair-tread-gaps': (r) =>
    `Gaps between treads must be at most ${n(Number(r.need) * 1000)} mm. The model has no open-riser data, so this can’t be checked.`,
  'stair-geometry': (r) => {
    const p = r.params ?? {}
    return `Rise ${n(Number(p.rise) * 100)} cm, going ${n(Number(p.going) * 100)} cm, ${n(p.risers)} risers. The rules only ask that stairs can be used safely; there are no fixed figures.`
  },
  'stair-handrails': () =>
    'Handrails on both sides (one is enough where both are unnecessary), easy to grip and continuous. Not modelled; judged on the finished stairs.',
  'stair-guards': (r) => {
    const p = r.params ?? {}
    return `Stairs and floor openings need fall protection. Where young children may be, ${cm(p.climbH)} cm of its height must resist climbing and vertical gaps must be at most ${n(Number(p.gapMax) * 1000)} mm. The model draws a ${cm(p.modelRailH)} cm rail with balusters every ${cm(p.modelBalusterCc)} cm, which isn’t checked against this.`
  },
  'escape-window-sill': (r) => {
    const p = r.params ?? {}
    const reason = pick(SILL_REASON, p.reason)
    if (reason) return `${lead(r)}${reason(r)}`
    return `${lead(r)}Sill ${cmUp(r.have)} cm above the floor — at most ${cm(r.need)} cm allowed.`
  },
  'escape-window-size': (r) => {
    const p = r.params ?? {}
    const reason = pick(SIZE_REASON, p.reason)
    return `${lead(r)}${reason ? reason(p) : 'The free opening can’t be checked.'}`
  },
  'floor-escape-door': (r) => {
    const branch = r.params?.branch
    if (branch === 'over') {
      return `The attic floor is about ${m2(r.have)} m², more than ${m2(r.need)} m², so it needs an escape door on this floor, or an escape window that qualifies. The height above the ground outside isn’t in the model.`
    }
    if (branch === 'atMost') {
      return `The attic floor is about ${m2(r.have)} m², ${m2(r.need)} m² or less, so an escape door on this floor or the one below is enough, or an escape window that qualifies. The height above the ground outside isn’t in the model.`
    }
    return 'The attic floor area couldn’t be worked out, so the escape-door rule can’t be applied.'
  },
  'room-height': (r) => {
    const p = r.params ?? {}
    return `No fixed minimum room height: it must suit how the room is used. ${m2(p.standArea)} of ${m2(p.floorArea)} m² floor has standing height (at least ${cm(p.standHeight)} cm).`
  },
  alterations: () =>
    'An altered part must meet the new-build rules, but they can be adapted with a documented risk assessment. Whether converting the attic counts as a change of use is for the kommun to decide.',
}

/** The sentence for one rules-check row. */
export function ruleText(r: RuleResult): string {
  return TEXT[r.id](r)
}

export const RULE_IDS = Object.keys(TEXT) as RuleId[]

/** "1 not OK · 4 can’t tell", or "All checks OK" when nothing is open. */
export function rulesSummary(rules: readonly RuleResult[]): string {
  const fail = rules.filter((r) => r.status === 'fail').length
  const unknown = rules.filter((r) => r.status === 'unknown').length
  const parts = []
  if (fail) parts.push(`${fail} not OK`)
  if (unknown) parts.push(`${unknown} can’t tell`)
  return parts.length ? parts.join(' · ') : 'All checks OK'
}
