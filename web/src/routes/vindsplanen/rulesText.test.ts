import { describe, expect, it } from 'vitest'
import { ATTIC_DEF, deriveGeometry } from '../../lib/vindsplanen/attic'
import { examplePlan } from '../../lib/vindsplanen/plan'
import { checkRules, type RuleId, type RuleResult } from '../../lib/vindsplanen/rules'
import { RULE_IDS, ruleText, STATUS_LABEL } from './rulesText'

const ALL: RuleId[] = [
  'stair-free-height', 'stair-tread-gaps', 'stair-geometry', 'stair-handrails', 'stair-guards',
  'escape-window-sill', 'escape-window-size', 'floor-escape-door', 'room-height', 'alterations',
]
const geo = deriveGeometry(ATTIC_DEF)
const row = (r: Partial<RuleResult> & { id: RuleId }): RuleResult => ({ ref: 'x', status: 'info', ...r })

describe('ruleText', () => {
  it('has wording for every rule id', () => {
    expect([...RULE_IDS].sort()).toEqual([...ALL].sort())
  })

  it('words every row of the example plan, with no stray tokens', () => {
    const p = examplePlan()
    for (const r of checkRules(geo, p)) {
      const t = ruleText(r)
      expect(t.length).toBeGreaterThan(20)
      expect(t).not.toMatch(/undefined|NaN|\[object|\{|\}/)
    }
  })

  it('formats free height in whole cm, rounded toward the miss', () => {
    const base = { id: 'stair-free-height', status: 'fail', need: 2, itemId: 'c1' } as const
    expect(ruleText(row({ ...base, have: 1.965, params: { limit: 'roof' } }))).toBe('Free height 196 cm under the roof — at least 200 cm needed.')
    expect(ruleText(row({ ...base, have: 1.9996, params: { limit: 'roof' } }))).toContain('Free height 199 cm')
    expect(ruleText(row({ ...base, status: 'ok', have: 2, params: { limit: 'landing' } }))).toContain('Free height 200 cm under the top landing')
    expect(ruleText(row({ ...base, have: 1.8, params: { limit: 'below' } }))).toContain('above someone on the existing stairs below')
  })

  it('formats sills with an at-most limit, and explains each unknown reason', () => {
    const sill = { id: 'escape-window-sill', need: 1.2, status: 'ok' } as const
    expect(ruleText(row({ ...sill, itemId: 's1', have: 1, params: { window: 'roof' } }))).toBe('Sill 100 cm above the floor — at most 120 cm allowed.')
    expect(ruleText(row({ ...sill, status: 'fail', have: 1.205, params: { window: 'gable' } }))).toBe('Gable window: Sill 121 cm above the floor — at most 120 cm allowed.')
    const u = { ...sill, status: 'unknown' } as const
    expect(ruleText(row({ ...u, itemId: 's1', params: { window: 'roof', reason: 'not-measured' } }))).toContain('isn’t a valid number')
    expect(ruleText(row({ ...u, have: 1, params: { window: 'roof', reason: 'not-placed' } }))).toContain('no valid opening')
    expect(ruleText(row({ ...u, have: 0.4, params: { window: 'roof', reason: 'behind-knee-wall', kneeH: 0.6 } }))).toContain('knee wall is 60 cm')
  })

  it('explains window size, boarding, tread gaps and floor area', () => {
    const size = { id: 'escape-window-size', status: 'unknown', params: { window: 'roof', frameW: 0.78, frameH: 1.18, needW: 0.5, needH: 0.6, needSum: 1.5 } } as const
    expect(ruleText(row({ ...size, params: { ...size.params, reason: 'frame-not-free-opening' } }))).toContain('Frame 78 × 118 cm')
    expect(ruleText(row({ ...size, status: 'fail', params: { ...size.params, frameW: 0.4, reason: 'frame-too-small' } }))).toContain('too small')
    expect(ruleText(row({ id: 'stair-free-height', status: 'unknown', have: 2.05, need: 2, params: { limit: 'roof', reason: 'boarded' } }))).toContain('plasterboard')
    expect(ruleText(row({ id: 'stair-free-height', status: 'unknown', need: 2, params: { reason: 'not-measured' } }))).toContain('couldn’t be measured')
    expect(ruleText(row({ id: 'stair-tread-gaps', status: 'unknown', need: 0.1, params: { reason: 'no-riser-data' } }))).toContain('at most 100 mm')
    expect(ruleText(row({ id: 'floor-escape-door', have: 27.34, need: 25, params: { branch: 'over' } }))).toContain('about 27,3 m², more than 25 m²')
    expect(ruleText(row({ id: 'floor-escape-door', have: 24.4, need: 25, params: { branch: 'atMost' } }))).toContain('25 m² or less')
    expect(ruleText(row({ id: 'floor-escape-door', params: { branch: 'unknown' } }))).toContain('couldn’t be worked out')
  })

  it('leaves the change-of-use call to the kommun', () => {
    expect(ruleText(row({ id: 'alterations' }))).toContain('change of use is for the kommun to decide')
  })

  it('labels every status', () => {
    expect(STATUS_LABEL).toEqual({ ok: 'OK', fail: 'Not OK', unknown: 'Can’t tell', info: 'Info' })
  })
})
