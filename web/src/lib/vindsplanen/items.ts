// Item catalogues and item geometry for Vindsplanen, ported from v41
// (lines 365–434, 701–720, 756, 1026–1067, 1198–1270). Material and sun
// entries are ids only; colours and textures belong to the scene.

import { clamp, roofY, type Geometry } from './attic'
import { FF, hallRect, swRect } from './below'
import { curvedPlan, stairHoles, toWorld, type RailContext, type ObstacleBox } from './stairs'
import type { ClosetItem, Gable, Item, ItemType, PlanV2, Side, SkylightItem, StorageItem } from './plan'

/** Roof window sizes (w × h on the slope), metres. */
export const SKY_SIZES = Object.freeze({
  '78×98': { w: 0.78, h: 0.98 },
  '78×118': { w: 0.78, h: 1.18 },
  '78×140': { w: 0.78, h: 1.4 },
  '114×118': { w: 1.14, h: 1.18 },
  '114×140': { w: 1.14, h: 1.4 },
  '134×98': { w: 1.34, h: 0.98 },
})
export type SkySize = keyof typeof SKY_SIZES

/** Bed sizes → mattress width, metres (all 2.0 m long). */
export const BED_SIZES = Object.freeze({ '90×200': 0.9, '120×200': 1.2, '140×200': 1.4, '160×200': 1.6, '180×200': 1.8 })
export type BedSize = keyof typeof BED_SIZES

/** Box furniture and its default size. */
export const FURNITURE_DEFAULTS = Object.freeze({
  wardrobe: { w: 1.0, d: 0.6, h: 2.0 },
  desk: { w: 1.2, d: 0.6, h: 0.75 },
  sofa: { w: 2.0, d: 0.9, h: 0.82 },
  dresser: { w: 0.8, d: 0.45, h: 0.8 },
  nightstand: { w: 0.45, d: 0.4, h: 0.5 },
  rug: { w: 2.0, d: 1.4, h: 0.01 },
})
export type FurnitureType = keyof typeof FURNITURE_DEFAULTS

/** Every item type, in v41 `TYPES` order. */
export const ITEM_TYPES = [
  'bed', 'skylight', 'wall', 'stairs', 'curved', 'spiral', 'storage', 'closet',
  'wardrobe', 'desk', 'sofa', 'dresser', 'nightstand', 'rug',
] as const

/** The add-item menu order (v41 `ADD_ORDER`). */
export const ADD_ORDER = [
  'skylight', 'wall', 'storage', 'closet', 'curved', 'spiral', 'stairs',
  'bed', 'wardrobe', 'desk', 'sofa', 'dresser', 'nightstand', 'rug',
] as const

export const isItemType = (t: unknown): t is ItemType => typeof t === 'string' && (ITEM_TYPES as readonly string[]).includes(t)

/** Material option ids per category (v41 `MATS`), first-listed order. */
export const MATERIAL_OPTIONS = Object.freeze({
  floor: ['oak', 'whiteoak', 'pine', 'smoked', 'grey', 'lino', 'chip'],
  panel: ['pine', 'white', 'grey', 'green', 'board'],
  rafter: ['natural', 'white', 'black', 'ceiling'],
  walls: ['white', 'warm', 'sage', 'clay', 'navy', 'pine'],
} as const)
export type MaterialCategory = keyof typeof MATERIAL_OPTIONS
export const MATERIAL_DEFAULTS: Readonly<Record<MaterialCategory, string>> = Object.freeze({
  floor: 'whiteoak',
  panel: 'white',
  rafter: 'natural',
  walls: 'white',
})

export const SUN_IDS = ['morning', 'midday', 'evening', 'overcast'] as const
export type SunId = (typeof SUN_IDS)[number]

// ---------- Roof windows

/** A roof window's rectangle on its slope: x along the attic, s up the slope from the eaves. */
export function skyRect(geo: Geometry, it: SkylightItem): { x0: number; x1: number; s0: number; s1: number } {
  const sz = SKY_SIZES[it.size]
  const bay = geo.BAYS[it.bay]
  const sBot = it.bottom / geo.SIN
  return { x0: bay.c - sz.w / 2, x1: bay.c + sz.w / 2, s0: sBot, s1: sBot + sz.h }
}

/**
 * Roof windows that get a real opening (v41 `buildSlopes`, line 702): within
 * the slope, and not within 5 cm of one already accepted on that slope.
 */
export function skyHolesOk(geo: Geometry, items: readonly Item[]): Set<string> {
  const ok = new Set<string>()
  for (const side of ['S', 'N'] as const) {
    const accepted: ReturnType<typeof skyRect>[] = []
    items
      .filter((i): i is SkylightItem => i.type === 'skylight' && i.slope === side)
      .forEach((it) => {
        const r = skyRect(geo, it)
        if (r.x0 < 0.03 || r.x1 > geo.L - 0.03 || r.s0 < 0.03 || r.s1 > geo.SLEN - 0.03) return
        if (accepted.some((a) => r.x0 < a.x1 + 0.05 && r.x1 > a.x0 - 0.05 && r.s0 < a.s1 + 0.05 && r.s1 > a.s0 - 0.05)) return
        accepted.push(r)
        ok.add(it.id)
      })
  }
  return ok
}

/** Whether the east-gable window fits under the roof (v41 line 756). */
export function gableWindowFit(geo: Geometry, g: Gable): { fits: boolean } {
  const top = g.sill + g.h
  const edge = Math.abs(g.off) + g.w / 2
  return { fits: edge < geo.HALF - 0.05 && roofY(geo, edge) - 0.08 >= top }
}

// ---------- Furniture

/** Footprint, height and the corner points checked against the roof (v41 `buildFurniture`). */
export function furnitureChecks(it: Extract<Item, { type: 'bed' | FurnitureType }>): { w: number; d: number; h: number; checks: [number, number, number][] } {
  if (it.type === 'bed') {
    const w = BED_SIZES[it.size]
    const d = 2.0
    const h = 0.56
    // the headboard corners are 1.0 m high
    return { w, d, h, checks: [[-w / 2, -d / 2, 1.0], [w / 2, -d / 2, 1.0], [-w / 2, d / 2, h], [w / 2, d / 2, h]] }
  }
  const { w, d, h } = it
  return { w, d, h, checks: [[-w / 2, -d / 2, h], [w / 2, -d / 2, h], [-w / 2, d / 2, h], [w / 2, d / 2, h]] }
}

// ---------- Storage room and closet

/**
 * The inside corner of an L-shaped stair opening just east of a storage room,
 * if there is one: [corner x, corner z, far end z] (v41 `stairCorner`).
 */
export function stairCorner(geo: Geometry, plan: Pick<PlanV2, 'items' | 'options'>, it: { side: Side }, x1: number): [number, number, number] | null {
  const sg = it.side === 'N' ? -1 : 1
  for (const st of plan.items) {
    if (st.type !== 'curved' || st.turn === 'N') continue
    const P = curvedPlan(plan.options.below, st)
    if (!P.turn) return null
    const op = P.opening.map(([a, b]) => toWorld(st, a, b))
    const pv = toWorld(st, P.pivot[0], P.pivot[1])
    const ox = Math.min(...op.map((q) => q[0]))
    if (Math.abs(ox - 0.05 - x1) > 0.35) continue // the opening must start right where the room ends
    const far = sg < 0 ? Math.max(...op.map((q) => q[1])) : Math.min(...op.map((q) => q[1])) // the end of the opening nearest the middle of the room
    if (Math.abs(pv[1]) < Math.abs(far) || Math.abs(pv[1]) > geo.KZ + 0.3 || pv[1] * sg < 0) continue // the turn must head away from this wall
    return [pv[0], pv[1], far]
  }
  return null
}

export interface StorageGeom {
  sg: number
  x0: number
  x1: number
  /** Front wall z. */
  zf: number
  /** Back: knee wall, or into the eaves when that bay is opened. */
  zb: number
  /** Height at the front. */
  hF: number
  dw: number
  dh: number
  /** The corner part beside an L-shaped stair opening. */
  ext: { x2: number; zn: number } | null
  /** East end of the front wall. */
  xe: number
  /** Door centre x. */
  dc: number
  /** A partition wall already stands at x0 / x1. */
  sharedX0: boolean
  sharedX1: boolean
}

export function storageGeom(geo: Geometry, plan: Pick<PlanV2, 'items' | 'options'>, it: StorageItem): StorageGeom {
  const { KZ, HALF, EDGES } = geo
  const sg = it.side === 'N' ? -1 : 1
  const x0 = it.x - it.w / 2
  const x1 = it.x + it.w / 2
  const zf = sg * (KZ - it.d)
  const cn = it.wrap ? stairCorner(geo, plan, it, x1) : null
  const x2 = cn ? cn[0] - 0.05 : x1 // the corner part: walls just clear of the opening's edges
  const zn = cn ? cn[1] - sg * 0.05 : null
  const bayOpen = (x: number) => {
    const i = EDGES.findIndex((e, k) => k < EDGES.length - 1 && x >= e - 0.01 && x < EDGES[k + 1] - 0.01)
    return i >= 0 && plan.options.knee[it.side].includes(i)
  }
  const zb = sg * (bayOpen(it.x) ? HALF - 0.05 : KZ)
  const hF = roofY(geo, zf)
  const dw = Math.min(0.8, it.w - 0.25)
  const dh = Math.min(2.0, hF - 0.08)
  const shared = (x: number) => plan.items.some((i) => i.type === 'wall' && Math.abs(i.x - x) < 0.12)
  const ext = cn && zn !== null && Math.abs(zn) > Math.abs(zf) + 0.2 && x2 > x1 + 0.2 ? { x2, zn } : null
  const xe = ext ? x2 : x1
  return { sg, x0, x1, zf, zb, hF, dw, dh, ext, xe, dc: (x0 + xe) / 2, sharedX0: shared(x0), sharedX1: shared(x1) }
}

export interface ClosetGeom {
  E: boolean
  /** Gable x. */
  xg: number
  dir: number
  sg: number
  zb: number
  /** Door-end z. */
  zd: number
  /** Depth from the gable. */
  d: number
  /** Inner (long-side) wall x. */
  xi: number
  x0: number
  x1: number
  /** Height at the door end. */
  hD: number
  dw: number
  dh: number
  t: number
  dc: number
}

/**
 * A closet against a gable, in the strip between the gable and the stair
 * opening (v41 `closetGeom`, line 1256). Fitted: as deep as the strip, and
 * ending where you step off the stairs, clear of the gable window.
 */
export function closetGeom(geo: Geometry, plan: Pick<PlanV2, 'items' | 'options'>, it: ClosetItem): ClosetGeom {
  const { L, KZ, HALF, BAYS } = geo
  const E = it.wall === 'E'
  const xg = E ? L : 0
  const dir = E ? -1 : 1
  const sg = it.side === 'N' ? -1 : 1
  const t = 0.08
  const bay = E ? BAYS.length - 1 : 0
  const zb = sg * (plan.options.knee[it.side].includes(bay) ? HALF - 0.05 : KZ)
  let zd = zb - sg * it.len
  let d = it.d
  if (it.fit) {
    const g = plan.options.gable
    const win = E && g.on && gableWindowFit(geo, g).fits
    const near = win ? (sg < 0 ? g.off - g.w / 2 : g.off + g.w / 2) : 0
    // end flush with the edge you step off the stairs at, when that edge is beside this strip
    const arr = plan.items
      .filter((i) => i.type === 'curved')
      .map((i) => {
        const P = curvedPlan(plan.options.below, i)
        const o = P.opening
        const e = [o[P.arrive], o[(P.arrive + 1) % o.length]].map(([a, b]) => toWorld(i, a, b))
        return Math.abs(e[0][1] - e[1][1]) < 0.02 && Math.max(e[0][0], e[1][0]) * dir * -1 > (xg - 1.5) * dir * -1 && e[0][1] * sg > 0 ? e[0][1] : null
      })
      .filter((v): v is number => v !== null)
    zd = arr.length ? arr[0] : sg * 0.3
    if (win && near * sg > 0 && (zd - near) * sg < 0.05) zd = near - sg * 0.05 // and keep clear of the gable window
    const hs = stairHoles(geo, plan, HALF).holes.filter((p) => p.some(([, z]) => (z - zd) * sg > -0.01))
    const xs = hs.flatMap((p) => p.map((q) => q[0]))
    d = xs.length ? (E ? L - Math.max(...xs) : Math.min(...xs)) - 0.04 : 0.6
    d = clamp(d, 0.3, 1.5)
  }
  const xi = xg + dir * d
  const x0 = Math.min(xi, xg)
  const x1 = Math.max(xi, xg)
  const hD = roofY(geo, zd)
  const dw = Math.max(0.3, Math.min(0.6, d - 0.12))
  const dh = Math.min(2.0, hD - 0.08)
  return { E, xg, dir, sg, zb, zd, d, xi, x0, x1, hD, dw, dh, t, dc: xi - dir * (d / 2) }
}

/**
 * The size v41 writes back into a fitted closet every time it is drawn
 * (`buildCloset`, line 1273), so unticking `fit` keeps it. Null when not fitted.
 */
export function closetFittedSize(geo: Geometry, plan: Pick<PlanV2, 'items' | 'options'>, it: ClosetItem): { d: number; len: number } | null {
  if (!it.fit) return null
  const C = closetGeom(geo, plan, it)
  return { d: +C.d.toFixed(2), len: +Math.abs(C.zb - C.zd).toFixed(2) }
}

/**
 * Apply `closetFittedSize` to every fitted closet, as a v41 rebuild does.
 * Returns the same plan object when nothing changes.
 */
export function withFittedClosets(geo: Geometry, plan: PlanV2): PlanV2 {
  let changed = false
  const items = plan.items.map((it) => {
    if (it.type !== 'closet') return it
    const f = closetFittedSize(geo, plan, it)
    if (!f || (f.d === it.d && f.len === it.len)) return it
    changed = true
    return { ...it, d: f.d, len: f.len }
  })
  return changed ? { ...plan, items } : plan
}

/** Storage rooms and closets (plus 10 cm) and the hallway-below walls, for `railSegments`. */
export function railContext(geo: Geometry, plan: Pick<PlanV2, 'items' | 'options'>): RailContext {
  const stores: ObstacleBox[] = plan.items
    .filter((i): i is StorageItem => i.type === 'storage')
    .map((i) => storageGeom(geo, plan, i))
    .map((S) => {
      const xs = [S.x0, S.xe, ...(S.ext ? [S.ext.x2] : [])]
      const zs = [S.zf, S.zb, ...(S.ext ? [S.ext.zn] : [])]
      return [Math.min(...xs) - 0.1, Math.max(...xs) + 0.1, Math.min(...zs) - 0.1, Math.max(...zs) + 0.1] as ObstacleBox
    })
  const closets: ObstacleBox[] = plan.items
    .filter((i): i is ClosetItem => i.type === 'closet')
    .map((i) => closetGeom(geo, plan, i))
    .map((C) => [C.x0 - 0.1, C.x1 + 0.1, Math.min(C.zd, C.zb) - 0.1, Math.max(C.zd, C.zb) + 0.1])
  const h = hallRect(geo, plan.options.below)
  return { obstacles: stores.concat(closets), hall: { za: h.za, zb: h.zb } }
}

// ---------- New items

/**
 * A storage room along a long wall, fitted into the gap between a partition
 * wall and the stair opening, or centred if there is neither (v41 `storageFit`).
 */
export function storageFit(geo: Geometry, plan: Pick<PlanV2, 'items' | 'options'>, side: Side): Omit<StorageItem, 'id' | 'type'> {
  const { L, KZ } = geo
  const sg = side === 'N' ? -1 : 1
  const holes = stairHoles(geo, plan, KZ).holes.filter((p) => p.some(([, z]) => z * sg > KZ - 1.2))
  const ox = holes.length ? Math.min(...holes.flatMap((p) => p.map((q) => q[0]))) : null
  let x0 = L / 2 - 0.6
  let x1 = L / 2 + 0.6
  if (ox !== null) {
    x1 = ox - 0.05
    const w = plan.items
      .filter((i) => i.type === 'wall' && i.x < x1 - 0.6)
      .map((i) => (i as { x: number }).x)
      .sort((a, b) => b - a)[0]
    x0 = w !== undefined ? w + 0.05 : Math.max(0, x1 - 1.4)
  }
  const len = clamp(x1 - x0, 0.6, 3)
  const it = { x: +(x0 + len / 2).toFixed(2), z: 0, rot: 0, w: +len.toFixed(2), d: 1.0, side, door: 'slide' as const, wrap: true }
  const cn = stairCorner(geo, plan, it, it.x + it.w / 2)
  if (cn) {
    const d = KZ - Math.abs(cn[2]) - 0.05
    if (d >= 0.5 && d <= 1.6) it.d = +d.toFixed(2) // front in line with the end of the opening
  }
  return it
}

/** A new item of `type` with v41's defaults (`makeItem`, line 420). */
export function makeItem(geo: Geometry, plan: Pick<PlanV2, 'items' | 'options'>, type: ItemType, id: string): Item {
  const { L } = geo
  switch (type) {
    case 'bed':
      return { id, type, x: L / 2, z: 0, rot: 0, size: '160×200' }
    case 'skylight': {
      const used = new Set(plan.items.filter((i) => i.type === 'skylight' && i.slope === 'S').map((i) => (i as SkylightItem).bay))
      const bay = [3, 2, 4, 1, 5, 0, 6].find((n) => !used.has(n))
      return { id, type, slope: 'S', bay: bay == null ? 3 : bay, size: '78×118', bottom: 1.0 }
    }
    case 'wall':
      return { id, type, x: L / 2, door: true, doorZ: 0 }
    case 'stairs':
      return { id, type, x: L / 2, z: 0, rot: 0, w: 0.9, run: 2.8, drop: +FF(plan.options.below).toFixed(2) }
    case 'storage':
      return { id, type, ...storageFit(geo, plan, 'N') }
    case 'closet':
      return { id, type, wall: 'E', side: 'N', fit: true, d: 0.55, len: 1.5 }
    case 'spiral':
      // best headroom and walkway found, though it stands in front of doors below
      return { id, type, x: 4.8, z: -0.7, rot: 225, dir: 'cw', d: 1.7, deg: 330, risers: 0 }
    case 'curved': {
      // stacked above the existing stairs: bottom step 20 cm into the
      // stairwell's west end, 5 cm off its centre line toward the hallway
      const r = swRect(geo, plan.options.below)
      const north = plan.options.below.side === 'N'
      const zc = (r.z0 + r.z1) / 2
      return { id, type, x: +(r.x0 + 0.2).toFixed(2), z: +(zc + (north ? 0.05 : -0.05)).toFixed(2), rot: 0, turn: north ? 'R' : 'L', a: 6, w: 0.8, risers: 0 }
    }
    default: {
      const t = FURNITURE_DEFAULTS[type]
      return { id, type, x: L / 2, z: 0, rot: 0, w: t.w, d: t.d, h: t.h }
    }
  }
}
