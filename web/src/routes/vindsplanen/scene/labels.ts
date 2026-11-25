// Swedish text of the labels pinned in the 3D view (v41 lines 693–694,
// 1405–1422). Numbers arrive already worked out (whole cm).

import type { BelowDoor } from '../../../lib/vindsplanen/plan'

export const LABEL = {
  west: 'Väster · mot bostaden',
  east: 'Östra gaveln · trädgården',
  a1: (cm: number) => `A1 · ${cm} cm lång`,
  eaves: (cm: number) => `${cm} cm bred vid takfoten (uträknat)`,
  a2: (cm: number) => `A2 · ${cm} cm mellan knäväggarna`,
  a4: (cm: number) => `A4 · nock ${cm} cm`,
  a3: (cm: number) => `A3 · ${cm} cm`,
  bottomStep: (cm: number) => `nedersta steget ${cm} cm från västra gaveln`,
  b3: (cm: number) => `B3 · hall ${cm} cm`,
  plain: (cm: number) => `${cm} cm`,
  b4: (cm: number) => `B4 · trapphål ${cm} cm`,
  b5: (cm: number) => `B5 · ${cm} cm`,
  b6: (cm: number) => `B6 · ${cm} cm`,
  b1: (cm: number) => `B1 · takhöjd ${cm} cm`,
  b7: (cm: number) => `B7 · spaljé ${cm} cm`,
  door: (i: number, d: BelowDoor, at: number, w: number) =>
    `D${i + 1} · ${at} från ${d.wall === 'W' ? 'N' : 'Ö'} · ${w} bred`,
  /** A measuring step's dimension line (Stage 5 highlights). */
  step: (code: string, cm: number, sill?: boolean) => `${code} · ${sill ? `bröstning ${cm}` : `${cm} cm`}`,
}
