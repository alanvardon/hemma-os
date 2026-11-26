// The persisted Vindsplanen document (PlanV2) and its validation.
//
// Field names follow v41's sanitized state (vindsplanen-v41.html 435–498) so
// the v1 import (legacy.ts) is near-identity, plus `v: 2`, minus `example`
// and `options.below.v`. The viewing choices (quality, sun, dims, zones,
// rafters, cutaway) are per-device ViewPrefs, not part of the plan.
//
// Clamping is exactly v41 `num()` (line 453): a finite number is clamped to
// its range, anything else takes the default. Only v41's eleven one-time
// `below.v` migrations are left out — the import accepts only post-migration
// (below.v === 11) exports.

import { atticOf, deriveGeometry, ATTIC_DEF, clamp, type Attic, type Geometry } from './attic'
import { BELOW_DEF } from './below'
import {
  BED_SIZES,
  FURNITURE_DEFAULTS,
  MATERIAL_DEFAULTS,
  MATERIAL_OPTIONS,
  SKY_SIZES,
  SUN_IDS,
  isItemType,
  type BedSize,
  type FurnitureType,
  type MaterialCategory,
  type SkySize,
  type SunId,
} from './items'

export type Side = 'N' | 'S'

interface Base {
  id: string
  x: number
  z: number
  rot: number
}

export interface BedItem extends Base {
  type: 'bed'
  size: BedSize
}
export interface SkylightItem {
  id: string
  type: 'skylight'
  slope: Side
  bay: number
  size: SkySize
  /** Height of the window's bottom edge above the floor, metres. */
  bottom: number
}
export interface WallItem {
  id: string
  type: 'wall'
  x: number
  door: boolean
  doorZ: number
}
export interface StairsItem extends Base {
  type: 'stairs'
  w: number
  run: number
  drop: number
}
export interface CurvedItem extends Base {
  type: 'curved'
  turn: 'L' | 'R' | 'N'
  /** Straight steps before the turn. */
  a: number
  w: number
  /** 0 = worked out from the floor-to-floor height. */
  risers: number
}
export interface SpiralItem extends Base {
  type: 'spiral'
  dir: 'cw' | 'ccw'
  d: number
  deg: number
  risers: number
}
export interface StorageItem extends Base {
  type: 'storage'
  w: number
  d: number
  side: Side
  door: 'slide' | 'hinge' | 'none'
  wrap: boolean
}
export interface ClosetItem {
  id: string
  type: 'closet'
  wall: 'E' | 'W'
  side: Side
  fit: boolean
  d: number
  len: number
}
export interface FurnitureItem extends Base {
  type: FurnitureType
  w: number
  d: number
  h: number
}

export type Item =
  | BedItem
  | SkylightItem
  | WallItem
  | StairsItem
  | CurvedItem
  | SpiralItem
  | StorageItem
  | ClosetItem
  | FurnitureItem

export type ItemType = Item['type']

export interface BelowDoor {
  wall: 'N' | 'S' | 'W'
  /** Centre: from the east wall (N/S walls) or from the north wall (W). */
  at: number
  w: number
  kind: 'door' | 'panel'
  /** Handle on the left as seen from the hallway. */
  flip: boolean
}

export interface Below {
  show: boolean
  ceil: number
  slab: number
  side: Side
  hw: number
  off: number
  east: number
  screen: number
  len: number
  sw: number
  hall: number
  hallLen: number
  ground: number
  oldN: number
  oldW: number
  oldG: number
  oldK: number
  oldB: number
  winZ: number
  winW: number
  winH: number
  winS: number
  fill: number
  ret: number
  doors: BelowDoor[]
}

export interface Gable {
  on: boolean
  w: number
  h: number
  sill: number
  off: number
}

export type Materials = Record<MaterialCategory, string>

export interface PlanOptions {
  gable: Gable
  below: Below
  /** Opened knee-wall bays per side (no knee wall; floored eaves). */
  knee: { N: number[]; S: number[] }
  /** Insulated and plasterboarded bays. */
  board: number[]
  attic: Attic
  /** Measure-step code → date measured ('YYYY-MM-DD' or 'earlier'). */
  measured: Record<string, string>
  /**
   * Where the house stands, for the real sun (plan 144). Household-level: both
   * partners see the same house. An older client (before plan 144) drops
   * `site` when it saves; accepted, the worst case is that it reverts to
   * SITE_DEF and nothing else is lost.
   */
  site: Site
}

export interface Site {
  /** Compass bearing (degrees, 0–359) of the model's +x axis, west gable → east gable. */
  ridgeBearing: number
  /** Latitude, degrees north (55–69), one decimal. No address is stored. */
  lat: number
  /** Longitude, degrees east (10–25), one decimal. */
  lon: number
}

/** Default site: ridge east–west (the model's own naming, attic.ts), central Stockholm. */
export const SITE_DEF: Readonly<Site> = { ridgeBearing: 90, lat: 59.3, lon: 18.0 }

/** Round to one decimal: the site is coarse on purpose (~10 km), for privacy. */
const oneDecimal = (v: number): number => Math.round(v * 10) / 10

/**
 * `num()` per field: a finite number is clamped (bearing 370 → 359, not
 * wrapped), anything else takes the default. lat/lon are then rounded to one
 * decimal so a precise location never persists.
 */
export function sanitizeSite(raw: unknown): Site {
  const s: Loose = isObj(raw) ? raw : {}
  return {
    ridgeBearing: num(s.ridgeBearing, 0, 359, SITE_DEF.ridgeBearing),
    lat: oneDecimal(num(s.lat, 55, 69, SITE_DEF.lat)),
    lon: oneDecimal(num(s.lon, 10, 25, SITE_DEF.lon)),
  }
}

export interface PlanV2 {
  v: 2
  materials: Materials
  options: PlanOptions
  items: Item[]
}

export type Quality = 'fast' | 'nice'

export type SunMode = 'preset' | 'real'

export interface ViewPrefs {
  zones: boolean
  rafters: boolean
  cutaway: boolean
  sun: SunId
  quality: Quality
  dims: boolean
  /** 'preset': one of the fixed `sun` moods; 'real': the sun for sunDate/sunMinutes at the plan's site. */
  sunMode: SunMode
  /** Month and day for the real sun, 'MM-DD' (no year; 02-29 is not offered). */
  sunDate: string
  /** Swedish clock time for the real sun, minutes after midnight (0–1439). */
  sunMinutes: number
}

/**
 * The pure default for `sunDate`. viewPrefs.ts passes today's date instead
 * when it loads prefs, so the sanitizer stays deterministic.
 */
export const SUN_DATE_DEF = '06-21'
export const SUN_MINUTES_DEF = 720

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/** 'MM-DD' for a day that exists in every year (so 02-29 is refused). */
export function isMonthDay(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const m = /^(\d{2})-(\d{2})$/.exec(v)
  if (!m) return false
  const month = Number(m[1])
  const day = Number(m[2])
  return month >= 1 && month <= 12 && day >= 1 && day <= DAYS_IN_MONTH[month - 1]
}

/** v41 defaults: quality is 'fast' on a coarse (touch) pointer. */
export function defaultViewPrefs(coarse = false, sunDate: string = SUN_DATE_DEF): ViewPrefs {
  return {
    zones: true, rafters: true, cutaway: true, sun: 'morning', quality: coarse ? 'fast' : 'nice', dims: false,
    sunMode: 'preset', sunDate: isMonthDay(sunDate) ? sunDate : SUN_DATE_DEF, sunMinutes: SUN_MINUTES_DEF,
  }
}

type Loose = Record<string, unknown>
const isObj = (v: unknown): v is Loose => !!v && typeof v === 'object'

/** v41 view-pref rules (sanitize lines 459–462). */
export function sanitizeViewPrefs(raw: unknown, coarse = false, sunDate: string = SUN_DATE_DEF): ViewPrefs {
  const out = defaultViewPrefs(coarse, sunDate)
  if (!isObj(raw)) return out
  ;(['zones', 'rafters', 'cutaway'] as const).forEach((k) => {
    if (typeof raw[k] === 'boolean') out[k] = raw[k] as boolean
  })
  if (typeof raw.sun === 'string' && (SUN_IDS as readonly string[]).includes(raw.sun)) out.sun = raw.sun as SunId
  out.dims = raw.dims === true
  if (raw.quality === 'fast' || raw.quality === 'nice') out.quality = raw.quality
  // Plan 144 real sun: invalid values take the default (not clamped).
  if (raw.sunMode === 'preset' || raw.sunMode === 'real') out.sunMode = raw.sunMode
  if (isMonthDay(raw.sunDate)) out.sunDate = raw.sunDate
  if (Number.isInteger(raw.sunMinutes) && (raw.sunMinutes as number) >= 0 && (raw.sunMinutes as number) <= 1439) out.sunMinutes = raw.sunMinutes as number
  return out
}

/** v41 `examplePlan` (line 435), as a PlanV2. `attic` defaults to this house. */
export function examplePlan(attic: Attic = ATTIC_DEF): PlanV2 {
  return {
    v: 2,
    materials: { floor: 'whiteoak', panel: 'white', rafter: 'natural', walls: 'white' },
    options: {
      gable: { on: true, w: 1.0, h: 1.2, sill: 0.8, off: 0 },
      below: { ...BELOW_DEF, doors: BELOW_DEF.doors.map((d) => ({ ...d })) },
      knee: { N: [], S: [] },
      board: [],
      attic: { ...attic },
      measured: {},
      site: { ...SITE_DEF },
    },
    items: [
      { id: 'w1', type: 'wall', x: 4.8, door: true, doorZ: 0 },
      { id: 'b1', type: 'bed', x: 1.05, z: 0, rot: 90, size: '160×200' },
      { id: 'n1', type: 'nightstand', x: 0.25, z: -1.07, rot: 90, w: 0.45, d: 0.4, h: 0.5 },
      { id: 'n2', type: 'nightstand', x: 0.25, z: 1.07, rot: 90, w: 0.45, d: 0.4, h: 0.5 },
      { id: 'd1', type: 'dresser', x: 3.4, z: 1.19, rot: 0, w: 0.8, d: 0.45, h: 0.8 },
      { id: 'r1', type: 'rug', x: 2.75, z: 0, rot: 90, w: 1.6, d: 1.1, h: 0.01 },
      { id: 's1', type: 'skylight', slope: 'S', bay: 1, size: '78×118', bottom: 1.0 },
      { id: 's2', type: 'skylight', slope: 'N', bay: 2, size: '78×118', bottom: 1.0 },
      { id: 's3', type: 'skylight', slope: 'S', bay: 5, size: '78×118', bottom: 1.0 },
      { id: 'c1', type: 'curved', x: 6.08, z: -1.55, rot: 0, turn: 'R', a: 4, w: 0.8, risers: 12 },
      { id: 'k1', type: 'desk', x: 8.15, z: 0, rot: 90, w: 1.2, d: 0.6, h: 0.75 },
    ],
  }
}

/** v41 `num`: clamp a finite number, else the default. No coercion. */
export const num = (v: unknown, a: number, b: number, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? clamp(v, a, b) : d

/** Math.round with JS coercion, as v41 applies it to counts (Math.round("14") === 14). */
const roundLoose = (v: unknown): number => Math.round(Number(v))

export interface SanitizeOptions {
  /** Id for an item without a string id. Default: deterministic 'i1', 'i2', … not already used. */
  newId?: () => string
}

function defaultIdMaker(items: unknown[]): () => string {
  const used = new Set(items.filter(isObj).map((i) => i.id).filter((id): id is string => typeof id === 'string'))
  let k = 0
  return () => {
    let id: string
    do id = 'i' + ++k
    while (used.has(id))
    used.add(id)
    return id
  }
}

/**
 * The shared body of v41 `sanitize`, with every `below.v` migration branch
 * taken as for v === 11. Returns null for a non-object or missing items array.
 */
export function sanitizeShape(p: unknown, opts: SanitizeOptions = {}): PlanV2 | null {
  if (!isObj(p) || !Array.isArray(p.items)) return null
  const ex = examplePlan()
  const newId = opts.newId ?? defaultIdMaker(p.items)
  const o: Loose = isObj(p.options) ? p.options : {}
  const hasOptions = isObj(p.options)

  const materials: Materials = { ...MATERIAL_DEFAULTS }
  for (const k of Object.keys(MATERIAL_OPTIONS) as MaterialCategory[]) {
    const v = isObj(p.materials) ? p.materials[k] : undefined
    if (typeof v === 'string' && (MATERIAL_OPTIONS[k] as readonly string[]).includes(v)) materials[k] = v
  }

  // The attic comes first here because the clamps below use its geometry. v41
  // clamped against the attic read at page load, which equals the plan's own
  // attic for any plan saved by v41 (it reloads when they differ).
  const attic: Attic = o.attic ? atticOf(o.attic) : { ...ATTIC_DEF } // a plan without one keeps this house's measurements
  const geo: Geometry = deriveGeometry(attic)
  const { L, HALF, BAYS } = geo

  let gable: Gable = { ...ex.options.gable }
  let below: Below = { ...BELOW_DEF, doors: BELOW_DEF.doors.map((d) => ({ ...d, flip: false })) }
  if (hasOptions) {
    const g: Loose = isObj(o.gable) ? o.gable : {}
    gable = { on: g.on !== false, w: num(g.w, 0.3, 2.5, 1), h: num(g.h, 0.3, 2.2, 1.2), sill: num(g.sill, 0, 2, 0.8), off: num(g.off, -2, 2, 0) }
    const bl: Loose = isObj(o.below) ? o.below : {}
    const D = BELOW_DEF
    const oldN = num(roundLoose(bl.oldN), 0, 30, 0)
    const oldK = Number(bl.oldK) || 0
    const oldB = Number(bl.oldB) || 0
    const doorsIn: unknown[] = Array.isArray(bl.doors) ? bl.doors : D.doors
    below = {
      show: bl.show !== false,
      ceil: num(bl.ceil, 1.8, 3.2, D.ceil),
      slab: num(bl.slab, 0.1, 0.6, D.slab),
      side: bl.side === 'S' ? 'S' : 'N',
      hw: num(bl.hw, 1.2, 2.4, D.hw),
      off: num(bl.off, 0, 2, D.off),
      east: num(bl.east, 0, 6, D.east),
      screen: num(bl.screen, 0, 5, D.screen),
      len: num(bl.len, 0.6, 5, D.len),
      sw: num(bl.sw, 0.6, 2, D.sw),
      hall: num(bl.hall, 0.6, 3, D.hall),
      hallLen: num(bl.hallLen, 1, L, D.hallLen),
      ground: num(bl.ground, 0, 4, 0),
      oldN: oldN >= 4 ? oldN : 0,
      oldW: num(bl.oldW, 0, 1.5, 0),
      oldG: num(bl.oldG, 0, 0.4, 0),
      oldK: oldK >= 2 && oldK <= 8 ? Math.round(oldK) : 0,
      oldB: oldB >= 0 && oldB <= 4 ? Math.round(oldB) : 0,
      winZ: num(bl.winZ, 0, 4, 0),
      winW: num(bl.winW, 0, 3, 0),
      winH: num(bl.winH, 0, 2.5, 0),
      winS: num(bl.winS, 0, 2, 0),
      fill: num(bl.fill, 0, 0.5, 0),
      ret: num(bl.ret, 0, 2, 0.44),
      doors: doorsIn
        .filter(isObj)
        .slice(0, 20)
        .map((d) => ({
          wall: d.wall === 'N' || d.wall === 'S' || d.wall === 'W' ? d.wall : 'S',
          at: num(d.at, 0, L, 1),
          w: num(d.w, 0.3, 2, 0.82),
          kind: d.kind === 'panel' ? 'panel' : 'door',
          flip: d.flip === true,
        })),
    }
  }

  // Bay lists: integer, in range, deduplicated, then sorted with the default
  // (lexicographic) comparator exactly as v41 — [10, 2] stays [10, 2].
  const bays = (v: unknown): number[] =>
    Array.isArray(v)
      ? [...new Set(v.filter((n): n is number => Number.isInteger(n) && n >= 0 && n < BAYS.length))].sort()
      : []
  const k = o.knee
  const knee = isObj(k) ? { N: bays(k.N), S: bays(k.S) } : { N: [], S: [] }
  const board = bays(o.board)

  const measured: Record<string, string> = {}
  if (isObj(o.measured))
    Object.entries(o.measured).forEach(([key, v]) => {
      if (/^[ABDW]\d{1,2}$/.test(key) && typeof v === 'string') measured[key] = v.slice(0, 10)
    })

  const items: Item[] = []
  for (const it of p.items as unknown[]) {
    // v41 tested `TYPES[it.type]`, which also matched inherited names such as
    // 'constructor'; only the catalogue's own types are accepted here.
    if (!isObj(it) || !isItemType(it.type)) continue
    const id = typeof it.id === 'string' ? it.id : newId()
    if (it.type === 'skylight') {
      items.push({
        id,
        type: 'skylight',
        slope: it.slope === 'N' ? 'N' : 'S',
        bay: num(roundLoose(it.bay), 0, BAYS.length - 1, 3), // v41 default 3 even with fewer bays; kept
        size: typeof it.size === 'string' && Object.hasOwn(SKY_SIZES, it.size) ? (it.size as SkySize) : '78×118',
        bottom: num(it.bottom, 0.3, 2.2, 1),
      })
      continue
    }
    if (it.type === 'wall') {
      items.push({ id, type: 'wall', x: num(it.x, 0, L, L / 2), door: !!it.door, doorZ: num(it.doorZ, -1.2, 1.2, 0) })
      continue
    }
    const base = { id, x: num(it.x, 0, L, L / 2), z: num(it.z, -HALF, HALF, 0), rot: num(it.rot, 0, 359, 0) }
    const rot4 = typeof it.rot === 'number' && [0, 90, 180, 270].includes(it.rot) ? it.rot : 0
    const risers = (v: unknown) => {
      const n = num(roundLoose(v), 0, 24, 0)
      return n >= 4 ? n : 0
    }
    switch (it.type) {
      case 'bed':
        items.push({ ...base, type: 'bed', size: typeof it.size === 'string' && Object.hasOwn(BED_SIZES, it.size) ? (it.size as BedSize) : '160×200' })
        break
      case 'closet':
        items.push({
          id,
          type: 'closet',
          wall: it.wall === 'W' ? 'W' : 'E',
          side: it.side === 'S' ? 'S' : 'N',
          fit: it.fit !== false,
          d: num(it.d, 0.3, 1.5, 0.55),
          len: num(it.len, 0.4, 2.5, 1.5),
        })
        break
      case 'storage':
        items.push({
          ...base,
          type: 'storage',
          w: num(it.w, 0.6, 3, 1.2),
          d: num(it.d, 0.5, 1.6, 1),
          side: it.side === 'S' ? 'S' : 'N',
          door: it.door === 'slide' || it.door === 'hinge' || it.door === 'none' ? it.door : 'slide',
          wrap: it.wrap !== false,
        })
        break
      case 'spiral':
        items.push({
          ...base,
          type: 'spiral',
          dir: it.dir === 'ccw' ? 'ccw' : 'cw',
          d: num(it.d, 1.1, 2.4, 1.6),
          deg: num(roundLoose(it.deg), 180, 540, 360),
          risers: risers(it.risers),
        })
        break
      case 'curved':
        items.push({
          ...base,
          type: 'curved',
          rot: rot4,
          turn: it.turn === 'L' || it.turn === 'R' || it.turn === 'N' ? it.turn : 'L',
          a: num(roundLoose(it.a), 0, 20, 6),
          w: num(it.w, 0.6, 1.4, 0.9),
          risers: risers(it.risers),
        })
        break
      case 'stairs':
        items.push({ ...base, type: 'stairs', rot: rot4, w: num(it.w, 0.6, 1.5, 0.9), run: num(it.run, 1.2, 4.5, 2.8), drop: num(it.drop, 1.8, 3.5, 2.6) })
        break
      default: {
        const t = FURNITURE_DEFAULTS[it.type as FurnitureType]
        items.push({ ...base, type: it.type as FurnitureType, w: num(it.w, 0.1, 4, t.w), d: num(it.d, 0.1, 4, t.d), h: num(it.h, 0.01, 2.6, t.h) })
      }
    }
  }

  const site = sanitizeSite(o.site)

  return { v: 2, materials, options: { gable, below, knee, board, attic, measured, site }, items }
}

/**
 * Validate a stored PlanV2 document. Returns null for anything that is not a
 * `v: 2` object with an items array; otherwise every field is clamped or
 * defaulted as v41 `sanitize` does.
 */
export function sanitizePlan(p: unknown, opts: SanitizeOptions = {}): PlanV2 | null {
  if (!isObj(p) || p.v !== 2) return null
  return sanitizeShape(p, opts)
}
