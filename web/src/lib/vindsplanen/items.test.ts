import { describe, expect, it } from 'vitest'
import { ADD_ORDER, closetFittedSize, closetGeom, gableWindowFit, makeItem, skyHolesOk, skyRect, storageFit, storageGeom, withFittedClosets } from './items'
import { expectClose, FIXTURE_NAMES, goldPlan } from './testkit'

describe('makeItem — v41 defaults for every type, against this plan', () => {
  it.each(FIXTURE_NAMES)('%s', (name) => {
    const { gold, plan, geo } = goldPlan(name)
    for (const t of ADD_ORDER) {
      const { id, ...rest } = makeItem(geo, plan, t, 'new')
      expect(id).toBe('new')
      expectClose(rest, gold.makeItems[t], 1e-3, t)
    }
  })
})

describe('roof windows, gable window — parity with v41', () => {
  it.each(FIXTURE_NAMES)('%s: which windows get an opening, and their rectangles', (name) => {
    const { gold, plan, geo } = goldPlan(name)
    expect([...skyHolesOk(geo, plan.items)].sort()).toEqual([...gold.skyHoleOk].sort())
    for (const it of plan.items) if (it.type === 'skylight') expectClose(skyRect(geo, it), gold.info[it.id].rect, 1e-3, it.id)
    expect(gableWindowFit(geo, plan.options.gable).fits).toBe(gold.gableFit)
  })
})

describe('storage room and closet geometry — parity with v41', () => {
  it.each(FIXTURE_NAMES)('%s', (name) => {
    const { gold, plan, geo } = goldPlan(name)
    for (const it of plan.items) {
      if (it.type === 'storage') {
        const S = storageGeom(geo, plan, it)
        const g = { ...gold.info[it.id] }
        const fit = g.fit
        delete g.fit
        expectClose(S, g, 1e-3, it.id)
        expectClose(storageFit(geo, plan, it.side), fit, 1e-3, `${it.id} fit`)
      } else if (it.type === 'closet') expectClose(closetGeom(geo, plan, it), gold.info[it.id], 1e-3, it.id)
    }
  })

  it.each(FIXTURE_NAMES)('%s: a fitted closet stores the size v41 writes back on each rebuild', (name) => {
    const { gold, plan, geo } = goldPlan(name)
    const after = withFittedClosets(geo, plan)
    for (const it of after.items) {
      if (it.type !== 'closet') continue
      const g = gold.afterBuild.items.find((i) => i.id === it.id)
      expect({ d: it.d, len: it.len }, it.id).toEqual({ d: g?.d, len: g?.len })
    }
  })

  it('an unfitted closet keeps its own size', () => {
    const { plan, geo } = goldPlan('spiral')
    const cl = plan.items.find((i) => i.id === 'cl2')
    if (cl?.type !== 'closet') throw new Error('fixture')
    expect(closetFittedSize(geo, plan, cl)).toBeNull()
    expect(closetGeom(geo, plan, cl).d).toBe(0.3)
  })

  it('withFittedClosets returns the same object when nothing changes', () => {
    const { plan, geo } = goldPlan('example')
    expect(withFittedClosets(geo, plan)).toBe(plan)
  })
})
