// The floor below the attic: hallway, existing stairwell, old stairs and the
// layout of everything drawn there. Ported from v41 (lines 342–345, 780–785,
// 856–872, 890–969). The attic floor is y = 0; the floor below is y = −FF.

import { clamp, type Geometry } from './attic'
import { curvedPlan, isUpStair, pip, planOf, toWorld, GOING, HEAD, type CurvedLike, type Pt, type StairPlan } from './stairs'
import type { Below, BelowDoor, PlanV2 } from './plan'

export { GOING, HEAD }

/** The doors along the hallway, estimated from the owner's photos (v41 line 343). */
export const BELOW_DOORS: readonly Readonly<BelowDoor>[] = Object.freeze([
  { wall: 'S', at: 2.2, w: 0.82, kind: 'door', flip: false },
  { wall: 'S', at: 3.3, w: 0.82, kind: 'door', flip: false },
  { wall: 'N', at: 2.8, w: 0.9, kind: 'door', flip: false },
  { wall: 'N', at: 4.25, w: 0.82, kind: 'door', flip: false },
  { wall: 'W', at: 0.5, w: 0.8, kind: 'door', flip: false },
  { wall: 'W', at: 1.16, w: 0.34, kind: 'panel', flip: false },
  { wall: 'W', at: 1.8, w: 0.8, kind: 'door', flip: false },
] as BelowDoor[])

/** v41 `BELOW_DEF` (line 345) without its migration version `v: 11`. */
export const BELOW_DEF: Readonly<Below> = Object.freeze({
  show: true,
  ceil: 2.3,
  slab: 0.28,
  side: 'N',
  hw: 2.1,
  off: 0,
  east: 0,
  screen: 1.15,
  len: 2.3,
  sw: 1.0,
  hall: 1.3,
  hallLen: 4.75,
  ground: 0,
  oldN: 0,
  oldW: 0,
  oldG: 0,
  oldK: 0,
  oldB: 0,
  winZ: 0,
  winW: 0,
  winH: 0,
  winS: 0,
  fill: 0,
  ret: 0.44,
  doors: BELOW_DOORS as BelowDoor[],
} as Below)

/** Floor to floor: hallway floor to attic floor. */
export const FF = (B: Below): number => B.ceil + B.slab

export interface Rect {
  x0: number
  x1: number
  z0: number
  z1: number
}

/** The existing stairwell opening in the attic floor (world x/z). */
export function swRect(geo: Geometry, B: Below): Rect {
  const x1 = geo.L - B.east
  const x0 = x1 - B.len
  const z1 = B.side === 'S' ? B.hw - B.off : -B.hw + B.off + B.sw
  const z0 = z1 - B.sw
  return { x0, x1, z0, z1 }
}

export interface HallRect {
  /** West end of the hallway. */
  xw: number
  za: number
  zb: number
}

export function hallRect(geo: Geometry, B: Below): HallRect {
  const r = swRect(geo, B)
  const xw = Math.max(0, geo.L - B.hallLen)
  return B.side === 'S' ? { xw, za: r.z0 - B.hall, zb: B.hw } : { xw, za: -B.hw, zb: r.z1 + B.hall }
}

/** Width of the old stairs: as measured (B8), else the stairwell less 5 cm. */
export const OLD_W = (B: Below): number => (B.oldW > 0 ? B.oldW : Math.max(0.6, B.sw - 0.05))

export interface BelowWindow {
  z0: number
  w: number
  h: number
  sill: number
  measured?: true
}

/** The hallway's east-wall window: as measured (W1), else centred beside the stairwell. */
export function belowWin(geo: Geometry, B: Below): BelowWindow {
  const h = hallRect(geo, B)
  const r = swRect(geo, B)
  if (B.winW > 0) return { z0: h.za + B.winZ, w: B.winW, h: B.winH > 0 ? B.winH : 1.2, sill: B.winS > 0 ? B.winS : 0.8, measured: true }
  const hz0 = B.side === 'S' ? h.za : r.z1
  const hz1 = B.side === 'S' ? r.z0 : h.zb
  const w = Math.min(1.0, hz1 - hz0 - 0.2)
  return { z0: (hz0 + hz1) / 2 - w / 2, w, h: 1.2, sill: 0.8 }
}

export interface OldStairsItem extends CurvedLike {
  g: number
  wk: number
  b: number
  lead: number
  landingDepth: number
}

/**
 * The old stairs, ground floor → hallway (v41 `oldStairs`, line 861): storey
 * height and step count as measured, else assumed equal to the floor above.
 * Against the long wall, turning at the east end toward the hallway; the
 * turn begins one going before the corner (unlike v41, whose winders all
 * fanned inside the corner square), and the top tread is a landing.
 */
export function oldStairs(geo: Geometry, B: Below): { it: OldStairsItem; P: StairPlan } {
  const r = swRect(geo, B)
  const w = OLD_W(B)
  const north = B.side === 'N'
  const F2 = B.ground > 0 ? B.ground : B.ceil + B.slab
  const n = B.oldN >= 4 ? B.oldN : Math.max(4, Math.round(F2 / 0.185))
  const r2 = F2 / n
  const g = B.oldG > 0 ? B.oldG : GOING // step depth as measured (B9), else assumed
  // The turn starts one going before the corner, so the winders taper over
  // the end of the first flight too (owner's stairs, 2026-11-25).
  const lead = g
  // The top tread is a landing one rise below the hallway floor, filling the
  // rest of the stairwell after the straight steps that follow the turn (at
  // least one going deep). So n rises = a + wk + b + landing + the hallway.
  const landingFor = (b: number) => Math.max(g, B.sw - w - b * g)
  // steps in the turn as counted (B9); until then, the fewest that give the
  // existing stairs normal headroom (1.9 m) under the edge of this floor
  const clear = (k: number) => {
    const a = n - 2 - k
    const x = r.x1 - w - a * g - lead
    const i = Math.ceil((r.x0 - x) / g - 1e-9)
    return i <= 0 || i > a || F2 - i * r2 - 0.25 >= 1.9
  }
  const wk = B.oldK >= 2 ? B.oldK : [3, 4, 5, 6].find(clear) || 6
  const b = B.oldK >= 2 ? B.oldB : 0
  const a = Math.max(0, n - 2 - wk - b)
  const it: OldStairsItem = {
    x: r.x1 - w - a * g - lead,
    z: north ? r.z0 + w / 2 : r.z1 - w / 2,
    rot: 0,
    turn: north ? 'R' : 'L',
    a,
    w,
    risers: n,
    g,
    wk,
    b,
    lead,
    landingDepth: landingFor(b),
  }
  return { it, P: curvedPlan(B, it, F2) }
}

// ---------- Layout of the floor below (v41 `buildBelow`, line 890)

export type BelowCut = 'S' | 'N' | 'E' | 'W'
type Mat = 'trim' | 'sill' | 'floor' | 'wall' | 'glass'

/** One drawn part, in v41's draw order. `cut`: the cut-away layer it belongs to. */
export type BelowPart =
  | { kind: 'box'; w: number; h: number; d: number; mat: Mat; x: number; y: number; z: number; cut?: BelowCut }
  | { kind: 'rbox'; w: number; h: number; d: number; r: number; mat: Mat; x: number; y: number; z: number; rotY: number }
  /** A flat rectangle; floors lie flat (rotX −π/2), walls stand (rotY 0 or ±π/2). */
  | { kind: 'plane'; w: number; h: number; mat: Mat; x: number; y: number; z: number; rotX: number; rotY: number; cut?: BelowCut }
  /** The east end wall (profile from za to zb, ceil high) at x = L, with the window cut out. */
  | { kind: 'eastWall'; za: number; zb: number; ceil: number; x: number; y: number; window: { wc: number; wW: number; wH: number; sill: number } | null; cut: 'E' }
  /** The old stairs group, placed at its foot; treads from `oldStairs()`; a post at P.pivot when it turns. */
  | { kind: 'oldStairs'; x: number; y: number; z: number; post: boolean }
  | { kind: 'lamp' | 'lampDisc' | 'smoke' | 'smokeLed'; x: number; y: number; z: number }
  | { kind: 'door'; door: BelowDoor; index: number; dh: number; x: number; y: number; z: number; rotY: number; cut: BelowCut }

export interface BelowLayout {
  F: number
  y0: number
  sw: Rect
  hall: HallRect
  /** Hallway-side edge of the stairwell. */
  inner: number
  /** The white post where the slatted screen ends. */
  px: number
  window: BelowWindow
  parts: BelowPart[]
}

export function belowLayout(geo: Geometry, plan: Pick<PlanV2, 'items' | 'options'>): BelowLayout {
  const { L } = geo
  const B = plan.options.below
  const F = B.ceil + B.slab
  const r = swRect(geo, B)
  const h = hallRect(geo, B)
  const y0 = -F
  const parts: BelowPart[] = []
  const box = (w: number, hh: number, d: number, mat: Mat, x: number, y: number, z: number, cut?: BelowCut) =>
    parts.push(cut ? { kind: 'box', w, h: hh, d, mat, x, y, z, cut } : { kind: 'box', w, h: hh, d, mat, x, y, z })
  const rb = (w: number, hh: number, d: number, rr: number, x: number, y: number, z: number, rotY = 0) =>
    parts.push({ kind: 'rbox', w, h: hh, d, r: rr, mat: 'trim', x, y, z, rotY })
  const plane = (w: number, hh: number, mat: Mat, x: number, y: number, z: number, rotX: number, rotY: number, cut?: BelowCut) =>
    parts.push(cut ? { kind: 'plane', w, h: hh, mat, x, y, z, rotX, rotY, cut } : { kind: 'plane', w, h: hh, mat, x, y, z, rotX, rotY })
  const rect = (x0: number, x1: number, z0: number, z1: number) => {
    if (x1 - x0 < 0.01 || z1 - z0 < 0.01) return
    plane(x1 - x0, z1 - z0, 'floor', (x0 + x1) / 2, y0, (z0 + z1) / 2, -Math.PI / 2, 0)
  }
  // hallway floor around the stairwell opening
  if (B.fill > 0.005) {
    const fz = r.z1 - r.z0
    box(0.045, 0.22, fz, 'trim', r.x0 + B.fill - 0.0225, y0 - 0.11, (r.z0 + r.z1) / 2) // the new trimmer joist carrying the extended floor
  }
  const ox0 = clamp(r.x0 + B.fill, h.xw, L)
  const ox1 = clamp(r.x1, h.xw, L)
  const oz0 = clamp(r.z0, h.za, h.zb)
  const oz1 = clamp(r.z1, h.za, h.zb)
  rect(h.xw, ox0, h.za, h.zb)
  rect(ox1, L, h.za, h.zb)
  rect(ox0, ox1, h.za, oz0)
  rect(ox0, ox1, oz1, h.zb)
  // walls: hallway long walls, west end and the east wall with its window
  const wallZ = (z: number, cut: BelowCut) => plane(L - h.xw, B.ceil, 'wall', (h.xw + L) / 2, y0 + B.ceil / 2, z, 0, 0, cut)
  wallZ(h.zb, 'S')
  wallZ(h.za, 'N')
  plane(h.zb - h.za, B.ceil, 'wall', h.xw, y0 + B.ceil / 2, (h.za + h.zb) / 2, 0, Math.PI / 2, 'W')
  const bw = belowWin(geo, B)
  const wW = Math.min(bw.w, h.zb - h.za - 0.1)
  const wc = clamp(bw.z0 + bw.w / 2, h.za + wW / 2 + 0.05, h.zb - wW / 2 - 0.05)
  const wH = Math.min(bw.h, B.ceil - bw.sill - 0.05)
  const sill = bw.sill
  const hasWin = wW > 0.3
  if (hasWin) {
    plane(wW, wH, 'glass', L + 0.12, y0 + sill + wH / 2, wc, 0, -Math.PI / 2, 'E')
    box(0.2, 0.03, wW + 0.04, 'sill', L + 0.08, y0 + sill - 0.015, wc, 'E')
  }
  parts.push({ kind: 'eastWall', za: h.za, zb: h.zb, ceil: B.ceil, x: L, y: y0, window: hasWin ? { wc, wW, wH, sill } : null, cut: 'E' })

  // the attic stairs' treads, so railings leave a gap wherever those stairs
  // pass through; only steps low enough to meet a 90 cm banister
  const ups = plan.items.filter(isUpStair)
  const upT: Pt[][] = ups.flatMap((i) =>
    planOf(B, i)
      .treads.filter((q) => !q.landing && q.t - 0.06 < 1.0)
      .map((q) => q.poly.map(([a, b]) => toWorld(i, a, b))),
  )
  const blocked = (x: number, z: number) =>
    upT.some((p) => pip(p, x, z) || ([[0.04, 0], [-0.04, 0], [0, 0.04], [0, -0.04]] as Pt[]).some(([u, v]) => pip(p, x + u, z + v)))
  const railRun = (A: Pt, B2: Pt) => {
    const dx = B2[0] - A[0]
    const dz = B2[1] - A[1]
    const len = Math.hypot(dx, dz)
    if (len < 0.05) return
    rb(len, 0.05, 0.06, 0.015, (A[0] + B2[0]) / 2, y0 + 0.9, (A[1] + B2[1]) / 2, Math.atan2(-dz, dx))
    const k = Math.max(1, Math.floor(len / 0.11))
    for (let i = 1; i < k; i++) {
      const q = i / k
      box(0.025, 0.86, 0.025, 'trim', A[0] + dx * q, y0 + 0.43, A[1] + dz * q)
    }
    ;[A, B2].forEach(([x, z]) => rb(0.07, 0.97, 0.07, 0.01, x, y0 + 0.485, z)) // square newel at each end, as in the photos
  }
  const rail = (A: Pt, B2: Pt) => {
    const n = Math.max(2, Math.ceil(Math.hypot(B2[0] - A[0], B2[1] - A[1]) / 0.02))
    const at = (q: number): Pt => [A[0] + (B2[0] - A[0]) * q, A[1] + (B2[1] - A[1]) * q]
    let s0: number | null = null
    for (let i = 0; i <= n; i++) {
      const q = i / n
      const ok = !blocked(...at(q))
      if (ok && s0 === null) s0 = q
      if ((!ok || i === n) && s0 !== null) {
        const q1 = ok ? q : (i - 1) / n
        if ((q1 - s0) * n * 0.02 > 0.25 || (s0 === 0 && q1 === 1)) railRun(at(s0), at(q1))
        s0 = null
      }
    }
  }
  const inner = B.side === 'S' ? r.z0 : r.z1
  const OS = oldStairs(geo, B)
  const ow = OLD_W(B)
  const px = clamp(r.x0 + B.screen, r.x0, r.x1)
  const ax = Math.max(px, r.x1 - ow)
  if (ax - px > 0.05) rail([px, inner], [ax, inner])
  if (B.ret > 0.05) {
    // the short leg of the L: out from the post into the hallway, a banister to hold as you come up
    const out = B.side === 'S' ? -1 : 1
    rail([px, inner], [px, inner + out * Math.min(B.ret, B.hall - 0.1)])
  }
  // the screen and its post stop under the new stairs where those pass
  // through them: height = to the underside of the lowest step overhead
  const upH = ups.flatMap((i) => {
    const P = planOf(B, i)
    return P.treads.filter((q) => !q.landing).map((q) => ({ p: q.poly.map(([a, b]) => toWorld(i, a, b)), u: -P.F + q.t - 0.06 }))
  })
  const clearAt = (x: number, z: number) => {
    let top = B.ceil
    for (const q of upH)
      if (([[0, 0], [0.035, 0], [-0.035, 0], [0, 0.035], [0, -0.035]] as Pt[]).some(([u, v]) => pip(q.p, x + u, z + v))) top = Math.min(top, q.u - y0)
    return top
  }
  for (let x = r.x0 + 0.06; x < px - 0.04; x += 0.1) {
    const hh = clearAt(x, inner)
    if (hh > 0.15) box(0.045, hh, 0.06, 'trim', x, y0 + hh / 2, inner)
  }
  if (px - r.x0 > 0.1) {
    box(px - r.x0, 0.1, 0.07, 'trim', (r.x0 + px) / 2, y0 + 0.05, inner)
    let s0: number | null = null
    for (let x = r.x0; x <= px + 1e-6; x += 0.02) {
      const ok = clearAt(x, inner) >= B.ceil - 0.01 && x < px - 0.01
      if (ok && s0 === null) s0 = x
      if (!ok && s0 !== null) {
        if (x - s0 > 0.05) box(x - s0, 0.05, 0.07, 'trim', (s0 + x) / 2, y0 + B.ceil - 0.025, inner)
        s0 = null
      }
    }
  }
  {
    const hh = clearAt(px, inner)
    if (hh > 0.15) box(0.07, hh, 0.07, 'trim', px, y0 + hh / 2, inner)
  }
  rail([r.x0 + B.fill, r.z0], [r.x0 + B.fill, r.z1])
  if (B.east > 0.05) rail([r.x1, r.z0], [r.x1, r.z1])
  // the old stairs: up from the ground floor along the long wall, winders at the top
  parts.push({ kind: 'oldStairs', x: OS.it.x, y: y0 - OS.P.F, z: OS.it.z, post: OS.P.turn })
  // stairwell walls below this floor (hallway side and the bottom), plus a patch of the ground floor
  const sx0 = OS.it.x
  const yb = y0 - OS.P.F
  const sl = r.x1 - sx0
  const gr = GROUND_RUN
  const wz = inner + (B.side === 'N' ? 0.01 : -0.01)
  plane(sl, OS.P.F, 'wall', sx0 + sl / 2, yb + OS.P.F / 2, wz, 0, 0)
  plane(r.z1 - r.z0, OS.P.F, 'wall', sx0 - gr, yb + OS.P.F / 2, (r.z0 + r.z1) / 2, 0, Math.PI / 2)
  plane(gr, OS.P.F, 'wall', sx0 - gr / 2, yb + OS.P.F / 2, wz, 0, 0)
  plane(sl + gr, r.z1 - r.z0, 'floor', sx0 - gr + (sl + gr) / 2, yb, (r.z0 + r.z1) / 2, -Math.PI / 2, 0)
  const hx = (h.xw + r.x0) / 2
  const hzc = B.side === 'S' ? (h.za + r.z0) / 2 : (r.z1 + h.zb) / 2
  parts.push({ kind: 'lamp', x: hx, y: y0 + B.ceil - 0.2, z: hzc })
  parts.push({ kind: 'lampDisc', x: hx, y: y0 + B.ceil - 0.04, z: hzc })
  // smoke alarm on the ceiling nearer the window
  const sx = (r.x0 + L) / 2
  parts.push({ kind: 'smoke', x: sx, y: y0 + B.ceil - 0.018, z: hzc })
  parts.push({ kind: 'smokeLed', x: sx + 0.03, y: y0 + B.ceil - 0.036, z: hzc })
  // doors: four-panel doors with a casing and brass handle; a cupboard is a flush panel
  B.doors.forEach((d, index) => {
    const dh = Math.min(2.04, B.ceil - 0.1)
    if (d.wall === 'W') parts.push({ kind: 'door', door: d, index, dh, x: h.xw, y: y0, z: h.za + d.at, rotY: Math.PI / 2, cut: 'W' })
    else if (d.wall === 'N') parts.push({ kind: 'door', door: d, index, dh, x: L - d.at, y: y0, z: h.za, rotY: 0, cut: 'N' })
    else parts.push({ kind: 'door', door: d, index, dh, x: L - d.at, y: y0, z: h.zb, rotY: Math.PI, cut: 'S' })
  })
  return { F, y0, sw: r, hall: h, inner, px, window: bw, parts }
}

/** How far the ground floor is drawn (and walkable) beyond the foot of the old stairs. */
export const GROUND_RUN = 1.5
