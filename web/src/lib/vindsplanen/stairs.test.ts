import { describe, expect, it } from 'vitest'
import { ATTIC_DEF, deriveGeometry } from './attic'
import { BELOW_DEF } from './below'
import { railContext } from './items'
import { clipBox, curvedPlan, isUpStair, pip, planOf, railSegments, stairHoles, toWorld, type RailPart, type StairPlan } from './stairs'
import { stairInfo } from './warnings'
import { expectClose, FIXTURE_NAMES, goldPlan, type GoldMesh } from './testkit'

const planShape = (P: StairPlan) => ({
  n: P.n, r: P.r, g: P.g, F: P.F, treads: P.treads, opening: P.opening, arrive: P.arrive, turn: P.turn, pivot: P.pivot, a: P.a, wk: P.wk, landing: P.landing, spiral: !!P.spiral,
})

describe('planOf — treads and openings, parity with v41', () => {
  it.each(FIXTURE_NAMES)('%s: every curved and spiral stair', (name) => {
    const { gold, plan } = goldPlan(name)
    for (const it of plan.items.filter(isUpStair)) expectClose(planShape(planOf(plan.options.below, it)), gold.info[it.id].P, 1e-3, it.id)
  })
})

describe('stairHoles — world openings and overlap clashes', () => {
  it.each(FIXTURE_NAMES)('%s: clipped to KZ, HALF and the floor below', (name) => {
    const { gold, plan, geo } = goldPlan(name)
    for (const [k, lim] of [['KZ', geo.KZ], ['HALF', geo.HALF], ['hw', plan.options.below.hw]] as const) {
      const h = stairHoles(geo, plan, lim)
      expectClose(h.holes, gold.holes[k].holes, 1e-3, k)
      expect([...h.clash], k).toEqual(gold.holes[k].clash)
    }
  })
})

/** Rail parts as the meshes v41 draws for them (BoxGeometry size, centre, x-axis direction). */
function railMeshes(parts: RailPart[]) {
  return parts.map((p) => {
    if (p.kind === 'box') return { params: [p.w, p.h, p.d], pos: [p.x, p.y, p.z], dir: [1, 0, 0] }
    const d = [p.q[0] - p.p[0], p.q[1] - p.p[1], p.q[2] - p.p[2]]
    const len = Math.hypot(d[0], d[1], d[2])
    return { params: [len, p.h, p.w], pos: [(p.p[0] + p.q[0]) / 2, (p.p[1] + p.q[1]) / 2, (p.p[2] + p.q[2]) / 2], dir: d.map((v) => v / len) }
  })
}
const goldBoxes = (ms: GoldMesh[]) => ms.map((m) => ({ params: [m.params.width, m.params.height, m.params.depth], pos: m.pos, dir: m.dir }))

describe('railSegments — guard and banister, parity with v41 stairRails', () => {
  it.each(FIXTURE_NAMES)('%s', (name) => {
    const { gold, plan, geo } = goldPlan(name)
    const ctx = railContext(geo, plan)
    for (const it of plan.items) {
      if (it.type !== 'curved') continue
      const parts = railSegments(geo, plan, it, planOf(plan.options.below, it), ctx)
      expectClose(railMeshes(parts), goldBoxes(gold.info[it.id].rails as GoldMesh[]), 1e-3, it.id)
    }
  })
})

describe('hand-verified stairs', () => {
  it('the owner-like old stairs: 14 rises, 5 straight + 7 winders + 1 straight', () => {
    const { gold } = goldPlan('owner-like')
    const P = gold.below.old as { P: { n: number; a: number; wk: number; treads: { straight?: boolean; dir?: string }[] }; it: { b: number } }
    expect(P.P.n).toBe(14)
    expect([P.P.a, P.P.wk, P.it.b]).toEqual([5, 7, 1])
    expect(P.P.treads).toHaveLength(13) // 13 steps before the landing
  })

  it('a quarter turn of three winders: 30° / 60° splits, mirrored for a right turn', () => {
    const B = { ...BELOW_DEF }
    const L = curvedPlan(B, { x: 0, z: 0, rot: 0, turn: 'L', a: 2, w: 0.9, risers: 12 })
    const R = curvedPlan(B, { x: 0, z: 0, rot: 0, turn: 'R', a: 2, w: 0.9, risers: 12 })
    expect(L.n).toBe(12)
    expect(L.r).toBeCloseTo(2.58 / 12, 12)
    expect(L.treads).toHaveLength(11)
    const k = Math.tan(Math.PI / 6) * 0.9
    expect(L.treads[2].poly[2][0]).toBeCloseTo(2 * 0.24 + k, 12)
    expectClose(R.treads.map((t) => t.poly.map(([x, z]) => [x, -z])), L.treads.map((t) => t.poly), 1e-12)
    expect(L.arrive).toBe(2)
  })

  it('the 5 cm opening rule: opening starts where the floor underside comes within 2.0 m of a head', () => {
    // F = 2.58, slab 0.28: a tread counts once its top is above 0.30 m
    const P = curvedPlan({ ...BELOW_DEF }, { x: 0, z: 0, rot: 0, turn: 'N', a: 0, w: 0.9, risers: 12 })
    expect(P.opening[0][0]).toBeCloseTo(0.24, 12) // tread 2 (t = 0.43) is the first above 0.30 → xs = 1 · g
  })

  it('a straight flight: Blondel 2·rise + going, warning only outside 59–66 cm', () => {
    const geo = deriveGeometry(ATTIC_DEF)
    const s = stairInfo(geo, { id: 's', type: 'stairs', x: 4.25, z: 0, rot: 0, w: 0.9, run: 3.6, drop: 2.58 })
    expect(s.n).toBe(14)
    expect(s.blondel).toBeCloseTo((2 * 2.58) / 14 + 3.6 / 14, 12)
    expect(s.warn.map((w) => w.code)).toEqual([])
  })

  it('a rise over 20 cm is flagged (only reachable below the 1.8 m drop sanitize allows)', () => {
    const geo = deriveGeometry(ATTIC_DEF)
    const s = stairInfo(geo, { id: 's', type: 'stairs', x: 4.25, z: 0, rot: 0, w: 0.9, run: 1.2, drop: 0.62 })
    expect(s.n).toBe(3)
    expect(s.warn.find((w) => w.code === 'stairs-steep-rise')?.params).toEqual({ rise: 20.7 })
  })
})

describe('geometry primitives', () => {
  it('toWorld rotates local x toward −z for a positive rotation', () => {
    const [x, z] = toWorld({ x: 1, z: 1, rot: 90 }, 1, 0)
    expect(x).toBeCloseTo(1, 12)
    expect(z).toBeCloseTo(0, 12)
  })

  it('pip and clipBox', () => {
    const sq: [number, number][] = [[0, 0], [2, 0], [2, 2], [0, 2]]
    expect(pip(sq, 1, 1)).toBe(true)
    expect(pip(sq, 3, 1)).toBe(false)
    expect(clipBox(sq, 1, 3, -1, 1)).toEqual([[1, 0], [2, 0], [2, 1], [1, 1]])
    expect(clipBox(sq, 5, 6, 0, 1)).toBeNull()
  })
})
