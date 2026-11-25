// The floor below: hallway, stairwell, old stairs, the slatted screen, the
// L-shaped banister, trimmer, the hallway window, lamp, smoke alarm and doors.
// v41 `buildBelow` (lines 885–969) as drawn from `belowLayout()`, which holds
// every number; this file only turns its parts into meshes.

import * as THREE from 'three'
import type { Geometry } from '../../../lib/vindsplanen/attic'
import { belowLayout, oldStairs, type BelowCut, type BelowPart } from '../../../lib/vindsplanen/below'
import type { BelowDoor, PlanV2 } from '../../../lib/vindsplanen/plan'
import type { StairPlan } from '../../../lib/vindsplanen/stairs'
import type { SceneMats } from './materials'
import { box, planeM, profileGeo, rb, rectPath } from './util'

type Slice = Pick<PlanV2, 'items' | 'options'>

/** Treads of a stair plan (v41 `renderTreads`): oak treads and painted risers under straight ones. */
export function renderTreads(g: THREE.Object3D, P: StairPlan, turn: string, mats: SceneMats) {
  const { M } = mats
  P.treads.forEach((tr) => {
    if (tr.landing) return // the attic floor itself is the landing
    const s = new THREE.Shape()
    tr.poly.forEach(([x, z], i) => (i ? s.lineTo(x, -z) : s.moveTo(x, -z)))
    s.closePath()
    const geo = new THREE.ExtrudeGeometry(s, { depth: 0.045, bevelEnabled: false })
    geo.rotateX(-Math.PI / 2)
    geo.translate(0, tr.t - 0.045, 0)
    const m = new THREE.Mesh(geo, M.oak)
    m.castShadow = m.receiveShadow = true
    g.add(m)
    if (tr.straight) {
      const xs = tr.poly.map((q) => q[0])
      const zs = tr.poly.map((q) => q[1])
      const xmin = Math.min(...xs)
      const xmax = Math.max(...xs)
      const zmin = Math.min(...zs)
      const zmax = Math.max(...zs)
      if (tr.dir === 'z') {
        const zf = turn === 'R' ? zmin : zmax
        g.add(box(xmax - xmin, P.r - 0.045, 0.02, M.trim, (xmax + xmin) / 2, tr.t - 0.045 - (P.r - 0.045) / 2, zf))
      } else g.add(box(0.02, P.r - 0.045, zmax - zmin, M.trim, xmin, tr.t - 0.045 - (P.r - 0.045) / 2, (zmax + zmin) / 2))
    }
  })
}

/** A four-panel door with casing and brass handle, or a flush cupboard panel. */
function doorGroup(d: BelowDoor, dh: number, mats: SceneMats): THREE.Group {
  const { M } = mats
  const g = new THREE.Group()
  const cs = 0.07
  g.add(box(d.w, dh, 0.025, M.trim, 0, dh / 2, 0.012))
  if (d.kind === 'door') {
    g.add(
      box(cs, dh + cs, 0.018, M.frame, -d.w / 2 - cs / 2, (dh + cs) / 2, 0.009),
      box(cs, dh + cs, 0.018, M.frame, d.w / 2 + cs / 2, (dh + cs) / 2, 0.009),
      box(d.w + 2 * cs, cs, 0.018, M.frame, 0, dh + cs / 2, 0.009),
    )
    const pw = (d.w - 0.27) / 2
    const ph1 = dh * 0.36
    const ph2 = dh * 0.3
    ;[-1, 1].forEach((sx) => {
      const px = sx * (pw / 2 + 0.045)
      g.add(box(pw, ph1, 0.012, M.frame, px, dh - 0.12 - ph1 / 2, 0.03), box(pw, ph2, 0.012, M.frame, px, 0.14 + ph2 / 2, 0.03))
    })
    const hs = d.flip ? -1 : 1 // handle on the right as seen from the hallway, or the left when flipped
    g.add(box(0.025, 0.025, 0.06, M.brass, hs * (d.w / 2 - 0.08), 1.0, 0.05), box(0.12, 0.02, 0.02, M.brass, hs * (d.w / 2 - 0.12), 1.0, 0.08))
  } else g.add(box(0.02, 0.12, 0.03, M.brass, (d.flip ? -1 : 1) * (d.w / 2 - 0.05), 1.0, 0.04))
  return g
}

export interface BelowBuilt {
  /** Everything not in a cut-away layer. */
  root: THREE.Group
  /** The hallway walls (and what sits in them), hidden when the camera is outside. */
  cut: Record<BelowCut, THREE.Group>
  /** Cut-away anchor points (v41 CUT_B …p) for S, N and W; E is fixed at (L, −1, 0). */
  anchors: Record<BelowCut, THREE.Vector3>
}

export function buildBelow(geo: Geometry, plan: Slice, mats: SceneMats): BelowBuilt {
  const { M, M2 } = mats
  const lay = belowLayout(geo, plan)
  const B = plan.options.below
  const root = new THREE.Group()
  const cut: Record<BelowCut, THREE.Group> = { S: new THREE.Group(), N: new THREE.Group(), E: new THREE.Group(), W: new THREE.Group() }
  const matOf = (m: string): THREE.Material =>
    m === 'trim' ? M.trim : m === 'sill' ? M.sill : m === 'floor' ? M2.floor : m === 'wall' ? M2.wall : M.glass
  const add = (o: THREE.Object3D, c?: BelowCut) => {
    o.castShadow = o.receiveShadow = true
    ;(c ? cut[c] : root).add(o)
    return o
  }
  const draw = (p: BelowPart) => {
    switch (p.kind) {
      case 'box':
        add(box(p.w, p.h, p.d, matOf(p.mat), p.x, p.y, p.z), p.cut)
        return
      case 'rbox': {
        const m = rb(p.w, p.h, p.d, p.r, matOf(p.mat), p.x, p.y, p.z)
        m.rotation.y = p.rotY
        add(m)
        return
      }
      case 'plane': {
        const glass = p.mat === 'glass'
        const m = new THREE.Mesh(glass ? new THREE.PlaneGeometry(p.w, p.h) : planeM(p.w, p.h), matOf(p.mat))
        m.rotation.x = p.rotX
        m.rotation.y = p.rotY
        m.position.set(p.x, p.y, p.z)
        add(m, p.cut)
        if (glass) {
          m.userData.glass = true
          m.castShadow = false
        }
        return
      }
      case 'eastWall': {
        const es = new THREE.Shape()
        es.moveTo(p.za, 0)
        es.lineTo(p.zb, 0)
        es.lineTo(p.zb, p.ceil)
        es.lineTo(p.za, p.ceil)
        es.closePath()
        if (p.window) {
          const w = p.window
          es.holes.push(rectPath(w.wc - w.wW / 2, w.sill, w.wc + w.wW / 2, w.sill + w.wH))
        }
        const ew = new THREE.Mesh(profileGeo(es), M2.wall)
        ew.position.set(p.x, p.y, 0)
        add(ew, p.cut)
        return
      }
      case 'oldStairs': {
        const OS = oldStairs(geo, B)
        const og = new THREE.Group()
        renderTreads(og, OS.P, OS.it.turn, mats)
        if (p.post) {
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, OS.P.F, 16), M.trim)
          post.position.set(OS.P.pivot[0], OS.P.F / 2, OS.P.pivot[1])
          og.add(post)
        }
        og.position.set(p.x, p.y, p.z)
        og.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) o.castShadow = o.receiveShadow = true
        })
        root.add(og)
        return
      }
      case 'lamp': {
        const lamp = new THREE.PointLight('#fff1dc', 6, 0, 2)
        lamp.position.set(p.x, p.y, p.z)
        lamp.castShadow = true // as v41: `add()` set it on everything
        root.add(lamp) // in the floor-below group, never in a cut-away layer
        return
      }
      case 'lampDisc': {
        const disc = new THREE.Mesh(
          new THREE.CylinderGeometry(0.2, 0.2, 0.06, 32),
          new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#fff4e2', emissiveIntensity: 1.6 }),
        )
        disc.position.set(p.x, p.y, p.z)
        add(disc)
        disc.castShadow = false
        return
      }
      case 'smoke': {
        const sa = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, 0.035, 28), M.trim)
        sa.position.set(p.x, p.y, p.z)
        add(sa)
        return
      }
      case 'smokeLed': {
        const led = new THREE.Mesh(
          new THREE.SphereGeometry(0.006, 8, 6),
          new THREE.MeshStandardMaterial({ color: '#c0392b', emissive: '#ff2a1a', emissiveIntensity: 2 }),
        )
        led.position.set(p.x, p.y, p.z)
        add(led)
        led.castShadow = false
        return
      }
      case 'door': {
        const g = doorGroup(p.door, p.dh, mats)
        g.rotation.y = p.rotY
        g.position.set(p.x, p.y, p.z)
        g.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) o.castShadow = o.receiveShadow = true
        })
        cut[p.cut].add(g)
        return
      }
    }
  }
  lay.parts.forEach(draw)
  Object.values(cut).forEach((g) => root.add(g))
  const y0 = lay.y0
  const anchors: Record<BelowCut, THREE.Vector3> = {
    S: new THREE.Vector3(0, y0 + 1, lay.hall.zb),
    N: new THREE.Vector3(0, y0 + 1, lay.hall.za),
    W: new THREE.Vector3(lay.hall.xw, y0 + 1, 0),
    E: new THREE.Vector3(geo.L, -1, 0),
  }
  return { root, cut, anchors }
}
