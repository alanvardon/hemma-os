// Headroom zones on the attic floor (v41 `computeZones`, line 1003): a 5 cm
// grid classified as standing height (≥ 1.9 m), "BOA" floor (counts toward
// living area: within 60 cm of where standing height begins) or neither, with
// stair openings cut out. The scene paints the grid; this returns it.

import { ceilAt, roofY, type Geometry } from './attic'
import { pip, stairHoles } from './stairs'
import type { PlanV2 } from './plan'

export const ZONE_NONE = 0
export const ZONE_HOLE = 1
export const ZONE_STAND = 2
export const ZONE_BOA = 3

export interface ZoneSegment {
  /** Room bounds along x, between partition walls. */
  a: number
  b: number
  /** Cell counts. */
  stand: number
  boa: number
}

export interface Zones {
  nx: number
  nz: number
  dx: number
  dz: number
  /** Row-major (j * nx + i), j = 0 at z = −KZ; one of the ZONE_* values. */
  cells: Uint8Array
  /** Cell counts over the whole floor. */
  floor: number
  stand: number
  boa: number
  /** Area of one cell, m². */
  cellArea: number
  segs: ZoneSegment[]
}

export function zoneGrid(geo: Geometry): { nx: number; nz: number; dx: number; dz: number } {
  const nx = Math.round(geo.L / 0.05)
  const nz = Math.ceil((2 * geo.KZ) / 0.05)
  return { nx, nz, dx: geo.L / nx, dz: (2 * geo.KZ) / nz }
}

export function computeZones(geo: Geometry, plan: Pick<PlanV2, 'items' | 'options'>): Zones {
  const { L, KZ, HALF, SLOPE, STAND } = geo
  const { nx, nz, dx, dz } = zoneGrid(geo)
  const board = plan.options.board
  const cells = new Uint8Array(nx * nz)
  const holes = stairHoles(geo, plan, KZ).holes
  const walls = plan.items.flatMap((i) => (i.type === 'wall' ? [i.x] : [])).sort((a, b) => a - b)
  const bounds = [0, ...walls, L]
  const segs: ZoneSegment[] = bounds.slice(0, -1).map((a, i) => ({ a, b: bounds[i + 1], stand: 0, boa: 0 }))
  let floor = 0
  let stand = 0
  let boa = 0
  for (let j = 0; j < nz; j++) {
    const z = -KZ + (j + 0.5) * dz
    for (let i = 0; i < nx; i++) {
      const x = (i + 0.5) * dx
      const k = j * nx + i
      const y = ceilAt(geo, board, x, z)
      const drop = roofY(geo, z) - y
      if (holes.some((h) => pip(h, x, z))) {
        cells[k] = ZONE_HOLE
        continue
      }
      floor++
      const seg = segs.find((s) => x >= s.a && x < s.b) || segs[segs.length - 1]
      if (y >= STAND) {
        stand++
        boa++
        seg.stand++
        seg.boa++
        cells[k] = ZONE_STAND
      } else if (Math.abs(z) <= Math.min(KZ, HALF - (STAND + drop) / SLOPE + 0.6)) {
        boa++
        seg.boa++
        cells[k] = ZONE_BOA
      } else cells[k] = ZONE_NONE
    }
  }
  return { nx, nz, dx, dz, cells, floor, stand, boa, cellArea: dx * dz, segs }
}
