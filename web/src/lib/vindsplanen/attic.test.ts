import { describe, expect, it } from 'vitest'
import { ATTIC_DEF, atticOf, bayAt, ceilAt, cm, deriveGeometry, roofY } from './attic'
import { expectClose, FIXTURE_NAMES, goldPlan } from './testkit'

describe('deriveGeometry — parity with v41', () => {
  it.each(FIXTURE_NAMES)('%s: every derived constant matches', (name) => {
    const { gold, geo } = goldPlan(name)
    const g = gold.geometry
    expectClose(geo.attic, g.ATTIC)
    for (const k of ['L', 'H', 'KZ', 'HALF', 'W', 'SLOPE', 'THETA', 'SLEN', 'SIN', 'COS', 'KNEE_H', 'Z190', 'ZBOA', 'BOARD_D', 'BOARD_DY'] as const)
      expectClose(geo[k], g[k], 1e-3, k)
    expectClose(geo.RAFT_X, g.RAFT_X)
    expectClose(geo.EDGES, g.EDGES)
    expectClose(geo.BAYS, g.BAYS)
  })

  it.each(FIXTURE_NAMES)('%s: ceilAt matches on a 25 cm grid (boarded bays lowered)', (name) => {
    const { gold, plan, geo } = goldPlan(name)
    const out: [number, number, number][] = []
    for (let x = 0; x <= geo.L + 1e-9; x += 0.25)
      for (let z = -geo.HALF - 0.1; z <= geo.HALF + 0.1 + 1e-9; z += 0.25) out.push([x, z, ceilAt(geo, plan.options.board, x, z)])
    expectClose(out, gold.ceil)
  })
})

describe('hand-verified spot values (default attic)', () => {
  const geo = deriveGeometry(ATTIC_DEF)

  it('the roof at z = 0 is the ridge height', () => {
    expect(roofY(geo, 0)).toBe(ATTIC_DEF.ridge)
  })

  it('KNEE_H worked out from the slope equals the measured knee height', () => {
    // HALF − KZ = KZ·kneeH/(H − kneeH) and SLOPE = (H − kneeH)/KZ, so KNEE_H = kneeH
    expect(geo.KNEE_H).toBeCloseTo(0.9418, 10)
    expect(cm(geo.KNEE_H)).toBe(94)
  })

  it('the roof meets the floor at the eaves and is 0 beyond them', () => {
    expect(roofY(geo, geo.HALF)).toBe(0)
    expect(roofY(geo, -geo.HALF - 1)).toBe(0)
    expect(geo.HALF).toBeCloseTo((2.6 * 1.435) / (2.6 - 0.9418), 12)
  })

  it('rafters at 1.20 + k·1.22 m give 7 bays; bayAt is −1 outside', () => {
    expect(geo.RAFT_X.map((x) => +x.toFixed(2))).toEqual([1.2, 2.42, 3.64, 4.86, 6.08, 7.3])
    expect(geo.BAYS).toHaveLength(7)
    expect(bayAt(geo, 0)).toBe(0)
    expect(bayAt(geo, 1.2)).toBe(1)
    expect(bayAt(geo, geo.L)).toBe(-1)
  })

  it('a boarded bay lowers the ceiling by (rafter depth + 13 mm) / cos', () => {
    const open = ceilAt(geo, [], 0.5, 0)
    const boarded = ceilAt(geo, [0], 0.5, 0)
    expect(open - boarded).toBeCloseTo((0.19 + 0.013) / geo.COS, 12)
    expect(ceilAt(geo, [0], geo.L, 0)).toBe(open) // x is clamped into the last bay, which is open
  })
})

describe('atticOf (v41 line 331)', () => {
  it('defaults everything for a non-object', () => {
    expect(atticOf(null)).toEqual(ATTIC_DEF)
    expect(atticOf('x')).toEqual(ATTIC_DEF)
  })

  it('accepts numeric strings (v41 coerces with +v) and rejects null', () => {
    expect(atticOf({ len: '7', knee: null }).len).toBe(7)
    expect(atticOf({ knee: null }).knee).toBe(ATTIC_DEF.knee)
    // "" coerces to 0, which is within the knee-height range
    expect(atticOf({ kneeH: '' }).kneeH).toBe(0)
  })

  it('rejects out-of-range values rather than clamping them', () => {
    expect(atticOf({ len: 3.9 }).len).toBe(8.5)
    expect(atticOf({ len: 15.1 }).len).toBe(8.5)
    expect(atticOf({ len: 15 }).len).toBe(15)
  })

  it('keeps the ridge 30 cm above the knee, the first rafter inside, and drops rafters that do not fit', () => {
    expect(atticOf({ ridge: 1.9, kneeH: 1.6 }).kneeH).toBeCloseTo(1.6, 12)
    expect(atticOf({ ridge: 1.8, kneeH: 1.6 }).kneeH).toBeCloseTo(1.5, 12)
    // (the r0 > len − 0.1 rule cannot fire within the ranges: r0 ≤ 3, len ≥ 4)
    expect(atticOf({ len: 4, r0: 3 })).toMatchObject({ r0: 3, rn: 1 })
    expect(atticOf({ rn: 20 }).rn).toBe(6) // 1.2 + 5·1.22 = 7.3 ≤ 8.45
    expect(atticOf({ rn: 6.6 }).rn).toBe(6)
  })
})
