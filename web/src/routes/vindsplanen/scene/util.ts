// Mesh helpers shared by the Vindsplanen builders (v41 lines 645–658,
// 1311–1313, 1381–1397). Pure three.js; no plan geometry here.

import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import type { Pt } from '../../../lib/vindsplanen/stairs'

/** A built part of the scene. Lights are kept outside the cut-away groups (see Scene). */
export interface Built {
  obj: THREE.Object3D
  lights?: THREE.Light[]
  /** Run when the part is disposed, before its resources are freed (e.g. to drop a pending model swap). */
  onDispose?: () => void
}

export function shadowy<T extends THREE.Object3D>(o: T): T {
  o.traverse((m) => {
    if ((m as THREE.Mesh).isMesh) {
      m.castShadow = true
      m.receiveShadow = true
    }
  })
  return o
}

/** A plane whose UVs are in metres, so textures keep their scale. */
export function planeM(w: number, h: number): THREE.PlaneGeometry {
  const g = new THREE.PlaneGeometry(w, h)
  const uv = g.attributes.uv
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w, uv.getY(i) * h)
  return g
}

/**
 * Box-projected UVs in metres for a box-like geometry (plan 141): each vertex
 * takes the two coordinates across its normal's main axis, u along the longer
 * of the two (by the geometry's size), so textures keep their real-world scale
 * and wood grain runs along a part's length. BoxGeometry's own UVs stretch
 * 0–1 over each face whatever its size.
 */
export function metreUv<T extends THREE.BufferGeometry>(g: T): T {
  const pos = g.attributes.position
  const nor = g.attributes.normal
  const uv = g.attributes.uv
  if (!pos || !nor || !uv) return g
  g.computeBoundingBox()
  const size = g.boundingBox ? g.boundingBox.getSize(new THREE.Vector3()).toArray() : [1, 1, 1]
  const p = [0, 0, 0]
  for (let i = 0; i < pos.count; i++) {
    const n = [Math.abs(nor.getX(i)), Math.abs(nor.getY(i)), Math.abs(nor.getZ(i))]
    const axis = n[0] >= n[1] && n[0] >= n[2] ? 0 : n[1] >= n[2] ? 1 : 2
    const [a, b] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1]
    const [u, v] = size[a] >= size[b] ? [a, b] : [b, a]
    p[0] = pos.getX(i)
    p[1] = pos.getY(i)
    p[2] = pos.getZ(i)
    uv.setXY(i, p[u], p[v])
  }
  uv.needsUpdate = true
  return g
}

export function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(metreUv(new THREE.BoxGeometry(w, h, d)), mat)
  m.position.set(x, y, z)
  m.castShadow = m.receiveShadow = true
  return m
}

/** A rounded box (v41 `rb`). */
export function rb(w: number, h: number, d: number, r: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const rr = Math.max(0.001, Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001))
  const m = new THREE.Mesh(metreUv(new RoundedBoxGeometry(w, h, d, 3, rr)), mat)
  m.position.set(x, y, z)
  m.castShadow = m.receiveShadow = true
  return m
}

/** A floor outline (x, z) with holes, as a Shape in (x, −z) for rotateX(−π/2). */
export function floorShape(x0: number, x1: number, z0: number, z1: number, holes: readonly Pt[][]): THREE.Shape {
  const s = new THREE.Shape()
  s.moveTo(x0, -z0)
  s.lineTo(x1, -z0)
  s.lineTo(x1, -z1)
  s.lineTo(x0, -z1)
  s.closePath()
  holes.forEach((pts) => {
    const p = new THREE.Path()
    pts.forEach((q, i) => (i ? p.lineTo(q[0], -q[1]) : p.moveTo(q[0], -q[1])))
    p.closePath()
    s.holes.push(p)
  })
  return s
}

/** A flat floor mesh geometry from `floorShape`, lying at y = 0. */
export function floorGeo(shape: THREE.Shape): THREE.ShapeGeometry {
  const g = new THREE.ShapeGeometry(shape)
  g.rotateX(-Math.PI / 2)
  return g
}

/** A profile drawn in (z, y) turned to stand across the attic (in the y–z plane at x = 0). */
export function profileGeo(shape: THREE.Shape): THREE.ShapeGeometry {
  const g = new THREE.ShapeGeometry(shape)
  g.rotateY(-Math.PI / 2)
  return g
}

export function rectPath(x0: number, y0: number, x1: number, y1: number): THREE.Path {
  const p = new THREE.Path()
  p.moveTo(x0, y0)
  p.lineTo(x1, y0)
  p.lineTo(x1, y1)
  p.lineTo(x0, y1)
  p.closePath()
  return p
}

/** A bar from p to q (v41 `bar`): a box of cross-section w × h. */
export function bar(g: THREE.Object3D, p: readonly number[], q: readonly number[], w: number, h: number, mat: THREE.Material) {
  const A = new THREE.Vector3(p[0], p[1], p[2])
  const B = new THREE.Vector3(q[0], q[1], q[2])
  const d = B.clone().sub(A)
  const len = d.length()
  if (len < 0.01) return
  const m = new THREE.Mesh(new THREE.BoxGeometry(len, h, w), mat)
  m.position.copy(A).add(B).multiplyScalar(0.5)
  m.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), d.normalize())
  m.castShadow = m.receiveShadow = true
  g.add(m)
}

// ---------- Labels: page elements pinned to 3D points (see Scene's label layer)

export type LabelKind = 'dim' | 'big' | 'sign'

export interface LabelData {
  text: string
  kind: LabelKind
}

/** An empty object carrying a label; the Scene projects it every frame. */
export function label(text: string, kind: LabelKind = 'sign'): THREE.Object3D {
  const o = new THREE.Object3D()
  o.userData.label = { text, kind } satisfies LabelData
  return o
}

/** An orange dimension line from a to b with ticks and a label at its middle (v41 `dimLine`). */
export function dimLine(a: readonly number[], b: readonly number[], text: string, mat: THREE.Material, lift = 0, big = false): THREE.Group {
  const g = new THREE.Group()
  const A = new THREE.Vector3(a[0], a[1], a[2])
  const B = new THREE.Vector3(b[0], b[1], b[2])
  const dir = B.clone().sub(A).normalize()
  const tk = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(0.07, 0, 0) : new THREE.Vector3(0, 0.07, 0)
  const ls = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints([A, B, A.clone().add(tk), A.clone().sub(tk), B.clone().add(tk), B.clone().sub(tk)]),
    mat,
  )
  ls.renderOrder = 6
  ls.userData.overlay = true
  g.add(ls)
  const l = label(text, big ? 'big' : 'dim')
  l.position.copy(A).add(B).multiplyScalar(0.5)
  l.position.y += lift
  g.add(l)
  return g
}

/** A highlight box (v41 `hlBox`). */
export function hlBox(mat: THREE.Material, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(Math.max(x1 - x0, 0.01), Math.max(y1 - y0, 0.01), Math.max(z1 - z0, 0.01)), mat)
  m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
  m.renderOrder = 4
  m.userData.overlay = true
  return m
}

// ---------- Disposal

/**
 * Geometries and materials owned by a model template cache (models.ts):
 * instances clone the template and share these, so object disposal must leave
 * them alone; the cache frees them itself when the scene unmounts.
 */
const templateRes = new WeakSet<THREE.BufferGeometry | THREE.Material>()

export function markTemplate(r: THREE.BufferGeometry | THREE.Material) {
  templateRes.add(r)
}

export const isTemplate = (r: THREE.BufferGeometry | THREE.Material) => templateRes.has(r)

/**
 * Free the GPU resources of a built subtree: every geometry, and every
 * material (with its textures) that is not one of the scene's shared ones.
 * Model template geometries and materials (`markTemplate`) are skipped too.
 * Lights get `dispose()` too.
 */
export function disposeObject(root: THREE.Object3D, shared: ReadonlySet<THREE.Material>) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (mesh.geometry && !templateRes.has(mesh.geometry)) mesh.geometry.dispose()
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
    if (mat) {
      for (const m of Array.isArray(mat) ? mat : [mat]) {
        if (shared.has(m) || templateRes.has(m)) continue
        for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose()
        m.dispose()
      }
    }
    if ((o as THREE.Light).isLight) (o as THREE.Light).dispose()
  })
}

export function disposeBuilt(b: Built, shared: ReadonlySet<THREE.Material>) {
  b.onDispose?.()
  disposeObject(b.obj, shared)
  b.lights?.forEach((l) => l.dispose())
}
