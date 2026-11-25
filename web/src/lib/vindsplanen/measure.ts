// The Measure tab's registry of coded steps (v41 `walkSteps`, line 1868) as
// data, plus the pure apply/validate/progress logic around it (v41
// 1971–2036). Titles and instructions are the route's (Swedish) copy, keyed
// by step code and field key; each step carries what it needs to be worded
// (`door` for D steps). Also the camera presets (v41 `CAMS`, line 1476).

import { atticOf, clamp, cm, type Geometry } from './attic'
import { belowWin, FF, hallRect, oldStairs, OLD_W, swRect } from './below'
import { sanitizeShape, type BelowDoor, type PlanV2 } from './plan'

export type Pt3 = [number, number, number]

export interface Camera {
  p: Pt3
  t: Pt3
}

export interface MeasureField {
  key: string
  /** Current value in metres, or a count when `raw`. */
  v: number
  /** Accepted input range in display units (cm, or a count when `raw`). */
  min: number
  max: number
  raw?: true
  /** '' for a count; cm otherwise. */
  unit?: ''
}

export interface MeasureDim {
  a: Pt3
  b: Pt3
  /** The value printed on the line, whole cm. */
  cm: number
  /** Printed as "sill <cm>" rather than "<cm> cm". */
  sill?: true
}

/** [x0, x1, y0, y1, z0, z1] highlight box. */
export type HlBox = [number, number, number, number, number, number]

export type MeasureGroup = 'A' | 'B' | 'W' | 'D'

export interface MeasureStep {
  code: string
  /** Attic steps show the attic as it is today (no furniture, every rafter, no plasterboard). */
  attic: boolean
  fields: MeasureField[]
  cam: Camera
  dims: MeasureDim[]
  boxes: HlBox[]
  /** Rafters to highlight: [rafter x, slope]. */
  hl: [number, 'S' | 'N'][]
  /** D steps: the door being measured. */
  door?: { index: number; wall: BelowDoor['wall']; kind: BelowDoor['kind'] }
}

const dim = (a: Pt3, b: Pt3, v: number, sill?: true): MeasureDim => (sill ? { a, b, cm: cm(v), sill } : { a, b, cm: cm(v) })

/** Every measuring step for this plan, in v41 order (A1–A8, B1–B9, W1, W2, D1…). */
export function measureSteps(geo: Geometry, plan: Pick<PlanV2, 'options'>): MeasureStep[] {
  const { L, KZ, HALF, SLOPE, H, KNEE_H, RAFT_X, RAFT_N, RAFT_CC, RAFT_D, RAFT_W, BAYS } = geo
  const B = plan.options.below
  const h = hallRect(geo, B)
  const r = swRect(geo, B)
  const y0 = -FF(B)
  const dirH = B.side === 'S' ? -1 : 1
  const inner = B.side === 'S' ? r.z0 : r.z1
  const hallSide = B.side === 'S' ? h.za : h.zb
  const zc = (h.za + h.zb) / 2
  const wc = (r.z0 + r.z1) / 2
  const px = clamp(r.x0 + B.screen, r.x0, r.x1)
  const eye = (x: number, z: number): Pt3 => [x, y0 + 1.6, z]
  const ground = B.ground > 0 ? B.ground : FF(B)
  const OS = oldStairs(geo, B)
  const oldN = OS.P.n
  // B8's dimension line stands just inside the opening's west end, at the
  // front of step 2 (where the owner measured): from the straight step below
  // it (0: the ground floor) up to this hallway's floor
  const b8x = r.x0 + 0.02
  const b8i = Math.ceil((b8x - OS.it.x) / OS.it.g - 1e-9)
  const b8k = b8i >= 1 && b8i <= OS.P.a ? b8i : 0
  const xm = BAYS[Math.floor(BAYS.length / 2)].c
  const zs = (y: number) => HALF - y / SLOPE - 0.28
  const rx = RAFT_X[Math.max(0, Math.floor(RAFT_N / 2) - 1)]
  const knees: HlBox[] = [
    [xm - 0.55, xm + 0.55, 0, KNEE_H, KZ - 0.02, KZ + 0.02],
    [xm - 0.55, xm + 0.55, 0, KNEE_H, -KZ - 0.02, -KZ + 0.02],
  ]
  const step = (s: Omit<MeasureStep, 'boxes' | 'hl'> & Partial<Pick<MeasureStep, 'boxes' | 'hl'>>): MeasureStep => ({ boxes: [], hl: [], ...s })
  const steps: MeasureStep[] = [
    step({ code: 'A1', attic: true, fields: [{ key: 'len', v: L, min: 400, max: 1500 }],
      cam: { p: [L / 2, 4.3, HALF + 4.2], t: [L / 2, 0.4, 0] }, dims: [dim([0, 0.05, 0], [L, 0.05, 0], L)],
      boxes: [[-0.03, 0.03, 0, 1.4, -KZ, KZ], [L - 0.03, L + 0.03, 0, 1.4, -KZ, KZ]] }),
    step({ code: 'A2', attic: true, fields: [{ key: 'knee', v: 2 * KZ, min: 100, max: 440 }],
      cam: { p: [xm - 1.2, 5.6, -HALF - 2.6], t: [xm, 0.2, 0] }, dims: [dim([xm, 0.05, -KZ], [xm, 0.05, KZ], 2 * KZ)], boxes: knees }),
    step({ code: 'A3', attic: true, fields: [{ key: 'kneeH', v: KNEE_H, min: 0, max: 160 }],
      cam: { p: [xm - 1.0, 2.6, -HALF - 2.4], t: [xm, 0.5, KZ] }, dims: [dim([xm, 0, KZ - 0.04], [xm, KNEE_H, KZ - 0.04], KNEE_H)], boxes: [knees[0]] }),
    step({ code: 'A4', attic: true, fields: [{ key: 'ridge', v: H, min: 180, max: 400 }],
      cam: { p: [xm - 0.6, 2.4, -HALF - 3.8], t: [xm, 1.2, 0] }, dims: [dim([xm, 0, 0], [xm, H, 0], H)] }),
    step({ code: 'A5', attic: true, fields: [{ key: 'r0', v: RAFT_X[0], min: 5, max: 300 }],
      cam: { p: [RAFT_X[0] + 0.8, 2.4, -HALF - 3.0], t: [RAFT_X[0] * 0.5, 1.2, KZ * 0.8] },
      dims: [dim([0, 1.3, zs(1.3)], [RAFT_X[0], 1.3, zs(1.3)], RAFT_X[0])], boxes: [[-0.03, 0.03, 0, 1.4, -KZ, KZ]], hl: [[RAFT_X[0], 'S']] }),
    step({ code: 'A6', attic: true, fields: [{ key: 'cc', v: RAFT_CC, min: 30, max: 200 }],
      cam: { p: [rx + RAFT_CC / 2, 2.4, -HALF - 3.0], t: [rx + RAFT_CC / 2, 1.2, KZ * 0.8] },
      dims: RAFT_N > 1 ? [dim([rx, 1.3, zs(1.3)], [rx + RAFT_CC, 1.3, zs(1.3)], RAFT_CC)] : [], hl: [[rx, 'S'], [rx + RAFT_CC, 'S']] }),
    step({ code: 'A7', attic: true, fields: [{ key: 'rn', v: RAFT_N, unit: '', min: 1, max: 20, raw: true }],
      cam: { p: [L / 2, 2.6, -HALF - 4.6], t: [L / 2, 1.1, 0.6] }, dims: [], hl: RAFT_X.map((x) => [x, 'S'] as [number, 'S']) }),
    step({ code: 'A8', attic: true, fields: [{ key: 'rd', v: RAFT_D, min: 8, max: 35 }, { key: 'rw', v: RAFT_W, min: 3, max: 12 }],
      cam: { p: [rx + 0.5, 1.9, -HALF - 1.4], t: [rx, 1.35, KZ + 0.2] }, dims: [], hl: [[rx, 'S']] }),
    step({ code: 'B1', attic: false, fields: [{ key: 'ceil', v: B.ceil, min: 180, max: 320 }],
      cam: { p: eye(h.xw + 2.2, zc), t: [h.xw + 0.5, y0 + 1.2, hallSide - dirH * 0.4] },
      dims: [dim([h.xw + 0.5, y0, hallSide - dirH * 0.4], [h.xw + 0.5, y0 + B.ceil, hallSide - dirH * 0.4], B.ceil)] }),
    step({ code: 'B2', attic: false, fields: [{ key: 'floorToFloor', v: FF(B), min: 200, max: 380 }],
      cam: { p: eye(r.x0 - 1.3, zc), t: [r.x0 + 0.3, y0 + 1.4, wc] }, dims: [dim([r.x0 + 0.3, y0, wc], [r.x0 + 0.3, 0, wc], FF(B))] }),
    step({ code: 'B3', attic: false, fields: [{ key: 'hallLen', v: B.hallLen, min: 100, max: 850 }],
      cam: { p: [h.xw + 0.4, y0 + 1.9, hallSide - dirH * 0.35], t: [L, y0 + 0.6, zc] },
      dims: [dim([h.xw, y0 + 0.9, hallSide - dirH * 0.25], [L, y0 + 0.9, hallSide - dirH * 0.25], L - h.xw)],
      boxes: [[h.xw - 0.02, h.xw + 0.02, y0, y0 + B.ceil, h.za, h.zb], [L - 0.02, L + 0.02, y0, y0 + B.ceil, h.za, h.zb]] }),
    step({ code: 'B4', attic: false, fields: [{ key: 'opening', v: B.len + B.east, min: 60, max: 500 }],
      cam: { p: eye(r.x0 - 0.9, inner + dirH * 0.9), t: [(r.x0 + r.x1) / 2, y0 + 0.2, inner] },
      dims: [dim([r.x0, y0 + 0.05, inner + dirH * 0.15], [L, y0 + 0.05, inner + dirH * 0.15], L - r.x0)],
      boxes: [[r.x0, r.x1, y0 - 0.01, y0 + 0.02, r.z0, r.z1]] }),
    step({ code: 'B5', attic: false, fields: [{ key: 'sw', v: B.sw, min: 60, max: 200 }],
      cam: { p: eye(r.x0 - 1.0, inner + dirH * 0.7), t: [r.x0 + 0.3, y0 + 0.3, wc] }, dims: [dim([r.x0 + 0.25, y0 + 0.05, r.z0], [r.x0 + 0.25, y0 + 0.05, r.z1], B.sw)] }),
    step({ code: 'B6', attic: false, fields: [{ key: 'hall', v: B.hall, min: 60, max: 300 }],
      cam: { p: eye(r.x0 - 0.8, hallSide - dirH * 0.35), t: [(r.x0 + r.x1) / 2, y0 + 0.4, (inner + hallSide) / 2] },
      dims: [dim([(r.x0 + r.x1) / 2, y0 + 0.05, inner], [(r.x0 + r.x1) / 2, y0 + 0.05, hallSide], B.hall)] }),
    step({ code: 'B7', attic: false, fields: [{ key: 'screen', v: B.screen, min: 0, max: 500 }],
      cam: { p: eye(r.x0 + 0.4, inner + dirH * 1.15), t: [(r.x0 + px) / 2, y0 + 1.1, inner] },
      dims: [dim([r.x0, y0 + 1.1, inner + dirH * 0.05], [px, y0 + 1.1, inner + dirH * 0.05], B.screen)],
      boxes: [[r.x0, px, y0, y0 + B.ceil, inner - 0.04, inner + 0.04]] }),
    step({ code: 'B8', attic: false,
      fields: [{ key: 'steps', v: oldN, unit: '', min: 6, max: 24, raw: true }, { key: 'stepHeight', v: ground / oldN, min: 14, max: 24 }, { key: 'width', v: OLD_W(B), min: 60, max: 150 }],
      cam: { p: [r.x1 - 0.3, y0 + 1.8, inner + dirH * 0.5], t: [r.x0 + 0.4, y0 - 1.2, wc] }, dims: [dim([b8x, y0 - ground + b8k * OS.P.r, wc], [b8x, y0, wc], ground - b8k * OS.P.r)] }),
  ]
  {
    const g = OS.it.g
    const k = Math.max(1, OS.P.a - 5)
    const x = OS.it.x + (k - 1) * g
    const ty = y0 - OS.P.F + k * OS.P.r
    const z = OS.it.z
    steps.push(step({ code: 'B9', attic: false,
      fields: [{ key: 'going', v: g, min: 15, max: 35 }, { key: 'winders', v: OS.P.wk as number, unit: '', min: 2, max: 8, raw: true }, { key: 'after', v: OS.it.b, unit: '', min: 0, max: 4, raw: true }],
      cam: { p: [x + 1.6, ty + 1.5, z + 0.9], t: [x + g / 2, ty, z] }, dims: [dim([x, ty + 0.02, z], [x + g, ty + 0.02, z], g)],
      boxes: [[x, x + g, ty - 0.045, ty + 0.01, z - OS.it.w / 2, z + OS.it.w / 2]] }))
  }
  {
    const bw = belowWin(geo, B)
    const z = bw.z0 + bw.w / 2
    steps.push(step({ code: 'W1', attic: false,
      fields: [{ key: 'edge', v: bw.z0 - h.za, min: 0, max: 400 }, { key: 'w', v: bw.w, min: 30, max: 300 }, { key: 'h', v: bw.h, min: 30, max: 250 }, { key: 'sill', v: bw.sill, min: 0, max: 200 }],
      cam: { p: [Math.max(h.xw + 0.4, L - 3.9), y0 + 1.6, h.zb - 0.3], t: [L, y0 + 1.1, (h.za + bw.z0 + bw.w) / 2] },
      dims: [dim([L - 0.05, y0 + bw.sill - 0.1, h.za], [L - 0.05, y0 + bw.sill - 0.1, bw.z0], bw.z0 - h.za), dim([L - 0.05, y0, z], [L - 0.05, y0 + bw.sill, z], bw.sill, true)],
      boxes: [[L - 0.05, L + 0.02, y0 + bw.sill, y0 + bw.sill + bw.h, bw.z0, bw.z0 + bw.w]] }))
  }
  {
    const g = plan.options.gable
    const z0 = g.off - g.w / 2
    steps.push(step({ code: 'W2', attic: true,
      fields: [{ key: 'edge', v: z0 + KZ, min: 0, max: 400 }, { key: 'w', v: g.w, min: 30, max: 250 }, { key: 'h', v: g.h, min: 30, max: 220 }, { key: 'sill', v: g.sill, min: 0, max: 200 }],
      cam: { p: [L - 4.2, 1.6, 0.6], t: [L, 1.0, (z0 + g.w - KZ) / 2] },
      dims: [dim([L - 0.05, g.sill - 0.1, -KZ], [L - 0.05, g.sill - 0.1, z0], z0 + KZ), dim([L - 0.05, 0, g.off], [L - 0.05, g.sill, g.off], g.sill, true)],
      boxes: [[L - 0.05, L + 0.02, g.sill, g.sill + g.h, z0, z0 + g.w]] }))
  }
  B.doors.forEach((d, i) => {
    const isW = d.wall === 'W'
    const edge = d.at - d.w / 2
    let cam: Camera
    let dims: MeasureDim[]
    let boxes: HlBox[]
    if (isW) {
      const z = h.za + d.at
      cam = { p: eye(h.xw + 2.1, z), t: [h.xw, y0 + 1.0, z] }
      dims = [dim([h.xw + 0.12, y0 + 0.05, h.za], [h.xw + 0.12, y0 + 0.05, h.za + edge], edge)]
      boxes = [[h.xw - 0.03, h.xw + 0.05, y0, y0 + 2.04, z - d.w / 2, z + d.w / 2]]
    } else {
      const x = L - d.at
      const wz = d.wall === 'N' ? h.za : h.zb
      const s2 = d.wall === 'N' ? 1 : -1
      const mx = (x + L - edge / 2) / 2
      cam = { p: [Math.max(h.xw + 0.25, x - 1.3), y0 + 1.75, wz + s2 * Math.min(2.0, h.zb - h.za - 0.3)], t: [mx, y0 + 0.8, wz] }
      dims = [dim([L, y0 + 0.05, wz + s2 * 0.12], [L - edge, y0 + 0.05, wz + s2 * 0.12], edge)]
      boxes = [[x - d.w / 2, x + d.w / 2, y0, y0 + 2.04, wz - 0.04, wz + 0.04]]
    }
    steps.push(step({ code: 'D' + (i + 1), attic: false, fields: [{ key: 'edge', v: edge, min: 0, max: 850 }, { key: 'w', v: d.w, min: 30, max: 200 }], cam, dims, boxes, door: { index: i, wall: d.wall, kind: d.kind } }))
  })
  return steps
}

/** The number shown for a field: whole count, or cm to one decimal (v41 `valText`). */
export const fieldDisplay = (f: MeasureField): number => (f.raw ? Math.round(f.v) : +(f.v * 100).toFixed(1))

/** Per field: is the typed value (display units) a finite number within range? */
export const validateInputs = (st: MeasureStep, inputs: readonly number[]): boolean[] =>
  st.fields.map((f, k) => Number.isFinite(inputs[k]) && inputs[k] >= f.min && inputs[k] <= f.max)

export function measureProgress(steps: readonly MeasureStep[], measured: Readonly<Record<string, string>>): { done: number; total: number; next: number } {
  const done = steps.filter((s) => measured[s.code]).length
  const i = steps.findIndex((s) => !measured[s.code])
  return { done, total: steps.length, next: i < 0 ? 0 : i }
}

/**
 * "Save and next" on a step (v41 line 2029): write each typed value (display
 * units) through the step's setter in order, mark the step measured on
 * `date`, and for an attic step normalise the attic with `atticOf`. Returns
 * null when any value fails `validateInputs`.
 *
 * v41 reloaded the page when an attic step changed the attic, which re-ran
 * `sanitize` against the new geometry; this does the same in place.
 */
export function applyMeasureStep(geo: Geometry, plan: PlanV2, code: string, inputs: readonly number[], date: string): PlanV2 | null {
  const steps = measureSteps(geo, plan)
  const st = steps.find((s) => s.code === code)
  if (!st || validateInputs(st, inputs).some((ok) => !ok)) return null
  const out: PlanV2 = structuredClone(plan)
  const A = out.options.attic
  const B = out.options.below
  const g = out.options.gable
  const vals = st.fields.map((f, k) => (f.raw ? inputs[k] : inputs[k] / 100))
  const oldN = oldStairs(geo, plan.options.below).P.n
  switch (code) {
    case 'A1': A.len = vals[0]; break
    case 'A2': A.knee = vals[0]; break
    case 'A3': A.kneeH = vals[0]; break
    case 'A4': A.ridge = vals[0]; break
    case 'A5': A.r0 = vals[0]; break
    case 'A6': A.cc = vals[0]; break
    case 'A7': A.rn = Math.round(vals[0]); break
    case 'A8': A.rd = vals[0]; A.rw = vals[1]; break
    case 'B1': B.ceil = vals[0]; break
    case 'B2': B.slab = clamp(vals[0] - B.ceil, 0.1, 0.6); break
    case 'B3': B.hallLen = vals[0]; break
    case 'B4': B.len = clamp(vals[0] - B.east, 0.6, 5); break
    case 'B5': B.sw = vals[0]; break
    case 'B6': B.hall = vals[0]; break
    case 'B7': B.screen = vals[0]; break
    case 'B8':
      B.oldN = Math.round(vals[0])
      B.ground = clamp(vals[1] * (B.oldN || oldN), 1.8, 4)
      B.oldW = vals[2]
      break
    case 'B9':
      B.oldG = vals[0]
      B.oldK = Math.round(vals[1])
      B.oldB = Math.round(vals[2])
      break
    case 'W1': B.winZ = vals[0]; B.winW = vals[1]; B.winH = vals[2]; B.winS = vals[3]; break
    case 'W2':
      // the first field is the edge from the north knee wall; the width
      // setter turns it into the centre offset
      g.on = true
      g.w = vals[1]
      g.off = clamp(vals[0] - geo.KZ + vals[1] / 2, -2, 2)
      g.h = vals[2]
      g.sill = vals[3]
      break
    default: {
      const d = st.door && B.doors[st.door.index]
      if (!d) return null
      d.w = vals[1]
      d.at = vals[0] + vals[1] / 2
    }
  }
  out.options.measured[code] = date
  if (st.attic) {
    out.options.attic = atticOf(out.options.attic)
    if (JSON.stringify(out.options.attic) !== JSON.stringify(plan.options.attic)) return sanitizeShape(out)
  }
  return out
}

/** v41 `CAMS`: the view presets. */
export function cameraPresets(geo: Geometry, plan: Pick<PlanV2, 'options'>): Record<'overview' | 'plan' | 'east' | 'eye' | 'below' | 'section', Camera> {
  const { L } = geo
  const B = plan.options.below
  const F = FF(B)
  const h = hallRect(geo, B)
  const r = swRect(geo, B)
  const zh = B.side === 'S' ? (h.za + r.z0) / 2 : (r.z1 + h.zb) / 2
  const sg = B.side === 'S' ? 1 : -1
  return {
    overview: { p: [L / 2 + 3.2, 5.6, 6.8], t: [L / 2, 0.7, 0] },
    plan: { p: [L / 2, 12.5, 0.01], t: [L / 2, 0, 0] },
    east: { p: [L + 4.2, 1.7, 0], t: [L / 2, 1.0, 0] },
    eye: { p: [0.45, 1.62, 0.05], t: [L, 1.2, 0] },
    below: { p: [h.xw + 0.35, -F + 1.55, zh + 0.15], t: [L, -F + 1.2, zh - 0.25] },
    section: { p: [L + 1.5, 0.2, sg * 7.5], t: [L - 2.4, -1.0, 0] },
  }
}
