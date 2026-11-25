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

describe('old stairs: the turn begins one going before the corner', () => {
  // Fictional stairs shaped like the owner's: 14 rises, 92 cm wide, 21 cm going,
  // 7 winders and 1 straight step after the turn, against the north wall.
  // Walking up: 1–5 straight, 6–12 winders, 13 straight, 14 the hallway floor.
  const geo = deriveGeometry(ATTIC_DEF)
  const B = { ...BELOW_DEF, oldN: 14, oldW: 0.92, oldG: 0.21, oldK: 7, oldB: 1 }
  const { it: os, P } = oldStairs(geo, B)
  const area = (poly: [number, number][]) =>
    Math.abs(
      poly.reduce((s, [x, z], i) => {
        const [x2, z2] = poly[(i + 1) % poly.length]
        return s + x * z2 - x2 * z
      }, 0),
    ) / 2

  it('13 treads = 5 straight + 7 winders + 1 straight; the foot is one going further west than v41', () => {
    expect([P.a, P.wk, os.b]).toEqual([5, 7, 1])
    expect(P.treads).toHaveLength(13)
    expect(P.treads.slice(0, 5).every((q) => q.straight && !q.dir)).toBe(true)
    expect(P.treads.slice(5, 12).every((q) => !q.straight)).toBe(true)
    expect(P.treads[12]).toMatchObject({ straight: true, dir: 'z' }) // step 13; step 14 is the hallway floor
    expect(P.treads[12].t).toBeCloseTo((13 * 2.58) / 14, 12)
    expect(os.lead).toBeCloseTo(0.21, 12)
    // 8.5 − 0.92 − 5 · 0.21 − 0.21 = 6.32 (v41: 8.5 − 0.92 − 1.05 = 6.53)
    expect(os.x).toBeCloseTo(6.32, 12)
    // the corner post: 5 straight goings + the lead from the foot
    expect(P.pivot[0]).toBeCloseTo(5 * 0.21 + 0.21, 12)
  })

  it('the winders tile the turn exactly (lead + corner square), rising one rise each, none narrowing to a point', () => {
    const winders = P.treads.slice(P.a, P.a + 7)
    expect(winders.reduce((s, q) => s + area(q.poly), 0)).toBeCloseTo((0.21 + 0.92) * 0.92, 10)
    winders.forEach((q, j) => {
      expect(q.t).toBeCloseTo((P.a + j + 1) * P.r, 10)
      expect(q.poly.length).toBeGreaterThanOrEqual(4) // a post-side edge (lead / 7 = 3 cm), not a v41 triangle
    })
    // the first winder starts flush with the end of the straight flight
    expect(Math.min(...winders[0].poly.map((p) => p[0]))).toBeCloseTo(P.a * P.g, 12)
    // the last winder ends on the exit edge through the post
    expect(winders[6].poly.some(([x, z]) => Math.abs(x - P.pivot[0]) < 1e-9 && Math.abs(z - P.pivot[1]) < 1e-9)).toBe(true)
  })

  describe('the top flight reaching past a 1.00 m stairwell into the hallway', () => {
    // 0.92 m of stairs + 1 step of 0.21 m after the turn = 1.13 m from the long
    // wall, 13 cm past the 1.00 m stairwell's hallway edge (z1 = −1.10).
    const plan = { items: [], options: { below: B } } as unknown as Parameters<typeof belowLayout>[1]
    const lay = belowLayout(geo, plan)
    const floors = lay.parts.filter((p): p is Extract<BelowPart, { kind: 'plane' }> => p.kind === 'plane' && p.mat === 'floor' && Math.abs(p.y - lay.y0) < 1e-9)
    const floorAt = (x: number, z: number) => floors.some((f) => Math.abs(x - f.x) <= f.w / 2 && Math.abs(z - f.z) <= f.h / 2)
    const r = swRect(geo, B)

    it('the hallway floor is open over the strip step 13 crosses, between the corner post and the east wall', () => {
      expect(floorAt(r.x1 - 0.1, r.z1 + 0.06)).toBe(false) // over step 13
      expect(floorAt(r.x1 - 0.1, r.z1 + 0.14)).toBe(true) // just past it: hallway floor
      expect(floorAt(r.x1 - 0.92 - 0.05, r.z1 + 0.06)).toBe(true) // west of the post: hallway floor
    })

    it('the stairwell wall stops under step 13 there: up to the bottom of its riser (12 rises)', () => {
      const walls = lay.parts.filter((p): p is Extract<BelowPart, { kind: 'plane' }> => p.kind === 'plane' && p.mat === 'wall' && Math.abs(p.z - (r.z1 + 0.01)) < 1e-9 && p.rotY === 0)
      const east = walls.find((p) => p.x > r.x1 - 0.92)!
      expect(east.w).toBeCloseTo(0.92, 12)
      expect(east.h).toBeCloseTo(12 * P.r, 12)
    })

    it('a stairwell wide enough for the stairs keeps the hallway floor whole beside it', () => {
      const wide = { ...B, sw: 1.2 }
      const L2 = belowLayout(geo, { items: [], options: { below: wide } } as unknown as Parameters<typeof belowLayout>[1])
      const r2 = swRect(geo, wide)
      const f2 = L2.parts.filter((p): p is Extract<BelowPart, { kind: 'plane' }> => p.kind === 'plane' && p.mat === 'floor' && Math.abs(p.y - L2.y0) < 1e-9)
      expect(f2.some((f) => Math.abs(r2.x1 - 0.1 - f.x) <= f.w / 2 && Math.abs(r2.z1 + 0.06 - f.z) <= f.h / 2)).toBe(true)
      expect(f2).toHaveLength(floors.length - 1)
    })
  })
})
