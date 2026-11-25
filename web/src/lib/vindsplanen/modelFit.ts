// Which CC0 furniture model stands in for a box item, and how it is scaled
// (plan 142). Pure: no three.js. The models live in
// public/vindsplanen/models/ (see ASSETS.md there): Y-up, metres, origin at
// the floor centre of the footprint, front facing +z.
//
// Axis convention: an item's w runs along its local x, h up y and d along its
// local z, with its front at +z — the same as the procedural boxes in
// itemsScene.ts (the sofa's back and the desk's rail at −z, drawer and door
// fronts at +z). The item's `rot` turns the whole group, so a model sits in
// the group unrotated and only scales per axis.

import type { FurnitureType } from './items'

export interface ModelVariant {
  id: string
  type: FurnitureType
  /** The .glb under public/vindsplanen/models/. */
  file: string
  /** Measured size of the model as committed: [w (x), h (y), d (z)] in metres. */
  size: readonly [w: number, h: number, d: number]
}

export interface ModelFit {
  id: string
  /** Per-axis scale [x, y, z] that brings the model to the target size. */
  scale: [number, number, number]
  /** max over the axes of |ln(scale)|: 0 for an exact fit. */
  distortion: number
}

/** Beyond this the box is kept: no axis may stretch or squash by more than 40 % (the default 2.0 × 0.9 m sofa needs 36.8 % depth). */
export const MAX_DISTORTION = Math.log(1.4)

/** The committed models (ASSETS.md, plan 142). Beds, wardrobes and rugs stay procedural. */
export const MODEL_VARIANTS: readonly ModelVariant[] = Object.freeze([
  { id: 'sofa-classic', type: 'sofa', file: 'sofa-classic.glb', size: [1.571, 0.797, 0.658] },
  { id: 'desk', type: 'desk', file: 'desk.glb', size: [1.134, 0.8, 0.706] },
  { id: 'dresser-painted', type: 'dresser', file: 'dresser-painted.glb', size: [1.195, 1.182, 0.617] },
  { id: 'nightstand-light', type: 'nightstand', file: 'nightstand-light.glb', size: [0.55, 0.551, 0.45] },
  { id: 'nightstand', type: 'nightstand', file: 'nightstand.glb', size: [0.505, 0.616, 0.509] },
] satisfies ModelVariant[])

export const variantsFor = (type: string): ModelVariant[] => MODEL_VARIANTS.filter((v) => v.type === type)

const okSize = (n: number) => Number.isFinite(n) && n > 0

/**
 * Pick the variant whose largest per-axis distortion |ln(target / size)| is
 * smallest, with the scale that fits it to the target. Null when the list is
 * empty, the target is not three positive finite numbers, or even the best
 * variant would stretch an axis beyond MAX_DISTORTION. Ties keep the earlier
 * variant.
 */
export function fitModel(variants: readonly ModelVariant[], target: readonly [number, number, number]): ModelFit | null {
  if (target.length !== 3 || !target.every(okSize)) return null
  let best: ModelFit | null = null
  for (const v of variants) {
    if (!v.size.every(okSize)) continue
    const scale: [number, number, number] = [target[0] / v.size[0], target[1] / v.size[1], target[2] / v.size[2]]
    const distortion = Math.max(...scale.map((s) => Math.abs(Math.log(s))))
    if (!best || distortion < best.distortion) best = { id: v.id, scale, distortion }
  }
  return best && best.distortion <= MAX_DISTORTION ? best : null
}
