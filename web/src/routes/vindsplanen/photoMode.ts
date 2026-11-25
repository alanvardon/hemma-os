// Photo mode (plan 143): the pure parts — the path tracer's settings per
// device and the status copy. No three.js here, so the route can import it
// without pulling the 3D chunk (the tracer itself lives in scene/photo.ts).

/** Where a photo session is: building the scene, adding samples, finished, or over. */
export type PhotoPhase = 'preparing' | 'rendering' | 'done' | 'off' | 'failed'

export interface PhotoSettings {
  /** Samples per pixel before the tracer stops refining. */
  maxSamples: number
  /** Path-traced resolution relative to the canvas (upscaled to it). */
  renderScale: number
  /** The image is traced in tiles × tiles pieces, one per frame, so a frame stays short. */
  tiles: number | null
  /** Material textures are resampled to this size in the tracer's texture array. */
  textureSize: number
}

/**
 * Mobile (a coarse pointer) traces a quarter of the pixels in 2×2 tiles with
 * small textures and stops at 200 samples; desktop keeps the tracer's default
 * tiling (`tiles: null`) at full resolution up to 400.
 */
export function photoSettings(isMobile: boolean): PhotoSettings {
  return isMobile
    ? { maxSamples: 200, renderScale: 0.5, tiles: 2, textureSize: 512 }
    : { maxSamples: 400, renderScale: 1, tiles: null, textureSize: 1024 }
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
