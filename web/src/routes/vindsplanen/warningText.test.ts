import { describe, expect, it } from 'vitest'
import { INFO_CODES, planWarnings, type WarningCode } from '../../lib/vindsplanen/warnings'
import { deriveGeometry } from '../../lib/vindsplanen/attic'
import { importV1 } from '../../lib/vindsplanen/legacy'
import ownerLike from '../../lib/vindsplanen/__fixtures__/owner-like.json'
import { WARNING_CODES, warningText } from './warningText'

// Every code the core can emit (the WarningCode union, spelled out so a new
// code without wording fails here as well as at the type level).
const ALL: WarningCode[] = [
  'furn-roof-clash', 'furn-outside', 'wall-door-low', 'wall-on-rafter', 'sky-wider-than-bay', 'sky-reaches-ridge',
  'sky-overlap', 'stairs-outside', 'stairs-steep-rise', 'stairs-too-steep', 'stairs-shallow', 'stairs-low-head',
  'up-walkway-narrow', 'up-outside-hall', 'up-over-well', 'up-low-head', 'up-down-head', 'up-knee-wall',
  'up-hole-clash', 'spiral-landing-head', 'spiral-shallow', 'up-steep-rise', 'up-door-blocked',
  'storage-hole-overlap', 'storage-low-front', 'closet-hole-overlap', 'closet-door-low', 'closet-shallow',
]
const PARAMS = { h: 187, w: 114, clear: 101.5, rise: 21.5, blondel: 68, head: 176, free: 75, reach: 13, need: 15, step: 4, going: 18, count: 2, walls: 'W,N', depth: 30 }

describe('warningText', () => {
  it('has Swedish wording for all 28 codes', () => {
    expect(ALL).toHaveLength(28)
    expect([...WARNING_CODES].sort()).toEqual([...ALL].sort())
    for (const code of ALL) {
      const t = warningText({ code, params: PARAMS })
      expect(t.length).toBeGreaterThan(10)
      expect(t).not.toMatch(/undefined|NaN|\{|\}/)
    }
  })

  it('formats numbers the Swedish way, in cm', () => {
    expect(warningText({ code: 'sky-wider-than-bay', params: { w: 114, clear: 101.5 } })).toBe(
      '114 cm is wider than the 101,5 cm gap between rafters. A rafter would have to be cut and trimmed.',
    )
    expect(warningText({ code: 'up-walkway-narrow', params: { free: 75 } })).toContain('Leaves only 75 cm to walk past')
    expect(warningText({ code: 'up-over-well', params: { reach: 13, need: 15 } })).toContain('13 cm over')
  })

  it('names the doors a stair stands in front of', () => {
    expect(warningText({ code: 'up-door-blocked', params: { count: 1, walls: 'N' } })).toContain('a door')
    expect(warningText({ code: 'up-door-blocked', params: { count: 2, walls: 'W,S' } })).toContain('2 doors')
    expect(warningText({ code: 'up-door-blocked', params: { count: 2, walls: 'W,S' } })).toContain('west end, south wall')
  })

  it('words every warning the owner-like fixture produces', () => {
    const r = importV1(ownerLike.input)
    if (!r.ok) throw new Error('fixture must import')
    const all = Object.values(planWarnings(deriveGeometry(r.plan.options.attic), r.plan)).flat()
    expect(all.length).toBeGreaterThan(0)
    for (const w of all) expect(warningText(w)).not.toBe(w.code)
    expect(all.some((w) => INFO_CODES.has(w.code))).toBe(true)
  })
})
