// The measurements toggle: orange dimension lines with labels on the attic
// and on the floor below (v41 `buildDims`, lines 1399–1423), and the Measure
// tab's per-step highlights (v41 showWalk 2006–2008, rafterHl 1967).

import * as THREE from 'three'
import { clamp, cm, type Geometry } from '../../../lib/vindsplanen/attic'
import { FF, hallRect, swRect } from '../../../lib/vindsplanen/below'
import type { MeasureStep } from '../../../lib/vindsplanen/measure'
import type { PlanV2 } from '../../../lib/vindsplanen/plan'
import { LABEL } from './labels'
import type { SceneMats } from './materials'
import { dimLine, hlBox, label } from './util'

type Slice = Pick<PlanV2, 'items' | 'options'>

export function buildDims(geo: Geometry, plan: Slice, mats: SceneMats): { attic: THREE.Group; below: THREE.Group } {
  const { L, HALF, KZ, H, W, KNEE_H } = geo
  const attic = new THREE.Group()
  const below = new THREE.Group()
  let into = attic
  const add = (a: number[], b: number[], text: string, lift = 0) => into.add(dimLine(a, b, text, mats.dim, lift))
  const y = 0.03
  add([0, y, HALF + 0.3], [L, y, HALF + 0.3], LABEL.a1(cm(L)))
  add([-0.3, y, -HALF], [-0.3, y, HALF], LABEL.eaves(cm(W)))
  add([0.4, y, -KZ], [0.4, y, KZ], LABEL.a2(cm(2 * KZ)), 0.15)
  add([0.05, 0, 0], [0.05, H, 0], LABEL.a4(cm(H)))
  add([0.05, 0, KZ - 0.04], [0.05, KNEE_H, KZ - 0.04], LABEL.a3(cm(KNEE_H)))
  plan.items.forEach((i) => {
    if (i.type === 'curved') add([0, y, i.z], [i.x, y, i.z], LABEL.bottomStep(cm(i.x)), 0.15)
  })
  const B = plan.options.below
  if (!B.show) return { attic, below }
  into = below
  const h = hallRect(geo, B)
  const r = swRect(geo, B)
  const y0 = -FF(B) + 0.03
  const dirH = B.side === 'S' ? -1 : 1
  const inner = B.side === 'S' ? r.z0 : r.z1
  const hallSide = B.side === 'S' ? h.za : h.zb
  const px = clamp(r.x0 + B.screen, r.x0, r.x1)
  add([h.xw, y0, hallSide - dirH * 0.2], [L, y0, hallSide - dirH * 0.2], LABEL.b3(cm(L - h.xw)))
  add([h.xw + 0.15, y0, h.za], [h.xw + 0.15, y0, h.zb], LABEL.plain(cm(h.zb - h.za)))
  add([r.x0, y0, inner + dirH * 0.15], [r.x1, y0, inner + dirH * 0.15], LABEL.b4(cm(r.x1 - r.x0)))
  add([r.x0 + 0.2, y0, r.z0], [r.x0 + 0.2, y0, r.z1], LABEL.b5(cm(r.z1 - r.z0)))
  add([(r.x0 + r.x1) / 2, y0, inner], [(r.x0 + r.x1) / 2, y0, hallSide], LABEL.b6(cm(Math.abs(hallSide - inner))))
  add([h.xw + 0.5, y0, hallSide - dirH * 0.4], [h.xw + 0.5, y0 + B.ceil - 0.03, hallSide - dirH * 0.4], LABEL.b1(cm(B.ceil)))
  add([r.x0, y0 + 1.15, inner + dirH * 0.05], [px, y0 + 1.15, inner + dirH * 0.05], LABEL.b7(cm(B.screen)))
  B.doors.forEach((d, i) => {
    const l = label(LABEL.door(i, d, cm(d.at), cm(d.w)), 'dim')
    if (d.wall === 'W') l.position.set(h.xw + 0.08, y0 + 2.15, h.za + d.at)
    else l.position.set(L - d.at, y0 + 2.15, d.wall === 'N' ? h.za + 0.08 : h.zb - 0.08)
    below.add(l)
  })
  return { attic, below }
}

/** What the Measure tab highlights for one step. */
export type MeasureHighlight = Pick<MeasureStep, 'code' | 'dims' | 'boxes' | 'hl'>

/**
 * The step's dimension lines, highlight boxes and highlighted rafters.
 * `rafters`: the rafter meshes per slope (their `userData.rx` is the rafter x).
 */
export function buildHighlights(hl: MeasureHighlight, rafters: Record<'S' | 'N', THREE.Object3D>, mats: SceneMats): THREE.Group {
  const g = new THREE.Group()
  hl.dims.forEach((d) => g.add(dimLine(d.a, d.b, LABEL.step(hl.code, d.cm, d.sill), mats.dim, 0, true)))
  hl.boxes.forEach((b) => g.add(hlBox(mats.hl, ...b)))
  hl.hl.forEach(([x, side]) => {
    rafters[side].children.forEach((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh || Math.abs(m.userData.rx - x) > 1e-6) return
      const c = new THREE.Mesh(m.geometry.clone(), mats.hl)
      c.position.copy(m.position)
      c.rotation.copy(m.rotation)
      c.scale.set(2.2, 1.25, 1.01)
      c.renderOrder = 4
      c.userData.overlay = true
      g.add(c)
    })
  })
  return g
}
