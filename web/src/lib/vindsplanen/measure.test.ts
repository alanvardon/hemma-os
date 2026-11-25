import { describe, expect, it } from 'vitest'
import { atticOf, deriveGeometry } from './attic'
import { applyMeasureStep, fieldDisplay, measureProgress, measureSteps, validateInputs, type MeasureStep } from './measure'
import { examplePlan } from './plan'
import { expectClose, FIXTURE_NAMES, goldPlan } from './testkit'

const valText = (st: MeasureStep) => st.fields.map((f) => (f.raw ? String(fieldDisplay(f)) : `${fieldDisplay(f)} cm`)).join(' · ')

describe('measureSteps — the registry, parity with v41 walkSteps', () => {
  it.each(FIXTURE_NAMES)('%s: codes, fields, camera, dimension lines, highlights', (name) => {
    const { gold, plan, geo } = goldPlan(name)
    const steps = measureSteps(geo, plan)
    expectClose(
      steps.map((s) => ({
        code: s.code,
        attic: s.attic,
        fields: s.fields.map((f) => ({ v: f.v, min: f.min, max: f.max, raw: !!f.raw, unit: f.unit ?? 'cm' })),
        cam: s.cam,
        dims: s.dims.map((d) => [d.a, d.b, d.sill ? `sill ${d.cm}` : `${d.cm} cm`]),
        boxes: s.boxes,
        hl: s.hl,
        valText: valText(s),
      })),
      gold.measure,
    )
  })

  it.each(FIXTURE_NAMES)('%s: "Save and next" writes what v41 setters write', (name) => {
    const { gold, plan, geo } = goldPlan(name)
    for (const g of gold.measureApply) {
      const out = applyMeasureStep(geo, plan, g.code, g.inputs, '2026-11-25')
      expect(out, g.code).not.toBeNull()
      if (!out) continue
      expect(out.options.measured[g.code]).toBe('2026-11-25')
      if (g.code[0] === 'A') expectClose(out.options.attic, g.attic, 1e-3, g.code)
      else {
        const below = { ...(g.below as Record<string, unknown>) }
        delete below.v
        expectClose(out.options.below, below, 1e-3, g.code)
        expectClose(out.options.gable, g.gable, 1e-3, g.code)
      }
    }
  })
})

describe('measure logic', () => {
  const plan = examplePlan()
  const geo = deriveGeometry(plan.options.attic)

  it('A1–A8, B1–B9, W1, W2, then one D step per door', () => {
    const codes = measureSteps(geo, plan).map((s) => s.code)
    expect(codes).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'W1', 'W2', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'])
  })

  it('progress counts measured codes; next is the first unmeasured, else the first', () => {
    const steps = measureSteps(geo, plan)
    expect(measureProgress(steps, {})).toEqual({ done: 0, total: 26, next: 0 })
    expect(measureProgress(steps, { A1: 'earlier', A2: '2026-01-01', X9: 'x' })).toEqual({ done: 2, total: 26, next: 2 })
    expect(measureProgress(steps, Object.fromEntries(steps.map((s) => [s.code, 'earlier']))).next).toBe(0)
  })

  it('rejects a value outside the field range, or not a number, and changes nothing', () => {
    const st = measureSteps(geo, plan).find((s) => s.code === 'B1') as MeasureStep
    expect(validateInputs(st, [179])).toEqual([false])
    expect(validateInputs(st, [Number.NaN])).toEqual([false])
    expect(validateInputs(st, [180])).toEqual([true])
    expect(applyMeasureStep(geo, plan, 'B1', [400], '2026-11-25')).toBeNull()
    expect(applyMeasureStep(geo, plan, 'Q1', [1], '2026-11-25')).toBeNull()
  })

  it('B2 sets the slab from the floor-to-floor height, clamped to 10–60 cm', () => {
    const out = applyMeasureStep(geo, plan, 'B2', [300], '2026-11-25')
    expect(out?.options.below.slab).toBeCloseTo(0.6, 12)
    expect(plan.options.below.slab).toBe(0.28) // input untouched
  })

  it('an attic step re-derives the geometry and re-sanitizes like v41 reloading', () => {
    const out = applyMeasureStep(geo, plan, 'A1', [700], '2026-11-25')
    expect(out?.options.attic.len).toBe(7)
    expect(out?.options.attic).toEqual(atticOf(out?.options.attic))
    // the desk at x 8.15 no longer fits inside a 7 m attic: clamped like a v41 reload would
    expect(out?.items.find((i) => i.id === 'k1')).toMatchObject({ x: 7 })
  })

  it('a door step turns "edge + width" into the door centre', () => {
    const out = applyMeasureStep(geo, plan, 'D1', [150, 90], '2026-11-25')
    expect(out?.options.below.doors[0]).toMatchObject({ at: 1.95, w: 0.9 })
  })
})
