// CC0 PBR texture sets for the Vindsplanen scene (plan 141), served from
// public/vindsplanen/tex/<set>/<res>/{color,normal,orm}.jpg — same origin, so
// the CSP's img-src 'self' allows them; no blob: URLs or workers.
// web/public/vindsplanen/ASSETS.md lists the sources and licences.
//
// `orm.jpg` packs ambient occlusion in R and roughness in G, so one texture
// serves as both aoMap and roughnessMap.

import * as THREE from 'three'

export type TexRes = '1k' | '2k'
export type SetName = 'floor-oak' | 'floor-pine' | 'panel' | 'plaster' | 'chipboard' | 'fabric'

export interface SetInfo {
  /** Real-world width (= height) one texture tile covers, metres (ASSETS.md). */
  size: number
  /**
   * Mean albedo of the 1k colour map in *linear* RGB (each pixel decoded from
   * sRGB, then averaged; measured 2026-11-25). Dividing an option's linear
   * colour by it gives the `material.color` tint that lands the surface's
   * average on that option.
   */
  albedo: readonly [number, number, number]
  /** Mean of the roughness channel (orm G), 0–1. */
  rough: number
  /** Mean of the ambient-occlusion channel (orm R), 0–1. */
  ao: number
  /** The boards run along v (up the image); rotate a quarter turn to run them along u. */
  boardsAlongV?: boolean
}

export const SETS: Readonly<Record<SetName, SetInfo>> = {
  'floor-oak': { size: 1.7, albedo: [0.3325, 0.2183, 0.1274], rough: 0.377, ao: 0.982 },
  'floor-pine': { size: 1.5, albedo: [0.1925, 0.0998, 0.0419], rough: 0.862, ao: 0.961 },
  panel: { size: 1.8, albedo: [0.4614, 0.3849, 0.3401], rough: 0.524, ao: 0.95, boardsAlongV: true },
  plaster: { size: 1.0, albedo: [0.2735, 0.2455, 0.2006], rough: 0.907, ao: 0.673 },
  chipboard: { size: 2.51, albedo: [0.507, 0.3184, 0.1722], rough: 0.581, ao: 0.94 },
  fabric: { size: 0.27, albedo: [0.2863, 0.4108, 0.6198], rough: 0.718, ao: 0.772 },
}

export interface TexSet {
  map: THREE.Texture
  normalMap: THREE.Texture
  orm: THREE.Texture
}

export interface TexSetCache {
  /**
   * The set's three textures, loaded once per name + resolution. They are
   * templates: materials use `clone()`s carrying their own repeat (clones share
   * the image and, with equal sampling settings, one GPU texture).
   */
  loadSet(name: SetName, res: TexRes, aniso: number): Promise<TexSet>
  /** The set if it has already loaded, else undefined. */
  peek(name: SetName, res: TexRes): TexSet | undefined
  /** Forget every set of another resolution (after a quality change). */
  keepOnly(res: TexRes): void
  dispose(): void
}

const texUrl = (name: SetName, res: TexRes, file: string) => `${import.meta.env.BASE_URL}vindsplanen/tex/${name}/${res}/${file}.jpg`

export function createTexSetCache(): TexSetCache {
  const loader = new THREE.TextureLoader()
  const cache = new Map<string, { res: TexRes; promise: Promise<TexSet>; value?: TexSet }>()
  let disposed = false
  const free = (s: TexSet) => {
    s.map.dispose()
    s.normalMap.dispose()
    s.orm.dispose()
  }
  const load = async (name: SetName, res: TexRes, file: string, srgb: boolean, aniso: number) => {
    const t = await loader.loadAsync(texUrl(name, res, file))
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.anisotropy = aniso
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
    return t
  }
  return {
    loadSet(name, res, aniso) {
      const key = `${name}@${res}`
      const hit = cache.get(key)
      if (hit) return hit.promise
      const parts = [load(name, res, 'color', true, aniso), load(name, res, 'normal', false, aniso), load(name, res, 'orm', false, aniso)]
      const entry: { res: TexRes; promise: Promise<TexSet>; value?: TexSet } = {
        res,
        promise: Promise.allSettled(parts).then((r) => {
          const ok = r.flatMap((x) => (x.status === 'fulfilled' ? [x.value] : []))
          if (ok.length < 3 || disposed) {
            ok.forEach((t) => t.dispose())
            const failed = r.find((x): x is PromiseRejectedResult => x.status === 'rejected')
            throw failed ? failed.reason : new Error('texture cache disposed')
          }
          const [map, normalMap, orm] = ok
          const set = { map, normalMap, orm }
          if (cache.get(key) === entry) entry.value = set
          else free(set) // dropped while loading
          return set
        }),
      }
      cache.set(key, entry)
      return entry.promise
    },
    peek(name, res) {
      return cache.get(`${name}@${res}`)?.value
    },
    keepOnly(res) {
      cache.forEach((e, k) => {
        if (e.res === res) return
        if (e.value) free(e.value)
        cache.delete(k)
      })
    },
    dispose() {
      disposed = true
      cache.forEach((e) => e.value && free(e.value))
      cache.clear()
    },
  }
}
