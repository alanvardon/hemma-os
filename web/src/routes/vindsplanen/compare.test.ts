import { describe, expect, it } from 'vitest'
import { deriveGeometry } from '../../lib/vindsplanen/attic'
import { examplePlan, PRICES_NONE } from '../../lib/vindsplanen/plan'
import { quantities } from '../../lib/vindsplanen/quantities'
import { planWarnings, realWarnings } from '../../lib/vindsplanen/warnings'
import { computeZones } from '../../lib/vindsplanen/zones'
import { summarizeVariant } from './compare'

describe('summarizeVariant', () => {
  it('matches the open plan stats and item list for the example plan', () => {
    const plan = examplePlan()
    const geo = deriveGeometry(plan.options.attic)
    const z = computeZones(geo, plan)
    const w = planWarnings(geo, plan)
    const s = summarizeVariant(plan)
    expect(s.floor).toBeCloseTo(z.floor * z.cellArea, 9)
    expect(s.stand).toBeCloseTo(z.stand * z.cellArea, 9)
    expect(s.boa).toBeCloseTo(z.boa * z.cellArea, 9)
    expect(s.warnings).toBe(Object.values(w).reduce((n, ws) => n + realWarnings(ws).length, 0))
    // the example: one turning stair and three roof windows
    expect(s.stairs).toBe(1)
    expect(s.windows).toBe(3)
    expect(s.floor).toBeGreaterThan(s.stand)
  })

  it('counts an empty plan as no stairs, windows or warnings', () => {
    const plan = { ...examplePlan(), items: [] }
    expect(summarizeVariant(plan)).toMatchObject({ stairs: 0, windows: 0, warnings: 0 })
  })

  it('differs between two variants that differ', () => {
    const a = examplePlan()
    const b = { ...a, items: a.items.filter((i) => i.type !== 'skylight') }
    expect(summarizeVariant(a).windows - summarizeVariant(b).windows).toBe(3)
  })
})

describe('summarizeVariant — estimated cost (plan 150)', () => {
  const priced = { floor: 400, panel: 300, walls: 200, insulation: null }
  it('is null while a line with area has no price, and ignores a 0 m² line', () => {
    const plan = examplePlan()
    expect(summarizeVariant({ ...plan, prices: { floor: 400, panel: null, walls: 200, insulation: null } }).cost).toBeNull()
    const q = quantities(deriveGeometry(plan.options.attic), plan)
    // example plan: nothing insulated, so the insulation price is not needed
    expect(q.insulation).toBe(0)
    expect(summarizeVariant({ ...plan, prices: priced }).cost).toBeCloseTo(q.floor * 400 + q.panel * 300 + q.walls * 200, 9)
  })

  it('uses each variant’s own prices', () => {
    const a = { ...examplePlan(), prices: priced }
    const b = { ...a, prices: { ...priced, floor: 800 } }
    const q = quantities(deriveGeometry(a.options.attic), a)
    expect(summarizeVariant(b).cost! - summarizeVariant(a).cost!).toBeCloseTo(q.floor * 400, 9)
  })

  it('is null when no prices are entered', () => {
    expect(summarizeVariant({ ...examplePlan(), prices: { ...PRICES_NONE } }).cost).toBeNull()
  })
})
