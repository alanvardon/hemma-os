import { describe, expect, it } from 'vitest'
import { skyHolesOk } from './items'
import { isUpStair, stairHoles } from './stairs'
import { curvedInfo, INFO_CODES, planWarnings, realWarnings, skyInfo, stairInfo, wallInfo, type Warning } from './warnings'
import { englishWarning, expectClose, FIXTURE_NAMES, goldPlan } from './testkit'

describe('planWarnings — parity with v41 rebuildAll', () => {
  it.each(FIXTURE_NAMES)('%s: same warnings, same numbers, same order', (name) => {
    const { gold, plan, geo } = goldPlan(name)
    const ours = planWarnings(geo, plan)
    const rendered = Object.fromEntries(Object.entries(ours).map(([id, ws]) => [id, ws.map(englishWarning)]))
    expect(rendered).toEqual(gold.warnings)
  })

  it('the fixtures exercise every warning code', () => {
    const seen = new Set<string>()
    for (const name of FIXTURE_NAMES) {
      const { plan, geo } = goldPlan(name)
      Object.values(planWarnings(geo, plan)).flat().forEach((w) => seen.add(w.code))
    }
    // unreachable within sanitize's ranges: rise = drop / round(drop / 0.18) stays ≤ ~19 cm for drop 1.8–3.5 m
    const unreached = ['stairs-steep-rise']
    const all = [
      'furn-roof-clash', 'furn-outside', 'wall-door-low', 'wall-on-rafter', 'sky-wider-than-bay', 'sky-reaches-ridge', 'sky-overlap',
      'stairs-outside', 'stairs-steep-rise', 'stairs-too-steep', 'stairs-shallow', 'stairs-low-head', 'up-walkway-narrow', 'up-outside-hall',
      'up-over-well', 'up-low-head', 'up-down-head', 'up-knee-wall', 'up-hole-clash', 'spiral-landing-head', 'spiral-shallow', 'up-steep-rise',
      'up-door-blocked', 'storage-hole-overlap', 'storage-low-front', 'closet-hole-overlap', 'closet-door-low', 'closet-shallow',
    ]
    const missing = all.filter((c) => !seen.has(c))
    expect(missing).toEqual(unreached)
  })
})

describe('the numbers behind the warnings', () => {
  it.each(FIXTURE_NAMES)('%s: curved/spiral headroom, down-headroom and walk-past width', (name) => {
    const { gold, plan, geo } = goldPlan(name)
    const clash = stairHoles(geo, plan, geo.KZ).clash
    for (const it of plan.items.filter(isUpStair)) {
      const c = curvedInfo(geo, plan, it, clash)
      const g = gold.info[it.id]
      expectClose({ head: c.head, downHead: c.downHead, minFree: c.minFree }, { head: g.head, downHead: g.downHead, minFree: g.minFree }, 1e-3, it.id)
    }
  })

  it.each(FIXTURE_NAMES)('%s: straight-stair rise, going, Blondel and headroom', (name) => {
    const { gold, plan, geo } = goldPlan(name)
    for (const it of plan.items) {
      if (it.type !== 'stairs') continue
      const s = stairInfo(geo, it)
      const g = gold.info[it.id]
      expectClose({ n: s.n, rise: s.rise, going: s.going, blondel: s.blondel, minHead: s.minHead }, { n: g.n, rise: g.rise, going: g.going, blondel: g.blondel, minHead: g.minHead })
    }
  })

  it.each(FIXTURE_NAMES)('%s: roof window positions on the slope', (name) => {
    const { gold, plan, geo } = goldPlan(name)
    const ok = skyHolesOk(geo, plan.items)
    for (const it of plan.items) {
      if (it.type !== 'skylight') continue
      const s = skyInfo(geo, it, ok)
      const g = gold.info[it.id]
      expectClose({ sBot: s.sBot, sTop: s.sTop, topY: s.topY, bay: s.bay }, { sBot: g.sBot, sTop: g.sTop, topY: g.topY, bay: g.bay })
    }
  })
})

describe('warning shape', () => {
  it('params are numbers in whole cm (or v41-rounded) and strings only for door walls', () => {
    const { plan, geo } = goldPlan('straight')
    const ws = Object.values(planWarnings(geo, plan)).flat()
    const door = ws.find((w) => w.code === 'up-door-blocked') as Warning
    expect(door.params).toEqual({ count: 2, walls: 'S,S' })
    const low = ws.find((w) => w.code === 'wall-door-low') as Warning
    expect(low.params).toEqual({ h: 90 })
    const steep = ws.find((w) => w.code === 'stairs-too-steep') as Warning
    expect(Number.isInteger(steep.params.blondel)).toBe(true)
  })

  it('the rafter-line note is information, not a warning (v41 realWarn)', () => {
    expect(INFO_CODES.has('wall-on-rafter')).toBe(true)
    expect(realWarnings([{ code: 'wall-on-rafter', params: {} }, { code: 'furn-outside', params: {} }])).toEqual([{ code: 'furn-outside', params: {} }])
  })

  it('a door near the knee wall is clamped and reported at its real height', () => {
    const { plan, geo } = goldPlan('straight')
    const w = plan.items.find((i) => i.id === 'w3')
    if (w?.type !== 'wall') throw new Error('fixture')
    const info = wallInfo(geo, w)
    expect(info.zc).toBeCloseTo(geo.KZ - 0.45, 12)
    expect(info.dh).toBeLessThan(1.9)
  })
})
