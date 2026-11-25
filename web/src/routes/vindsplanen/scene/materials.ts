// Surface materials and procedural textures for the Vindsplanen scene, ported
// from v41 (planning/140-vindsplanen-ref/vindsplanen-v41.html, lines 377–401
// for the option colours and 592–643 for the painting and the materials).
// Material *ids* live in lib/vindsplanen/items.ts; their looks live here.
//
// Textures are painted into in-memory canvases (CanvasTexture), so nothing
// needs blob: URLs or workers (CSP: img-src 'self' data:).

import * as THREE from 'three'
import type { MaterialCategory } from '../../../lib/vindsplanen/items'
import type { Materials } from '../../../lib/vindsplanen/plan'

export interface SurfaceStyle {
  base: string
  kind: 'plank' | 'solid' | 'speckle'
  rows?: number
  vary?: number
  rough: number
}

/** v41 `MATS` options, keyed as MATERIAL_OPTIONS (base null = "same as ceiling"). */
export const SURFACES: Record<MaterialCategory, Record<string, Omit<SurfaceStyle, 'base'> & { base: string | null }>> = {
  floor: {
    oak: { base: '#b98c5a', kind: 'plank', rows: 8, vary: 0.1, rough: 0.5 },
    whiteoak: { base: '#dcc8a8', kind: 'plank', rows: 8, vary: 0.06, rough: 0.5 },
    pine: { base: '#d6aa72', kind: 'plank', rows: 6, vary: 0.12, rough: 0.55 },
    smoked: { base: '#6e4b31', kind: 'plank', rows: 8, vary: 0.12, rough: 0.45 },
    grey: { base: '#aba59c', kind: 'plank', rows: 8, vary: 0.07, rough: 0.6 },
    lino: { base: '#8e9f88', kind: 'solid', rough: 0.55 },
    chip: { base: '#c8a679', kind: 'speckle', rough: 0.9 },
  },
  panel: {
    pine: { base: '#dcc093', kind: 'plank', rows: 10, vary: 0.09, rough: 0.7 },
    white: { base: '#efede7', kind: 'plank', rows: 10, vary: 0.015, rough: 0.85 },
    grey: { base: '#cdd2ce', kind: 'plank', rows: 10, vary: 0.015, rough: 0.85 },
    green: { base: '#3e5a4b', kind: 'plank', rows: 10, vary: 0.03, rough: 0.8 },
    board: { base: '#f2f0eb', kind: 'solid', rough: 0.92 },
  },
  rafter: {
    natural: { base: '#b98152', kind: 'solid', rough: 0.7 },
    white: { base: '#efece6', kind: 'solid', rough: 0.85 },
    black: { base: '#2b2826', kind: 'solid', rough: 0.8 },
    ceiling: { base: null, kind: 'solid', rough: 0.85 },
  },
  walls: {
    white: { base: '#eeebe5', kind: 'solid', rough: 0.92 },
    warm: { base: '#ece2d3', kind: 'solid', rough: 0.92 },
    sage: { base: '#a8b49f', kind: 'solid', rough: 0.92 },
    clay: { base: '#c79f86', kind: 'solid', rough: 0.92 },
    navy: { base: '#36455c', kind: 'solid', rough: 0.9 },
    pine: { base: '#dcc093', kind: 'plank', rows: 10, vary: 0.09, rough: 0.7 },
  },
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

/** v41 `rng`: mulberry32, so the boards paint exactly as in the artifact. */
function rng(seed: number): () => number {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shade(hex: string, k: number): string {
  const c = new THREE.Color(hex)
  return `rgb(${clamp(c.r * 255 * k, 0, 255) | 0},${clamp(c.g * 255 * k, 0, 255) | 0},${clamp(c.b * 255 * k, 0, 255) | 0})`
}

/** v41 `paintSurface`: colour into `canvas`, board seams as grooves into `bump`. */
function paintSurface(canvas: HTMLCanvasElement, opt: SurfaceStyle, seed: number, bump: HTMLCanvasElement | null) {
  const S = canvas.width
  const Hh = canvas.height
  const g = canvas.getContext('2d')
  if (!g) return
  const r = rng(seed || 11)
  const b = bump ? bump.getContext('2d') : null
  g.fillStyle = opt.base
  g.fillRect(0, 0, S, Hh)
  if (b) {
    b.fillStyle = '#fff'
    b.fillRect(0, 0, S, Hh)
  }
  if (opt.kind === 'speckle') {
    for (let i = 0; i < (S * Hh) / 26; i++) {
      g.globalAlpha = 0.45
      g.fillStyle = shade(opt.base, 0.72 + r() * 0.55)
      g.fillRect(r() * S, r() * Hh, 1 + r() * 2.5, 1 + r() * 2)
    }
    g.globalAlpha = 1
    return
  }
  if (opt.kind !== 'plank') {
    for (let i = 0; i < (S * Hh) / 40; i++) {
      g.globalAlpha = 0.035
      g.fillStyle = shade(opt.base, 0.85 + r() * 0.3)
      g.fillRect(r() * S, r() * Hh, 2, 2)
    }
    g.globalAlpha = 1
    return
  }
  const rows = opt.rows ?? 8
  const vary = opt.vary ?? 0
  const rh = Hh / rows
  const k = S / 512
  for (let i = 0; i < rows; i++) {
    const y = i * rh
    const jx = r() * S
    ;[
      [0, jx],
      [jx, S],
    ].forEach(([a, bx]) => {
      g.fillStyle = shade(opt.base, 1 + (r() - 0.5) * 2 * vary)
      g.fillRect(a, y, bx - a, rh)
      g.strokeStyle = shade(opt.base, 0.66)
      for (let j = 0; j < 10; j++) {
        g.globalAlpha = 0.06 + r() * 0.07
        g.lineWidth = (0.5 + r() * 1.2) * k
        g.beginPath()
        const gy = y + r() * rh
        const ph = r() * 6
        const amp = rh * (0.04 + r() * 0.08)
        g.moveTo(a, gy)
        for (let x = a; x <= bx; x += 14 * k) g.lineTo(x, gy + Math.sin((x * 0.012) / k + ph) * amp)
        g.stroke()
      }
      if (r() < 0.5) {
        g.globalAlpha = 0.18
        g.fillStyle = shade(opt.base, 0.6)
        g.beginPath()
        g.ellipse(a + r() * (bx - a), y + rh * (0.3 + r() * 0.4), 4 * k, 2.5 * k, 0, 0, Math.PI * 2)
        g.fill()
      }
      g.globalAlpha = 1
      g.fillStyle = shade(opt.base, 0.55)
      g.fillRect(a, y, 2 * k, rh)
      if (b) {
        b.fillStyle = '#777'
        b.fillRect(a, y, 2 * k, rh)
      }
    })
    g.fillStyle = shade(opt.base, 0.58)
    g.fillRect(0, y, S, 2 * k)
    if (b) {
      b.fillStyle = '#666'
      b.fillRect(0, y, S, 2 * k)
    }
  }
}

const std = (o: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, ...o })
const fabric = (color: string, rough?: number) =>
  new THREE.MeshPhysicalMaterial({ color, roughness: rough || 0.92, sheen: 0.7, sheenRoughness: 0.75, sheenColor: new THREE.Color('#ffffff') })

export type TrimMat =
  | 'sub' | 'lower' | 'trim' | 'oak' | 'oakDark' | 'walnut' | 'metal' | 'brass'
  | 'linen' | 'duvet' | 'sage' | 'sofa' | 'rug' | 'frame' | 'sill' | 'glass' | 'clash'

/** Every shared material of one scene. `shared` lists them so object disposal skips them. */
export interface SceneMats {
  floor: THREE.MeshStandardMaterial
  panel: THREE.MeshStandardMaterial
  rafter: THREE.MeshStandardMaterial
  wall: THREE.MeshStandardMaterial
  /** The plasterboard of insulated bays. */
  board: THREE.MeshStandardMaterial
  M: Record<TrimMat, THREE.Material>
  /** The floor below: oak floor, walls, ceiling. */
  M2: { floor: THREE.MeshStandardMaterial; wall: THREE.MeshStandardMaterial; ceil: THREE.MeshStandardMaterial }
  /** Dimension lines and measuring highlights. */
  dim: THREE.LineBasicMaterial
  hl: THREE.MeshBasicMaterial
  shared: Set<THREE.Material>
  /** Apply the plan's surface choices (v41 applyAllMats). */
  apply(materials: Materials): void
  dispose(): void
}

export function createMats(maxAnisotropy: number): SceneMats {
  const texCache = new Map<string, { map: THREE.CanvasTexture; bump: THREE.CanvasTexture }>()
  const getTex = (cat: MaterialCategory, key: string) => {
    const id = cat + ':' + key
    const hit = texCache.get(id)
    if (hit) return hit
    const c = document.createElement('canvas')
    const bmp = document.createElement('canvas')
    c.width = c.height = bmp.width = bmp.height = 1024
    paintSurface(c, SURFACES[cat][key] as SurfaceStyle, id.length * 97 + key.charCodeAt(0), bmp)
    const mk = (cv: HTMLCanvasElement, srgb: boolean) => {
      const t = new THREE.CanvasTexture(cv)
      t.wrapS = t.wrapT = THREE.RepeatWrapping
      t.repeat.set(1 / 1.2, 1 / 1.2)
      t.anisotropy = maxAnisotropy
      if (srgb) t.colorSpace = THREE.SRGBColorSpace
      return t
    }
    const out = { map: mk(c, true), bump: mk(bmp, false) }
    texCache.set(id, out)
    return out
  }

  const M: Record<TrimMat, THREE.Material> = {
    sub: std({ color: '#b49c7c' }),
    lower: std({ color: '#b5a690', roughness: 0.7 }),
    trim: std({ color: '#f2f0eb', roughness: 0.55 }),
    oak: std({ color: '#b98a5c', roughness: 0.5 }),
    oakDark: std({ color: '#8b6440', roughness: 0.5 }),
    walnut: std({ color: '#5e4130', roughness: 0.45 }),
    metal: std({ color: '#2b2b2b', metalness: 0.8, roughness: 0.35 }),
    brass: std({ color: '#b8955a', metalness: 1, roughness: 0.32 }),
    linen: fabric('#f3f0e8'),
    duvet: fabric('#7f909c'),
    sage: fabric('#6f8a7c'),
    sofa: fabric('#8d9ba2'),
    rug: fabric('#c4b096', 1),
    frame: std({ color: '#f4f2ee', roughness: 0.4 }),
    sill: std({ color: '#f4f2ee', roughness: 0.35 }),
    glass: new THREE.MeshPhysicalMaterial({ color: '#dfeaf2', roughness: 0.05, metalness: 0, transparent: true, opacity: 0.16, depthWrite: false }),
    clash: new THREE.MeshBasicMaterial({ color: '#d2401c', transparent: true, opacity: 0.28, depthWrite: false }),
  }
  const floorT = getTex('floor', 'oak')
  const M2 = {
    floor: std({ roughness: 0.5, map: floorT.map, bumpMap: floorT.bump }),
    wall: std({ color: '#f1efeb', roughness: 0.92, side: THREE.DoubleSide }),
    ceil: std({ color: '#f6f5f2', roughness: 0.95, side: THREE.DoubleSide }),
  }
  const mats = {
    floor: std(),
    panel: std({ side: THREE.DoubleSide }),
    rafter: std(),
    wall: std({ side: THREE.DoubleSide }),
    board: std({ color: '#f2f0eb', roughness: 0.92, side: THREE.DoubleSide }),
  }
  const dim = new THREE.LineBasicMaterial({ color: '#c2410c', depthTest: false, transparent: true })
  const hl = new THREE.MeshBasicMaterial({ color: '#e8762b', transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide })
  const shared = new Set<THREE.Material>([...Object.values(mats), ...Object.values(M), ...Object.values(M2), dim, hl])

  const applyMat = (mat: THREE.MeshStandardMaterial, cat: MaterialCategory, key: string, panelKey: string) => {
    let opt = (SURFACES[cat][key] ?? Object.values(SURFACES[cat])[0]) as SurfaceStyle
    if (cat === 'rafter' && key === 'ceiling') opt = { ...(SURFACES.panel[panelKey] as SurfaceStyle), kind: 'solid' }
    if (opt.kind === 'solid') {
      mat.map = null
      mat.bumpMap = null
      mat.color.set(opt.base)
    } else {
      const t = getTex(cat, key)
      mat.map = t.map
      mat.bumpMap = t.bump
      mat.bumpScale = 1.2
      mat.color.set('#ffffff')
    }
    mat.roughness = opt.rough
    mat.needsUpdate = true
  }

  return {
    ...mats,
    M,
    M2,
    dim,
    hl,
    shared,
    apply(m) {
      applyMat(mats.floor, 'floor', m.floor, m.panel)
      applyMat(mats.panel, 'panel', m.panel, m.panel)
      applyMat(mats.rafter, 'rafter', m.rafter, m.panel)
      applyMat(mats.wall, 'walls', m.walls, m.panel)
    },
    dispose() {
      shared.forEach((m) => m.dispose())
      texCache.forEach((t) => {
        t.map.dispose()
        t.bump.dispose()
      })
      texCache.clear()
    },
  }
}

// ---------- Sky and sun (v41 lines 402–407, 552–582)

/** v41 `SUNS`: offset from the attic's middle (×1.6), intensity and colour. */
export const SUN_STYLE = {
  morning: { off: [7, 3.6, 3.2], int: 3.4, color: '#ffe6c4' },
  midday: { off: [0.6, 6.4, 5.6], int: 3.6, color: '#fff4e4' },
  evening: { off: [-7, 3.0, 3.6], int: 3.0, color: '#ffd2a1' },
  overcast: { off: [1, 8, 2], int: 0, color: '#ffffff' },
} as const

export const ENV_INTENSITY = 0.75
export const EXPOSURE = 1.12

/** An equirectangular gradient used as background and as soft ambient light. */
export function skyTexture(): THREE.DataTexture {
  const stops = (
    [
      [0, '#7fa6d4'],
      [0.38, '#b9d0e6'],
      [0.5, '#e8eef1'],
      [0.52, '#d3cfc4'],
      [1, '#a8a294'],
    ] as const
  ).map(([t, h]) => [t, new THREE.Color(h)] as const)
  const w = 256
  const h = 128
  const data = new Float32Array(w * h * 4)
  const c = new THREE.Color()
  for (let j = 0; j < h; j++) {
    const t = 1 - j / (h - 1)
    let k = 0
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++
    const [t0, c0] = stops[k]
    const [t1, c1] = stops[k + 1]
    c.lerpColors(c0, c1, clamp((t - t0) / (t1 - t0), 0, 1))
    for (let i = 0; i < w; i++) {
      const o = (j * w + i) * 4
      data[o] = c.r
      data[o + 1] = c.g
      data[o + 2] = c.b
      data[o + 3] = 1
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType)
  tex.mapping = THREE.EquirectangularReflectionMapping
  tex.magFilter = tex.minFilter = THREE.LinearFilter
  tex.needsUpdate = true
  return tex
}
