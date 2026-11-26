import { describe, expect, it } from 'vitest'
import { ATTIC_DEF, atticOf, deriveGeometry } from './attic'
import { examplePlan, type Item, type PlanV2, type StairsItem } from './plan'
import {
  checkRules,
  ESCAPE_DOOR_AREA,
  gradeAtLeast,
  gradeAtMost,
  RULES_SOURCE,
  storeyArea,
  type RuleResult,
} from './rules'
import { isUpStair } from './stairs'
import { curvedInfo, stairInfo } from './warnings'
import { FIXTURE_NAMES, goldPlan } from './testkit'

const geo = deriveGeometry(ATTIC_DEF)
const withItems = (items: Item[], over: Partial<PlanV2['options']> = {}): PlanV2 => {
  const p = examplePlan()
  return { ...p, options: { ...p.options, ...over }, items }
}
const rows = (rs: RuleResult[], id: string) => rs.filter((r) => r.id === id)
const one = (rs: RuleResult[], id: string, itemId?: string): RuleResult => {
  const m = rs.filter((r) => r.id === id && r.itemId === itemId)
  expect(m).toHaveLength(1)
  return m[0]
}

/** A straight stair along x, centred on the ridge, whose wide edge meets the roof at height `head`. */
const stairWithHead = (head: number, x = 3): StairsItem => ({
  id: 'st',
  type: 'stairs',
  x,
  z: 0,
  rot: 0,
  // stairInfo's worst tread is the top one (k = 0) at the long edges |z| = w/2,
  // where roofY = (HALF − w/2)·SLOPE; so w/2 = HALF − head/SLOPE gives exactly `head`
  w: 2 * (geo.HALF - head / geo.SLOPE),
  run: 1.2,
  drop: 2.58,
})

describe('checkRules — example plan golden statuses', () => {
  const rs = checkRules(geo, examplePlan())

  it('lists the rows in display order with their statuses', () => {
    expect(rs.map((r) => [r.id, r.itemId ?? (r.params?.window === 'gable' ? 'gable' : ''), r.status])).toEqual([
      ['stair-free-height', 'c1', 'fail'],
      ['stair-tread-gaps', '', 'unknown'],
      ['stair-geometry', 'c1', 'info'],
      ['stair-handrails', '', 'info'],
      ['stair-guards', '', 'info'],
      ['escape-window-sill', 's1', 'ok'],
      ['escape-window-size', 's1', 'unknown'],
      ['escape-window-sill', 's2', 'ok'],
      ['escape-window-size', 's2', 'unknown'],
      ['escape-window-sill', 's3', 'ok'],
      ['escape-window-size', 's3', 'unknown'],
      ['escape-window-sill', 'gable', 'ok'],
      ['escape-window-size', 'gable', 'unknown'],
      ['floor-escape-door', '', 'info'],
      ['room-height', '', 'info'],
      ['alterations', '', 'info'],
    ])
  })

  it('c1 free height is the curved stair headroom under the roof, 1.965 m < 2.00 m', () => {
    // curvedInfo.head (pinned to v41 by the warnings golden test): the tightest
    // tread is under the south slope, roofY + F − t = 1.9655 m. downHead is
    // 2.3507 m and there is no spiral landing, so the roof limits it.
    const r = one(rs, 'stair-free-height', 'c1')
    expect(r.have).toBeCloseTo(1.965483, 6)
    expect(r.need).toBe(2)
    expect(r.params).toEqual({ limit: 'roof' })
    expect(r.ref).toBe('BFS 2024:9 2 kap. 25 §')
  })

  it('c1 stair geometry context: 12 risers of 2.58/12 = 0.215 m, going 0.24 m', () => {
    const r = one(rs, 'stair-geometry', 'c1')
    expect(r.params?.risers).toBe(12)
    expect(r.params?.rise).toBeCloseTo(0.215, 9)
    expect(r.params?.going).toBeCloseTo(0.24, 9)
  })

  it('roof-window sills are their `bottom` (1.00 m) and the gable sill 0.80 m — all ≤ 1.20 m', () => {
    for (const id of ['s1', 's2', 's3']) expect(one(rs, 'escape-window-sill', id)).toMatchObject({ have: 1, need: 1.2, status: 'ok' })
    const g = rows(rs, 'escape-window-sill').find((r) => r.params?.window === 'gable')
    expect(g).toMatchObject({ have: 0.8, status: 'ok' })
  })

  it('window size is unknown: a 78×118 frame is not the free opening', () => {
    expect(one(rs, 'escape-window-size', 's1').params).toMatchObject({ frameW: 0.78, frameH: 1.18, reason: 'frame-not-free-opening' })
  })

  it('storey area 8.50 × 2.87 = 24.395 m² ≤ 25 m²; zones floor (holes out) 23.18 m²', () => {
    const r = one(rs, 'floor-escape-door')
    expect(r.have).toBeCloseTo(24.395, 9)
    expect(r.need).toBe(ESCAPE_DOOR_AREA)
    expect(r.params?.branch).toBe('atMost')
    expect(r.params?.floorInsideKnee).toBeCloseTo(23.1827, 3)
  })

  it('room height is context only: 9.78 m² of 23.18 m² has ≥ 1.90 m', () => {
    const r = one(rs, 'room-height')
    expect(r.status).toBe('info')
    expect(r.params?.standArea).toBeCloseTo(9.7778, 3)
    expect(r.params?.standHeight).toBe(1.9)
  })

  it('cites only the new rules and never BBR', () => {
    for (const r of rs) expect(r.ref).toMatch(/^BFS 2024:[789] /)
    expect(RULES_SOURCE).toContain('BFS 2024:7 (as amended by BFS 2025:10)')
    expect(RULES_SOURCE).toContain('BBR was repealed 1 Oct 2026')
    expect(RULES_SOURCE).toContain('Guidance, not a permit decision.')
  })
})

describe('grading boundaries', () => {
  it('free height: exactly 2.00 is ok, 1.999 fails', () => {
    expect(gradeAtLeast(2.0, 2.0)).toBe('ok')
    expect(gradeAtLeast(1.999, 2.0)).toBe('fail')
  })
  it('sill: exactly 1.20 is ok, 1.201 fails', () => {
    expect(gradeAtMost(1.2, 1.2)).toBe('ok')
    expect(gradeAtMost(1.201, 1.2)).toBe('fail')
  })
  it('missing or non-finite values are unknown, never ok', () => {
    for (const v of [NaN, Infinity, -Infinity, undefined as unknown as number, '2' as unknown as number]) {
      expect(gradeAtLeast(v, 2)).toBe('unknown')
      expect(gradeAtMost(v, 1.2)).toBe('unknown')
    }
  })
})

describe('free height over the stairs (2 kap. 25 §)', () => {
  it('a straight stair whose roof clearance is exactly 2.00 m is ok', () => {
    const st = stairWithHead(2.0)
    expect(stairInfo(geo, st).minHead).toBeCloseTo(2.0, 12)
    expect(one(checkRules(geo, withItems([st])), 'stair-free-height', 'st')).toMatchObject({ status: 'ok', params: { limit: 'roof' } })
  })

  it('1.999 m fails', () => {
    const r = one(checkRules(geo, withItems([stairWithHead(1.999)])), 'stair-free-height', 'st')
    expect(r.status).toBe('fail')
    expect(r.have).toBeCloseTo(1.999, 9)
  })

  it('an ok stair in an insulated bay is downgraded to unknown (plasterboard sits lower)', () => {
    const st = stairWithHead(2.1) // x 2.4–3.6: bays 1 (1.2–2.42) and 2 (2.42–3.64)
    expect(one(checkRules(geo, withItems([st], { board: [2] })), 'stair-free-height', 'st')).toMatchObject({ status: 'unknown', params: { reason: 'boarded' } })
    expect(one(checkRules(geo, withItems([st], { board: [5] })), 'stair-free-height', 'st').status).toBe('ok')
    // a fail stays a fail: boarding only lowers the ceiling
    expect(one(checkRules(geo, withItems([stairWithHead(1.9)], { board: [2] })), 'stair-free-height', 'st').status).toBe('fail')
  })

  it('headroom that cannot be computed (NaN drop) is unknown, with no measured value', () => {
    const st = { ...stairWithHead(2.1), drop: NaN }
    const r = one(checkRules(geo, withItems([st])), 'stair-free-height', 'st')
    expect(r.status).toBe('unknown')
    expect(r.have).toBeUndefined()
  })

  it.each(FIXTURE_NAMES)('%s: curved/spiral rows use the worst of roof, landing and below headroom', (name) => {
    const { plan, geo: g } = goldPlan(name)
    const rs = checkRules(g, plan)
    for (const it of plan.items.filter(isUpStair)) {
      const c = curvedInfo(g, plan, it, new Set())
      const r = one(rs, 'stair-free-height', it.id)
      expect(r.have).toBe(Math.min(c.head, c.landingHead, c.downHead))
    }
  })

  it('spiral stairs: the landing clearance is the number behind spiral-landing-head', () => {
    const { plan, geo: g } = goldPlan('spiral')
    const sp = plan.items.filter((i) => i.type === 'spiral')
    expect(sp.length).toBeGreaterThan(0)
    for (const it of sp) {
      const c = curvedInfo(g, plan, it, new Set())
      const w = c.warn.find((x) => x.code === 'spiral-landing-head')
      if (w) expect(w.params.head).toBe(Math.round(c.landingHead * 100))
      else expect(c.landingHead >= 2.0).toBe(true)
    }
  })

  it('attic-custom: the old stairs under the new ones limit c1 (1.794 m, "below")', () => {
    const { plan, geo: g } = goldPlan('attic-custom')
    const r = one(checkRules(g, plan), 'stair-free-height', 'c1')
    expect(r).toMatchObject({ status: 'fail', params: { limit: 'below' } })
    expect(r.have).toBeCloseTo(1.793571, 5)
  })
})

describe('stair rows only when there are stairs', () => {
  it('no stairs: no stair rows at all', () => {
    const p = examplePlan()
    const rs = checkRules(geo, { ...p, items: p.items.filter((i) => i.type !== 'curved') })
    expect(rs.filter((r) => r.id.startsWith('stair-'))).toEqual([])
  })
  it('with stairs: one tread-gap row (unknown, 100 mm), whatever the number of stairs', () => {
    const rs = checkRules(geo, withItems([stairWithHead(2.1), { ...stairWithHead(2.1, 6), id: 'st2' }]))
    expect(rows(rs, 'stair-tread-gaps')).toEqual([{ id: 'stair-tread-gaps', ref: 'BFS 2024:9 2 kap. 6 §', status: 'unknown', need: 0.1, params: { reason: 'no-riser-data' } }])
    expect(rows(rs, 'stair-free-height')).toHaveLength(2)
  })
})

describe('escape windows (BFS 2024:7 2 kap. 26 §)', () => {
  const sky = (bottom: number, extra: Partial<Extract<Item, { type: 'skylight' }>> = {}): Item => ({ id: 'w', type: 'skylight', slope: 'S', bay: 1, size: '78×118', bottom, ...extra })
  const sill = (items: Item[], over: Partial<PlanV2['options']> = {}) => one(checkRules(geo, withItems(items, over)), 'escape-window-sill', 'w')

  it('sill exactly 1.20 m is ok, 1.201 m fails', () => {
    expect(sill([sky(1.2)])).toMatchObject({ status: 'ok', have: 1.2 })
    expect(sill([sky(1.201)])).toMatchObject({ status: 'fail', have: 1.201 })
  })

  it('a non-finite sill is unknown, never ok', () => {
    expect(sill([sky(NaN)]).status).toBe('unknown')
  })

  it('a window starting behind a kept knee wall is unknown; with that bay opened it is graded', () => {
    expect(geo.KNEE_H).toBeCloseTo(0.9418, 4)
    expect(sill([sky(0.5)]).params).toMatchObject({ reason: 'behind-knee-wall' })
    expect(sill([sky(0.5)]).status).toBe('unknown')
    expect(sill([sky(0.5)], { knee: { N: [], S: [1] } }).status).toBe('ok')
  })

  it('a window that gets no opening in the roof (overlaps another) is unknown', () => {
    const r = one(checkRules(geo, withItems([sky(1.0, { id: 'a' }), sky(1.0)])), 'escape-window-sill', 'w')
    expect(r).toMatchObject({ status: 'unknown', params: { reason: 'not-placed' } })
  })

  it('a gable window too small even as a frame fails the size rule; off means no gable rows', () => {
    const p = examplePlan()
    const small = checkRules(geo, { ...p, options: { ...p.options, gable: { ...p.options.gable, w: 0.45 } } })
    expect(rows(small, 'escape-window-size').find((r) => r.params?.window === 'gable')).toMatchObject({ status: 'fail', params: { reason: 'frame-too-small' } })
    // 0.7 + 0.7 = 1.4 < 1.5
    const sum = checkRules(geo, { ...p, options: { ...p.options, gable: { ...p.options.gable, w: 0.7, h: 0.7 } } })
    expect(rows(sum, 'escape-window-size').find((r) => r.params?.window === 'gable')?.status).toBe('fail')
    const off = checkRules(geo, { ...p, options: { ...p.options, gable: { ...p.options.gable, on: false } } })
    expect([...rows(off, 'escape-window-sill'), ...rows(off, 'escape-window-size')].some((r) => r.params?.window === 'gable')).toBe(false)
  })

  it('a gable sill of 1.25 m fails', () => {
    const p = examplePlan()
    const rs = checkRules(geo, { ...p, options: { ...p.options, gable: { ...p.options.gable, sill: 1.25 } } })
    expect(rows(rs, 'escape-window-sill').find((r) => r.params?.window === 'gable')?.status).toBe('fail')
  })
})

describe('storey area note (BFS 2024:7 7 kap. 16 §)', () => {
  const at = (len: number, knee: number, kneeBays: number[] = []) => {
    const g = deriveGeometry(atticOf({ ...ATTIC_DEF, len, knee }))
    const p = examplePlan(g.attic)
    const plan = { ...p, options: { ...p.options, knee: { N: kneeBays, S: [] } }, items: [] }
    return { r: one(checkRules(g, plan), 'floor-escape-door'), g, plan }
  }

  it('exactly 25 m² (10.0 × 2.5) takes the ≤ 25 m² branch', () => {
    const { r } = at(10, 2.5)
    expect(r.have).toBe(25)
    expect(r.params?.branch).toBe('atMost')
  })

  it('just over (10.004 × 2.5 = 25.01 m²) takes the > 25 m² branch', () => {
    expect(at(10.004, 2.5).r.params?.branch).toBe('over')
  })

  it('opened knee-wall bays add their floored eaves', () => {
    const { r, g, plan } = at(8.5, 2.87, [0])
    // bay 0 is 1.2 m wide; the eaves strip runs from KZ out to HALF
    expect(r.have).toBeCloseTo(8.5 * 2.87 + 1.2 * (g.HALF - g.KZ), 9)
    expect(storeyArea(g, plan)).toBe(r.have)
    expect(r.params?.branch).toBe('over')
  })
})

describe('informational rows', () => {
  it('are always info, carry no graded value, and alterations is always present', () => {
    const rs = checkRules(geo, examplePlan())
    for (const id of ['stair-geometry', 'stair-handrails', 'stair-guards', 'room-height', 'alterations']) for (const r of rows(rs, id)) expect(r.status).toBe('info')
    expect(one(rs, 'stair-guards').params).toMatchObject({ climbH: 0.8, gapMax: 0.1 })
    expect(checkRules(geo, withItems([])).at(-1)?.id).toBe('alterations')
  })
})
