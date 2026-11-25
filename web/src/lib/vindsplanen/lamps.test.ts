import { describe, expect, it } from 'vitest'
import { ATTIC_DEF, deriveGeometry } from './attic'
import { lampSpots, MAX_LAMPS, type LampSpot } from './lamps'
import { examplePlan, type FurnitureItem, type Item } from './plan'

// The default attic (ATTIC_DEF): L 8.5, ridge H 2.6, KZ 1.435, knee 0.9418
// → HALF = 2.6 · 1.435 / (2.6 − 0.9418) = 2.25003, SLOPE = H / HALF = 1.15554,
// so roofY(z) = (2.25003 − |z|) · 1.15554.
const geo = deriveGeometry(ATTIC_DEF)

function expectSpots(actual: LampSpot[], expected: LampSpot[]) {
  expect(actual.map((s) => s.kind)).toEqual(expected.map((s) => s.kind))
  actual.forEach((s, i) => s.at.forEach((v, k) => expect(v).toBeCloseTo(expected[i].at[k], 4)))
}

const furn = (type: FurnitureItem['type'], id: string, x: number, z: number, rot: number, w: number, d: number, h: number): FurnitureItem => ({ id, type, x, z, rot, w, d, h })

describe('lampSpots', () => {
  it('the example plan: two room pendants, both bedside lamps and the desk lamp', () => {
    expectSpots(lampSpots(geo, examplePlan().items), [
      // wall w1 at x 4.8 splits the attic into rooms 0–4.8 and 4.8–8.5; a
      // pendant hangs mid-room on the ridge line at min(2.6 − 0.45, 2.2) = 2.15
      { kind: 'pendant', at: [2.4, 2.15, 0] },
      { kind: 'pendant', at: [6.65, 2.15, 0] },
      // n1/n2: nightstand top 0.5 + 0.35; roofY(1.07) − 0.15 = 1.2135 does not cap it
      { kind: 'table', at: [0.25, 0.85, -1.07] },
      { kind: 'table', at: [0.25, 0.85, 1.07] },
      // k1: desk top 0.75 + 0.45 on the ridge line (roof 2.6 above)
      { kind: 'table', at: [8.15, 1.2, 0] },
    ])
  })

  it('no items: only the one pendant, mid-attic', () => {
    expectSpots(lampSpots(geo, []), [{ kind: 'pendant', at: [4.25, 2.15, 0] }])
  })

  it('a sofa gets a floor lamp past its right arm, near its back, turned with the sofa', () => {
    // rot 90: local (w/2 + 0.25, −d/2 + 0.25) = (1.25, −0.2) → x 3 − 0.2 = 2.8,
    // z 0.5 − 1.25 = −0.75; roofY(0.75) − 0.15 = 1.5833 leaves it at 1.45
    expectSpots(lampSpots(geo, [furn('sofa', 'so', 3, 0.5, 90, 2, 0.9, 0.82)]), [
      { kind: 'pendant', at: [4.25, 2.15, 0] },
      { kind: 'floor', at: [2.8, 1.45, -0.75] },
    ])
  })

  it('keeps a floor lamp inside the gables and a bulb under the roof slope', () => {
    // rot 180 at x 1: the lamp would stand at x 1 − 1.25 = −0.25, so it is
    // kept at 0.15; z 0 + 0.2 = 0.2
    // the 0.8 m nightstand at z 1.35: 0.8 + 0.35 = 1.15 > roofY(1.35) − 0.15 = 0.8900
    expectSpots(lampSpots(geo, [furn('sofa', 'so', 1, 0, 180, 2, 0.9, 0.82), furn('nightstand', 'ns', 6, 1.35, 0, 0.45, 0.4, 0.8)]), [
      { kind: 'pendant', at: [4.25, 2.15, 0] },
      { kind: 'floor', at: [0.15, 1.45, 0.2] },
      { kind: 'table', at: [6, 0.89003, 1.35] },
    ])
  })

  it('a low ridge lowers the pendants with it', () => {
    const low = deriveGeometry({ ...ATTIC_DEF, ridge: 2.4 })
    expect(lampSpots(low, [])[0].at[1]).toBeCloseTo(1.95, 6)
  })

  it('more than six candidates: the room pendants first, then the small lamps in plan order', () => {
    const items: Item[] = [
      ...examplePlan().items.filter((i) => i.type !== 'wall'),
      { id: 'wa', type: 'wall', x: 6, door: true, doorZ: 0 },
      { id: 'wb', type: 'wall', x: 2, door: true, doorZ: 0 },
      { id: 'wc', type: 'wall', x: 4, door: true, doorZ: 0 },
    ]
    const spots = lampSpots(geo, items)
    expect(spots).toHaveLength(MAX_LAMPS)
    // walls sorted to 2, 4, 6 → rooms 0–2, 2–4, 4–6, 6–8.5; then n1, n2 fill the cap and the desk is left out
    expectSpots(spots, [
      { kind: 'pendant', at: [1, 2.15, 0] },
      { kind: 'pendant', at: [3, 2.15, 0] },
      { kind: 'pendant', at: [5, 2.15, 0] },
      { kind: 'pendant', at: [7.25, 2.15, 0] },
      { kind: 'table', at: [0.25, 0.85, -1.07] },
      { kind: 'table', at: [0.25, 0.85, 1.07] },
    ])
  })
})
