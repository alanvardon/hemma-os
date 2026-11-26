// Photo mode (plan 143): the pure parts — the path tracer's settings per
// device and the status copy. No three.js here, so the route can import it
// without pulling the 3D chunk (the tracer itself lives in scene/photo.ts).

/** Where a photo session is: building the scene, adding samples, finished, or over. */
export type PhotoPhase = 'preparing' | 'rendering' | 'done' | 'off' | 'failed'

export interface PhotoSettings {
  /** Samples per pixel before the tracer stops refining. */
  maxSamples: number
  /** Path-traced resolution relative to the canvas's drawing buffer (upscaled to it). */
  renderScale: number
  /** The image is traced in tiles × tiles pieces, one per frame, so a frame stays short. */
  tiles: number
  /** Material textures are resampled to this size in the tracer's texture array. */
  textureSize: number
}

/**
 * Both trace at about one ray per CSS pixel: a 2× screen would otherwise cost
 * four times the time per sample for detail the noise hides until late.
 * Mobile (a coarse pointer) traces in 2×2 tiles with small textures and stops
 * at 200 samples; desktop in 3×3 tiles (a frame stays under ~100 ms) up to 300.
 */
export function photoSettings(isMobile: boolean, pixelRatio = 1): PhotoSettings {
  const cssScale = Math.min(1, Math.max(0.5, 1 / (Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1)))
  return isMobile
    ? { maxSamples: 200, renderScale: 0.5, tiles: 2, textureSize: 512 }
    : { maxSamples: 300, renderScale: cssScale, tiles: 3, textureSize: 1024 }
}

/** The phase a running session is in once the scene is built: done at the sample cap. */
export function photoPhase(samples: number, maxSamples: number): 'rendering' | 'done' {
  return samples >= maxSamples ? 'done' : 'rendering'
}

/** Whole samples shown to the user (tiles add a fraction per frame), never past the cap. */
export function shownSamples(samples: number, maxSamples: number): number {
  if (!Number.isFinite(samples) || samples < 0) return 0
  return Math.min(Math.floor(samples), maxSamples)
}

/** The status line: the phase word announced to screen readers, and the visible count. */
export function photoStatus(phase: PhotoPhase, samples: number, maxSamples: number): { label: string; count: string } {
  const n = shownSamples(samples, maxSamples)
  if (phase === 'preparing') return { label: 'Preparing…', count: '' }
  if (phase === 'done') return { label: 'Done', count: `${maxSamples} samples` }
  if (phase === 'rendering') return { label: 'Rendering…', count: `${n} / ${maxSamples} samples` }
  return { label: '', count: '' }
}

/** The saved image's file name, by local date: `vindsplanen-2026-11-25.png`. */
export function photoFileName(d: Date): string {
  const p = (x: number) => String(x).padStart(2, '0')
  return `vindsplanen-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.png`
}

/** A trace value above this (linear) counts as a firefly: clipped when measuring, so one stray path can't skew the gain. */
export const GAIN_SAMPLE_CLAMP = 4
/** Per-channel gain bounds: a broken or near-black measurement never swings the photo further than this. */
export const GAIN_RANGE = [0.1, 20] as const

/**
 * The per-channel gain (white balance and exposure in one) that brings the
 * path-traced image's mean colour to the raster view's, measured on the same
 * pixels: those the raster image covers fully (`ref` alpha ≥ 0.99, so the sky
 * background is left out). Both are linear RGBA, row for row the same size.
 * No usable pixel, or a channel that is black in either image, keeps that
 * channel at 1.
 */
export function matchGain(ref: ArrayLike<number>, trace: ArrayLike<number>): [number, number, number] {
  const r = [0, 0, 0]
  const t = [0, 0, 0]
  const n = Math.min(ref.length, trace.length) - 3
  for (let i = 0; i < n; i += 4) {
    if (!(ref[i + 3] >= 0.99)) continue
    for (let c = 0; c < 3; c++) {
      const a = ref[i + c]
      const b = trace[i + c]
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue
      r[c] += Math.max(0, a)
      t[c] += Math.min(Math.max(0, b), GAIN_SAMPLE_CLAMP)
    }
  }
  return r.map((rv, c) => {
    const tv = t[c]
    if (!(rv > 0) || !(tv > 0)) return 1
    return Math.min(GAIN_RANGE[1], Math.max(GAIN_RANGE[0], rv / tv))
  }) as [number, number, number]
}
