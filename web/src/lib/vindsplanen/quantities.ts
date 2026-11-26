// Material quantities from the attic geometry, and an estimated material cost
// from the household's own prices (plan 150). Pure: no React, no three.js.
//
// Every quantity is a surface area in m², kept at full precision; rounding is
// for display only. The areas follow the shell as the scene builds it
// (routes/vindsplanen/scene/shell.ts, itemsScene.ts) and are gross areas a
// builder would order by — no waste allowance, no deduction for rafters or
// studs in front of a surface.
//
// floor — the finished attic floor:
//   + the floor inside the knee walls, 2·KZ·L
//   − the stair openings in it, `stairHoles(geo, plan, KZ)` (as buildFloors)
//   + per opened knee-wall bay (options.knee), the floored eaves strip
//     bay width × (HALF − KZ)
//   − the stair openings reaching into that strip, `stairHoles(HALF)` clipped
//     to it (as buildKnee).
//
// panel — the panelled underside of the roof (both slopes) in the bays that
//   are NOT insulated (not in options.board), measured on the slope:
//   + per bay and side, bay width × slope length from the top of the knee
//     wall (v = (HALF − KZ)/COS) — or from the floor (v = 0) when that bay's
//     knee wall is opened — up to the ridge (v = SLEN)
//   − every roof window that gets a real opening (`skyHolesOk`), by the part
//     of its rectangle that lies on that strip. The panelling behind a knee
//     wall (in the unfinished eaves) is not counted.
//
// insulation — the insulated, plasterboarded ceiling of the bays in
//   options.board, measured on the plasterboard plane (BOARD_D in from the
//   panelling) exactly as buildBoard draws it:
//   + per boarded bay and side, bay width × (vTop − v0) from `boardSpan`
//     (v0: the top of the knee wall, or the floor when the bay is opened;
//     vTop: where the two sides meet at the ridge)
//   − roof window openings, by the part of each that lies on that strip.
//   The thin end caps that close the cavity next to an open bay are left out.
//
// walls — wall surface for the wall finish, one quantity for all walls:
//   + knee walls: per kept (not opened) bay and side, bay width × KNEE_H,
//     the room-side face only (the back faces the unfinished eaves)
//   + both gable ends, room-side face: the area under the roof inside the
//     knee walls, ∫ roofY over |z| ≤ KZ = KZ·(H + KNEE_H) per gable, plus,
//     when the end bay's knee wall is opened on a side, the eaves triangle
//     (HALF − KZ)·KNEE_H/2 on that side
//   − the east gable window when it is on and fits (`gableWindowFit`), by its
//     part within that finished gable area
//   + partition walls (items of type 'wall'): the profile as buildWall draws
//     it, KZ·(H + KNEE_H), counted on BOTH faces (a partition is finished on
//     both sides)
//   − the door opening, WALL_DOOR_W × dh from `wallInfo`, on both faces.
//   Storage-room and closet walls are not included (plan 150 lists knee
//   walls, gables and partition walls only).

import { boardSpan, type Geometry } from './attic'
import { gableWindowFit, skyHolesOk, skyRect } from './items'
import { isPrice, PRICE_KEYS, type PlanV2, type PriceKey, type Prices, type SkylightItem } from './plan'
import { clipBox, stairHoles, type Pt } from './stairs'
import { WALL_DOOR_W, wallInfo } from './warnings'

export type QuantityKey = PriceKey

/** Material quantities, m², full precision. */
export type Quantities = Record<QuantityKey, number>

/** Every term behind `quantities`, m², so each can be checked on its own. */
export interface QuantityParts {
  /** 2·KZ·L. */
  floorInside: number
  /** Stair openings in the floor inside the knee walls. */
  floorInsideHoles: number
  /** Floored eaves of opened knee-wall bays, before openings. */
  floorEaves: number
  /** Stair openings in those eaves strips. */
  floorEavesHoles: number
  /** Panelling of the non-insulated bays, before window openings. */
  panelGross: number
  panelWindows: number
  /** Plasterboard ceiling of the insulated bays, before window openings. */
  insulationGross: number
  insulationWindows: number
  /** Room-side faces of the kept knee walls. */
  kneeWalls: number
  /** Both gable ends, room side, before the gable window. */
  gables: number
  gableWindow: number
  /** Partition walls, both faces, before door openings. */
  partitions: number
  /** Partition door openings, both faces. */
  partitionDoors: number
}

/** Area of a simple polygon (shoelace), always ≥ 0. */
export function polygonArea(poly: readonly Pt[]): number {
  let a = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1]
  return Math.abs(a) / 2
}

/** Overlap length of [a0, a1] and [b0, b1], ≥ 0. */
const overlap = (a0: number, a1: number, b0: number, b1: number): number => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0)

export function quantityParts(geo: Geometry, plan: Pick<PlanV2, 'items' | 'options'>): QuantityParts {
  const { L, KZ, HALF, H, KNEE_H, SLEN, COS, BAYS, EDGES } = geo
  const { knee, board, gable } = plan.options
  const boarded = new Set(board)
  const last = BAYS.length - 1
  const sides = ['S', 'N'] as const
  const opened = (side: 'S' | 'N', i: number) => knee[side].includes(i)

  // ---- floor
  const floorInside = 2 * KZ * L
  const floorInsideHoles = sum(stairHoles(geo, plan, KZ).holes.map(polygonArea))
  const holesHALF = stairHoles(geo, plan, HALF).holes
  let floorEaves = 0
  let floorEavesHoles = 0
  sides.forEach((side) => {
    const sign = side === 'S' ? 1 : -1
    const za = sign > 0 ? KZ : -HALF
    const zb = sign > 0 ? HALF : -KZ
    BAYS.forEach((_, i) => {
      if (!opened(side, i)) return
      const x0 = EDGES[i]
      const x1 = EDGES[i + 1]
      floorEaves += (x1 - x0) * (HALF - KZ)
      // the same clip as buildKnee
      holesHALF.forEach((p) => {
        const c = clipBox(p, x0 + 0.001, x1 - 0.001, za + 0.001, zb - 0.001)
        if (c) floorEavesHoles += polygonArea(c)
      })
    })
  })

  // ---- roof surfaces: panel (open bays) and insulation (boarded bays)
  const ok = skyHolesOk(geo, plan.items)
  const windows = plan.items.filter((i): i is SkylightItem => i.type === 'skylight' && ok.has(i.id))
  const kneeTopV = (HALF - KZ) / COS
  let panelGross = 0
  let panelWindows = 0
  let insulationGross = 0
  let insulationWindows = 0
  sides.forEach((side) => {
    const onSide = windows.filter((w) => w.slope === side).map((w) => skyRect(geo, w))
    BAYS.forEach((_, i) => {
      const x0 = EDGES[i]
      const x1 = EDGES[i + 1]
      const o = opened(side, i)
      const [v0, v1] = boarded.has(i) ? ((s) => [s.v0, s.vTop])(boardSpan(geo, o)) : [o ? 0 : kneeTopV, SLEN]
      const gross = (x1 - x0) * (v1 - v0)
      const cut = sum(onSide.map((r) => overlap(r.x0, r.x1, x0, x1) * overlap(r.s0, r.s1, v0, v1)))
      if (boarded.has(i)) {
        insulationGross += gross
        insulationWindows += cut
      } else {
        panelGross += gross
        panelWindows += cut
      }
    })
  })

  // ---- walls
  let kneeWalls = 0
  sides.forEach((side) =>
    BAYS.forEach((_, i) => {
      if (!opened(side, i)) kneeWalls += (EDGES[i + 1] - EDGES[i]) * KNEE_H
    }),
  )
  const inner = KZ * (H + KNEE_H) // ∫ roofY dz over |z| ≤ KZ
  const eavesTri = ((HALF - KZ) * KNEE_H) / 2
  const gableArea = (bay: number) => inner + sides.filter((s) => opened(s, bay)).length * eavesTri
  const gables = gableArea(0) + gableArea(last)
  let gableWindow = 0
  if (gable.on && gableWindowFit(geo, gable).fits) {
    // the east gable's finished part spans −zN..zS
    const zS = opened('S', last) ? HALF : KZ
    const zN = opened('N', last) ? HALF : KZ
    gableWindow = overlap(gable.off - gable.w / 2, gable.off + gable.w / 2, -zN, zS) * gable.h
  }
  let partitions = 0
  let partitionDoors = 0
  plan.items.forEach((it) => {
    if (it.type !== 'wall') return
    partitions += 2 * inner
    if (it.door) partitionDoors += 2 * WALL_DOOR_W * Math.max(0, wallInfo(geo, it).dh)
  })

  return {
    floorInside,
    floorInsideHoles,
    floorEaves,
    floorEavesHoles,
    panelGross,
    panelWindows,
    insulationGross,
    insulationWindows,
    kneeWalls,
    gables,
    gableWindow,
    partitions,
    partitionDoors,
  }
}

/** The four material quantities, m², full precision (see the header for what each covers). */
export function quantities(geo: Geometry, plan: Pick<PlanV2, 'items' | 'options'>): Quantities {
  const p = quantityParts(geo, plan)
  return {
    floor: p.floorInside - p.floorInsideHoles + p.floorEaves - p.floorEavesHoles,
    panel: p.panelGross - p.panelWindows,
    walls: p.kneeWalls + p.gables - p.gableWindow + p.partitions - p.partitionDoors,
    insulation: p.insulationGross - p.insulationWindows,
  }
}

export interface CostLine {
  key: QuantityKey
  /** Quantity, m². */
  m2: number
  /** kr/m² incl. VAT, or null when not entered. */
  price: number | null
  /** m2 × price at full precision, or null when the price is not entered. */
  kr: number | null
}

/**
 * One line per quantity, in PRICE_KEYS order. A price that is not a finite
 * number ≥ 0 (null, missing, or anything sanitizePrices would refuse) counts
 * as not entered: kr is null, never 0. A price of 0 gives 0 kr.
 */
export function costLines(q: Quantities, prices: Prices | undefined): CostLine[] {
  return PRICE_KEYS.map((key) => {
    const v = prices?.[key]
    const price = isPrice(v) ? v : null
    return { key, m2: q[key], price, kr: price === null ? null : q[key] * price }
  })
}

/**
 * The estimated material cost: the sum of the priced lines, kr at full
 * precision (round for display only), and the lines left out because their
 * price is not entered. With every price missing, kr is 0 and `missing`
 * lists all four — the caller must not present that 0 as an estimate.
 */
export function costTotal(lines: readonly CostLine[]): { kr: number; missing: QuantityKey[] } {
  let kr = 0
  const missing: QuantityKey[] = []
  lines.forEach((l) => {
    if (l.kr === null) missing.push(l.key)
    else kr += l.kr
  })
  return { kr, missing }
}
