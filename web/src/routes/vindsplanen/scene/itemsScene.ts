// Items → meshes: furniture, partition walls, roof windows, straight, curved
// and spiral stairs with their railings, the storage room and the closet.
// Ported from v41 lines 1026–1305 (the build* halves; the warnings and the
// geometry they need come from lib/vindsplanen).

import * as THREE from 'three'
import { roofY, roofZAt, slopePoint, type Geometry } from '../../../lib/vindsplanen/attic'
import { BED_SIZES, closetGeom, furnitureChecks, railContext, skyHolesOk, storageGeom } from '../../../lib/vindsplanen/items'
import type { ClosetItem, CurvedItem, Item, PlanV2, SkylightItem, SpiralItem, StairsItem, StorageItem, WallItem } from '../../../lib/vindsplanen/plan'
import { planOf, railSegments } from '../../../lib/vindsplanen/stairs'
import { furnWarnings, skyInfo, stairInfo, wallInfo, WALL_DOOR_W } from '../../../lib/vindsplanen/warnings'
import { fitModel, MODEL_VARIANTS } from '../../../lib/vindsplanen/modelFit'
import { renderTreads } from './belowScene'
import type { SceneMats } from './materials'
import type { SceneModels } from './models'
import { bar, box, disposeObject, profileGeo, rb, rectPath, type Built } from './util'

type Slice = Pick<PlanV2, 'items' | 'options'>
type Furn = Extract<Item, { type: 'bed' | 'wardrobe' | 'desk' | 'sofa' | 'dresser' | 'nightstand' | 'rug' }>

const CORNERS: [number, number][] = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
]

// ---------- Furniture

/**
 * Furniture: a procedural box group, returned at once. When a CC0 model fits
 * the item's size (modelFit.ts) and loads, it replaces the box parts inside
 * the same group, so the group's itemId, picking, selection and the clash
 * overlay carry on unchanged. Models face +z like the boxes (backs at −z).
 */
export function buildFurniture(geo: Geometry, plan: Slice, it: Furn, mats: SceneMats, models?: SceneModels): Built {
  const { M } = mats
  const g = new THREE.Group()
  const { w, d, h, checks } = furnitureChecks(it)
  if (it.type === 'bed') {
    const bw = BED_SIZES[it.size]
    const bd = 2.0
    g.add(rb(bw + 0.06, 0.26, bd + 0.04, 0.025, M.oak, 0, 0.15, 0))
    CORNERS.forEach(([a, b]) => g.add(box(0.05, 0.05, 0.05, M.oakDark, a * (bw / 2 - 0.02), 0.025, b * (bd / 2 - 0.02))))
    g.add(rb(bw, 0.22, bd - 0.02, 0.07, M.linen, 0, 0.38, 0.01))
    g.add(rb(bw + 0.1, 0.08, bd * 0.68, 0.04, M.duvet, 0, 0.52, bd * 0.16))
    g.add(rb(bw + 0.1, 0.1, 0.16, 0.05, M.duvet, 0, 0.53, bd * 0.16 - bd * 0.34 + 0.08))
    const n = bw > 1.15 ? 2 : 1
    const pw = n === 2 ? bw / 2 - 0.08 : bw - 0.18
    for (let i = 0; i < n; i++) {
      const p = rb(pw, 0.14, 0.42, 0.07, M.linen, n === 2 ? ((i ? 1 : -1) * bw) / 4 : 0, 0.55, -bd / 2 + 0.3)
      p.rotation.x = -0.28
      g.add(p)
    }
    g.add(rb(bw + 0.06, 1.0, 0.09, 0.035, M.sage, 0, 0.5, -bd / 2 - 0.025))
  } else if (it.type === 'wardrobe') {
    g.add(rb(w, h, d, 0.008, M.trim, 0, h / 2, 0))
    const n = w > 0.7 ? 2 : 1
    const dw = w / n
    for (let i = 0; i < n; i++) {
      const x = -w / 2 + dw * (i + 0.5)
      g.add(rb(dw - 0.006, h - 0.06, 0.02, 0.004, M.trim, x, h / 2, d / 2 + 0.01))
      g.add(box(0.012, 0.32, 0.02, M.brass, x + (n === 2 ? (i ? -1 : 1) * (dw / 2 - 0.06) : dw / 2 - 0.06), h * 0.55, d / 2 + 0.035))
    }
  } else if (it.type === 'desk') {
    g.add(rb(w, 0.03, d, 0.008, M.oak, 0, h - 0.015, 0))
    CORNERS.forEach(([a, b]) => g.add(box(0.03, h - 0.03, 0.03, M.metal, a * (w / 2 - 0.05), (h - 0.03) / 2, b * (d / 2 - 0.05))))
    g.add(box(w - 0.1, 0.03, 0.02, M.metal, 0, h - 0.06, -d / 2 + 0.05))
  } else if (it.type === 'sofa') {
    g.add(rb(w, 0.24, d, 0.04, M.sofa, 0, 0.18, 0))
    const n = w > 1.6 ? 3 : 2
    const cw = (w - 0.36) / n
    for (let i = 0; i < n; i++) {
      const x = -w / 2 + 0.18 + cw * (i + 0.5)
      g.add(rb(cw - 0.01, 0.14, d - 0.24, 0.06, M.sofa, x, 0.37, 0.07))
      const b = rb(cw - 0.01, 0.4, 0.18, 0.07, M.sofa, x, 0.58, -d / 2 + 0.17)
      b.rotation.x = -0.12
      g.add(b)
    }
    g.add(rb(0.18, 0.44, d, 0.06, M.sofa, -w / 2 + 0.09, 0.36, 0), rb(0.18, 0.44, d, 0.06, M.sofa, w / 2 - 0.09, 0.36, 0))
    CORNERS.forEach(([a, b]) => g.add(box(0.04, 0.06, 0.04, M.walnut, a * (w / 2 - 0.06), 0.03, b * (d / 2 - 0.06))))
  } else if (it.type === 'rug') {
    g.add(rb(w, 0.012, d, 0.005, M.rug, 0, 0.006, 0))
  } else {
    g.add(rb(w, h - 0.06, d, 0.012, M.oak, 0, (h - 0.06) / 2 + 0.06, 0))
    CORNERS.forEach(([a, b]) => g.add(box(0.035, 0.06, 0.035, M.oakDark, a * (w / 2 - 0.04), 0.03, b * (d / 2 - 0.04))))
    const n = it.type === 'dresser' ? 3 : 1
    const fh = (h - 0.1) / n
    for (let i = 0; i < n; i++) {
      const y = 0.08 + fh * (i + 0.5)
      g.add(rb(w - 0.03, fh - 0.012, 0.012, 0.004, M.oakDark, 0, y, d / 2 + 0.004))
      g.add(box(Math.min(0.12, w * 0.3), 0.012, 0.02, M.brass, 0, y, d / 2 + 0.02))
    }
  }
  g.position.set(it.x, 0, it.z)
  g.rotation.y = (it.rot * Math.PI) / 180
  // a red box round furniture that hits the roof slope
  if (furnWarnings(geo, plan, it, checks).clash) {
    const hh = Math.max(...checks.map((c) => c[2])) + 0.02
    const m = new THREE.Mesh(new THREE.BoxGeometry(w + 0.03, hh, d + 0.03), M.clash)
    m.position.y = hh / 2
    m.userData.overlay = true
    m.renderOrder = 3
    m.castShadow = false
    g.add(m)
  }
  return { obj: g, onDispose: models ? swapInModel(g, it, w, h, d, mats, models) : undefined }
}

/** Start loading the best-fitting model for a box item; returns the cancel for `Built.onDispose`. */
function swapInModel(g: THREE.Group, it: Furn, w: number, h: number, d: number, mats: SceneMats, models: SceneModels): (() => void) | undefined {
  const variants = MODEL_VARIANTS.filter((v) => v.type === it.type)
  const fit = fitModel(variants, [w, h, d])
  const variant = fit && variants.find((v) => v.id === fit.id)
  if (!fit || !variant) return undefined
  // Disposed and detached = the item was replaced or removed meanwhile: leave it alone.
  // Disposed but still attached = a StrictMode effect replay (dev), whose group
  // is still the one on screen: swap anyway.
  let disposed = false
  void models.template(variant.file).then((tpl) => {
    if (!tpl) return // the model failed to load (warned once in models.ts): keep the box
    if (disposed && !g.parent) return
    const parts = g.children.filter((c) => !c.userData.overlay)
    parts.forEach((c) => {
      g.remove(c)
      disposeObject(c, mats.shared)
    })
    const inst = tpl.clone(true)
    inst.scale.set(...fit.scale)
    inst.userData.model = variant.id
    g.add(inst)
  })
  return () => {
    disposed = true
  }
}

// ---------- Partition wall

export function buildWall(geo: Geometry, it: WallItem, mats: SceneMats): Built {
  const { KZ, KNEE_H, H } = geo
  const { M } = mats
  const g = new THREE.Group()
  const t = 0.1
  const dw = WALL_DOOR_W
  const { zc, dh } = wallInfo(geo, it)
  const s = new THREE.Shape()
  s.moveTo(-KZ, 0)
  if (it.door) {
    s.lineTo(zc - dw / 2, 0)
    s.lineTo(zc - dw / 2, dh)
    s.lineTo(zc + dw / 2, dh)
    s.lineTo(zc + dw / 2, 0)
  }
  s.lineTo(KZ, 0)
  s.lineTo(KZ, KNEE_H)
  s.lineTo(0, H)
  s.lineTo(-KZ, KNEE_H)
  s.closePath()
  const geom = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false })
  geom.translate(0, 0, -t / 2)
  geom.rotateY(-Math.PI / 2)
  const wall = new THREE.Mesh(geom, mats.wall)
  wall.castShadow = wall.receiveShadow = true
  g.add(wall)
  // skirting on both faces, broken by the door, plus architraves round the opening
  const spans: [number, number][] = it.door
    ? [
        [-KZ, zc - dw / 2],
        [zc + dw / 2, KZ],
      ]
    : [[-KZ, KZ]]
  ;[-1, 1].forEach((f) => {
    spans.forEach(([a, b]) => {
      if (b - a > 0.02) g.add(box(0.014, 0.07, b - a, M.trim, f * (t / 2 + 0.007), 0.035, (a + b) / 2))
    })
    if (it.door) {
      const aw = 0.06
      g.add(
        box(0.014, dh + aw, aw, M.trim, f * (t / 2 + 0.007), (dh + aw) / 2, zc - dw / 2 - aw / 2),
        box(0.014, dh + aw, aw, M.trim, f * (t / 2 + 0.007), (dh + aw) / 2, zc + dw / 2 + aw / 2),
        box(0.014, aw, dw + aw * 2, M.trim, f * (t / 2 + 0.007), dh + aw / 2, zc),
      )
    }
  })
  if (it.door) g.add(box(t, 0.012, dw, M.oak, 0, 0.006, zc))
  g.position.x = it.x
  return { obj: g }
}

// ---------- Roof window (placed in its slope's group)

export function buildSkylight(geo: Geometry, plan: Slice, it: SkylightItem, mats: SceneMats): Built {
  const { THETA, COS, SIN, ROOF_T, BOARD_D } = geo
  const { M } = mats
  const ok = skyHolesOk(geo, plan.items)
  const inf = skyInfo(geo, it, ok)
  const g = new THREE.Group()
  const sign = it.slope === 'S' ? 1 : -1
  const sMid = (inf.sBot + inf.sTop) / 2
  g.position.set(...slopePoint(geo, it.slope, inf.bay.c, sMid))
  g.rotation.x = sign > 0 ? THETA - Math.PI / 2 : Math.PI / 2 - THETA
  const { w, h } = inf.sz
  const o = sign
  const D = ROOF_T
  const t = 0.025
  const f = 0.06
  const D0 = plan.options.board.includes(it.bay) ? BOARD_D : 0
  const LD = D + D0
  const lz = (o * (D - D0)) / 2
  // lining through the roof build-up (and the insulated ceiling, if any), then a white frame and glass at the outer face
  g.add(
    box(w, t, LD, M.trim, 0, -h / 2 - t / 2, lz),
    box(w, t, LD, M.trim, 0, h / 2 + t / 2, lz),
    box(t, h + 2 * t, LD, M.trim, -w / 2 - t / 2, 0, lz),
    box(t, h + 2 * t, LD, M.trim, w / 2 + t / 2, 0, lz),
  )
  const fz = o * (D - 0.05)
  g.add(
    box(w, f, 0.07, M.frame, 0, -h / 2 + f / 2, fz),
    box(w, f, 0.07, M.frame, 0, h / 2 - f / 2, fz),
    box(f, h, 0.07, M.frame, -w / 2 + f / 2, 0, fz),
    box(f, h, 0.07, M.frame, w / 2 - f / 2, 0, fz),
  )
  g.add(box(w - 0.1, 0.035, 0.03, M.metal, 0, h / 2 - f - 0.03, fz - o * 0.03))
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.08, h - 0.08), M.glass)
  glass.position.z = o * (D - 0.03)
  glass.userData.glass = true
  g.add(glass)
  const lights: THREE.Light[] = []
  if (ok.has(it.id)) {
    const lt = new THREE.RectAreaLight('#e3edf8', 4.5, w, h)
    g.updateMatrix()
    const centre = new THREE.Vector3(0, 0, -o * (D0 + 0.02)).applyMatrix4(g.matrix) // the slope group is at the origin
    const inward = new THREE.Vector3(0, -COS, -sign * SIN)
    lt.position.copy(centre)
    lt.lookAt(centre.clone().add(inward))
    lights.push(lt)
  }
  return { obj: g, lights }
}

// ---------- Straight stairs (a flight down through the attic floor)

export function buildStairs(geo: Geometry, it: StairsItem, mats: SceneMats): Built {
  const { M } = mats
  const g = new THREE.Group()
  const { n, rise, going } = stairInfo(geo, it)
  const hw = it.w / 2
  for (let k = 1; k < n; k++) {
    const xc = it.run / 2 - (k - 0.5) * going
    g.add(rb(going + 0.03, 0.042, it.w - 0.07, 0.008, M.oak, xc, -k * rise - 0.021, 0))
  }
  const ang = Math.atan2(it.drop, it.run)
  const len = Math.hypot(it.drop, it.run)
  ;[-1, 1].forEach((sd) => {
    const st = box(len, 0.24, 0.035, M.trim, 0, -it.drop / 2 - 0.08, sd * (hw - 0.03))
    st.rotation.z = ang
    g.add(st)
  })
  ;(
    [
      [it.run, it.drop, 0.02, 0, -it.drop / 2, -hw - 0.01],
      [it.run, it.drop, 0.02, 0, -it.drop / 2, hw + 0.01],
      [0.02, it.drop, it.w, -it.run / 2 - 0.01, -it.drop / 2, 0],
    ] as const
  ).forEach(([a, b, c, x, y, z]) => g.add(box(a, b, c, mats.wall, x, y, z)))
  g.add(box(it.run + 0.04, 0.02, it.w + 0.04, M.lower, 0, -it.drop - 0.01, 0))
  const rh = 0.9
  ;[-1, 1].forEach((sd) => {
    g.add(rb(it.run + 0.04, 0.045, 0.06, 0.018, M.oak, 0, rh, sd * hw))
    ;[-it.run / 2, it.run / 2 - 0.04].forEach((x) => g.add(rb(0.07, rh, 0.07, 0.01, M.trim, x, rh / 2, sd * hw)))
    for (let x = -it.run / 2 + 0.12; x < it.run / 2 - 0.08; x += 0.12) g.add(box(0.022, rh - 0.05, 0.022, M.trim, x, (rh - 0.05) / 2, sd * hw))
  })
  g.add(rb(0.06, 0.045, it.w, 0.018, M.oak, -it.run / 2, rh, 0))
  for (let z = -hw + 0.12; z < hw - 0.06; z += 0.12) g.add(box(0.022, rh - 0.05, 0.022, M.trim, -it.run / 2, (rh - 0.05) / 2, z))
  g.position.set(it.x, 0, it.z)
  g.rotation.y = (it.rot * Math.PI) / 180
  return { obj: g }
}

// ---------- Curved and spiral stairs up from the floor below

/** The guard round the opening and the banister, from `railSegments`. */
function stairRails(geo: Geometry, plan: Slice, it: CurvedItem, mats: SceneMats): THREE.Group {
  const { M } = mats
  const P = planOf(plan.options.below, it)
  const g = new THREE.Group()
  railSegments(geo, plan, it, P, railContext(geo, plan)).forEach((p) => {
    if (p.kind === 'bar') bar(g, p.p, p.q, p.w, p.h, M.oak)
    else g.add(box(p.w, p.h, p.d, M.trim, p.x, p.y, p.z))
  })
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.userData.rail = true
  })
  return g
}

export function buildCurved(geo: Geometry, plan: Slice, it: CurvedItem, mats: SceneMats): Built {
  const P = planOf(plan.options.below, it)
  const g = new THREE.Group()
  renderTreads(g, P, it.turn, mats)
  if (P.turn) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, P.F, 20), mats.M.trim)
    post.position.set(P.pivot[0], P.F / 2, P.pivot[1])
    post.castShadow = post.receiveShadow = true
    g.add(post)
  }
  g.add(stairRails(geo, plan, it, mats))
  g.position.set(it.x, -P.F, it.z)
  g.rotation.y = (it.rot * Math.PI) / 180
  return { obj: g }
}

export function buildSpiral(plan: Slice, it: SpiralItem, mats: SceneMats): Built {
  const P = planOf(plan.options.below, it)
  const g = new THREE.Group()
  renderTreads(g, P, 'R', mats)
  const col = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, P.F, 24), mats.M.trim)
  col.position.set(0, P.F / 2, 0)
  col.castShadow = col.receiveShadow = true
  g.add(col)
  g.position.set(it.x, -P.F, it.z)
  g.rotation.y = (it.rot * Math.PI) / 180
  return { obj: g }
}

// ---------- Storage room and closet

/** A wall standing across the attic at x from za back to zb, its top following the roof. */
function sideWall(geo: Geometry, x: number, za: number, zb: number, mat: THREE.Material): THREE.Mesh {
  const ps = new THREE.Shape()
  const n = 8
  ps.moveTo(za, 0)
  ps.lineTo(zb, 0)
  for (let k = 0; k <= n; k++) {
    const z = zb + ((za - zb) * k) / n
    ps.lineTo(z, Math.max(0.02, roofY(geo, z)))
  }
  ps.closePath()
  const m = new THREE.Mesh(profileGeo(ps), mat)
  m.position.x = x
  return m
}

/** A wall along the attic at z, from x0 to x1 and h high, with an optional door opening. */
function frontWall(x0: number, x1: number, h0: number, h1: number, z: number, t: number, mat: THREE.Material, door?: { c: number; w: number; h: number }) {
  const fs = new THREE.Shape()
  fs.moveTo(x0, 0)
  fs.lineTo(x1, 0)
  fs.lineTo(x1, h1)
  fs.lineTo(x0, h0)
  fs.closePath()
  if (door) fs.holes.push(rectPath(door.c - door.w / 2, 0, door.c + door.w / 2, door.h))
  const fg = new THREE.ExtrudeGeometry(fs, { depth: t, bevelEnabled: false })
  fg.translate(0, 0, z - t / 2)
  return new THREE.Mesh(fg, mat)
}

export function buildStorage(geo: Geometry, plan: Slice, it: StorageItem, mats: SceneMats): Built {
  const { M } = mats
  const g = new THREE.Group()
  const S = storageGeom(geo, plan, it)
  const { sg, x0, x1, zf, zb, hF, dw, dh, ext, xe, dc } = S
  const t = 0.08
  // front wall to the roof, with the door opening; it runs on past the corner part when there is one
  g.add(frontWall(x0, xe, hF, hF, zf, t, mats.wall, { c: dc, w: dw, h: dh }))
  // side walls follow the roof back to the knee wall or into the eaves; none where a partition wall already is
  if (!S.sharedX0) g.add(sideWall(geo, x0, zf, zb, mats.wall))
  if (ext) {
    g.add(sideWall(geo, x1, ext.zn, zb, mats.wall)) // behind the corner part, the main room's end wall stands over the stair run
    const hn = roofY(geo, ext.zn)
    g.add(frontWall(x1, ext.x2, hn, hn, ext.zn, t, mats.wall)) // along the stair run
    const es = new THREE.Shape()
    es.moveTo(zf, 0)
    es.lineTo(ext.zn, 0)
    es.lineTo(ext.zn, hn)
    es.lineTo(zf, hF)
    es.closePath()
    const em = new THREE.Mesh(profileGeo(es), mats.wall)
    em.position.x = ext.x2
    g.add(em) // beside the turn
  } else if (!S.sharedX1) g.add(sideWall(geo, x1, zf, zb, mats.wall))
  // the door: a sliding leaf on a top track, left a little open; or a hinged leaf
  if (it.door !== 'none') {
    const oz = zf - sg * (t / 2 + 0.025)
    const open = it.door === 'slide' ? dw * 0.3 : 0
    g.add(box(dw + 0.04, dh, 0.03, M.trim, dc + open, dh / 2, oz), box(0.025, 0.18, 0.02, M.brass, dc + open - dw / 2 + 0.06, 1.0, oz - sg * 0.02))
    if (it.door === 'slide') g.add(box(xe - x0 - 0.02, 0.05, 0.06, M.trim, (x0 + xe) / 2, dh + 0.03, oz)) // track along the front
  }
  g.add(box(dw + 0.16, 0.06, t + 0.02, M.trim, dc, dh + 0.03, zf)) // head trim
  // shelves along the inside of the west side, stepping down with the roof
  ;[0.45, 0.9, 1.35, 1.75].forEach((y) => {
    const zEnd = sg * Math.min(Math.abs(zb), roofZAt(geo, y + 0.2))
    const len = Math.abs(zEnd) - Math.abs(zf) - 0.05
    if (len < 0.25) return // skip a shelf the roof would cut off
    g.add(box(0.35, 0.025, len, M.oak, x0 + 0.2, y, (zf + zEnd) / 2))
  })
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = o.receiveShadow = true
  })
  return { obj: g }
}

export function buildCloset(geo: Geometry, plan: Slice, it: ClosetItem, mats: SceneMats): Built {
  const { M } = mats
  const g = new THREE.Group()
  const C = closetGeom(geo, plan, it)
  const { x0, x1, zb, zd, xi, hD, dw, dh, t, dc, sg } = C
  // the long side, under the roof from the door end back to the eaves
  g.add(sideWall(geo, xi, zd, zb, mats.wall))
  // the door end, with a narrow hinged door
  g.add(frontWall(x0, x1, hD, hD, zd, t, mats.wall, { c: dc, w: dw, h: dh }))
  const oz = zd - sg * (t / 2 + 0.02)
  g.add(
    box(dw, dh, 0.03, M.trim, dc, dh / 2, oz),
    box(0.02, 0.16, 0.02, M.brass, dc + C.dir * (dw / 2 - 0.06), 1.0, oz - sg * 0.02),
    box(dw + 0.14, 0.06, t + 0.02, M.trim, dc, dh + 0.03, zd),
  )
  // shelves the full width inside, each stopping where the roof comes down
  ;[0.35, 0.75, 1.15, 1.55].forEach((y) => {
    const zEnd = sg * Math.min(Math.abs(zb), roofZAt(geo, y + 0.15))
    const len = (zEnd - zd) * sg - 0.06
    if (len < 0.2) return
    g.add(box(x1 - x0 - 0.1, 0.022, len, M.oak, (x0 + x1) / 2, y, zd + sg * (0.06 + len / 2)))
  })
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = o.receiveShadow = true
  })
  return { obj: g }
}

// ---------- Dispatch

export function buildItem(geo: Geometry, plan: Slice, it: Item, mats: SceneMats, models?: SceneModels): Built {
  let b: Built
  switch (it.type) {
    case 'skylight':
      b = buildSkylight(geo, plan, it, mats)
      break
    case 'wall':
      b = buildWall(geo, it, mats)
      break
    case 'stairs':
      b = buildStairs(geo, it, mats)
      break
    case 'curved':
      b = buildCurved(geo, plan, it, mats)
      break
    case 'spiral':
      b = buildSpiral(plan, it, mats)
      break
    case 'storage':
      b = buildStorage(geo, plan, it, mats)
      break
    case 'closet':
      b = buildCloset(geo, plan, it, mats)
      break
    default:
      b = buildFurniture(geo, plan, it, mats, models)
  }
  b.obj.userData.itemId = it.id
  return b
}
