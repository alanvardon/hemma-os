import { describe, expect, it } from 'vitest'
import { ATTIC_DEF, deriveGeometry } from './attic'
import { BELOW_DEF, belowLayout, belowWin, FF, hallRect, OLD_W, oldStairs, swRect, type BelowPart } from './below'
import { expectClose, FIXTURE_NAMES, goldPlan, type GoldMesh } from './testkit'

describe('floor-below rectangles and old stairs — parity with v41', () => {
  it.each(FIXTURE_NAMES)('%s', (name) => {
    const { gold, plan, geo } = goldPlan(name)
    const B = plan.options.below
    const os = oldStairs(geo, B)
    expectClose(
      {
        F: FF(B),
        sw: swRect(geo, B),
        hall: hallRect(geo, B),
        oldW: OLD_W(B),
        win: belowWin(geo, B),
        old: { it: os.it, P: { n: os.P.n, r: os.P.r, g: os.P.g, F: os.P.F, treads: os.P.treads, opening: os.P.opening, arrive: os.P.arrive, turn: os.P.turn, pivot: os.P.pivot, a: os.P.a, wk: os.P.wk, spiral: false } },
      },
      { F: gold.below.F, sw: gold.below.sw, hall: gold.below.hall, oldW: gold.below.oldW, win: gold.below.win, old: gold.below.old },
    )
  })
})

/** Our parts as the objects v41 adds to the floor below, in order. */
function asMeshes(parts: BelowPart[]) {
  return parts.map((p) => {
    switch (p.kind) {
      case 'box':
        return { type: 'Mesh', geo: 'BoxGeometry', size: [p.w, p.h, p.d], pos: [p.x, p.y, p.z], rot: [0, 0, 0], cut: p.cut ?? '' }
      case 'rbox':
        return { type: 'Mesh', geo: 'RoundedBoxGeometry', size: [p.w, p.h, p.d], pos: [p.x, p.y, p.z], rot: [0, p.rotY, 0], cut: '' }
      case 'plane':
        return { type: 'Mesh', geo: 'PlaneGeometry', size: [p.w, p.h], pos: [p.x, p.y, p.z], rot: [p.rotX, p.rotY, 0], cut: p.cut ?? '' }
      case 'eastWall':
        return { type: 'Mesh', geo: 'ShapeGeometry', size: [], pos: [p.x, p.y, 0], rot: [0, 0, 0], cut: 'E' }
      case 'oldStairs':
        return { type: 'Group', geo: null, size: [], pos: [p.x, p.y, p.z], rot: [0, 0, 0], cut: '' }
      case 'lamp':
        return { type: 'PointLight', geo: null, size: [], pos: [p.x, p.y, p.z], rot: [0, 0, 0], cut: '' }
      case 'lampDisc':
      case 'smoke':
        return { type: 'Mesh', geo: 'CylinderGeometry', size: [], pos: [p.x, p.y, p.z], rot: [0, 0, 0], cut: '' }
      case 'smokeLed':
        return { type: 'Mesh', geo: 'SphereGeometry', size: [], pos: [p.x, p.y, p.z], rot: [0, 0, 0], cut: '' }
      case 'door':
        return { type: 'Group', geo: null, size: [], pos: [p.x, p.y, p.z], rot: [0, p.rotY, 0], cut: p.cut }
    }
  })
}
function goldMeshes(ms: GoldMesh[]) {
  return ms.map((m) => {
    const size =
      m.geo === 'BoxGeometry' || m.geo === 'RoundedBoxGeometry' ? [m.params.width, m.params.height, m.params.depth] : m.geo === 'PlaneGeometry' ? [m.params.width, m.params.height] : []
    return { type: m.type, geo: m.geo, size, pos: m.pos, rot: m.rot, cut: m.cut }
  })
}

describe('belowLayout — every part v41 buildBelow draws (trimmer, floor, walls, window, banisters, screen, old stairs, doors)', () => {
  it.each(FIXTURE_NAMES)('%s', (name) => {
    const { gold, plan, geo } = goldPlan(name)
    expectClose(asMeshes(belowLayout(geo, plan).parts), goldMeshes(gold.below.parts))
  })

  it('the trimmer joist appears only when the floor is extended over the stairwell', () => {
    const { plan, geo } = goldPlan('owner-like')
    const trimmer = (fill: number) =>
      belowLayout(geo, { ...plan, options: { ...plan.options, below: { ...plan.options.below, fill } } }).parts.filter((p) => p.kind === 'box' && p.h === 0.22)
    expect(trimmer(0)).toHaveLength(0)
    const [t] = trimmer(0.1)
    expect(t).toMatchObject({ kind: 'box', w: 0.045 })
    if (t.kind !== 'box') throw new Error('box')
    expect(t.x).toBeCloseTo(swRect(geo, plan.options.below).x0 + 0.1 - 0.0225, 12)
  })
})

describe('hand-verified floor below (defaults)', () => {
  const geo = deriveGeometry(ATTIC_DEF)
  const B = { ...BELOW_DEF }

  it('the stairwell sits against the north wall at the east end', () => {
    expect(swRect(geo, B)).toEqual({ x0: 8.5 - 2.3, x1: 8.5, z0: -2.1, z1: -1.1 })
    expect(hallRect(geo, B)).toEqual({ xw: 8.5 - 4.75, za: -2.1, zb: -1.1 + 1.3 })
  })

  it('floor to floor is ceiling + slab; old stairs default to round(F / 18.5 cm) rises', () => {
    expect(FF(B)).toBeCloseTo(2.58, 12)
    expect(oldStairs(geo, B).P.n).toBe(14)
  })

  it('step 10 of the old stairs to the hallway-above ceiling (owner-like, default storey heights)', () => {
    // 14 rises over F2 = 2.58 m: step 10 is 10 · 2.58 / 14 = 1.843 m above the ground floor.
    // The hallway ceiling is F2 + ceil = 2.58 + 2.30 = 4.88 m above the ground floor, so
    // 4.88 − 1.843 = 3.037 m ≈ 304 cm. (The plan's "~309 cm" depends on the owner's measured
    // B8 storey height, which this fictional fixture does not carry.)
    const { geo: g, plan } = goldPlan('owner-like')
    const B = plan.options.below
    const os = oldStairs(g, B)
    const step10 = os.P.treads[9].t
    expect(step10).toBeCloseTo((10 * 2.58) / 14, 12)
    expect(Math.round((FF(B) + B.ceil - step10) * 100)).toBe(304)
  })
})
