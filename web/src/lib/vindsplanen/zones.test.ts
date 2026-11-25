import { describe, expect, it } from 'vitest'
import { ATTIC_DEF, deriveGeometry } from './attic'
import { examplePlan } from './plan'
import { computeZones, ZONE_BOA, ZONE_HOLE, ZONE_STAND } from './zones'
import { FIXTURE_NAMES, goldPlan } from './testkit'

describe('computeZones — parity with v41 (5 cm grid)', () => {
  it.each(FIXTURE_NAMES)('%s: every cell, the floor totals and each room', (name) => {
    const { gold, plan, geo } = goldPlan(name)
    const z = computeZones(geo, plan)
    expect([z.nx, z.nz]).toEqual([gold.zones.nx, gold.zones.nz])
    // v41 paints openings and "neither" alike (transparent)
    const cells = Array.from(z.cells, (c) => (c === ZONE_STAND ? 'S' : c === ZONE_BOA ? 'B' : '.')).join('')
    expect(cells).toBe(gold.zones.cells)
    const f = (v: number) => (v * z.cellArea).toFixed(1)
    expect([f(z.floor), f(z.stand), f(z.boa)]).toEqual([gold.zones.floor, gold.zones.stand, gold.zones.boa])
    expect(z.segs.map((s, i) => `Room ${i + 1} · ${s.a.toFixed(2)}–${s.b.toFixed(2)} m${f(s.boa)} m² · ${f(s.stand)} m² standing`)).toEqual(gold.zones.rooms)
  })
})

describe('zones, hand-checked', () => {
  it('stair openings are holes and are not counted as floor', () => {
    const geo = deriveGeometry(ATTIC_DEF)
    const z = computeZones(geo, examplePlan())
    const holes = Array.from(z.cells).filter((c) => c === ZONE_HOLE).length
    expect(holes).toBeGreaterThan(0)
    expect(z.floor + holes).toBe(z.nx * z.nz)
    expect(z.stand).toBeLessThanOrEqual(z.boa)
  })

  it('standing height runs to where the roof is 1.9 m (z = ±Z190)', () => {
    const geo = deriveGeometry(ATTIC_DEF)
    const z = computeZones(geo, { ...examplePlan(), items: [] })
    const col = Array.from({ length: z.nz }, (_, j) => z.cells[j * z.nx + 10])
    const standRows = col.map((c, j) => (c === ZONE_STAND ? -geo.KZ + (j + 0.5) * z.dz : null)).filter((v): v is number => v !== null)
    expect(Math.max(...standRows)).toBeLessThanOrEqual(geo.Z190)
    expect(Math.max(...standRows)).toBeGreaterThan(geo.Z190 - z.dz)
  })
})
