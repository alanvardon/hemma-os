// Plan 143 — photo mode's pure parts: device settings, phase, sample count and status copy.
import { describe, expect, it } from 'vitest'
import { GAIN_RANGE, GAIN_SAMPLE_CLAMP, matchGain, photoFileName, photoPhase, photoSettings, photoStatus, shownSamples } from './photoMode'

describe('photoSettings', () => {
  it('desktop: 300 samples in 3×3 tiles with 1k textures, at full resolution on a 1× screen', () => {
    expect(photoSettings(false)).toEqual({ maxSamples: 300, renderScale: 1, tiles: 3, textureSize: 1024 })
    expect(photoSettings(false, 1)).toEqual(photoSettings(false))
  })
  it('desktop traces about one ray per CSS pixel on a dense screen, never below half', () => {
    expect(photoSettings(false, 2).renderScale).toBe(0.5)
    expect(photoSettings(false, 1.25).renderScale).toBeCloseTo(0.8)
    expect(photoSettings(false, 3).renderScale).toBe(0.5)
    expect(photoSettings(false, 0.5).renderScale).toBe(1)
  })
  it('desktop treats a broken pixel ratio as 1×', () => {
    expect(photoSettings(false, Number.NaN).renderScale).toBe(1)
    expect(photoSettings(false, 0).renderScale).toBe(1)
    expect(photoSettings(false, -2).renderScale).toBe(1)
  })
  it('mobile: 200 samples at half resolution in 2×2 tiles with 512 px textures, whatever the screen', () => {
    expect(photoSettings(true)).toEqual({ maxSamples: 200, renderScale: 0.5, tiles: 2, textureSize: 512 })
    expect(photoSettings(true, 3)).toEqual(photoSettings(true))
  })
})

/** RGBA pixels from [r, g, b, a] tuples. */
const px = (...p: number[][]) => Float32Array.from(p.flat())

describe('matchGain', () => {
  it('brings the traced mean to the raster mean, per channel', () => {
    const ref = px([0.8, 0.8, 0.8, 1], [0.4, 0.4, 0.4, 1])
    const trace = px([0.8, 0.6, 0.4, 1], [0.4, 0.3, 0.2, 1])
    const [r, g, b] = matchGain(ref, trace)
    expect(r).toBeCloseTo(1)
    expect(g).toBeCloseTo(1.2 / 0.9)
    expect(b).toBeCloseTo(2)
  })
  it('measures only pixels the raster image covers fully (the sky background is left out)', () => {
    const ref = px([0.5, 0.5, 0.5, 1], [9, 9, 9, 0], [9, 9, 9, 0.5])
    const trace = px([0.25, 0.25, 0.25, 1], [0.1, 0.1, 0.1, 1], [0.1, 0.1, 0.1, 1])
    expect(matchGain(ref, trace)).toEqual([2, 2, 2])
  })
  it('clips trace fireflies before averaging', () => {
    const ref = px([1, 1, 1, 1], [1, 1, 1, 1])
    const trace = px([1000, 1000, 1000, 1], [0, 0, 0, 1])
    // means 1 vs (clamp + 0) / 2: the firefly counts as GAIN_SAMPLE_CLAMP, not 1000
    expect(matchGain(ref, trace)).toEqual([2 / GAIN_SAMPLE_CLAMP, 2 / GAIN_SAMPLE_CLAMP, 2 / GAIN_SAMPLE_CLAMP])
  })
  it('keeps the gain within its range', () => {
    expect(matchGain(px([1, 1, 1, 1]), px([0.001, 0.001, 0.001, 1]))).toEqual([GAIN_RANGE[1], GAIN_RANGE[1], GAIN_RANGE[1]])
    expect(matchGain(px([0.001, 0.001, 0.001, 1]), px([3, 3, 3, 1]))).toEqual([GAIN_RANGE[0], GAIN_RANGE[0], GAIN_RANGE[0]])
  })
  it('leaves a channel at 1 when either image is black in it or nothing is measurable', () => {
    expect(matchGain(px([0.5, 0, 0.5, 1]), px([0.25, 0.5, 0, 1]))).toEqual([2, 1, 1])
    expect(matchGain(px([1, 1, 1, 0]), px([0.5, 0.5, 0.5, 1]))).toEqual([1, 1, 1])
    expect(matchGain(new Float32Array(0), new Float32Array(0))).toEqual([1, 1, 1])
  })
  it('skips broken values and measures the shorter image only', () => {
    const ref = px([Number.NaN, 0.5, 0.5, 1], [0.5, 0.5, 0.5, 1], [5, 5, 5, 1])
    const trace = px([0.25, Number.POSITIVE_INFINITY, 0.25, 1], [0.25, 0.25, 0.25, 1])
    expect(matchGain(ref, trace)).toEqual([2, 2, 2])
  })
})

describe('photoPhase', () => {
  it('renders until the cap, then is done', () => {
    expect(photoPhase(0, 400)).toBe('rendering')
    expect(photoPhase(399.89, 400)).toBe('rendering')
    expect(photoPhase(400, 400)).toBe('done')
    expect(photoPhase(400.11, 400)).toBe('done')
  })
})

describe('shownSamples', () => {
  it('shows whole samples (tiles add ninths) and never past the cap', () => {
    expect(shownSamples(120.889, 400)).toBe(120)
    expect(shownSamples(400.33, 400)).toBe(400)
  })
  it('treats a missing or broken count as none', () => {
    expect(shownSamples(Number.NaN, 400)).toBe(0)
    expect(shownSamples(-1, 400)).toBe(0)
    expect(shownSamples(Number.POSITIVE_INFINITY, 400)).toBe(0)
  })
})

describe('photoStatus', () => {
  it('words each phase', () => {
    expect(photoStatus('preparing', 0, 400)).toEqual({ label: 'Preparing…', count: '' })
    expect(photoStatus('rendering', 120.5, 400)).toEqual({ label: 'Rendering…', count: '120 / 400 samples' })
    expect(photoStatus('done', 400, 200)).toEqual({ label: 'Done', count: '200 samples' })
    expect(photoStatus('off', 10, 400)).toEqual({ label: '', count: '' })
  })
})

describe('photoFileName', () => {
  it('names the PNG by the local date, zero-padded', () => {
    expect(photoFileName(new Date(2026, 0, 5, 23, 59))).toBe('vindsplanen-2026-01-05.png')
    expect(photoFileName(new Date(2026, 10, 25))).toBe('vindsplanen-2026-11-25.png')
  })
})
