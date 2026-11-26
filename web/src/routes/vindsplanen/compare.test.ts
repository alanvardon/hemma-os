import { describe, expect, it } from 'vitest'
import { deriveGeometry } from '../../lib/vindsplanen/attic'
import { examplePlan } from '../../lib/vindsplanen/plan'
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
