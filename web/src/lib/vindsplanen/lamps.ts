// Where the lamps go in the "Evening, lamps on" mood (plan 141): a pure
// placement the scene turns into warm point lights. No three.js here.
//
// Coordinates as in attic.ts: x from the west gable, y up from the attic
// floor, z from north (−) to south (+), metres.

import { clamp, roofY, type Geometry } from './attic'
import type { Item } from './plan'
import { toWorld } from './stairs'

export type LampKind = 'pendant' | 'table' | 'floor'

export interface LampSpot {
  kind: LampKind
  /** The light's position (the bulb), metres. */
  at: [number, number, number]
}

/** At most this many lamps are lit (each is a point light in the scene). */
export const MAX_LAMPS = 6
/** A pendant hangs this far below the ridge, and never lower than PENDANT_MAX_Y. */
export const PENDANT_DROP = 0.45
export const PENDANT_MAX_Y = 2.2
/** A bedside lamp's bulb sits this far above the nightstand top. */
export const TABLE_LAMP_RISE = 0.35
/** A desk lamp's bulb sits this far above the desk top. */
export const DESK_LAMP_RISE = 0.45
/** A floor lamp's bulb height, and where it stands beside a sofa (past its right arm, near the back). */
export const FLOOR_LAMP_Y = 1.45
const FLOOR_LAMP_SIDE = 0.25
const FLOOR_LAMP_BACK = 0.25
/** Keep every bulb at least this far below the roof slope above it. */
const ROOF_CLEAR = 0.15
/** Keep a floor lamp this far inside the knee walls and gables. */
const WALL_CLEAR = 0.15

const below = (geo: Geometry, y: number, z: number) => Math.min(y, roofY(geo, z) - ROOF_CLEAR)

/**
 * The lamps to light: first one ceiling pendant per room (the segments
 * between partition walls, west to east, at the room's middle on the ridge
 * line), then, in plan order, a table lamp on each nightstand, a desk lamp
 * over each desk and a floor lamp beside each sofa. Capped at MAX_LAMPS, so
 * the room lights win over the small lamps when there are too many.
 */
export function lampSpots(geo: Geometry, items: readonly Item[]): LampSpot[] {
  const out: LampSpot[] = []
  const walls = items.flatMap((i) => (i.type === 'wall' ? [i.x] : [])).sort((a, b) => a - b)
  const bounds = [0, ...walls, geo.L]
  const py = Math.min(geo.H - PENDANT_DROP, PENDANT_MAX_Y)
  for (let i = 0; i < bounds.length - 1; i++) {
    if (bounds[i + 1] - bounds[i] < 1e-6) continue // two walls at the same x: no room between them
    out.push({ kind: 'pendant', at: [(bounds[i] + bounds[i + 1]) / 2, py, 0] })
  }
  for (const it of items) {
    if (it.type === 'nightstand') out.push({ kind: 'table', at: [it.x, below(geo, it.h + TABLE_LAMP_RISE, it.z), it.z] })
    else if (it.type === 'desk') out.push({ kind: 'table', at: [it.x, below(geo, it.h + DESK_LAMP_RISE, it.z), it.z] })
    else if (it.type === 'sofa') {
      const [wx, wz] = toWorld(it, it.w / 2 + FLOOR_LAMP_SIDE, -it.d / 2 + FLOOR_LAMP_BACK)
      const x = clamp(wx, WALL_CLEAR, geo.L - WALL_CLEAR)
      const z = clamp(wz, -geo.KZ + WALL_CLEAR, geo.KZ - WALL_CLEAR)
      out.push({ kind: 'floor', at: [x, below(geo, FLOOR_LAMP_Y, z), z] })
    }
  }
  return out.slice(0, MAX_LAMPS)
}
