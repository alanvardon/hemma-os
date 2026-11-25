// CC0 furniture models (plan 142): one GLTFLoader cache per scene. Each .glb
// loads once into a template that lives as long as the scene; items get
// `template.clone(true)`, which shares the template's geometries, materials
// and textures. Those are registered with `markTemplate`, so disposing an
// item (disposeObject) leaves them alone; `dispose()` frees them when the
// scene unmounts. The scene's environment map lights the models' standard
// materials like every other surface.
//
// CSP: the .glb files embed their JPEGs. Stock GLTFLoader decodes embedded
// images through a blob: URL, which img-src/connect-src forbid, so the
// `cspImages` plugin decodes them with createImageBitmap(Blob) instead — no
// URL, no worker.

import * as THREE from 'three'
import { GLTFLoader, type GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { markTemplate } from './util'

const modelUrl = (file: string) => `${import.meta.env.BASE_URL}vindsplanen/models/${file}`

export interface SceneModels {
  /** The template for a model file, or null if it failed to load (warned once; not retried). */
  template(file: string): Promise<THREE.Group | null>
  /** Free the templates' GPU resources (scene unmount). */
  dispose(): void
}

/** Decode a GLB's embedded images without blob: URLs (see the note at the top). */
function cspImages(parser: GLTFParser) {
  const stock = parser.loadImageSource.bind(parser)
  const cache = new Map<number, Promise<THREE.Texture>>()
  parser.loadImageSource = (sourceIndex, loader) => {
    const def = parser.json.images?.[sourceIndex]
    if (def?.bufferView === undefined || typeof createImageBitmap === 'undefined') return stock(sourceIndex, loader)
    let p = cache.get(sourceIndex)
    if (!p) {
      p = parser
        .getDependency('bufferView', def.bufferView)
        .then((view: ArrayBuffer) => createImageBitmap(new Blob([view], { type: def.mimeType }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }))
        .then((bitmap) => {
          const tex = new THREE.Texture(bitmap)
          tex.needsUpdate = true
          tex.userData.mimeType = def.mimeType
          return tex
        })
      cache.set(sourceIndex, p)
      return p
    }
    return p.then((t) => t.clone())
  }
  return { name: 'VP_csp_images' }
}

export function createModels(maxAnisotropy: number): SceneModels {
  const loader = new GLTFLoader().register(cspImages)
  const cache = new Map<string, Promise<THREE.Group | null>>()
  const loaded: THREE.Group[] = []
  const anisotropy = Math.min(8, maxAnisotropy)

  const free = (root: THREE.Object3D) => {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.geometry.dispose()
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose()
        m.dispose()
      }
    })
  }

  return {
    template(file) {
      const url = modelUrl(file)
      let p = cache.get(url)
      if (!p) {
        p = loader.loadAsync(url).then(
          (gltf) => {
            const root = gltf.scene
            root.traverse((o) => {
              const mesh = o as THREE.Mesh
              if (!mesh.isMesh) return
              mesh.castShadow = mesh.receiveShadow = true
              markTemplate(mesh.geometry)
              for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
                markTemplate(m)
                for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.anisotropy = anisotropy
              }
            })
            loaded.push(root)
            return root
          },
          (err: unknown) => {
            console.warn(`Vindsplanen: furniture model ${file} did not load; keeping the box.`, err)
            return null
          },
        )
        cache.set(url, p)
      }
      return p
    },
    // Frees the GPU side only: the templates stay usable (three uploads them
    // again on next use), so a StrictMode effect replay or a load still in
    // flight cannot leave an item holding a dead template.
    dispose() {
      loaded.forEach(free)
    },
  }
}
