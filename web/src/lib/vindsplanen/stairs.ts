// Stair geometry for Vindsplanen, ported from v41 (lines 786–855, 973–977,
// 1312–1350). Plans are in each stair's local coordinates (x along the first
// flight, z across it); `toWorld` maps them into the attic.

import { ceilAt, clamp, bayAt, type Geometry } from './attic'
import type { Below, CurvedItem, PlanV2, SpiralItem, StairsItem, Item } from './plan'

export type Pt = [number, number]
export type Pt3 = [number, number, number]

/** Default step depth (going) of a new stair, metres. */
export const GOING = 0.24
/** Headroom aimed for under the roof on the new stairs. */
export const HEAD = 1.9

/** Point in polygon (even-odd), v41 `pip`. */
export function pip(poly: readonly Pt[], x: number, z: number): boolean {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]
    const [xj, zj] = poly[j]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c
  }
  return c
}

/** Sutherland–Hodgman clip of a polygon to a box; null when < 3 points remain. */
export function clipBox(poly: readonly Pt[], x0: number, x1: number, z0: number, z1: number): Pt[] | null {
  const cut = (pts: Pt[], keep: (q: Pt) => boolean, at: (A: Pt, B: Pt) => Pt): Pt[] => {
    const out: Pt[] = []
    for (let i = 0; i < pts.length; i++) {
      const A = pts[i]
      const B = pts[(i + 1) % pts.length]
      const ia = keep(A)
      const ib = keep(B)
      if (ia) out.push(A)
      if (ia !== ib) out.push(at(A, B))
    }
    return out
  }
  const atX = (v: number) => (A: Pt, B: Pt): Pt => {
    const t = (v - A[0]) / (B[0] - A[0])
    return [v, A[1] + t * (B[1] - A[1])]
  }
  const atZ = (v: number) => (A: Pt, B: Pt): Pt => {
    const t = (v - A[1]) / (B[1] - A[1])
    return [A[0] + t * (B[0] - A[0]), v]
  }
  let p = cut([...poly], (q) => q[0] >= x0, atX(x0))
  p = cut(p, (q) => q[0] <= x1, atX(x1))
  p = cut(p, (q) => q[1] >= z0, atZ(z0))
  p = cut(p, (q) => q[1] <= z1, atZ(z1))
  return p.length >= 3 ? p : null
}

export interface Placed {
  x: number
  z: number
  rot: number
}

export function stairFrame(it: { rot: number }): { c: number; s: number } {
  const a = (it.rot * Math.PI) / 180
  return { c: Math.cos(a), s: Math.sin(a) }
}

export function toWorld(it: Placed, lx: number, lz: number): Pt {
  const f = stairFrame(it)
  return [it.x + lx * f.c + lz * f.s, it.z - lx * f.s + lz * f.c]
}

export function stairCorners(it: StairsItem): Pt[] {
  return (
    [
      [-it.run / 2, -it.w / 2],
      [it.run / 2, -it.w / 2],
      [it.run / 2, it.w / 2],
      [-it.run / 2, it.w / 2],
    ] as Pt[]
  ).map(([a, b]) => toWorld(it, a, b))
}

export function inStair(it: StairsItem, x: number, z: number): boolean {
  const f = stairFrame(it)
  const dx = x - it.x
  const dz = z - it.z
  const lx = dx * f.c - dz * f.s
  const lz = dx * f.s + dz * f.c
  return Math.abs(lx) <= it.run / 2 && Math.abs(lz) <= it.w / 2
}

export function stairsInside(geo: Geometry, it: StairsItem): boolean {
  return stairCorners(it).every(([x, z]) => x > 0.02 && x < geo.L - 0.02 && z > -geo.KZ + 0.02 && z < geo.KZ - 0.02)
}

export interface Tread {
  poly: Pt[]
  /** Tread top above the floor below (for the new stairs) or above the stair's foot. */
  t: number
  straight?: boolean
  dir?: 'z'
  landing?: boolean
}

export interface StairPlan {
  n: number
  r: number
  g: number
  F: number
  treads: Tread[]
  opening: Pt[]
  /** Index of the opening edge you step off at (−1: none). */
  arrive: number
  turn: boolean
  pivot: Pt
  a: number
  wk?: number
  landing?: Pt[]
  spiral?: boolean
}

/** A curved (quarter-turn) stair: the new stairs, or the old ones below (which also set g/wk/b). */
export interface CurvedLike extends Placed {
  turn: 'L' | 'R' | 'N'
  a: number
  w: number
  risers: number
  g?: number
  wk?: number
  b?: number
}

/**
 * Curved stairs in local coordinates (v41 `curvedPlan`, line 795): start at
 * x=0 climbing +x, `a` straight treads, a quarter turn of winders, then the
 * rest. A left turn heads toward local −z. Tread heights are above the floor
 * below.
 */
export function curvedPlan(B: Below, it: CurvedLike, Fo?: number): StairPlan {
  const F = Fo || B.ceil + B.slab
  const n = it.risers >= 4 ? Math.round(it.risers) : Math.max(4, Math.round(F / 0.185))
  const r = F / n
  const g = (it.g ?? 0) > 0 ? (it.g as number) : GOING
  const w = it.w
  const total = n - 1
  const m = it.turn === 'R' ? -1 : 1
  const turn = it.turn !== 'N'
  const wk = (it.wk ?? 0) >= 2 ? Math.round(it.wk as number) : 3 // winders in the quarter turn
  const a = turn ? clamp(Math.round(it.a), 0, total - wk) : total
  const T: Tread[] = []
  for (let i = 1; i <= a; i++)
    T.push({ poly: [[(i - 1) * g, -w / 2], [i * g, -w / 2], [i * g, w / 2], [(i - 1) * g, w / 2]], t: i * r, straight: true })
  const x0 = a * g
  let zEnd = 0
  let open: Pt[]
  let arrive: number
  // the opening must start where the attic floor's underside would come within 2.0 m of someone's head
  const fi = T.findIndex((q) => q.t > F - B.slab - 2.0)
  const ci = fi < 0 ? a : fi
  if (turn) {
    const k = Math.tan(Math.PI / 6) * w
    const P: Pt = [x0, -w / 2]
    if (wk === 3)
      T.push(
        { poly: [P, [x0, w / 2], [x0 + k, w / 2]], t: (a + 1) * r },
        { poly: [P, [x0 + k, w / 2], [x0 + w, w / 2], [x0 + w, -w / 2 + k]], t: (a + 2) * r },
        { poly: [P, [x0 + w, -w / 2 + k], [x0 + w, -w / 2]], t: (a + 3) * r },
      )
    else {
      // wk tapered steps fanning round the post, each turning 90/wk degrees
      const hit = (th: number): Pt => (th >= Math.PI / 4 ? [x0 + w / Math.tan(th), w / 2] : [x0 + w, -w / 2 + w * Math.tan(th)])
      for (let j = 1; j <= wk; j++) {
        const t0 = (Math.PI / 2) * (1 - (j - 1) / wk)
        const t1 = (Math.PI / 2) * (1 - j / wk)
        const A = hit(t0)
        const Bq = hit(t1)
        const poly: Pt[] = [P, A]
        if (t0 > Math.PI / 4 + 1e-9 && t1 < Math.PI / 4 - 1e-9) poly.push([x0 + w, w / 2])
        poly.push(Bq)
        T.push({ poly, t: (a + j) * r })
      }
    }
    const b = total - a - wk
    for (let j = 1; j <= b; j++)
      T.push({
        poly: [[x0, -w / 2 - (j - 1) * g], [x0 + w, -w / 2 - (j - 1) * g], [x0 + w, -w / 2 - j * g], [x0, -w / 2 - j * g]],
        t: (a + wk + j) * r,
        straight: true,
        dir: 'z',
      })
    zEnd = -w / 2 - b * g
    const xs = ci < a ? ci * g : x0
    open =
      xs < x0 - 1e-6
        ? [[xs, w / 2], [x0 + w, w / 2], [x0 + w, zEnd], [x0, zEnd], [x0, -w / 2], [xs, -w / 2]]
        : [[x0, w / 2], [x0 + w, w / 2], [x0 + w, zEnd], [x0, zEnd]]
    arrive = 2
  } else {
    const xs = ci * g
    open = [[xs, -w / 2], [x0, -w / 2], [x0, w / 2], [xs, w / 2]]
    arrive = 1
  }
  const mir = (pts: Pt[]): Pt[] => pts.map(([x, z]) => [x, z * m])
  T.forEach((q) => {
    q.poly = mir(q.poly)
  })
  return { n, r, g, F, treads: T, opening: mir(open), arrive, turn, pivot: [x0, (-w / 2) * m], a, wk }
}

/**
 * Spiral stairs around the centre column (v41 `spiralPlan`, line 827): the
 * bottom step starts at angle 0 and the steps fan round by `deg` degrees up to
 * the attic floor, then a top landing of one step (≥ 30°).
 */
export function spiralPlan(B: Below, it: SpiralItem): StairPlan {
  const F = B.ceil + B.slab
  const n = it.risers >= 4 ? Math.round(it.risers) : Math.max(4, Math.round(F / 0.19))
  const r = F / n
  const R = it.d / 2
  const ri = 0.06
  const m = it.dir === 'ccw' ? -1 : 1
  const step = (it.deg * Math.PI) / 180 / (n - 1)
  const T: Tread[] = []
  for (let i = 0; i < n - 1; i++) {
    const a0 = i * step
    const a1 = (i + 1) * step
    const pts: Pt[] = [[ri * Math.cos(a0), m * ri * Math.sin(a0)]]
    for (let k = 0; k <= 6; k++) {
      const a = a0 + ((a1 - a0) * k) / 6
      pts.push([R * Math.cos(a), m * R * Math.sin(a)])
    }
    pts.push([ri * Math.cos(a1), m * ri * Math.sin(a1)])
    T.push({ poly: pts, t: (i + 1) * r })
  }
  const L0 = (n - 1) * step
  const L1 = L0 + Math.max(step, Math.PI / 6)
  const arc = (a0: number, a1: number, rad: number, k: number): Pt[] =>
    Array.from({ length: k + 1 }, (_, j) => {
      const a = a0 + ((a1 - a0) * j) / k
      return [rad * Math.cos(a), m * rad * Math.sin(a)] as Pt
    })
  const landing: Pt[] = [[0, 0], ...arc(L0, L1, R, 8)]
  T.push({ poly: landing, t: F, landing: true })
  const open: Pt[] = [[0, 0], ...arc(L1, L0 + 2 * Math.PI, R + 0.05, 24)]
  return { n, r, g: (step * (R + ri)) / 2, F, treads: T, opening: open, landing, arrive: -1, turn: true, pivot: [0, 0], a: 0, spiral: true }
}

export type UpStair = CurvedItem | SpiralItem

export const isUpStair = (it: Item): it is UpStair => it.type === 'curved' || it.type === 'spiral'

export const planOf = (B: Below, it: UpStair): StairPlan => (it.type === 'spiral' ? spiralPlan(B, it) : curvedPlan(B, it))

export interface StairHoles {
  /** World-space openings in the attic floor, in item order, minus clashing ones. */
  holes: Pt[][]
  /** Ids of stairs whose opening's bounding box overlaps an earlier one. */
  clash: Set<string>
}

/**
 * World-space openings in the attic floor, clipped to the half-width `lim`
 * (v41 `stairHoles`). v41 kept the clash set in a module-level Set that every
 * call reset; here it is returned with the holes.
 */
export function stairHoles(geo: Geometry, plan: Pick<PlanV2, 'items' | 'options'>, lim: number): StairHoles {
  const B = plan.options.below
  const hs: Pt[][] = []
  const seen: number[][] = []
  const clash = new Set<string>()
  plan.items.forEach((i) => {
    let p: Pt[] | null = null
    if (i.type === 'stairs') {
      if (stairsInside(geo, i)) p = stairCorners(i)
    } else if (isUpStair(i)) {
      p = clipBox(
        planOf(B, i).opening.map(([a, b]) => toWorld(i, a, b)),
        0.02,
        geo.L - 0.02,
        -lim + 0.02,
        lim - 0.02,
      )
    }
    if (!p) return
    const bb = [
      Math.min(...p.map((q) => q[0])),
      Math.max(...p.map((q) => q[0])),
      Math.min(...p.map((q) => q[1])),
      Math.max(...p.map((q) => q[1])),
    ]
    if (seen.some((o) => bb[0] < o[1] && bb[1] > o[0] && bb[2] < o[3] && bb[3] > o[2])) {
      clash.add(i.id)
      return
    }
    seen.push(bb)
    hs.push(p)
  })
  return { holes: hs, clash }
}

// ---------- Railings round the new stairs (v41 `stairRails`, lines 1309–1350)

export const RAIL_H = 0.9
/** Baluster spacing: close enough that a 10 cm ball cannot pass. */
export const BAL_CC = 0.11

/** A box obstacle [x0, x1, z0, z1] in world space that closes a guard edge. */
export type ObstacleBox = [number, number, number, number]

/**
 * What the railings need from the rest of the plan: storage-room and closet
 * boxes that close a guard edge, and the hallway-below long walls (a banister
 * along one is a plain handrail). Built by `railContext(geo, plan)` in items.ts.
 */
export interface RailContext {
  obstacles: ObstacleBox[]
  hall: { za: number; zb: number }
}

/** A rail part in the stair's own coordinates (attic floor at y = P.F). */
export type RailPart =
  | { kind: 'bar'; p: Pt3; q: Pt3; w: number; h: number; mat: 'oak' }
  | { kind: 'box'; w: number; h: number; d: number; x: number; y: number; z: number; mat: 'trim' }

/**
 * The guard round the opening (left open on the arrival edge and wherever a
 * wall, storage room, closet, knee wall or low roof closes it) and the
 * banister up the inner side of the flights. `ctx` is `railContext(geo, plan)`
 * from items.ts. Parts are in v41's draw order.
 */
export function railSegments(
  geo: Geometry,
  plan: Pick<PlanV2, 'items' | 'options'>,
  it: UpStair,
  P: StairPlan,
  ctx: RailContext,
): RailPart[] {
  const obstacles = ctx.obstacles
  const parts: RailPart[] = []
  const { L, KZ } = geo
  const y = P.F
  const op = P.opening
  const wd = (a: number, b: number) => toWorld(it, a, b)
  const n = op.length
  const knee = plan.options.knee
  const board = plan.options.board
  const walls = plan.items.filter((i) => i.type === 'wall').map((i) => i.x)
  const bar = (p: Pt3, q: Pt3, w: number, h: number) => {
    const len = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2])
    if (len < 0.01) return
    parts.push({ kind: 'bar', p, q, w, h, mat: 'oak' })
  }
  const box = (w: number, h: number, d: number, x: number, yy: number, z: number) =>
    parts.push({ kind: 'box', w, h, d, x, y: yy, z, mat: 'trim' })
  const blocked = (lx: number, lz: number): boolean => {
    const [x, z] = wd(lx, lz)
    const kneeOpen = knee[z < 0 ? 'N' : 'S'].includes(bayAt(geo, clamp(x, 0, L - 1e-6)))
    return (
      x < 0.1 ||
      x > L - 0.1 ||
      walls.some((w) => Math.abs(w - x) < 0.1) ||
      (Math.abs(z) > KZ - 0.1 && !kneeOpen) ||
      ceilAt(geo, board, x, z) < RAIL_H + 0.05 ||
      obstacles.some((b) => x > b[0] && x < b[1] && z > b[2] && z < b[3])
    )
  }
  const guard = (A: Pt, B: Pt) => {
    const len = Math.hypot(B[0] - A[0], B[1] - A[1])
    bar([A[0], y + RAIL_H - 0.03, A[1]], [B[0], y + RAIL_H - 0.03, B[1]], 0.07, 0.05)
    const k = Math.max(1, Math.ceil(len / BAL_CC))
    for (let i = 1; i < k; i++) {
      const q = i / k
      box(0.025, RAIL_H - 0.06, 0.025, A[0] + (B[0] - A[0]) * q, y + (RAIL_H - 0.06) / 2, A[1] + (B[1] - A[1]) * q)
    }
    ;[A, B].forEach((e) => box(0.07, RAIL_H + 0.06, 0.07, e[0], y + (RAIL_H + 0.06) / 2, e[1]))
  }
  for (let i = 0; i < n; i++) {
    if (i === P.arrive) continue
    const A = op[i]
    const B = op[(i + 1) % n]
    const len = Math.hypot(B[0] - A[0], B[1] - A[1])
    if (len < 0.05) continue
    if (P.turn && Math.abs(A[0] - P.pivot[0]) < 1e-6 && Math.abs(B[0] - P.pivot[0]) < 1e-6) continue // the top flight's banister guards this edge
    let nx = -(B[1] - A[1]) / len
    let nz = (B[0] - A[0]) / len
    const mx = (A[0] + B[0]) / 2
    const mz = (A[1] + B[1]) / 2
    if (pip(op, mx + nx * 0.05, mz + nz * 0.05)) {
      // stand on the floor, just outside the opening
      nx = -nx
      nz = -nz
    }
    const at = (q: number): Pt => [A[0] + (B[0] - A[0]) * q + nx * 0.04, A[1] + (B[1] - A[1]) * q + nz * 0.04]
    const k = Math.max(2, Math.ceil(len / 0.02))
    let s0: number | null = null
    for (let j = 0; j <= k; j++) {
      const q = j / k
      const ok = !blocked(...at(q))
      if (ok && s0 === null) s0 = q
      if ((!ok || j === k) && s0 !== null) {
        const q1 = ok ? q : (j - 1) / k
        if ((q1 - s0) * len > 0.15) guard(at(s0), at(q1))
        s0 = null
      }
    }
  }
  // banister on the inner side of the flights, the side with the post
  if (P.turn) {
    // v41 reads it.turn here even for a spiral (undefined → m = 1); kept.
    const m = (it as { turn?: string }).turn === 'R' ? -1 : 1
    const w = (it as { w?: number }).w as number
    const x0 = P.pivot[0]
    const zi = (-w / 2 + 0.04) * m
    const zEnd = P.opening.reduce((e, q) => (m > 0 ? Math.min(e, q[1]) : Math.max(e, q[1])), 0)
    const hr = RAIL_H
    const wk = P.wk as number
    const runs: { p: Pt3; q: Pt3; top: (v: number) => number }[] = []
    if (P.a > 0) runs.push({ p: [P.g * 0.5, P.r + hr, zi], q: [x0 - 0.04, P.a * P.r + hr, zi], top: (lx) => Math.ceil(lx / P.g) * P.r })
    runs.push({
      p: [x0 + 0.04, (P.a + wk) * P.r + hr, (-w / 2 - 0.02) * m],
      q: [x0 + 0.04, y + RAIL_H, zEnd + 0.12 * m],
      top: (lz) => (P.a + wk + Math.ceil((Math.abs(lz) - w / 2) / P.g)) * P.r,
    })
    const h = ctx.hall
    const nearWall = ([lx, , lz]: Pt3) => {
      const [, z] = wd(lx, lz)
      return Math.min(Math.abs(z - h.za), Math.abs(z - h.zb)) < 0.12
    }
    runs.forEach((R) => {
      bar(R.p, R.q, 0.05, 0.06)
      if (nearWall(R.p) && nearWall(R.q)) return // along a wall: handrail only
      const len = Math.hypot(R.q[0] - R.p[0], R.q[2] - R.p[2])
      const k = Math.max(1, Math.ceil(len / BAL_CC))
      for (let i = 0; i <= k; i++) {
        const q = i / k
        const x = R.p[0] + (R.q[0] - R.p[0]) * q
        const z = R.p[2] + (R.q[2] - R.p[2]) * q
        const yt = R.p[1] + (R.q[1] - R.p[1]) * q - 0.03
        const yb = R.top(R === runs[0] && P.a > 0 ? x : z)
        if (yt - yb > 0.2) box(0.025, yt - yb, 0.025, x, (yt + yb) / 2, z)
      }
    })
  }
  return parts
}
