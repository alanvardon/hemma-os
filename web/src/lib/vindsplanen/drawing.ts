// The builder's drawing (plan 145): a dimensioned top-down plan of the attic
// and a side section through one stair, as plain primitives the route draws as
// SVG. Pure and deterministic: no React, no three.js, no browser APIs.
//
// Every position and size comes from the same pure functions the model and the
// warnings use (deriveGeometry, stairHoles, storageGeom, closetGeom, skyRect,
// slopePoint, wallInfo, curvedInfo, stairInfo); nothing a carpenter will cut
// to is worked out a second way here.
//
// Frames, both in metres, both "sheet" frames (first axis right, second down):
// - plan: [x, z] exactly as attic.ts — x from the west gable (0) east to L, z
//   from north (−) to south (+), ridge at z = 0. North is up on the sheet when
//   the ridge runs east–west.
// - section: [z, −y] — looking east from the west gable, so north is on the
//   left; y is up from the attic floor, so it is negated to point down.
//
// Dimension text is in centimetres, sv-SE (comma decimal, non-breaking-space
// grouping), with up to one decimal — i.e. millimetre precision — the same
// formatter as warningText.ts. The sheet states the unit once ("cm"), so the
// text carries no unit. A dimension that mirrors a number the app already
// shows elsewhere (headroom: whole cm from `cm()`, as the warnings and the
// item info lines print it) uses that number verbatim.

import { bayAt, clamp, cm, roofY, roofZAt, slopePoint, STAND, type Geometry } from './attic'
import { BED_SIZES, closetGeom, skyRect, storageGeom } from './items'
import { isUpStair, stairHoles, toWorld, type Pt, type UpStair } from './stairs'
import { curvedInfo, stairInfo, wallInfo, WALL_DOOR_W } from './warnings'
import type { ClosetItem, FurnitureItem, Item, PlanV2, SkylightItem, StairsItem, StorageItem, WallItem } from './plan'

export type { Pt }

export type LineStyle = 'wall' | 'thin' | 'hidden' | 'axis'
export type RectStyle = 'opening' | 'item' | 'storage' | 'window'
export type PolyStyle = 'opening' | 'storage'

/**
 * One thing to draw. `tag` groups primitives by what they belong to
 * ('shell', 'rafters', 'stand', 'overall', or '<type>:<item id>') so the sheet
 * and the tests can find them.
 *
 * - line: a to b.
 * - rect: centred at `at`, `w` along its local x and `h` along its local z,
 *   turned `rot` degrees with the stairs' / furniture's own convention
 *   (`toWorld`: world = at + [lx·cos + lz·sin, −lx·sin + lz·cos]).
 * - poly: a closed polygon (stair openings, storage-room footprints).
 * - dim: measures a→b; the dimension line is drawn `offset` metres off a→b
 *   along n = [−(b.z − a.z), b.x − a.x] / |b − a| (for a→b running +x, n is
 *   +z: positive offset is below on the sheet).
 * - label: text centred at `at`, an optional smaller second line `sub`.
 */
export type Prim =
  | { k: 'line'; a: Pt; b: Pt; style: LineStyle; tag: string }
  | { k: 'rect'; at: Pt; w: number; h: number; rot: number; style: RectStyle; tag: string }
  | { k: 'poly'; pts: Pt[]; style: PolyStyle; tag: string }
  | { k: 'dim'; a: Pt; b: Pt; offset: number; text: string; tag: string }
  | { k: 'label'; at: Pt; text: string; sub?: string; tag: string }

export interface Drawing {
  /** [min, max] over every point drawn, dimension lines included. */
  bounds: [Pt, Pt]
  prims: Prim[]
}

export interface PlanDrawing extends Drawing {
  /**
   * The north arrow, from the house's ridge bearing (plan 144); null when the
   * plan has no site. `dir` is a unit vector in the plan frame pointing north.
   */
  north: { dir: Pt; bearing: number } | null
}

/** The unit every dimension text is in. */
export const DIM_UNIT = 'cm'

const nf = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 1 })
/** A length in metres as dimension text: centimetres, up to one decimal, sv-SE. */
export const dimText = (m: number): string => nf.format(Math.round(Math.abs(m) * 1000) / 10)
/** Fixed decimals, as routes/vindsplanen/fmt.ts (lib code cannot import routes). */
const fixed = (v: number, d: number): string => v.toLocaleString('sv-SE', { minimumFractionDigits: d, maximumFractionDigits: d })

const NAME: Record<FurnitureItem['type'], string> = {
  wardrobe: 'Wardrobe',
  desk: 'Desk',
  sofa: 'Sofa',
  dresser: 'Dresser',
  nightstand: 'Nightstand',
  rug: 'Rug',
}

type Slice = Pick<PlanV2, 'items' | 'options'>

/** Below 1 mm a dimension or line is not worth drawing. */
const EPS = 1e-3

class Sheet {
  prims: Prim[] = []
  line(a: Pt, b: Pt, style: LineStyle, tag: string) {
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > EPS) this.prims.push({ k: 'line', a, b, style, tag })
  }
  rect(at: Pt, w: number, h: number, rot: number, style: RectStyle, tag: string) {
    this.prims.push({ k: 'rect', at, w, h, rot, style, tag })
  }
  poly(pts: Pt[], style: PolyStyle, tag: string) {
    this.prims.push({ k: 'poly', pts, style, tag })
  }
  /** A dimension whose line sits `dist` off a→b on the side `toward` points to. */
  dim(a: Pt, b: Pt, dist: number, toward: Pt, tag: string, text = dimText(Math.hypot(b[0] - a[0], b[1] - a[1]))) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (len <= EPS) return
    const n: Pt = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len]
    const s = n[0] * toward[0] + n[1] * toward[1] < 0 ? -1 : 1
    this.prims.push({ k: 'dim', a, b, offset: s * dist, text, tag })
  }
  label(at: Pt, text: string, tag: string, sub?: string) {
    this.prims.push(sub ? { k: 'label', at, text, sub, tag } : { k: 'label', at, text, tag })
  }
}

const N: Pt = [0, -1]
const S: Pt = [0, 1]
const W: Pt = [-1, 0]
const E: Pt = [1, 0]

/** Every point a primitive puts on the sheet (dimension lines at their offset). */
function primPoints(p: Prim): Pt[] {
  switch (p.k) {
    case 'line':
      return [p.a, p.b]
    case 'poly':
      return p.pts
    case 'label':
      return [p.at]
    case 'rect': {
      const a = (p.rot * Math.PI) / 180
      const c = Math.cos(a)
      const s = Math.sin(a)
      return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as Pt[]).map(([u, v]) => {
        const lx = (u * p.w) / 2
        const lz = (v * p.h) / 2
        return [p.at[0] + lx * c + lz * s, p.at[1] - lx * s + lz * c] as Pt
      })
    }
    case 'dim': {
      const len = Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1])
      const n: Pt = [-(p.b[1] - p.a[1]) / len, (p.b[0] - p.a[0]) / len]
      const o: Pt = [n[0] * p.offset, n[1] * p.offset]
      return [p.a, p.b, [p.a[0] + o[0], p.a[1] + o[1]], [p.b[0] + o[0], p.b[1] + o[1]]]
    }
  }
}

function boundsOf(prims: readonly Prim[]): [Pt, Pt] {
  const pts = prims.flatMap(primPoints)
  if (!pts.length) return [[0, 0], [0, 0]]
  return [
    [Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1]))],
    [Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))],
  ]
}

const bbox = (p: readonly Pt[]) => ({
  x0: Math.min(...p.map((q) => q[0])),
  x1: Math.max(...p.map((q) => q[0])),
  z0: Math.min(...p.map((q) => q[1])),
  z1: Math.max(...p.map((q) => q[1])),
})

type StairItem = StairsItem | UpStair
const isStair = (it: Item): it is StairItem => it.type === 'stairs' || isUpStair(it)

/**
 * Each stair's opening in the attic floor, keyed by item id, exactly as
 * `stairHoles(geo, plan, KZ)` cuts the floor: a stair whose opening clashes
 * with an earlier one has none. (`stairHoles` returns holes in item order
 * without ids; one item on its own yields its own hole, unchanged.)
 */
export function stairOpenings(geo: Geometry, plan: Slice): Map<string, Pt[]> {
  const { clash } = stairHoles(geo, plan, geo.KZ)
  const out = new Map<string, Pt[]>()
  for (const it of plan.items) {
    if (!isStair(it) || clash.has(it.id)) continue
    const h = stairHoles(geo, { items: [it], options: plan.options }, geo.KZ).holes[0]
    if (h) out.set(it.id, h)
  }
  return out
}

/** The roof window's footprint on the floor plan: its slope rectangle seen from above. */
export function skyFootprint(geo: Geometry, it: SkylightItem): { x0: number; x1: number; z0: number; z1: number } {
  const r = skyRect(geo, it)
  const za = slopePoint(geo, it.slope, r.x0, r.s0)[2]
  const zb = slopePoint(geo, it.slope, r.x0, r.s1)[2]
  return { x0: r.x0, x1: r.x1, z0: Math.min(za, zb), z1: Math.max(za, zb) }
}

/** The plan sheet: shell, rafters, standing height, openings, walls, rooms and furniture. */
export function planDrawing(geo: Geometry, plan: PlanV2): PlanDrawing {
  const { L, KZ, HALF, EDGES, RAFT_X } = geo
  const d = new Sheet()
  const knee = plan.options.knee
  const board = plan.options.board

  // ---- the shell: gables, eaves, knee walls (none in an opened bay), ridge
  d.line([0, -HALF], [0, HALF], 'wall', 'shell')
  d.line([L, -HALF], [L, HALF], 'wall', 'shell')
  d.line([0, -HALF], [L, -HALF], 'thin', 'shell')
  d.line([0, HALF], [L, HALF], 'thin', 'shell')
  for (const side of ['N', 'S'] as const) {
    const z = side === 'N' ? -KZ : KZ
    for (let i = 0; i < EDGES.length - 1; i++) if (!knee[side].includes(i)) d.line([EDGES[i], z], [EDGES[i + 1], z], 'wall', 'shell')
  }
  d.line([0, 0], [L, 0], 'axis', 'shell')
  d.label([L / 2, -0.12], 'Ridge', 'shell')
  d.label([L / 2, -KZ + 0.12], 'Knee wall', 'shell', `${dimText(geo.KNEE_H)} cm high`)

  // ---- rafters (centre lines, eaves to eaves) and the chain from the west gable
  RAFT_X.forEach((x) => d.line([x, -HALF], [x, HALF], 'thin', 'rafters'))
  const chain = [0, ...RAFT_X, L]
  for (let i = 0; i < chain.length - 1; i++) d.dim([chain[i], -HALF], [chain[i + 1], -HALF], 0.3, N, 'rafters')
  if (RAFT_X.length > 1) d.label([L / 2, -HALF - 0.55], `Rafters c/c ${dimText(geo.RAFT_CC)}`, 'rafters')

  // ---- the 1.90 m standing-height line, lowered under an insulated bay's ceiling
  for (const sg of [-1, 1]) {
    for (let i = 0; i < EDGES.length - 1; i++) {
      const z = sg * clamp(roofZAt(geo, STAND + (board.includes(i) ? geo.BOARD_DY : 0)), 0, HALF)
      d.line([EDGES[i], z], [EDGES[i + 1], z], 'hidden', 'stand')
    }
  }
  d.label([0.6, -geo.Z190 + 0.1], 'Standing height 190 cm', 'stand')

  // ---- overall: length, eaves to eaves, knee wall to knee wall
  d.dim([0, HALF], [L, HALF], 0.3, S, 'overall')
  d.dim([L, -HALF], [L, HALF], 0.3, E, 'overall')
  d.dim([0, -KZ], [0, KZ], 0.3, W, 'overall')

  // ---- items
  const openings = stairOpenings(geo, plan)
  for (const it of plan.items) {
    if (isStair(it)) drawStairOpening(d, geo, plan, it, openings.get(it.id))
    else if (it.type === 'skylight') drawSkylight(d, geo, it)
    else if (it.type === 'wall') drawWall(d, geo, it)
    else if (it.type === 'storage') drawStorage(d, geo, plan, it)
    else if (it.type === 'closet') drawCloset(d, geo, plan, it)
    else drawFurniture(d, it)
  }

  return { bounds: boundsOf(d.prims), prims: d.prims, north: northArrow(plan) }
}

function drawStairOpening(d: Sheet, geo: Geometry, plan: Slice, it: StairItem, hole: Pt[] | undefined) {
  if (!hole) return
  const tag = `${it.type}:${it.id}`
  const b = bbox(hole)
  d.poly(hole, 'opening', tag)
  // size, then position: west edge to the west gable, and the edge nearest the
  // ridge to the ridge (the north edge when the opening straddles the ridge)
  d.dim([b.x0, b.z0], [b.x1, b.z0], 0.15, N, tag)
  d.dim([b.x1, b.z0], [b.x1, b.z1], 0.15, E, tag)
  d.dim([0, b.z1], [b.x0, b.z1], 0.15, S, tag)
  const zr = b.z1 < 0 ? b.z1 : b.z0
  d.dim([b.x0, 0], [b.x0, zr], 0.15, W, tag)
  d.label([(b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2], 'Stair opening', tag, stairSteps(geo, plan, it))
}

/** "12 steps · rise 21,5 cm · going 24 cm", the numbers the item info shows. */
function stairSteps(geo: Geometry, plan: Slice, it: StairItem): string {
  if (it.type === 'stairs') {
    const s = stairInfo(geo, it)
    return `${s.n} steps · rise ${fixed(s.rise * 100, 1)} cm · going ${fixed(s.going * 100, 1)} cm`
  }
  const P = curvedInfo(geo, plan, it, new Set()).P
  return `${P.n} steps · rise ${fixed(P.r * 100, 1)} cm · going ${fixed(P.g * 100, 0)} cm`
}

function drawSkylight(d: Sheet, geo: Geometry, it: SkylightItem) {
  const tag = `skylight:${it.id}`
  const f = skyFootprint(geo, it)
  d.rect([(f.x0 + f.x1) / 2, (f.z0 + f.z1) / 2], f.x1 - f.x0, f.z1 - f.z0, 0, 'window', tag)
  const zr = it.slope === 'N' ? f.z0 : f.z1 // the outer (eaves-side) edge
  d.dim([0, zr], [f.x0, zr], 0.12, it.slope === 'N' ? N : S, tag)
  d.label([(f.x0 + f.x1) / 2, (f.z0 + f.z1) / 2], `Roof window ${it.size}, sill ${dimText(it.bottom)} cm`, tag, `${it.slope === 'N' ? 'North' : 'South'} slope · bay ${it.bay + 1}`)
}

function drawWall(d: Sheet, geo: Geometry, it: WallItem) {
  const tag = `wall:${it.id}`
  const { KZ } = geo
  const x = it.x
  const { zc, dh } = wallInfo(geo, it)
  const dw = WALL_DOOR_W
  if (it.door) {
    d.line([x, -KZ], [x, zc - dw / 2], 'wall', tag)
    d.line([x, zc + dw / 2], [x, KZ], 'wall', tag)
    d.dim([x, zc - dw / 2], [x, zc + dw / 2], 0.15, E, tag)
    d.label([x + 0.35, zc], `Door ${dimText(dw)} × ${dimText(dh)} cm`, tag)
  } else d.line([x, -KZ], [x, KZ], 'wall', tag)
  d.dim([0, KZ - 0.2], [x, KZ - 0.2], 0.1, N, tag)
  d.label([x, -KZ + 0.35], 'Partition wall', tag)
}

function drawStorage(d: Sheet, geo: Geometry, plan: Slice, it: StorageItem) {
  const tag = `storage:${it.id}`
  const G = storageGeom(geo, plan, it)
  const { x0, x1, zf, zb, ext, xe, dc, dw, dh } = G
  // the footprint: the room, plus the corner part beside an L-shaped stair opening
  d.poly(ext ? [[x0, zb], [x1, zb], [x1, ext.zn], [ext.x2, ext.zn], [ext.x2, zf], [x0, zf]] : [[x0, zb], [x1, zb], [x1, zf], [x0, zf]], 'storage', tag)
  // walls as the model builds them: the front (with its door opening), the sides
  d.line([x0, zf], [dc - dw / 2, zf], 'wall', tag)
  d.line([dc + dw / 2, zf], [xe, zf], 'wall', tag)
  if (!G.sharedX0) d.line([x0, zf], [x0, zb], 'wall', tag)
  if (ext) {
    d.line([x1, ext.zn], [x1, zb], 'wall', tag)
    d.line([x1, ext.zn], [ext.x2, ext.zn], 'wall', tag)
    d.line([ext.x2, zf], [ext.x2, ext.zn], 'wall', tag)
  } else if (!G.sharedX1) d.line([x1, zf], [x1, zb], 'wall', tag)
  d.dim([x0, zf], [xe, zf], 0.15, [0, -G.sg], tag)
  d.dim([x0, zf], [x0, G.sg * geo.KZ], 0.15, W, tag)
  d.label([(x0 + x1) / 2, (zf + zb) / 2], 'Storage room', tag, `${it.door === 'none' ? 'Opening' : 'Door'} ${dimText(dw)} × ${dimText(dh)} cm`)
}

function drawCloset(d: Sheet, geo: Geometry, plan: Slice, it: ClosetItem) {
  const tag = `closet:${it.id}`
  const C = closetGeom(geo, plan, it)
  const { x0, x1, zb, zd, xi, dc, dw, dh } = C
  d.poly([[x0, zd], [x1, zd], [x1, zb], [x0, zb]], 'storage', tag)
  d.line([xi, zd], [xi, zb], 'wall', tag)
  d.line([x0, zd], [Math.max(x0, dc - dw / 2), zd], 'wall', tag)
  d.line([Math.min(x1, dc + dw / 2), zd], [x1, zd], 'wall', tag)
  d.dim([x0, zd], [x1, zd], 0.15, [0, -C.sg], tag)
  d.dim([xi, zd], [xi, zb], 0.15, [C.dir, 0], tag)
  d.label([(x0 + x1) / 2, (zd + zb) / 2], 'Closet', tag, `Door ${dimText(dw)} × ${dimText(dh)} cm`)
}

function drawFurniture(d: Sheet, it: Exclude<Item, StairItem | SkylightItem | WallItem | StorageItem | ClosetItem>) {
  const tag = `${it.type}:${it.id}`
  if (it.type === 'bed') {
    d.rect([it.x, it.z], BED_SIZES[it.size], 2.0, it.rot, 'item', tag)
    d.label([it.x, it.z], `Bed ${it.size}`, tag)
    return
  }
  d.rect([it.x, it.z], it.w, it.d, it.rot, 'item', tag)
  d.label([it.x, it.z], NAME[it.type], tag, `${dimText(it.w)} × ${dimText(it.d)} cm`)
}

/**
 * North in the plan frame. The site's ridge bearing B is the compass bearing
 * of +x, and +z points along B + 90° (sun.ts `sunVector`), so a bearing β
 * lies at angle β − B from +x toward +z: north (β = 0) is [cos B, −sin B].
 */
export function northArrow(plan: Pick<PlanV2, 'options'>): PlanDrawing['north'] {
  const site = (plan.options as Partial<PlanV2['options']>).site
  const b = site?.ridgeBearing
  if (typeof b !== 'number' || !Number.isFinite(b)) return null
  const r = (b * Math.PI) / 180
  // + 0 turns −0 into 0
  return { dir: [Math.cos(r) + 0, -Math.sin(r) + 0], bearing: b }
}

// ---------- The section through one stair

/**
 * A cross-section of the attic looking east, through the given stair: the
 * attic floor (open over the stair's opening), the floor below, the roof
 * slopes and knee walls, the 1.90 m line, every tread at its height, and the
 * headroom at the tightest step. Null for an unknown id or an item that is
 * not a stair.
 */
export function sectionDrawing(geo: Geometry, plan: PlanV2, stairId: string): Drawing | null {
  const it = plan.items.find((i) => i.id === stairId)
  if (!it || !isStair(it)) return null
  const { HALF, KZ, H, KNEE_H, Z190 } = geo
  const B = plan.options.below
  const tag = `${it.type}:${it.id}`
  const d = new Sheet()
  const P = (z: number, y: number): Pt => [z, -y]

  // the stair's own numbers, from the same functions as its warnings
  let F: number
  let treads: { z0: number; z1: number; y: number; zc: number }[]
  let head: number
  let steps: string
  if (it.type === 'stairs') {
    const s = stairInfo(geo, it)
    F = it.drop
    // step k from the top: the k-th going down the run, k rises below the attic floor (as stairInfo walks it)
    treads = Array.from({ length: s.n }, (_, k) => {
      const xa = it.run / 2 - (k + 1) * s.going
      const xb = it.run / 2 - k * s.going
      const zs = ([[xa, -it.w / 2], [xb, -it.w / 2], [xa, it.w / 2], [xb, it.w / 2]] as Pt[]).map(([a, b]) => toWorld(it, a, b)[1])
      const z0 = Math.min(...zs)
      const z1 = Math.max(...zs)
      // the tightest corner of this step: where the roof is lowest
      const zc = roofY(geo, z0) <= roofY(geo, z1) ? z0 : z1
      return { z0, z1, y: -k * s.rise, zc }
    })
    head = s.minHead
    steps = `${s.n} steps · rise ${fixed(s.rise * 100, 1)} cm · going ${fixed(s.going * 100, 1)} cm`
  } else {
    const c = curvedInfo(geo, plan, it, new Set())
    F = c.P.F
    treads = c.P.treads.map((tr) => {
      const wp = tr.poly.map(([a, b]) => toWorld(it, a, b))
      const zs = wp.map((q) => q[1])
      return { z0: Math.min(...zs), z1: Math.max(...zs), y: tr.t - c.P.F, zc: wp.reduce((a, q) => a + q[1], 0) / wp.length }
    })
    head = c.head
    steps = `${c.P.n} steps · rise ${fixed(c.P.r * 100, 1)} cm · going ${fixed(c.P.g * 100, 0)} cm`
  }

  // the attic floor, open over the stair's opening (as the plan cuts it)
  const hole = stairOpenings(geo, plan).get(it.id)
  const hb = hole ? bbox(hole) : null
  const slab = B.slab
  for (const y of [0, -slab]) {
    if (hb) {
      d.line(P(-HALF, y), P(hb.z0, y), y === 0 ? 'wall' : 'thin', 'shell')
      d.line(P(hb.z1, y), P(HALF, y), y === 0 ? 'wall' : 'thin', 'shell')
    } else d.line(P(-HALF, y), P(HALF, y), y === 0 ? 'wall' : 'thin', 'shell')
  }
  d.line(P(-HALF, -F), P(HALF, -F), 'wall', 'shell')
  d.label(P(-HALF + 0.5, 0.1), 'Attic floor', 'shell')
  d.label(P(-HALF + 0.5, -F + 0.1), 'Floor below', 'shell')

  // the roof and the knee walls (none where this stair's bay is opened)
  d.line(P(-HALF, 0), P(0, H), 'wall', 'shell')
  d.line(P(0, H), P(HALF, 0), 'wall', 'shell')
  const bay = bayAt(geo, clamp(it.x, 0, geo.L - 1e-6))
  if (!plan.options.knee.N.includes(bay)) d.line(P(-KZ, 0), P(-KZ, KNEE_H), 'wall', 'shell')
  if (!plan.options.knee.S.includes(bay)) d.line(P(KZ, 0), P(KZ, KNEE_H), 'wall', 'shell')
  d.line(P(-Z190, STAND), P(Z190, STAND), 'hidden', 'stand')
  d.dim(P(0, 0), P(0, H), 0.15, [1, 0], 'overall')
  d.dim(P(HALF, -F), P(HALF, 0), 0.3, [1, 0], 'overall')

  // the treads, and the headroom over the tightest one
  treads.forEach((t) => d.line(P(t.z0, t.y), P(t.z1, t.y), 'wall', tag))
  const tight = treads.reduce((best, t) => (roofY(geo, t.zc) - t.y < roofY(geo, best.zc) - best.y ? t : best), treads[0])
  if (tight && Number.isFinite(head)) {
    d.dim(P(tight.zc, tight.y), P(tight.zc, roofY(geo, tight.zc)), 0.1, [-Math.sign(tight.zc) || 1, 0], tag, nf.format(cm(head)))
    d.label(P(tight.zc, tight.y - 0.15), `Tightest headroom ${nf.format(cm(head))} cm`, tag)
  }
  d.label(P(0, -F / 2), it.type === 'stairs' ? 'Stairs' : it.type === 'spiral' ? 'Spiral stairs' : 'Turning stairs', tag, steps)

  return { bounds: boundsOf(d.prims), prims: d.prims }
}
