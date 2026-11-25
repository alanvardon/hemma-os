// Attic shell geometry for Vindsplanen, ported from the v41 artifact
// (planning/140-vindsplanen-ref/vindsplanen-v41.html, lines 328–358).
//
// Coordinates are metres. x runs from the west gable (0) to the east gable
// (L), y is up from the attic floor, z runs from north (−) to south (+) with
// the ridge at z = 0.
//
// v41 derived every constant below as a module-level global from the attic
// measurements read out of localStorage at page load, and reloaded the page
// when one changed. Here they are a value: `deriveGeometry(attic)`, passed into
// every function explicitly.

export interface Attic {
  /** A1: west gable to east gable. */
  len: number
  /** A2: knee wall to knee wall (full width). */
  knee: number
  /** A3: knee wall height. */
  kneeH: number
  /** A4: floor to ridge. */
  ridge: number
  /** A5: west gable to the middle of the first rafter. */
  r0: number
  /** A6: rafter centre-to-centre spacing. */
  cc: number
  /** A7: number of rafters on one slope. */
  rn: number
  /** A8: rafter thickness. */
  rw: number
  /** A8: rafter depth below the panelling. */
  rd: number
}

export const ATTIC_DEF: Readonly<Attic> = Object.freeze({
  len: 8.5,
  knee: 2.87,
  kneeH: 0.9418,
  ridge: 2.6,
  r0: 1.2,
  cc: 1.22,
  rn: 6,
  rw: 0.045,
  rd: 0.19,
})

export const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v))
export const snap = (v: number): number => Math.round(v / 0.05) * 0.05
/** Metres to whole centimetres, as v41 `cm()`. */
export const cm = (v: number): number => Math.round(v * 100)

type Loose = Record<string, unknown>
const isObj = (v: unknown): v is Loose => !!v && typeof v === 'object'

/**
 * v41 `atticOf` (line 331): each field is accepted when `+v` is finite, not
 * null and within range, else the default. Note `+v` coerces, so a numeric
 * string (or "" → 0) is accepted — kept for parity.
 */
export function atticOf(a: unknown): Attic {
  const D = ATTIC_DEF
  const n = (v: unknown, lo: number, hi: number, d: number): number => {
    const x = Number(v)
    return Number.isFinite(x) && v !== null && x >= lo && x <= hi ? x : d
  }
  const o: Loose = isObj(a) ? a : {}
  const out: Attic = {
    len: n(o.len, 4, 15, D.len),
    knee: n(o.knee, 1, 4.4, D.knee),
    kneeH: n(o.kneeH, 0, 1.6, D.kneeH),
    ridge: n(o.ridge, 1.8, 4, D.ridge),
    r0: n(o.r0, 0.05, 3, D.r0),
    cc: n(o.cc, 0.3, 2, D.cc),
    rn: Math.round(n(o.rn, 1, 20, D.rn)),
    rw: n(o.rw, 0.03, 0.12, D.rw),
    rd: n(o.rd, 0.08, 0.35, D.rd),
  }
  if (out.ridge < out.kneeH + 0.3) out.kneeH = Math.max(0, out.ridge - 0.3)
  if (out.r0 > out.len - 0.1) out.r0 = Math.min(D.r0, out.len / 4)
  while (out.rn > 1 && out.r0 + (out.rn - 1) * out.cc > out.len - 0.05) out.rn--
  return out
}

export interface Bay {
  /** Bay centre x. */
  c: number
  /** Clear gap between the rafter faces (or gable). */
  clear: number
}

export interface Geometry {
  attic: Attic
  /** Length, gable to gable. */
  L: number
  /** Ridge height. */
  H: number
  /** Half the knee-wall-to-knee-wall width. */
  KZ: number
  /** Half the width at the eaves (where the slope meets the floor). */
  HALF: number
  W: number
  SLOPE: number
  THETA: number
  /** Slope length, eaves to ridge. */
  SLEN: number
  SIN: number
  COS: number
  /** Knee wall height as worked out from the slope. */
  KNEE_H: number
  /** Standing height (1.9 m) used by the zones. */
  STAND: number
  Z190: number
  ZBOA: number
  RAFT_CC: number
  RAFT_N: number
  RAFT_W: number
  RAFT_D: number
  ROOF_T: number
  RAFT_X: number[]
  /** Bay edges: [0, ...RAFT_X, L]. */
  EDGES: number[]
  BAYS: Bay[]
  /** Insulated bay build-up: rafter depth + 13 mm plasterboard. */
  BOARD_D: number
  /** BOARD_D measured straight down. */
  BOARD_DY: number
}

export const STAND = 1.9
export const ROOF_T = 0.26

export function deriveGeometry(attic: Attic): Geometry {
  const L = attic.len
  const H = attic.ridge
  const KZ = attic.knee / 2
  const HALF = (H * KZ) / (H - attic.kneeH)
  const W = 2 * HALF
  const SLOPE = H / HALF
  const THETA = Math.atan2(H, HALF)
  const SLEN = Math.hypot(H, HALF)
  const SIN = Math.sin(THETA)
  const COS = Math.cos(THETA)
  const KNEE_H = (HALF - KZ) * SLOPE
  const Z190 = HALF - STAND / SLOPE
  const ZBOA = Math.min(KZ, Z190 + 0.6)
  const RAFT_CC = attic.cc
  const RAFT_N = attic.rn
  const RAFT_W = attic.rw
  const RAFT_D = attic.rd
  const RAFT_X = Array.from({ length: RAFT_N }, (_, i) => attic.r0 + i * RAFT_CC)
  const EDGES = [0, ...RAFT_X, L]
  const BAYS = EDGES.slice(0, -1).map((a, i) => {
    const b = EDGES[i + 1]
    const ia = i === 0 ? 0 : RAFT_W / 2
    const ib = i === EDGES.length - 2 ? 0 : RAFT_W / 2
    return { c: (a + b) / 2, clear: b - a - ia - ib }
  })
  const BOARD_D = RAFT_D + 0.013
  const BOARD_DY = BOARD_D / COS
  return {
    attic: { ...attic },
    L, H, KZ, HALF, W, SLOPE, THETA, SLEN, SIN, COS, KNEE_H,
    STAND, Z190, ZBOA,
    RAFT_CC, RAFT_N, RAFT_W, RAFT_D, ROOF_T, RAFT_X, EDGES, BAYS,
    BOARD_D, BOARD_DY,
  }
}

/** Height of the roof (panelling) above the attic floor at z. */
export const roofY = (geo: Geometry, z: number): number => Math.max(0, (geo.HALF - Math.abs(z)) * geo.SLOPE)

/** Index of the bay containing x, or −1 (v41 `bayAt`). */
export const bayAt = (geo: Geometry, x: number): number =>
  geo.EDGES.findIndex((e, k) => k < geo.EDGES.length - 1 && x >= e && x < geo.EDGES[k + 1])

export const boardedAt = (geo: Geometry, board: readonly number[], x: number): boolean =>
  board.includes(bayAt(geo, clamp(x, 0, geo.L - 1e-6)))

/** Ceiling height at (x, z): the roof, lowered in an insulated (boarded) bay. */
export const ceilAt = (geo: Geometry, board: readonly number[], x: number, z: number): number =>
  Math.max(0, roofY(geo, z) - (boardedAt(geo, board, x) ? geo.BOARD_DY : 0))

// ---------- Slope placement, for drawing the shell (v41 buildSlopes 708,
// buildBoard 727–744, buildSkylight 1110, the storage/closet shelves 1238/1284)

/** Where the roof comes down to height y: the inverse of `roofY` (|z|). */
export const roofZAt = (geo: Geometry, y: number): number => geo.HALF - y / geo.SLOPE

/**
 * A point on a slope: u along the attic (x), v up the slope from the eaves,
 * moved `inset` straight in from the panelling (the plasterboard ceiling of an
 * insulated bay sits BOARD_D in). Returns [x, y, z].
 */
export function slopePoint(geo: Geometry, side: 'N' | 'S', u: number, v: number, inset = 0): [number, number, number] {
  const sign = side === 'S' ? 1 : -1
  return [u, v * geo.SIN - inset * geo.COS, sign * (geo.HALF - v * geo.COS - inset * geo.SIN)]
}

/**
 * The plasterboard ceiling of a run of insulated bays, in slope coordinates
 * (`slopePoint` with inset BOARD_D): from v0 (the floor when the knee wall is
 * opened, else the top of the knee wall) up to vTop where the two sides meet.
 */
export function boardSpan(geo: Geometry, kneeOpened: boolean): { v0: number; vTop: number } {
  const d = geo.BOARD_D
  const v0 = kneeOpened ? (d * geo.COS) / geo.SIN : (geo.HALF - geo.KZ - d * geo.SIN) / geo.COS
  return { v0, vTop: (geo.HALF - d * geo.SIN) / geo.COS }
}

/**
 * The end cap closing the insulation cavity where boarded bays stop next to an
 * open one, as a (z, y) profile on the south side (negate z for north): from
 * the board's foot to the panelling's foot, up to the ridge and back down.
 */
export function boardCapProfile(geo: Geometry, kneeOpened: boolean): [number, number][] {
  const dy = geo.BOARD_DY
  const zf = kneeOpened ? geo.HALF - dy / geo.SLOPE : geo.KZ
  const yf = kneeOpened ? 0 : geo.KNEE_H - dy
  return [[zf, yf], [kneeOpened ? geo.HALF : geo.KZ, kneeOpened ? 0 : geo.KNEE_H], [0, geo.H], [0, geo.H - dy]]
}
