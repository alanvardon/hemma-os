// English text of the labels pinned in the 3D view (v41 lines 693–694,
// 1405–1422). Numbers arrive already worked out (whole cm).

import type { BelowDoor } from '../../../lib/vindsplanen/plan'

export const LABEL = {
  west: 'West · next to living space',
  east: 'East gable · garden',
  a1: (cm: number) => `A1 · ${cm} cm long`,
  eaves: (cm: number) => `${cm} cm wide at the eaves (worked out)`,
  a2: (cm: number) => `A2 · ${cm} cm between knee walls`,
  a4: (cm: number) => `A4 · ridge ${cm} cm`,
  a3: (cm: number) => `A3 · ${cm} cm`,
  bottomStep: (cm: number) => `bottom step ${cm} cm from west gable`,
  b3: (cm: number) => `B3 · hallway ${cm} cm`,
  plain: (cm: number) => `${cm} cm`,
  b4: (cm: number) => `B4 · stairwell ${cm} cm`,
  b5: (cm: number) => `B5 · ${cm} cm`,
  b6: (cm: number) => `B6 · ${cm} cm`,
  b1: (cm: number) => `B1 · ceiling ${cm} cm`,
  b7: (cm: number) => `B7 · screen ${cm} cm`,
  door: (i: number, d: BelowDoor, at: number, w: number) =>
    `D${i + 1} · ${at} from ${d.wall === 'W' ? 'N' : 'E'} · ${w} wide`,
  /** A measuring step's dimension line (Stage 5 highlights). */
  step: (code: string, cm: number, sill?: boolean) => `${code} · ${sill ? `sill ${cm}` : `${cm} cm`}`,
}
