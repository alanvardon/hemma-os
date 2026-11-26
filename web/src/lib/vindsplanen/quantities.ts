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
//   + storage rooms (owner decision 2026-11-26), the room-facing side of the
//     new walls only, as buildStorage builds them from `storageGeom`:
//       front wall x0..xe at zf, hF high (= roofY(zf)), (xe − x0)·hF
//       side walls at x0 and x1 from zf back to zb, top following the roof,
//         ∫ roofY dz over zf..zb — skipped where a partition wall already
//         stands (sharedX0 / sharedX1) or where the side lies on a gable
//         (within SHARED_TOL of x = 0 or L), so no surface counts twice
//       with the corner part (ext) instead of the plain x1 side wall:
//         the side wall at x1 from ext.zn to zb (∫ roofY), the wall along
//         the stair run x1..ext.x2 at ext.zn, roofY(ext.zn) high, and the
//         end piece at ext.x2, the trapezoid zf..ext.zn with heights hF and
//         roofY(ext.zn) exactly as the scene draws it
//       The back (knee wall, or eaves) is not a new wall.
//   − the storage door opening dw × dh — for every door type: 'none' is an
//     open doorway (ItemEditor "Open doorway"), and the scene cuts the same
//     opening for it (buildStorage always passes the door to frontWall)
//   + closets, as buildCloset builds them from `closetGeom`: the long side at
//     xi from zd back to zb (∫ roofY dz) and the door end x0..x1 at zd, hD
//     high, d·hD; the gable and the knee wall behind it are not new walls
//   − the closet door opening dw × dh (as the drawing's schedule reports it).
//   ∫ roofY is exact (piecewise linear, kinked at the ridge z = 0); the scene
//   samples the same line with 8 points and floors it at 2 cm, which differs
//   by less than a few cm² and is ignored.

import { boardSpan, roofY, type Geometry } from './attic'
import { closetGeom, gableWindowFit, skyHolesOk, skyRect, storageGeom } from './items'
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
  /** Storage-room walls, room-facing side, before door openings. */
  storageWalls: number
  /** Storage-room door openings. */
  storageDoors: number
  /** Closet walls, room-facing side, before door openings. */
  closetWalls: number
  /** Closet door openings. */
  closetDoors: number
}

/** How close (m) a storage side wall must be to a gable to count as standing on it — the tolerance storageGeom uses for partitions. */
const SHARED_TOL = 0.12

/** ∫ roofY dz from za to zb, ≥ 0, exact: roofY = SLOPE·(HALF − |z|), 0 beyond the eaves. */
export function roofArea(geo: Pick<Geometry, 'HALF' | 'SLOPE'>, za: number, zb: number): number {
  const { HALF, SLOPE } = geo
  const F = (z: number) => {
    const c = Math.max(-HALF, Math.min(HALF, z))
    return SLOPE * (HALF * c - (c * Math.abs(c)) / 2)
  }
  return Math.abs(F(zb) - F(za))
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
  let storageWalls = 0
  let storageDoors = 0
  let closetWalls = 0
  let closetDoors = 0
  const onGable = (x: number) => x < SHARED_TOL || x > L - SHARED_TOL
  plan.items.forEach((it) => {
    if (it.type === 'storage') {
      const S = storageGeom(geo, plan, it)
      storageWalls += (S.xe - S.x0) * S.hF
      if (!S.sharedX0 && !onGable(S.x0)) storageWalls += roofArea(geo, S.zf, S.zb)
      if (S.ext) {
        const hn = roofY(geo, S.ext.zn)
        storageWalls += roofArea(geo, S.ext.zn, S.zb) + (S.ext.x2 - S.x1) * hn + (Math.abs(S.ext.zn - S.zf) * (S.hF + hn)) / 2
      } else if (!S.sharedX1 && !onGable(S.x1)) storageWalls += roofArea(geo, S.zf, S.zb)
      storageDoors += Math.max(0, S.dw) * Math.max(0, S.dh)
    } else if (it.type === 'closet') {
      const C = closetGeom(geo, plan, it)
      closetWalls += roofArea(geo, C.zd, C.zb) + (C.x1 - C.x0) * C.hD
      closetDoors += Math.max(0, C.dw) * Math.max(0, C.dh)
    }
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
    storageWalls,
    storageDoors,
    closetWalls,
    closetDoors,
  }
}

/** The four material quantities, m², full precision (see the header for what each covers). */
export function quantities(geo: Geometry, plan: Pick<PlanV2, 'items' | 'options'>): Quantities {
  const p = quantityParts(geo, plan)
  return {
    floor: p.floorInside - p.floorInsideHoles + p.floorEaves - p.floorEavesHoles,
    panel: p.panelGross - p.panelWindows,
    walls:
      p.kneeWalls + p.gables - p.gableWindow + p.partitions - p.partitionDoors + p.storageWalls - p.storageDoors + p.closetWalls - p.closetDoors,
    insulation: p.insulationGross - p.insulationWindows,
  }
}

export interface CostLine {
  key: QuantityKey
  /** Quantity, m². */
  m2: number
  /** kr/m² incl. VAT, or null when not entered. */
  price: number | null
  /** m2 × price at full precision; 0 when m2 is 0; null when m2 > 0 and the price is not entered. */
  kr: number | null
}

/**
 * Below this many m² a quantity counts as 0 (owner decision 2026-11-26). It
 * absorbs float noise from subtracting openings (e.g. 1e-15 left over) — far
 * below anything that could carry a price (1e-9 m² × 10 000 kr/m² = 0.00001 kr).
 */
export const ZERO_M2 = 1e-9

/**
 * One line per quantity, in PRICE_KEYS order. A price that is not a finite
 * number ≥ 0 (null, missing, or anything sanitizePrices would refuse) counts
 * as not entered. A line with 0 m² (|m2| < ZERO_M2) is never missing: its kr
 * is 0 whatever the price (owner decision 2026-11-26). A line with m² > 0 and
 * no price has kr null, never 0. A price of 0 gives 0 kr.
 */
export function costLines(q: Quantities, prices: Prices | undefined): CostLine[] {
  return PRICE_KEYS.map((key) => {
    const v = prices?.[key]
    const price = isPrice(v) ? v : null
    const m2 = q[key]
    const kr = Math.abs(m2) < ZERO_M2 ? 0 : price === null ? null : m2 * price
    return { key, m2, price, kr }
  })
}

/**
 * The estimated material cost: the sum of the priced lines, kr at full
 * precision (round for display only), and the lines left out because their
 * price is not entered (only lines with m² > 0 can be missing; a 0 m² line
 * adds 0 kr and never blocks the total). With every line missing, kr is 0
 * and `missing` lists them all — the caller must not present that 0 as an
 * estimate.
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
