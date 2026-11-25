// The model swap in buildFurniture and the template-skipping disposal (plan
// 142): a wrong dispose would free a shared template and blank every copy.

import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { roofZAt } from '../../../lib/vindsplanen/attic'
import type { Item } from '../../../lib/vindsplanen/plan'
import { goldPlan } from '../../../lib/vindsplanen/testkit'
import { furnWarnings } from '../../../lib/vindsplanen/warnings'
import { furnitureChecks } from '../../../lib/vindsplanen/items'
import { buildItem } from './itemsScene'
import type { SceneMats } from './materials'
import type { SceneModels } from './models'
import { disposeBuilt, disposeObject, markTemplate } from './util'

const { plan, geo } = goldPlan('example')
const slice = { items: plan.items.filter((i) => i.type === 'skylight'), options: plan.options }

function fakeMats(): SceneMats {
  const shared = new Set<THREE.Material>()
  const M = new Proxy({} as Record<string, THREE.Material>, {
    get(t, k: string) {
      if (!t[k]) {
        t[k] = new THREE.MeshBasicMaterial()
        shared.add(t[k])
      }
      return t[k]
    },
  })
  return { M, shared } as unknown as SceneMats
}

function template(): THREE.Group {
  const g = new THREE.Group()
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ map: new THREE.Texture() }))
  markTemplate(m.geometry)
  markTemplate(m.material)
  g.add(m)
  return g
}

/** A model cache whose loads resolve when the test says so. */
function fakeModels(result: THREE.Group | null) {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const models: SceneModels = { template: vi.fn(() => gate.then(() => result)), dispose: vi.fn() }
  return { models, release: async () => (release(), await gate, await Promise.resolve(), await Promise.resolve()) }
}

type Box = Extract<Item, { type: 'desk' | 'sofa' | 'dresser' | 'nightstand' | 'wardrobe' | 'rug' }>
const desk = (over: { z?: number; rot?: number } = {}): Box => ({ id: 'd1', type: 'desk', x: geo.L / 2, z: 0, rot: 90, w: 1.2, d: 0.6, h: 0.75, ...over })

const meshes = (o: THREE.Object3D) => {
  const out: THREE.Mesh[] = []
  o.traverse((m) => (m as THREE.Mesh).isMesh && out.push(m as THREE.Mesh))
  return out
}

describe('buildFurniture model swap', () => {
  it('returns the box at once, then swaps in the scaled model inside the same group', async () => {
    const tpl = template()
    const { models, release } = fakeModels(tpl)
    const mats = fakeMats()
    const b = buildItem(geo, slice, desk(), mats, models)
    expect(models.template).toHaveBeenCalledWith('desk.glb')
    const boxes = meshes(b.obj)
    expect(boxes.length).toBeGreaterThan(1)
    const boxDispose = boxes.map((m) => vi.spyOn(m.geometry, 'dispose'))
    await release()
    expect(b.obj.userData.itemId).toBe('d1')
    expect(b.obj.rotation.y).toBeCloseTo(Math.PI / 2)
    expect(b.obj.children).toHaveLength(1)
    const inst = b.obj.children[0]
    expect(inst.userData.model).toBe('desk')
    // 1.2/1.134, 0.75/0.8, 0.6/0.706 (modelFit.test.ts)
    expect(inst.scale.toArray()).toEqual([expect.closeTo(1.058201, 5), expect.closeTo(0.9375, 5), expect.closeTo(0.849858, 5)])
    const [m] = meshes(inst)
    expect(m.geometry).toBe((tpl.children[0] as THREE.Mesh).geometry) // shared, not copied
    boxDispose.forEach((s) => expect(s).toHaveBeenCalled()) // the replaced box parts are freed
  })

  it('keeps the clash overlay when the model comes in', async () => {
    const z = roofZAt(geo, 0.5) // the roof is 0.5 m up here: a 0.75 m desk hits it
    const it = desk({ z, rot: 0 })
    expect(furnWarnings(geo, slice, it, furnitureChecks(it).checks).clash).toBe(true)
    const { models, release } = fakeModels(template())
    const b = buildItem(geo, slice, it, fakeMats(), models)
    await release()
    const overlay = b.obj.children.filter((c) => c.userData.overlay)
    expect(overlay).toHaveLength(1)
    expect(b.obj.children.some((c) => c.userData.model === 'desk')).toBe(true)
  })

  it('leaves an item disposed before the load resolves alone', async () => {
    const { models, release } = fakeModels(template())
    const mats = fakeMats()
    const b = buildItem(geo, slice, desk(), mats, models)
    const before = [...b.obj.children]
    disposeBuilt(b, mats.shared)
    await release()
    expect(b.obj.children).toEqual(before)
  })

  it('still swaps an item whose dispose was a StrictMode replay: disposed but still in the scene', async () => {
    const { models, release } = fakeModels(template())
    const mats = fakeMats()
    const b = buildItem(geo, slice, desk(), mats, models)
    new THREE.Group().add(b.obj)
    disposeBuilt(b, mats.shared)
    await release()
    expect(b.obj.children.map((c) => c.userData.model)).toEqual(['desk'])
  })

  it('keeps the box when the model fails to load', async () => {
    const { models, release } = fakeModels(null)
    const b = buildItem(geo, slice, desk(), fakeMats(), models)
    const before = [...b.obj.children]
    await release()
    expect(b.obj.children).toEqual(before)
  })

  it('does not load a model when none fits, or for beds, wardrobes and rugs', () => {
    const { models } = fakeModels(template())
    const mats = fakeMats()
    buildItem(geo, slice, { id: 's', type: 'sofa', x: 2, z: 0, rot: 0, w: 3, d: 0.75, h: 0.82 }, mats, models)
    buildItem(geo, slice, { id: 'b', type: 'bed', x: 2, z: 0, rot: 0, size: '160×200' } as Item, mats, models)
    buildItem(geo, slice, { id: 'w', type: 'wardrobe', x: 2, z: 0, rot: 0, w: 1, d: 0.6, h: 2 }, mats, models)
    buildItem(geo, slice, { id: 'r', type: 'rug', x: 2, z: 0, rot: 0, w: 2, d: 1.4, h: 0.01 }, mats, models)
    expect(models.template).not.toHaveBeenCalled()
  })
})

describe('disposeObject and model templates', () => {
  it('skips template geometry, materials and their textures but frees the rest', () => {
    const tpl = template()
    const tm = tpl.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
    const spies = [vi.spyOn(tm.geometry, 'dispose'), vi.spyOn(tm.material, 'dispose'), vi.spyOn(tm.material.map!, 'dispose')]
    const root = new THREE.Group()
    const own = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())
    const ownGeo = vi.spyOn(own.geometry, 'dispose')
    const ownMat = vi.spyOn(own.material, 'dispose')
    root.add(tpl.clone(true), tpl.clone(true), own)
    disposeObject(root, new Set())
    spies.forEach((s) => expect(s).not.toHaveBeenCalled())
    expect(ownGeo).toHaveBeenCalled()
    expect(ownMat).toHaveBeenCalled()
  })
})
