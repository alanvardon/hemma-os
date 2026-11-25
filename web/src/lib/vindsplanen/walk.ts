// First-person walk: what you can stand on, collisions and headroom, ported
// from v41 (lines 1771–1835). Eyes at 168 cm (a 180 cm man); feet on whichever
// floor or stair tread is underfoot. The camera and input stay in the scene.

import { ceilAt, clamp, type Geometry } from './attic'
import { FF, GROUND_RUN, hallRect, oldStairs, swRect } from './below'
import { closetGeom, storageGeom } from './items'
import { curvedPlan, isUpStair, pip, planOf, stairHoles, toWorld, type Pt } from './stairs'
import type { ClosetItem, PlanV2, StorageItem } from './plan'

export const EYE = 1.68
export const BODY = 1.8
/** Highest step up (or down) taken in one move. */
export const STEP = 0.32

export type Where = 'attic' | 'below' | 'old' | 'new' | 'ground'

export type Surface =
  | { rect: [number, number, number, number]; holes: Pt[][]; y: number; where: Where; over?: undefined; poly?: undefined }
  | { poly: Pt[]; y: number; where: Where; over: true; rect?: undefined; holes?: undefined }

export interface WalkWall {
  x: number
  door: boolean
  zc: number
}

export interface WalkSeg {
  a: Pt
  b: Pt
  /** A doorway along the segment, as an x range. */
  gap?: [number, number]
}

export interface WalkWorld {
  surf: Surface[]
  walls: WalkWall[]
  segs: WalkSeg[]
  /** Openings in the ceiling of the floor below. */
  ceilHoles: Pt[][]
}

export interface WalkPose {
  x: number
  z: number
  feet: number
  where: Where | ''
}

type PlanSlice = Pick<PlanV2, 'items' | 'options'>

/** Everything you can stand on, plus walls and room sides (v41 `fpSurfaces`). */
export function walkWorld(geo: Geometry, plan: PlanSlice): WalkWorld {
  const { L, KZ, HALF, EDGES } = geo
  const B = plan.options.below
  const F = FF(B)
  const S: Surface[] = []
  S.push({ rect: [0, L, -KZ, KZ], holes: stairHoles(geo, plan, KZ).holes, y: 0, where: 'attic' })
  const eavesHoles = stairHoles(geo, plan, HALF).holes
  const sides: ['S' | 'N', number][] = [
    ['S', 1],
    ['N', -1],
  ]
  sides.forEach(([side, sg]) =>
    plan.options.knee[side].forEach((i) =>
      S.push({ rect: [EDGES[i], EDGES[i + 1], sg > 0 ? KZ : -HALF, sg > 0 ? HALF : -KZ], holes: eavesHoles, y: 0, where: 'attic' }),
    ),
  )
  const ceilHoles = stairHoles(geo, plan, B.hw).holes
  if (B.show) {
    const h = hallRect(geo, B)
    const r = swRect(geo, B)
    const OS = oldStairs(geo, B)
    const yb = -F - OS.P.F
    S.push({
      rect: [h.xw, L, h.za, h.zb],
      holes: [[[r.x0 + B.fill, r.z0], [r.x1, r.z0], [r.x1, r.z1], [r.x0 + B.fill, r.z1]]],
      y: -F,
      where: 'below',
    })
    // walk on the old stairs as filling the opening's width, so there is no gap to trip on at the hallway edge
    const ow = clamp(r.z1 - r.z0 - OS.it.b * OS.it.g, 0.6, r.z1 - r.z0)
    const north = B.side === 'N'
    const wit = { ...OS.it, w: ow, x: r.x1 - ow - OS.it.a * OS.it.g, z: north ? r.z0 + ow / 2 : r.z1 - ow / 2 }
    const WP = curvedPlan(B, wit, OS.P.F)
    WP.treads.forEach((t) => S.push({ poly: t.poly.map(([a, b]) => toWorld(wit, a, b)), y: yb + t.t, where: 'old', over: true }))
    S.push({ rect: [OS.it.x - GROUND_RUN, r.x1, r.z0, r.z1], holes: [], y: yb, where: 'ground' })
    plan.items.filter(isUpStair).forEach((it) =>
      planOf(B, it).treads.forEach((t) => {
        if (!t.landing) S.push({ poly: t.poly.map(([a, b]) => toWorld(it, a, b)), y: -F + t.t, where: 'new', over: true })
      }),
    )
  }
  const walls = plan.items.flatMap((w) => (w.type === 'wall' ? [{ x: w.x, door: w.door, zc: clamp(w.doorZ, -KZ + 0.45, KZ - 0.45) }] : []))
  const segs: WalkSeg[] = []
  plan.items
    .filter((i): i is ClosetItem => i.type === 'closet')
    .forEach((it) => {
      const C = closetGeom(geo, plan, it)
      segs.push({ a: [C.xi, C.zd], b: [C.xi, C.zb] }, { a: [C.x0, C.zd], b: [C.x1, C.zd] })
    })
  plan.items
    .filter((i): i is StorageItem => i.type === 'storage')
    .forEach((it) => {
      const G = storageGeom(geo, plan, it)
      segs.push({ a: [G.x0, G.zf], b: [G.xe, G.zf], gap: [G.dc - G.dw / 2 + 0.05, G.dc + G.dw / 2 - 0.05] }, { a: [G.x0, G.zf], b: [G.x0, G.zb] })
      if (G.ext)
        segs.push(
          { a: [G.x1, G.ext.zn], b: [G.x1, G.zb] },
          { a: [G.x1, G.ext.zn], b: [G.ext.x2, G.ext.zn] },
          { a: [G.ext.x2, G.ext.zn], b: [G.ext.x2, G.zf] },
        )
      else segs.push({ a: [G.x1, G.zf], b: [G.x1, G.zb] })
    })
  return { surf: S, walls, segs, ceilHoles }
}

export const inSurf = (s: Surface, x: number, z: number): boolean =>
  s.rect
    ? x >= s.rect[0] && x <= s.rect[1] && z >= s.rect[2] && z <= s.rect[3] && !s.holes.some((p) => pip(p, x, z))
    : pip(s.poly, x, z)

/** The highest surface at (x, z) no more than one step above `feet`. */
export function fpGround(world: WalkWorld, x: number, z: number, feet: number): Surface | null {
  let best: Surface | null = null
  for (const s of world.surf) if (s.y <= feet + STEP && (!best || s.y > best.y) && inSurf(s, x, z)) best = s
  return best
}

/** Headroom: to the lowest thing above — the roof, the underside of a floor, or stairs overhead. */
export function fpHeadroom(geo: Geometry, plan: PlanSlice, world: WalkWorld, x: number, z: number, feet: number): number {
  const B = plan.options.below
  const F = FF(B)
  const r = swRect(geo, B)
  let top = ceilAt(geo, plan.options.board, x, z)
  if (feet < -B.slab - 0.05 && !world.ceilHoles.some((p) => pip(p, x, z))) top = Math.min(top, -B.slab)
  if (feet < -F - 0.05 && !(x > r.x0 + B.fill && x < r.x1 && z > r.z0 && z < r.z1)) top = Math.min(top, -F - 0.25)
  for (const s of world.surf) if (s.over && s.y - 0.045 > feet + 0.5 && inSurf(s, x, z)) top = Math.min(top, s.y - 0.045)
  return top - feet
}

/**
 * Try one move (v41 `fpTry`): only onto a floor within one step up or down;
 * partition walls let you through their door. Returns the new pose, or null
 * when the move is refused.
 */
export function fpTry(geo: Geometry, plan: PlanSlice, world: WalkWorld, pose: WalkPose, nx: number, nz: number): WalkPose | null {
  for (const w of world.walls) if (pose.feet > -0.1 && (pose.x - w.x) * (nx - w.x) < 0 && !(w.door && Math.abs(nz - w.zc) < 0.35)) return null
  if (pose.feet > -0.1)
    for (const g of world.segs) {
      const [ax, az] = g.a
      const [bx, bz] = g.b
      const c = (px: number, pz: number, qx: number, qz: number, rx: number, rz: number) => (qx - px) * (rz - pz) - (qz - pz) * (rx - px)
      const d1 = c(ax, az, bx, bz, pose.x, pose.z)
      const d2 = c(ax, az, bx, bz, nx, nz)
      const d3 = c(pose.x, pose.z, nx, nz, ax, az)
      const d4 = c(pose.x, pose.z, nx, nz, bx, bz)
      if (d1 * d2 < 0 && d3 * d4 < 0) {
        const tt = d1 / (d1 - d2)
        const cx = pose.x + (nx - pose.x) * tt
        if (!(g.gap && cx > g.gap[0] && cx < g.gap[1])) return null
      }
    }
  const dx = nx - pose.x
  const dz = nz - pose.z
  const d = Math.hypot(dx, dz) || 1
  const px = nx + (dx / d) * 0.18 // keep a body's width from edges
  const pz = nz + (dz / d) * 0.18
  const g = fpGround(world, nx, nz, pose.feet)
  const gp = fpGround(world, px, pz, pose.feet + STEP) // the look-ahead may be two steps up, on tapered steps near the post
  if (!g || g.y < pose.feet - STEP || !gp || gp.y < pose.feet - STEP - 0.2) return null
  if (g.where === 'attic' && ceilAt(geo, plan.options.board, nx, nz) < 1.0) return null
  return { x: nx, z: nz, feet: g.y, where: g.where }
}

export interface WalkStart extends WalkPose {
  yaw: number
  pitch: number
  eyeY: number
}

/** Where a walk starts (v41 `fpPlace`): in the hallway below, or in the attic. Null if no spot fits. */
export function fpPlace(geo: Geometry, plan: PlanSlice, world: WalkWorld, where: 'below' | 'attic'): WalkStart | null {
  const { L } = geo
  const B = plan.options.below
  const F = FF(B)
  let spots: [number, number, number, number][]
  if (where === 'below' && B.show) {
    const h = hallRect(geo, B)
    spots = [
      [h.xw + 0.6, (h.za + h.zb) / 2, -F, 0],
      [h.xw + 1.2, (h.za + h.zb) / 2, -F, 0],
    ]
  } else
    spots = [
      [L - 1.0, 0.4, 0, Math.PI],
      [L - 1.0, -0.4, 0, Math.PI],
      [L / 2, 0, 0, Math.PI],
      [1.5, 0, 0, 0],
    ]
  for (const [x, z, y, yaw] of spots) {
    const g = fpGround(world, x, z, y)
    if (g && Math.abs(g.y - y) < 0.01) return { x, z, feet: y, yaw, pitch: -0.05, where: g.where, eyeY: y + EYE }
  }
  return null
}

/** Eye height above the feet: crouch under anything lower than you (v41 `fpUpdate`). */
export const eyeHeight = (head: number): number => Math.min(EYE, Math.max(0.6, head - 0.12))

/** Headroom below which the HUD says to stoop. */
export const mustStoop = (head: number): boolean => head < BODY + 0.05
