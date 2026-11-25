import { describe, expect, it } from 'vitest'
import { boardCapProfile, boardSpan, roofY, roofZAt, slopePoint } from './attic'
import { expectClose, FIXTURE_NAMES, goldPlan } from './testkit'

// The scene's slope helpers, checked against each fixture's v41-derived
// geometry (gold.geometry) and against roofY, which is itself parity-tested.
describe.each(FIXTURE_NAMES)('slope helpers — %s', (name) => {
  const { gold, geo } = goldPlan(name)
  const g = gold.geometry as Record<string, number>

  it('roofZAt inverts roofY and gives v41 Z190 at standing height', () => {
    expectClose(roofZAt(geo, 1.9), g.Z190)
    for (const y of [0, 0.45, 1.2, geo.H]) expect(roofY(geo, roofZAt(geo, y))).toBeCloseTo(y, 9)
    expectClose(roofZAt(geo, 0), g.HALF)
  })

  it('slopePoint runs from the eaves to the ridge on the roof surface', () => {
    for (const side of ['S', 'N'] as const) {
      const sg = side === 'S' ? 1 : -1
      expectClose(slopePoint(geo, side, 1, 0), [1, 0, sg * g.HALF])
      expectClose(slopePoint(geo, side, 1, g.SLEN), [1, g.H, 0])
      for (const v of [0.3, 1.1, 2.0]) {
        const [, y, z] = slopePoint(geo, side, 0, v)
        expect(y).toBeCloseTo(roofY(geo, z), 9)
      }
    }
  })

  it('an inset point lies BOARD_DY straight below the roof (the boarded ceiling)', () => {
    for (const v of [0.5, 1.5, 2.2]) {
      const [, y, z] = slopePoint(geo, 'S', 0, v, geo.BOARD_D)
      expectClose(roofY(geo, z) - y, g.BOARD_DY)
    }
  })

  it('boardSpan: the board starts on the floor (opened knee) or at the knee wall top, and meets at z = 0', () => {
    const open = boardSpan(geo, true)
    expect(slopePoint(geo, 'S', 0, open.v0, geo.BOARD_D)[1]).toBeCloseTo(0, 9)
    const shut = boardSpan(geo, false)
    expectClose(slopePoint(geo, 'S', 0, shut.v0, geo.BOARD_D)[2], g.KZ)
    expect(slopePoint(geo, 'S', 0, shut.vTop, geo.BOARD_D)[2]).toBeCloseTo(0, 9)
    expect(open.vTop).toBe(shut.vTop)
  })

  it('boardCapProfile: its inner corners sit on the boarded ceiling, the outer ones on the roof', () => {
    for (const opened of [true, false]) {
      const [a, b, c, d] = boardCapProfile(geo, opened)
      expect(roofY(geo, a[0]) - geo.BOARD_DY).toBeCloseTo(a[1], 9)
      expect(roofY(geo, d[0]) - geo.BOARD_DY).toBeCloseTo(d[1], 9)
      expect(roofY(geo, b[0])).toBeCloseTo(b[1], 9)
      expectClose(c, [0, g.H])
    }
  })
})
