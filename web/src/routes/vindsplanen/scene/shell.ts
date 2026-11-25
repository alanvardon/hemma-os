// The attic shell: rafters, gables, roof slopes with window openings,
// plasterboard in insulated bays, knee walls, the attic floor with its stair
// openings and the headroom-zone overlay. Ported from v41 lines 661–778 and
// 979–1024. Every dimension comes from lib/vindsplanen.

import * as THREE from 'three'
import { boardCapProfile, boardSpan, slopePoint, type Geometry } from '../../../lib/vindsplanen/attic'
import { hallRect } from '../../../lib/vindsplanen/below'
import { gableWindowFit, skyHolesOk, skyRect } from '../../../lib/vindsplanen/items'
import type { Gable, Item, PlanV2, SkylightItem } from '../../../lib/vindsplanen/plan'
import { clipBox, stairHoles } from '../../../lib/vindsplanen/stairs'
import { computeZones, ZONE_BOA, ZONE_STAND } from '../../../lib/vindsplanen/zones'
import { LABEL } from './labels'
import type { SceneMats } from './materials'
import { box, floorGeo, floorShape, label, metreUv, planeM, profileGeo, rectPath, shadowy, type Built } from './util'

type Slice = Pick<PlanV2, 'items' | 'options'>
type SideKey = 'S' | 'N'
const SIDES: [SideKey, number][] = [
  ['S', 1],
  ['N', -1],
]

// ---------- Rafters

/**
 * The rafters of both slopes (v41 line 681). `board`: a rafter between two
 * insulated bays is hidden (v41 buildBoard 723); `today` shows every rafter
 * (the Measure tab's attic steps).
 */
export function buildRafters(geo: Geometry, mats: SceneMats, board: readonly number[], today: boolean): Record<SideKey, THREE.Group> {
  const { RAFT_X, RAFT_W, RAFT_D, SLEN, THETA, H, HALF, EDGES } = geo
  const B = new Set(board)
  const out = { S: new THREE.Group(), N: new THREE.Group() }
  RAFT_X.forEach((x) => {
    SIDES.forEach(([side, sign]) => {
      const m = new THREE.Mesh(metreUv(new THREE.BoxGeometry(RAFT_W, RAFT_D, SLEN)), mats.rafter)
      m.rotation.x = sign * THETA
      m.position.set(x, H / 2, (sign * HALF) / 2)
      const ly = new THREE.Vector3(0, 1, 0).applyEuler(m.rotation)
      m.position.addScaledVector(ly, -RAFT_D / 2)
      m.userData.rx = x
      const i = EDGES.indexOf(x)
      m.visible = today || !(B.has(i - 1) && B.has(i))
      out[side].add(m)
    })
  })
  shadowy(out.S)
  shadowy(out.N)
  return out
}

// ---------- Gables

export function buildWestGable(geo: Geometry, mats: SceneMats): THREE.Group {
  const { HALF, H } = geo
  const g = new THREE.Group()
  const s = new THREE.Shape()
  s.moveTo(-HALF, 0)
  s.lineTo(HALF, 0)
  s.lineTo(0, H)
  s.closePath()
  g.add(new THREE.Mesh(profileGeo(s), mats.wall))
  const l = label(LABEL.west)
  l.position.set(-0.4, 2.2, 0)
  g.add(l)
  return shadowy(g)
}

export function buildEastLabel(geo: Geometry): THREE.Object3D {
  const l = label(LABEL.east)
  l.position.set(geo.L + 0.6, 2.2, 0)
  return l
}

/** The east gable with its window, or a vent when there is none (v41 `buildEast`). */
export function buildEast(geo: Geometry, gable: Gable, mats: SceneMats): Built {
  const { HALF, H, L } = geo
  const { M } = mats
  const g = gable
  const grp = new THREE.Group()
  const parts: THREE.Mesh[] = []
  const s = new THREE.Shape()
  s.moveTo(-HALF, 0)
  s.lineTo(HALF, 0)
  s.lineTo(0, H)
  s.closePath()
  const showWin = g.on && gableWindowFit(geo, g).fits
  if (showWin) s.holes.push(rectPath(g.off - g.w / 2, g.sill, g.off + g.w / 2, g.sill + g.h))
  const wall = new THREE.Mesh(profileGeo(s), mats.wall)
  wall.position.x = L
  parts.push(wall)
  const lights: THREE.Light[] = []
  if (showWin) {
    const D = 0.22
    const cy = g.sill + g.h / 2
    const t = 0.025
    // reveal (lining) through the wall thickness, then the frame and glass near the outside face
    parts.push(
      box(D, t, g.w, M.trim, L + D / 2, g.sill + g.h + t / 2, g.off),
      box(D, g.h, t, M.trim, L + D / 2, cy, g.off - g.w / 2 - t / 2),
      box(D, g.h, t, M.trim, L + D / 2, cy, g.off + g.w / 2 + t / 2),
    )
    parts.push(box(D + 0.06, 0.03, g.w + 0.06, M.sill, L + D / 2 - 0.03, g.sill - 0.015, g.off))
    const fx = L + D - 0.04
    const f = 0.055
    parts.push(
      box(0.06, f, g.w, M.frame, fx, g.sill + f / 2, g.off),
      box(0.06, f, g.w, M.frame, fx, g.sill + g.h - f / 2, g.off),
      box(0.06, g.h, f, M.frame, fx, cy, g.off - g.w / 2 + f / 2),
      box(0.06, g.h, f, M.frame, fx, cy, g.off + g.w / 2 - f / 2),
      box(0.05, g.h, 0.04, M.frame, fx, cy, g.off),
    )
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(g.w, g.h), M.glass)
    glass.rotation.y = -Math.PI / 2
    glass.position.set(fx + 0.01, cy, g.off)
    glass.userData.glass = true
    parts.push(glass)
    const lt = new THREE.RectAreaLight('#e3edf8', 5.5, g.w, g.h)
    lt.position.set(L - 0.02, cy, g.off)
    lt.lookAt(L - 2, cy, g.off)
    lights.push(lt)
  } else {
    parts.push(box(0.02, 0.22, 0.34, M.walnut, L - 0.012, H - 0.65, 0))
  }
  parts.forEach((m) => {
    m.castShadow = !m.userData.glass
    m.receiveShadow = true
    grp.add(m)
  })
  return { obj: grp, lights }
}

// ---------- Roof slopes

/** Both slopes, with a real opening wherever a roof window is accepted (v41 `buildSlopes`). */
export function buildSlopes(geo: Geometry, items: readonly Item[], mats: SceneMats): Record<SideKey, THREE.Mesh> {
  const { L, SLEN } = geo
  const ok = skyHolesOk(geo, items)
  const out = {} as Record<SideKey, THREE.Mesh>
  SIDES.forEach(([side]) => {
    const s = new THREE.Shape()
    s.moveTo(0, 0)
    s.lineTo(L, 0)
    s.lineTo(L, SLEN)
    s.lineTo(0, SLEN)
    s.closePath()
    items
      .filter((i): i is SkylightItem => i.type === 'skylight' && i.slope === side && ok.has(i.id))
      .forEach((it) => {
        const r = skyRect(geo, it)
        s.holes.push(rectPath(r.x0, r.s0, r.x1, r.s1))
      })
    const g = new THREE.ShapeGeometry(s)
    const pos = g.attributes.position
    for (let i = 0; i < pos.count; i++) {
      const [x, y, z] = slopePoint(geo, side, pos.getX(i), pos.getY(i))
      pos.setXYZ(i, x, y, z)
    }
    g.computeVertexNormals()
    const m = new THREE.Mesh(g, mats.panel)
    m.castShadow = m.receiveShadow = true
    out[side] = m
  })
  return out
}

// ---------- Plasterboard in insulated bays, and the ridge board

/**
 * v41 `buildBoard`: the ridge board over the bays still open to the rafters
 * (into the rafter group) and, per slope, the plasterboard ceilings with
 * window openings and the end caps. `today` leaves the plasterboard out.
 */
export function buildBoard(geo: Geometry, plan: Slice, mats: SceneMats, today: boolean): { ridge: THREE.Group; S: THREE.Group; N: THREE.Group } {
  const { BAYS, EDGES, H, BOARD_D: d } = geo
  const B = new Set(plan.options.board)
  const out = { ridge: new THREE.Group(), S: new THREE.Group(), N: new THREE.Group() }
  const ridge: [number, number][] = []
  BAYS.forEach((_, i) => {
    if (B.has(i)) return
    const last = ridge.at(-1)
    if (last && last[1] === EDGES[i]) last[1] = EDGES[i + 1]
    else ridge.push([EDGES[i], EDGES[i + 1]])
  })
  ridge.forEach(([a, b]) => {
    const m = new THREE.Mesh(metreUv(new THREE.BoxGeometry(b - a, 0.12, 0.045)), mats.rafter)
    m.position.set((a + b) / 2, H - 0.1, 0)
    m.castShadow = m.receiveShadow = true
    out.ridge.add(m)
  })
  if (!B.size || today) return out
  const ok = skyHolesOk(geo, plan.items)
  SIDES.forEach(([side, sign]) => {
    const runs: { i0: number; i1: number; x0: number; x1: number; o: boolean }[] = []
    BAYS.forEach((_, i) => {
      if (!B.has(i)) return
      const o = plan.options.knee[side].includes(i)
      const last = runs.at(-1)
      if (last && last.o === o && last.i1 === i - 1) {
        last.i1 = i
        last.x1 = EDGES[i + 1]
      } else runs.push({ i0: i, i1: i, x0: EDGES[i], x1: EDGES[i + 1], o })
    })
    runs.forEach((r) => {
      const { v0, vTop } = boardSpan(geo, r.o)
      const s = new THREE.Shape()
      s.moveTo(r.x0, v0)
      s.lineTo(r.x1, v0)
      s.lineTo(r.x1, vTop)
      s.lineTo(r.x0, vTop)
      s.closePath()
      plan.items
        .filter((i): i is SkylightItem => i.type === 'skylight' && i.slope === side && ok.has(i.id))
        .forEach((it) => {
          const q = skyRect(geo, it)
          if (q.x0 >= r.x0 && q.x1 <= r.x1 && q.s0 > v0 && q.s1 < vTop) s.holes.push(rectPath(q.x0, q.s0, q.x1, q.s1))
        })
      const g = new THREE.ShapeGeometry(s)
      const pos = g.attributes.position
      for (let k = 0; k < pos.count; k++) {
        const [x, y, z] = slopePoint(geo, side, pos.getX(k), pos.getY(k), d)
        pos.setXYZ(k, x, y, z)
      }
      g.computeVertexNormals()
      const m = new THREE.Mesh(g, mats.board)
      m.castShadow = m.receiveShadow = true
      out[side].add(m)
      // close the cavity where the insulated part stops next to an open bay
      const prof = boardCapProfile(geo, r.o)
      ;(
        [
          [r.x0, r.i0 > 0 && !B.has(r.i0 - 1)],
          [r.x1, r.i1 < BAYS.length - 1 && !B.has(r.i1 + 1)],
        ] as [number, boolean][]
      ).forEach(([x, cap]) => {
        if (!cap) return
        const cs = new THREE.Shape()
        prof.forEach(([pz, py], k) => (k ? cs.lineTo(pz, py) : cs.moveTo(pz, py)))
        cs.closePath()
        const cg = profileGeo(cs)
        if (sign < 0) cg.scale(1, 1, -1)
        const c = new THREE.Mesh(cg, mats.board)
        c.position.x = x
        out[side].add(c)
      })
    })
  })
  return out
}

// ---------- Knee walls

/**
 * Knee walls bay by bay (v41 `buildKnee`). An opened bay has no knee wall and
 * finished floor out to the eaves, leaving any stair opening behind it.
 * `today`: as the attic is now, every knee wall in place.
 */
export function buildKnee(geo: Geometry, plan: Slice, mats: SceneMats, today: boolean): THREE.Group {
  const { BAYS, EDGES, KZ, HALF, KNEE_H, L } = geo
  const { M } = mats
  const g = new THREE.Group()
  const holesHALF = stairHoles(geo, plan, HALF).holes
  SIDES.forEach(([side, sign]) => {
    const open = new Set(today ? [] : plan.options.knee[side])
    const runs: { x0: number; x1: number; o: boolean }[] = []
    BAYS.forEach((_, i) => {
      const x0 = EDGES[i]
      const x1 = EDGES[i + 1]
      const o = open.has(i)
      const last = runs.at(-1)
      if (last && last.o === o && Math.abs(last.x1 - x0) < 1e-6) last.x1 = x1
      else runs.push({ x0, x1, o })
    })
    runs.forEach(({ x0, x1, o }) => {
      const w = x1 - x0
      const xc = (x0 + x1) / 2
      if (o) {
        const za = sign > 0 ? KZ : -HALF
        const zb = sign > 0 ? HALF : -KZ
        const hs = holesHALF.map((p) => clipBox(p, x0 + 0.001, x1 - 0.001, za + 0.001, zb - 0.001)).filter((p): p is NonNullable<typeof p> => !!p)
        const f = new THREE.Mesh(floorGeo(floorShape(x0, x1, za, zb, hs)), mats.floor)
        f.receiveShadow = true
        g.add(f)
        return
      }
      const strip = new THREE.Mesh(planeM(w, HALF - KZ), M.sub)
      strip.rotation.x = -Math.PI / 2
      strip.position.set(xc, -0.002, (sign * (KZ + HALF)) / 2)
      strip.receiveShadow = true
      g.add(strip)
      const knee = new THREE.Mesh(planeM(w, KNEE_H), mats.wall)
      knee.position.set(xc, KNEE_H / 2, sign * KZ)
      knee.receiveShadow = true
      g.add(knee)
      g.add(box(w, 0.07, 0.014, M.trim, xc, 0.035, sign * (KZ - 0.007)))
      ;(
        [
          [x0, x0 > 0.01],
          [x1, x1 < L - 0.01],
        ] as [number, boolean][]
      ).forEach(([x, end]) => {
        if (end) g.add(box(0.045, KNEE_H, 0.06, M.trim, x, KNEE_H / 2, sign * (KZ + 0.03))) // post where the wall stops
      })
    })
  })
  return g
}

// ---------- Floors

/**
 * The attic floor with its stair openings, the ceiling of the floor below
 * (with the same openings) and the cut edges round each opening (v41 `buildFloor`).
 */
export function buildFloors(geo: Geometry, plan: Slice, mats: SceneMats): { floor: THREE.Mesh; ceil: THREE.Mesh; edge: THREE.Mesh } {
  const { L, KZ } = geo
  const B = plan.options.below
  const floor = new THREE.Mesh(floorGeo(floorShape(0, L, -KZ, KZ, stairHoles(geo, plan, KZ).holes)), mats.floor)
  floor.receiveShadow = true
  const hb = hallRect(geo, B)
  const holesHw = stairHoles(geo, plan, B.hw).holes
  const cholds = holesHw.map((p) => clipBox(p, hb.xw + 0.02, L - 0.02, hb.za + 0.02, hb.zb - 0.02)).filter((p): p is NonNullable<typeof p> => !!p)
  const cg = floorGeo(floorShape(hb.xw, L, hb.za, hb.zb, cholds))
  cg.translate(0, -B.slab, 0)
  const ceil = new THREE.Mesh(cg, mats.M2.ceil)
  ceil.receiveShadow = ceil.castShadow = true
  const pos: number[] = []
  holesHw.forEach((p) =>
    p.forEach(([x0, z0], i) => {
      const [x1, z1] = p[(i + 1) % p.length]
      pos.push(x0, 0, z0, x1, 0, z1, x1, -B.slab, z1, x0, 0, z0, x1, -B.slab, z1, x0, -B.slab, z0)
    }),
  )
  const eg = new THREE.BufferGeometry()
  eg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  eg.computeVertexNormals()
  const edge = new THREE.Mesh(eg, mats.M2.wall)
  edge.receiveShadow = edge.castShadow = true
  return { floor, ceil, edge }
}

// ---------- Headroom zones

/** The zones overlay: `computeZones` painted into a canvas texture on a plane just above the floor. */
export function buildZones(geo: Geometry, plan: Slice): THREE.Mesh {
  const z = computeZones(geo, plan)
  const canvas = document.createElement('canvas')
  canvas.width = z.nx
  canvas.height = z.nz
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const img = ctx.createImageData(z.nx, z.nz)
    for (let k = 0; k < z.cells.length; k++) {
      const c = z.cells[k]
      const o = k * 4
      if (c === ZONE_STAND) img.data.set([60, 160, 105, 95], o)
      else if (c === ZONE_BOA) img.data.set([214, 158, 52, 80], o)
    }
    ctx.putImageData(img, 0, 0)
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(geo.L, 2 * geo.KZ),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }),
  )
  m.rotation.x = -Math.PI / 2
  m.position.set(geo.L / 2, 0.006, 0)
  m.renderOrder = 2
  m.userData.overlay = true
  return m
}
