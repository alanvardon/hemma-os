// One-way import of a v41 artifact plan (the Save tab's "Copy plan", which is
// `JSON.stringify(state)` — already through every v41 migration, so
// `options.below.v === 11`). Older shapes are refused: the owner opens the
// plan in the artifact first, which migrates it, and copies it again.

import { sanitizeShape, sanitizeViewPrefs, type PlanV2, type SanitizeOptions, type ViewPrefs } from './plan'

/** The `options.below.v` of a v41 export. */
export const V41_BELOW_VERSION = 11

export type ImportV1Result =
  | { ok: true; plan: PlanV2; view: ViewPrefs }
  | { ok: false; reason: 'not-object' | 'too-old' | 'invalid' }

type Loose = Record<string, unknown>
const isObj = (v: unknown): v is Loose => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Map a v41 export to a PlanV2 plus the view preferences it carried
 * (quality, sun, dims, zones, rafters, cutaway). `example` and
 * `options.below.v` are dropped. `coarse` picks v41's default quality.
 */
export function importV1(raw: unknown, opts: SanitizeOptions & { coarse?: boolean } = {}): ImportV1Result {
  if (!isObj(raw)) return { ok: false, reason: 'not-object' }
  const options = isObj(raw.options) ? raw.options : null
  const below = options && isObj(options.below) ? options.below : null
  const v = below ? below.v : undefined
  if (typeof v !== 'number' || v < V41_BELOW_VERSION) return { ok: false, reason: 'too-old' }
  if (v !== V41_BELOW_VERSION || !Array.isArray(raw.items)) return { ok: false, reason: 'invalid' }
  const plan = sanitizeShape(raw, opts)
  if (!plan) return { ok: false, reason: 'invalid' }
  return { ok: true, plan, view: sanitizeViewPrefs(options, opts.coarse) }
}

/** Parse pasted text, then `importV1`. Unparseable text is 'not-object'. */
export function importV1Text(text: string, opts: SanitizeOptions & { coarse?: boolean } = {}): ImportV1Result {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'not-object' }
  }
  return importV1(raw, opts)
}
