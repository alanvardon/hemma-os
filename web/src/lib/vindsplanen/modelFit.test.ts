import { describe, expect, it } from 'vitest'
import { FURNITURE_DEFAULTS } from './items'
import { fitModel, MAX_DISTORTION, MODEL_VARIANTS, variantsFor, type ModelVariant } from './modelFit'

const target = (t: { w: number; h: number; d: number }): [number, number, number] => [t.w, t.h, t.d]

function expectFit(got: ReturnType<typeof fitModel>, id: string, scale: [number, number, number], distortion: number) {
  expect(got).not.toBeNull()
  expect(got!.id).toBe(id)
  got!.scale.forEach((s, i) => expect(s).toBeCloseTo(scale[i], 5))
  expect(got!.distortion).toBeCloseTo(distortion, 5)
}

describe('fitModel', () => {
  it('limits the stretch to ln(1.4)', () => {
    expect(MAX_DISTORTION).toBeCloseTo(0.336472, 6)
  })

  it('fits the default desk 1.2 × 0.75 × 0.6', () => {
    // desk.glb is 1.134 × 0.800 × 0.706:
    // x 1.2/1.134 = 1.058201 (ln 0.056570), y 0.75/0.8 = 0.937500 (ln −0.064539),
    // z 0.6/0.706 = 0.849858 (ln −0.162686) → distortion 0.162686
    expect(FURNITURE_DEFAULTS.desk).toEqual({ w: 1.2, d: 0.6, h: 0.75 })
    expectFit(fitModel(variantsFor('desk'), target(FURNITURE_DEFAULTS.desk)), 'desk', [1.058201, 0.9375, 0.849858], 0.162686)
  })

  it('fits the default sofa 2.0 × 0.82 × 0.9: its depth stretches 36.8 %, under the 40 % limit', () => {
    // sofa-classic.glb is 1.571 × 0.797 × 0.658:
    // x 2.0/1.571 = 1.273074 (ln 0.241435), y 0.82/0.797 = 1.028858 (ln 0.028450),
    // z 0.9/0.658 = 1.367781 (ln 0.313190 ≤ 0.336472) → distortion 0.313190
    expect(FURNITURE_DEFAULTS.sofa).toEqual({ w: 2.0, d: 0.9, h: 0.82 })
    expectFit(fitModel(variantsFor('sofa'), target(FURNITURE_DEFAULTS.sofa)), 'sofa-classic', [1.273074, 1.028858, 1.367781], 0.31319)
  })

  it('fits a 1.8 × 0.82 × 0.8 sofa', () => {
    // x 1.8/1.571 = 1.145767 (ln 0.136074), y 1.028858 (ln 0.028450),
    // z 0.8/0.658 = 1.215805 (ln 0.195407) → distortion 0.195407
    expectFit(fitModel(variantsFor('sofa'), [1.8, 0.82, 0.8]), 'sofa-classic', [1.145767, 1.028858, 1.215805], 0.195407)
  })

  it('keeps the box for a 3 m sofa', () => {
    // x 3.0/1.571 = 1.909612 (ln 0.646900) → null
    expect(fitModel(variantsFor('sofa'), [3.0, 0.82, 0.75])).toBeNull()
  })

  it('keeps the box for the default dresser 0.8 × 0.8 × 0.45: the model is a wide sideboard', () => {
    // dresser-painted.glb is 1.195 × 1.182 × 0.617:
    // x 0.8/1.195 = 0.669456 (ln −0.401290) → null
    expect(FURNITURE_DEFAULTS.dresser).toEqual({ w: 0.8, d: 0.45, h: 0.8 })
    expect(fitModel(variantsFor('dresser'), target(FURNITURE_DEFAULTS.dresser))).toBeNull()
  })

  it('fits a sideboard-sized dresser 1.2 × 1.0 × 0.5', () => {
    // x 1.2/1.195 = 1.004184 (ln 0.004175), y 1.0/1.182 = 0.846024 (ln −0.167208),
    // z 0.5/0.617 = 0.810373 (ln −0.210261) → distortion 0.210261
    expectFit(fitModel(variantsFor('dresser'), [1.2, 1.0, 0.5]), 'dresser-painted', [1.004184, 0.846024, 0.810373], 0.210261)
  })

  it('fits the default nightstand 0.45 × 0.5 × 0.4 with the lighter side table', () => {
    // nightstand-light.glb 0.550 × 0.551 × 0.450: x 0.818182 (ln −0.200671),
    //   y 0.907441 (ln −0.097127), z 0.888889 (ln −0.117783) → 0.200671
    // nightstand.glb 0.505 × 0.616 × 0.509: x 0.891089 (ln −0.115311),
    //   y 0.811688 (ln −0.208639), z 0.785855 (ln −0.240983) → 0.240983
    // → nightstand-light wins
    expect(FURNITURE_DEFAULTS.nightstand).toEqual({ w: 0.45, d: 0.4, h: 0.5 })
    expectFit(fitModel(variantsFor('nightstand'), target(FURNITURE_DEFAULTS.nightstand)), 'nightstand-light', [0.818182, 0.907441, 0.888889], 0.200671)
  })

  it('picks the painted nightstand when it fits better', () => {
    // 0.5 × 0.62 × 0.5: nightstand-light → max(0.095310, 0.117985, 0.105361) = 0.117985;
    // nightstand → x 0.990099 (ln −0.009950), y 1.006494 (ln 0.006473), z 0.982318 (ln −0.017840) → 0.017840
    expectFit(fitModel(variantsFor('nightstand'), [0.5, 0.62, 0.5]), 'nightstand', [0.990099, 1.006494, 0.982318], 0.01784)
  })

  it('returns an exact fit at scale 1', () => {
    const v = MODEL_VARIANTS.find((m) => m.id === 'desk')!
    expectFit(fitModel([v], [...v.size]), 'desk', [1, 1, 1], 0)
  })

  it('has no model for beds, wardrobes or rugs', () => {
    expect(variantsFor('bed')).toEqual([])
    expect(variantsFor('wardrobe')).toEqual([])
    expect(variantsFor('rug')).toEqual([])
  })

  it('returns null for an empty list', () => {
    expect(fitModel([], [1.2, 0.75, 0.6])).toBeNull()
  })

  it('returns null, without throwing, for a zero, negative, NaN or infinite target', () => {
    const desk = variantsFor('desk')
    expect(fitModel(desk, [0, 0.75, 0.6])).toBeNull()
    expect(fitModel(desk, [1.2, -0.75, 0.6])).toBeNull()
    expect(fitModel(desk, [1.2, Number.NaN, 0.6])).toBeNull()
    expect(fitModel(desk, [1.2, 0.75, Number.POSITIVE_INFINITY])).toBeNull()
  })

  it('skips a variant with a broken size', () => {
    const broken: ModelVariant = { id: 'broken', type: 'desk', file: 'x.glb', size: [0, 0.8, 0.7] }
    expect(fitModel([broken], [1.2, 0.75, 0.6])).toBeNull()
    expect(fitModel([broken, ...variantsFor('desk')], [1.2, 0.75, 0.6])?.id).toBe('desk')
  })

  it('accepts a stretch of exactly 40 %', () => {
    const v: ModelVariant = { id: 'unit', type: 'desk', file: 'x.glb', size: [1, 1, 1] }
    expect(fitModel([v], [1.4, 1, 1])?.id).toBe('unit')
    expect(fitModel([v], [1.41, 1, 1])).toBeNull()
  })
})
