// Surface materials and procedural textures for the Vindsplanen scene, ported
// from v41 (planning/140-vindsplanen-ref/vindsplanen-v41.html, lines 377–401
// for the option colours and 592–643 for the painting and the materials).
// Material *ids* live in lib/vindsplanen/items.ts; their looks live here.
//
// The v41 looks are painted into in-memory canvases (CanvasTexture), so
// nothing needs blob: URLs or workers (CSP: img-src 'self' data:). They show
// on the first frame and stay if the CC0 PBR sets (textures.ts, plan 141)
// fail to load; once a set has loaded it replaces the painted look.

import * as THREE from 'three'
import type { MaterialCategory } from '../../../lib/vindsplanen/items'
import type { Materials } from '../../../lib/vindsplanen/plan'
import { createTexSetCache, SETS, type SetName, type TexRes, type TexSet } from './textures'

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
  /** The PBR texture resolution; a change reloads the sets and swaps them in when ready. */
  setRes(res: TexRes): void
  dispose(): void
}

// ---------- PBR looks (plan 141)

/** How a surface option maps onto a CC0 texture set (textures.ts). */
export interface PbrLook {
  set: SetName
  /**
   * true: the set's colour map, tinted so its mean lands on `base` (wood,
   * chipboard, fabric). false: painted — flat `base` with the set's relief
   * (normal) and roughness/AO only.
   */
  map: boolean
  base: string
  /** The option's mean roughness; the set's roughness map varies around it. */
  rough: number
  normalScale?: number
}

/** Painted plaster: a calmer relief than the raw plaster scan. */
const PLASTER_RELIEF = 0.7

/** The PBR look of a surface option (the persisted option ids never change; only their looks). */
export function pbrLook(cat: MaterialCategory, key: string, opt: SurfaceStyle): PbrLook {
  const look = (set: SetName, map: boolean, normalScale?: number): PbrLook => ({ set, map, base: opt.base, rough: opt.rough, normalScale })
  if (cat === 'floor') {
    if (key === 'lino') return look('plaster', false, 0.15)
    if (key === 'chip') return look('chipboard', true)
    return look(key === 'pine' || key === 'smoked' ? 'floor-pine' : 'floor-oak', true)
  }
  if (cat === 'rafter') return look('floor-pine', false, 0.25) // solid timber: grain relief only, the option's colour
  if (key === 'pine') return look('panel', true) // panel or walls in pine panelling
  if (cat === 'panel' && key !== 'board') return look('panel', false) // painted panelling
  return look('plaster', false, PLASTER_RELIEF)
}

/**
 * `material.color` for a set's colour map so its mean (linear) albedo lands on
 * `base`: per channel base / mean, in linear space. Capped at 4× so a pale
 * option on a dark scan cannot blow the bright grain out to white.
 */
export function tintFor(base: string, albedo: readonly [number, number, number]): THREE.Color {
  const t = new THREE.Color(base)
  return new THREE.Color(clamp(t.r / albedo[0], 0, 4), clamp(t.g / albedo[1], 0, 4), clamp(t.b / albedo[2], 0, 4))
}

/** At most this much average occlusion from a set's AO map (the plaster and fabric scans are deep). */
const MAX_MEAN_AO = 0.1

let warned = false

interface Slot {
  mat: THREE.MeshStandardMaterial
  /** Texture clones this material owns (map, normal, orm): disposed when replaced. */
  owned: THREE.Texture[]
  /** The look last asked for, and what to show until (or unless) it loads. */
  last: { look: PbrLook; fallback: () => void } | null
  /** `lookKey@res` of the PBR look on screen, or null for the fallback. */
  showing: string | null
  /** `lookKey@res` being waited for. */
  want: string | null
}

export function createMats(maxAnisotropy: number, initialRes: TexRes = '1k'): SceneMats {
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

  // ----- PBR swapping: each textured material shows its canvas (or plain)
  // look at once and swaps to its CC0 set when that has loaded.
  const sets = createTexSetCache()
  let res = initialRes
  let disposed = false
  const slots = new Map<THREE.MeshStandardMaterial, Slot>()
  const slotOf = (mat: THREE.MeshStandardMaterial): Slot => {
    let s = slots.get(mat)
    if (!s) slots.set(mat, (s = { mat, owned: [], last: null, showing: null, want: null }))
    return s
  }
  const release = (s: Slot) => {
    s.owned.forEach((t) => t.dispose())
    s.owned = []
  }
  /** Back to the non-PBR look: clear the PBR maps and free their clones. */
  const unPbr = (s: Slot) => {
    const m = s.mat
    m.normalMap = m.roughnessMap = m.aoMap = null
    release(s)
    s.showing = null
  }
  const showPbr = (s: Slot, look: PbrLook, set: TexSet, key: string) => {
    const info = SETS[look.set]
    const m = s.mat
    release(s)
    const mk = (t: THREE.Texture) => {
      const c = t.clone()
      c.repeat.set(1 / info.size, 1 / info.size) // the builders' UVs are in metres
      c.rotation = info.boardsAlongV ? Math.PI / 2 : 0 // boards along u, as the canvas look paints them
      s.owned.push(c)
      return c
    }
    if (look.map) {
      m.map = mk(set.map)
      m.color.copy(tintFor(look.base, info.albedo))
    } else {
      m.map = null
      m.color.set(look.base)
    }
    const orm = mk(set.orm)
    m.normalMap = mk(set.normalMap)
    m.normalScale.setScalar(look.normalScale ?? 1)
    m.roughnessMap = orm
    m.roughness = clamp(look.rough / info.rough, 0, 3)
    m.aoMap = orm
    m.aoMapIntensity = Math.min(1, MAX_MEAN_AO / Math.max(1e-3, 1 - info.ao))
    m.bumpMap = null
    m.needsUpdate = true
    s.showing = key
  }
  const run = (s: Slot) => {
    if (!s.last || disposed) return
    const { look, fallback } = s.last
    const lookKey = JSON.stringify(look)
    const key = `${lookKey}@${res}`
    if (s.showing === key) return
    s.want = key
    const ready = sets.peek(look.set, res)
    if (ready) return showPbr(s, look, ready, key)
    // keep the same look at the other resolution while the new one loads; else the fallback
    if (!s.showing || !s.showing.startsWith(lookKey + '@')) {
      unPbr(s)
      fallback()
    }
    const r = res
    sets.loadSet(look.set, r, maxAnisotropy).then(
      (set) => {
        if (!disposed && s.want === key && res === r) showPbr(s, look, set, key)
      },
      (err: unknown) => {
        if (!warned) console.warn('Vindsplanen: textures could not load; keeping the painted look.', err)
        warned = true
      },
    )
  }
  const pbr = (mat: THREE.MeshStandardMaterial, look: PbrLook, fallback: () => void) => {
    const s = slotOf(mat)
    s.last = { look, fallback }
    run(s)
  }
  const plain = (mat: THREE.MeshStandardMaterial, base: string, rough: number) => () => {
    mat.map = mat.bumpMap = null
    mat.color.set(base)
    mat.roughness = rough
    mat.needsUpdate = true
  }

  const applyMat = (mat: THREE.MeshStandardMaterial, cat: MaterialCategory, key: string, panelKey: string) => {
    const k = key in SURFACES[cat] ? key : Object.keys(SURFACES[cat])[0]
    let opt = SURFACES[cat][k] as SurfaceStyle
    if (cat === 'rafter' && k === 'ceiling') opt = { ...(SURFACES.panel[panelKey] ?? SURFACES.panel.white) as SurfaceStyle, kind: 'solid' }
    const canvasLook = () => {
      if (opt.kind === 'solid') {
        mat.map = null
        mat.bumpMap = null
        mat.color.set(opt.base)
      } else {
        const t = getTex(cat, k)
        mat.map = t.map
        mat.bumpMap = t.bump
        mat.bumpScale = 1.2
        mat.color.set('#ffffff')
      }
      mat.roughness = opt.rough
      mat.needsUpdate = true
    }
    pbr(mat, pbrLook(cat, k, opt), canvasLook)
  }

  // the fixed surfaces: plasterboard, the floor below, the fabrics
  const fixed = () => {
    pbr(mats.board, { set: 'plaster', map: false, base: '#f2f0eb', rough: 0.92, normalScale: PLASTER_RELIEF }, plain(mats.board, '#f2f0eb', 0.92))
    pbr(M2.floor, { set: 'floor-oak', map: true, base: SURFACES.floor.oak.base as string, rough: 0.5 }, () => {
      M2.floor.map = floorT.map
      M2.floor.bumpMap = floorT.bump
      M2.floor.color.set('#ffffff')
      M2.floor.roughness = 0.5
      M2.floor.needsUpdate = true
    })
    pbr(M2.wall, { set: 'plaster', map: false, base: '#f1efeb', rough: 0.92, normalScale: PLASTER_RELIEF }, plain(M2.wall, '#f1efeb', 0.92))
    pbr(M2.ceil, { set: 'plaster', map: false, base: '#f6f5f2', rough: 0.95, normalScale: PLASTER_RELIEF }, plain(M2.ceil, '#f6f5f2', 0.95))
    ;(
      [
        ['linen', '#f3f0e8', 0.92],
        ['duvet', '#7f909c', 0.92],
        ['sage', '#6f8a7c', 0.92],
        ['sofa', '#8d9ba2', 0.92],
        ['rug', '#c4b096', 1],
      ] as const
    ).forEach(([name, base, rough]) => {
      const m = M[name] as THREE.MeshPhysicalMaterial
      pbr(m, { set: 'fabric', map: true, base, rough }, plain(m, base, rough))
    })
  }
  fixed()

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
    setRes(r) {
      if (r === res || disposed) return
      res = r
      sets.keepOnly(r)
      slots.forEach(run)
    },
    dispose() {
      disposed = true
      slots.forEach(release)
      slots.clear()
      sets.dispose()
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

/**
 * Light balance (plan 141). v41 lit the scene with its sky gradient as the
 * environment at 0.75 and a hemisphere light at 0.9 (1.3 when overcast). The
 * environment is now RoomEnvironment (lighting.ts), which is brighter than the
 * gradient, so it runs lower and the flat hemisphere fill drops to leave room
 * for it; together they keep the overall exposure of the v41 look.
 */
export const ENV_INTENSITY = 0.65
export const HEMI = 0.55
export const HEMI_OVERCAST = 0.75
export const EXPOSURE = 1.12

/**
 * v41 `SUNS`: offset from the attic's middle (×1.6), intensity and colour;
 * plus, per mood, the hemisphere fill and the environment (× ENV_INTENSITY).
 * `night` (plan 141) is the evening with the lamps lit: a faint afterglow from
 * the west, little daylight, and the lamps (lighting.ts) do the rest.
 */
export const SUN_STYLE = {
  morning: { off: [7, 3.6, 3.2], int: 3.4, color: '#ffe6c4', hemi: HEMI, env: 1 },
  midday: { off: [0.6, 6.4, 5.6], int: 3.6, color: '#fff4e4', hemi: HEMI, env: 1 },
  evening: { off: [-7, 3.0, 3.6], int: 3.0, color: '#ffd2a1', hemi: HEMI, env: 1 },
  overcast: { off: [1, 8, 2], int: 0, color: '#ffffff', hemi: HEMI_OVERCAST, env: 1 },
  night: { off: [-7, 1.2, 3.6], int: 0.15, color: '#ff9a5a', hemi: 0.04, env: 0.12 },
} as const

/**
 * The real sun's look (plan 144) from its altitude in radians: the lamp's
 * intensity and colour, the hemisphere fill and the environment share. Below
 * the horizon the sun is off and the room has only a dim sky ("dusk"); just
 * above it the light is weak and warm; from ~30° up it is the midday look.
 */
export function realSunLook(altitude: number): { int: number; color: string; hemi: number; env: number; down: boolean } {
  const alt = altitude * (180 / Math.PI)
  if (alt <= 0) return { int: 0, color: '#ff9a5a', hemi: 0.14, env: 0.22, down: true }
  const t = Math.min(1, alt / 30)
  const mix = (a: string, b: string) => '#' + new THREE.Color(a).lerp(new THREE.Color(b), t).getHexString()
  return {
    int: 0.5 + (SUN_STYLE.midday.int - 0.5) * t,
    color: mix('#ff9f5e', SUN_STYLE.midday.color),
    hemi: 0.2 + (HEMI - 0.2) * t,
    env: 0.35 + 0.65 * t,
    down: false,
  }
}

const DAY_SKY =['#7fa6d4', '#b9d0e6', '#e8eef1', '#d3cfc4', '#a8a294'] as const
/** Late evening: deep blue overhead, a last warm band at the horizon, dark ground. */
const NIGHT_SKY = ['#0b1222', '#18233a', '#4a3a44', '#1c1a1a', '#100f0e'] as const

/** An equirectangular gradient used as the background (`night`: the late-evening sky). */
export function skyTexture(night = false): THREE.DataTexture {
  const hex = night ? NIGHT_SKY : DAY_SKY
  const stops = ([0, 0.38, 0.5, 0.52, 1] as const).map((t, i) => [t, new THREE.Color(hex[i])] as const)
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
