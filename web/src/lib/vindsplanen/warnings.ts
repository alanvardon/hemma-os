// Per-item warnings and the numbers behind them, ported from v41
// (furnWarnings 1068, buildWall 1076, skyInfo 1100, stairInfo 1126,
// curvedInfo 1158, buildStorage 1245–1251, buildCloset 1288–1292).
//
// Warnings are structured `{ code, params }`; the route formats the words.
// Numeric params carry exactly the value v41 printed: whole centimetres from
// `cm()`, or the value v41 showed with toFixed(1) / toFixed(0), as a number.

import { ceilAt, clamp, cm, roofY, type Geometry } from './attic'
import { hallRect, oldStairs, swRect } from './below'
import { closetGeom, furnitureChecks, skyHolesOk, SKY_SIZES, storageGeom } from './items'
import { HEAD, isUpStair, pip, planOf, stairHoles, stairsInside, toWorld, type Pt, type StairPlan, type UpStair } from './stairs'
import type { ClosetItem, Item, PlanV2, SkylightItem, StairsItem, StorageItem, WallItem } from './plan'

export type WarningCode =
  // furniture
  | 'furn-roof-clash'
  | 'furn-outside'
  // partition wall
  | 'wall-door-low' // { h }
  | 'wall-on-rafter' // info, not a problem
  // roof window
  | 'sky-wider-than-bay' // { w, clear }
  | 'sky-reaches-ridge'
  | 'sky-overlap'
  // straight stairs
  | 'stairs-outside'
  | 'stairs-steep-rise' // { rise }
  | 'stairs-too-steep' // { blondel }
  | 'stairs-shallow' // { blondel }
  | 'stairs-low-head' // { head }
  // curved and spiral stairs
  | 'up-walkway-narrow' // { free }
  | 'up-outside-hall'
  | 'up-over-well' // { reach, need }
  | 'up-low-head' // { head }
  | 'up-down-head' // { head }
  | 'up-knee-wall'
  | 'up-hole-clash'
  | 'spiral-landing-head' // { step, head }
  | 'spiral-shallow' // { going }
  | 'up-steep-rise' // { rise }
  | 'up-door-blocked' // { count, walls: 'W,N,S' in door order }
  // storage room
  | 'storage-hole-overlap'
  | 'storage-low-front' // { h }
  // closet
  | 'closet-hole-overlap'
  | 'closet-door-low' // { h }
  | 'closet-shallow' // { depth }

export interface Warning {
  code: WarningCode
  params: Record<string, number | string>
}

/** Codes that are information, not a problem (v41 `realWarn` filtered 'Sits on…'). */
export const INFO_CODES: ReadonlySet<WarningCode> = new Set<WarningCode>(['wall-on-rafter'])
export const realWarnings = (ws: readonly Warning[]): Warning[] => ws.filter((w) => !INFO_CODES.has(w.code))

const W = (code: WarningCode, params: Record<string, number | string> = {}): Warning => ({ code, params })
/** The number v41 printed with toFixed(k). */
const fixed = (v: number, k: number): number => +v.toFixed(k)

type PlanSlice = Pick<PlanV2, 'items' | 'options'>

// ---------- Furniture

export function furnWarnings(geo: Geometry, plan: PlanSlice, it: Extract<Item, { x: number; z: number; rot: number }>, checks: [number, number, number][]): { warn: Warning[]; clash: boolean } {
  const a = (it.rot * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  const out: Warning[] = []
  let clash = false
  let behind = false
  checks.forEach(([lx, lz, h]) => {
    const z = it.z - lx * s + lz * c
    const x = it.x + lx * c + lz * s
    if (ceilAt(geo, plan.options.board, x, z) < h - 0.005) clash = true
    if (Math.abs(z) > geo.KZ + 0.005 || x < -0.005 || x > geo.L + 0.005) behind = true
  })
  if (clash) out.push(W('furn-roof-clash'))
  if (behind) out.push(W('furn-outside'))
  return { warn: out, clash }
}

// ---------- Partition wall

export const WALL_DOOR_W = 0.8

export function wallInfo(geo: Geometry, it: WallItem): { zc: number; dh: number; warn: Warning[] } {
  const { KZ } = geo
  const dw = WALL_DOOR_W
  const out: Warning[] = []
  let zc = 0
  let dh = 0
  if (it.door) {
    zc = clamp(it.doorZ, -KZ + dw / 2 + 0.05, KZ - dw / 2 - 0.05)
    dh = Math.min(2.0, roofY(geo, Math.abs(zc) + dw / 2) - 0.1)
    if (dh < 1.9) out.push(W('wall-door-low', { h: cm(dh) }))
  }
  // one per rafter within 7 cm, as v41
  geo.RAFT_X.forEach((x) => {
    if (Math.abs(x - it.x) < 0.07) out.push(W('wall-on-rafter'))
  })
  return { zc, dh, warn: out }
}

// ---------- Roof window

export function skyInfo(geo: Geometry, it: SkylightItem, holesOk: ReadonlySet<string>) {
  const sz = SKY_SIZES[it.size]
  const bay = geo.BAYS[it.bay]
  const sBot = it.bottom / geo.SIN
  const sTop = sBot + sz.h
  const out: Warning[] = []
  if (sz.w > bay.clear) out.push(W('sky-wider-than-bay', { w: cm(sz.w), clear: fixed(bay.clear * 100, 1) }))
  if (sTop > geo.SLEN - 0.2) out.push(W('sky-reaches-ridge'))
  else if (!holesOk.has(it.id)) out.push(W('sky-overlap'))
  return { sz, bay, sBot, sTop, topY: sTop * geo.SIN, warn: out }
}

// ---------- Straight stairs (a hatch-style flight down from the attic)

export function stairInfo(geo: Geometry, it: StairsItem) {
  const n = Math.max(3, Math.round(it.drop / 0.18))
  const rise = it.drop / n
  const going = it.run / n
  let minHead = Infinity
  for (let k = 0; k < n; k++) {
    const x0 = it.run / 2 - (k + 1) * going
    const x1 = it.run / 2 - k * going
    const zs = ([[x0, -it.w / 2], [x1, -it.w / 2], [x0, it.w / 2], [x1, it.w / 2]] as Pt[]).map(([a, b]) => toWorld(it, a, b)[1])
    minHead = Math.min(minHead, Math.min(...zs.map((z) => roofY(geo, z))) + k * rise)
  }
  const out: Warning[] = []
  const blondel = 2 * rise + going
  if (!stairsInside(geo, it)) out.push(W('stairs-outside'))
  if (rise > 0.2) out.push(W('stairs-steep-rise', { rise: fixed(rise * 100, 1) }))
  if (blondel < 0.59) out.push(W('stairs-too-steep', { blondel: fixed(blondel * 100, 0) }))
  if (blondel > 0.66) out.push(W('stairs-shallow', { blondel: fixed(blondel * 100, 0) }))
  if (minHead < 1.9) out.push(W('stairs-low-head', { head: cm(minHead) }))
  return { n, rise, going, blondel, minHead, warn: out }
}

// ---------- Curved and spiral stairs up from the floor below

export interface CurvedInfo {
  P: StairPlan
  /** Tightest headroom under the roof on the way up. */
  head: number
  /** Headroom for someone on the old stairs under the new ones (Infinity if none overlap). */
  downHead: number
  /** Narrowest walk-past width left in the hallway below. */
  minFree: number
  /**
   * Spiral stairs: the tightest clearance from a step to the underside of the
   * top landing above it (Infinity for curved stairs, or when no step is under
   * the landing). The number behind 'spiral-landing-head'.
   */
  landingHead: number
  warn: Warning[]
}

/**
 * `holeClash` is v41's module-level clash set as it stood when this item was
 * drawn — see `planWarnings` for which `stairHoles` call left it there.
 */
export function curvedInfo(geo: Geometry, plan: PlanSlice, it: UpStair, holeClash: ReadonlySet<string>): CurvedInfo {
  const { L, KZ, EDGES } = geo
  const B = plan.options.below
  const P = planOf(B, it)
  const r = swRect(geo, B)
  const h = hallRect(geo, B)
  const out: Warning[] = []
  const Wp = (pts: Pt[]) => pts.map(([a, b]) => toWorld(it, a, b))
  let head = Infinity
  let downHead = Infinity
  let outside = false
  let overWell = false
  const OS = oldStairs(geo, B)
  const oldT = OS.P.treads.map((q) => ({ t: q.t - OS.P.F, wp: q.poly.map(([a, b]) => toWorld(OS.it, a, b)) }))
  P.treads.forEach((tr, i) => {
    const wp = Wp(tr.poly)
    const cx = wp.reduce((s, q) => s + q[0], 0) / wp.length
    const cz = wp.reduce((s, q) => s + q[1], 0) / wp.length
    if (!tr.landing && wp.some(([x, z]) => x < h.xw - 0.01 || x > L + 0.01 || z < h.za - 0.01 || z > h.zb + 0.01)) outside = true
    head = Math.min(head, roofY(geo, cz) + P.F - tr.t)
    const ot = oldT.find((o) => pip(o.wp, cx, cz))
    if (ot) downHead = Math.min(downHead, tr.t - 0.045 - ot.t)
    if (i === 0 && wp.some(([x, z]) => x > r.x0 + B.fill + 0.02 && x < r.x1 - 0.02 && z > r.z0 + 0.02 && z < r.z1 - 0.02)) overWell = true
  })
  // the walk-past scan: 5 cm strips across the hallway, each 5 cm sample free
  // unless inside the stairwell or under a tread lower than 2.0 m
  const low = P.treads.filter((tr) => tr.t - 0.045 < 2.0).map((tr) => Wp(tr.poly))
  let minFree = Infinity
  for (let x = h.xw + 0.025; x < L; x += 0.05) {
    let free = 0
    for (let z = h.za + 0.025; z < h.zb; z += 0.05) {
      if (x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) continue
      if (low.some((q) => pip(q, x, z))) continue
      free += 0.05
    }
    minFree = Math.min(minFree, free)
  }
  const op = Wp(P.opening)
  if (minFree < 0.8) out.push(W('up-walkway-narrow', { free: cm(minFree) }))
  if (outside) out.push(W('up-outside-hall'))
  if (overWell) {
    const w0 = Wp(P.treads[0].poly)
    const need = Math.ceil((Math.max(...w0.map((q) => q[0])) - r.x0) * 100 + 2) // its far edge, past the opening's west end
    out.push(W('up-over-well', { reach: need - 2, need }))
  }
  if (head < HEAD) out.push(W('up-low-head', { head: cm(head) }))
  if (downHead < 2.0) out.push(W('up-down-head', { head: cm(downHead) }))
  const bayOpen = (x: number, z: number) => {
    const i = EDGES.findIndex((e, k) => k < EDGES.length - 1 && x >= e - 0.01 && x <= EDGES[k + 1] + 0.01)
    return i >= 0 && plan.options.knee[z < 0 ? 'N' : 'S'].includes(i)
  }
  if (op.some(([x, z]) => Math.abs(z) > KZ + 0.01 && !bayOpen(x, z))) out.push(W('up-knee-wall'))
  if (holeClash.has(it.id)) out.push(W('up-hole-clash'))
  let lowest = Infinity
  if (P.spiral) {
    const landing = P.landing as Pt[]
    let k = 0
    P.treads.forEach((tr, i) => {
      if (tr.landing) return
      const c = tr.poly.reduce((a, q) => [a[0] + q[0] / tr.poly.length, a[1] + q[1] / tr.poly.length], [0, 0])
      if (pip(landing, c[0], c[1])) {
        const clr = P.F - B.slab - tr.t
        if (clr < lowest) {
          lowest = clr
          k = i + 1
        }
      }
    })
    if (lowest < 2.0) out.push(W('spiral-landing-head', { step: k, head: cm(lowest) }))
  }
  if (P.spiral && P.g < 0.2) out.push(W('spiral-shallow', { going: cm(P.g) }))
  if (P.r > 0.2) out.push(W('up-steep-rise', { rise: fixed(P.r * 100, 1) }))
  const blockedDoors = B.doors.filter((d) => {
    // the 80 cm in front of each door on the floor below must stay clear
    const half = d.w / 2 + 0.05
    const zone =
      d.wall === 'W'
        ? [h.xw, h.xw + 0.8, h.za + d.at - half, h.za + d.at + half]
        : d.wall === 'N'
          ? [L - d.at - half, L - d.at + half, h.za, h.za + 0.8]
          : [L - d.at - half, L - d.at + half, h.zb - 0.8, h.zb]
    return P.treads.some((tr) => {
      if (tr.t - 0.045 >= 2.0) return false // a step whose underside is above 2 m can be walked under
      const wp = Wp(tr.poly)
      const cx = wp.reduce((a, q) => a + q[0], 0) / wp.length
      const cz = wp.reduce((a, q) => a + q[1], 0) / wp.length
      return [...wp, [cx, cz] as Pt].some(([x, z]) => x > zone[0] && x < zone[1] && z > zone[2] && z < zone[3])
    })
  })
  if (blockedDoors.length) out.push(W('up-door-blocked', { count: blockedDoors.length, walls: blockedDoors.map((d) => d.wall).join(',') }))
  return { P, head, downHead, minFree, landingHead: lowest, warn: out }
}

// ---------- Storage room and closet

const overlapsHoles = (holes: Pt[][], rects: number[][]) =>
  rects.some(([a, b, c, d]) =>
    holes.some(
      (p) =>
        p.some(([x, z]) => x > a + 0.01 && x < b - 0.01 && z > c + 0.01 && z < d - 0.01) ||
        ([[a, c], [b, c], [a, d], [b, d]] as Pt[]).some(([x, z]) => pip(p, x, z)),
    ),
  )

export function storageWarnings(geo: Geometry, plan: PlanSlice, it: StorageItem): Warning[] {
  const S = storageGeom(geo, plan, it)
  const warn: Warning[] = []
  const holes = stairHoles(geo, plan, geo.HALF).holes
  const zlo = Math.min(S.zf, S.zb)
  const zhi = Math.max(S.zf, S.zb)
  const rects = [[S.x0, S.x1, zlo, zhi]]
  if (S.ext) rects.push([S.x1, S.ext.x2, Math.min(S.zf, S.ext.zn), Math.max(S.zf, S.ext.zn)])
  if (overlapsHoles(holes, rects)) warn.push(W('storage-hole-overlap'))
  if (S.hF < 1.8) warn.push(W('storage-low-front', { h: cm(S.hF) }))
  return warn
}

export function closetWarnings(geo: Geometry, plan: PlanSlice, it: ClosetItem): Warning[] {
  const C = closetGeom(geo, plan, it)
  const warn: Warning[] = []
  const holes = stairHoles(geo, plan, geo.HALF).holes
  const zlo = Math.min(C.zd, C.zb)
  const zhi = Math.max(C.zd, C.zb)
  // v41 tests the closet's own box only (no corner part)
  if (
    holes.some(
      (p) =>
        p.some(([x, z]) => x > C.x0 + 0.01 && x < C.x1 - 0.01 && z > zlo + 0.01 && z < zhi - 0.01) ||
        ([[C.x0, zlo], [C.x1, zlo], [C.x0, zhi], [C.x1, zhi]] as Pt[]).some(([x, z]) => pip(p, x, z)),
    )
  )
    warn.push(W('closet-hole-overlap'))
  if (C.dh < 1.6) warn.push(W('closet-door-low', { h: cm(C.dh) }))
  if (C.d - 0.1 < 0.35) warn.push(W('closet-shallow', { depth: cm(C.d - 0.1) }))
  return warn
}

// ---------- Whole plan

/**
 * Every item's warnings, as a full v41 rebuild (`rebuildAll`) produces them.
 *
 * v41 quirk kept: curved/spiral stairs read a module-level clash set left by
 * whichever `stairHoles(lim)` ran last. In `rebuildAll` that is the floor
 * build's final call — `stairHoles(HALF)` when any knee-wall bay is opened
 * (buildKnee), else `stairHoles(KZ)` — until the first storage room or closet
 * is drawn, after which it is `stairHoles(KZ)`.
 */
export function planWarnings(geo: Geometry, plan: PlanSlice): Record<string, Warning[]> {
  const out: Record<string, Warning[]> = {}
  const holesOk = skyHolesOk(geo, plan.items)
  const kneeOpen = (['N', 'S'] as const).some((s) => plan.options.knee[s].length > 0)
  const clashAt = (lim: number) => stairHoles(geo, plan, lim).clash
  let lastLim = kneeOpen ? geo.HALF : geo.KZ
  for (const it of plan.items) {
    let warn: Warning[]
    if (it.type === 'skylight') warn = skyInfo(geo, it, holesOk).warn
    else if (it.type === 'wall') warn = wallInfo(geo, it).warn
    else if (it.type === 'stairs') warn = stairInfo(geo, it).warn
    else if (isUpStair(it)) warn = curvedInfo(geo, plan, it, clashAt(lastLim)).warn
    else if (it.type === 'storage') {
      warn = storageWarnings(geo, plan, it)
      lastLim = geo.KZ
    } else if (it.type === 'closet') {
      warn = closetWarnings(geo, plan, it)
      lastLim = geo.KZ
    } else warn = furnWarnings(geo, plan, it, furnitureChecks(it).checks).warn
    out[it.id] = warn
  }
  return out
}

