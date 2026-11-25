// Plan 143 — photo mode's pure parts: device settings, phase, sample count and status copy.
import { describe, expect, it } from 'vitest'
import { photoFileName, photoPhase, photoSettings, photoStatus, shownSamples } from './photoMode'

describe('photoSettings', () => {
  it('desktop: 400 samples at full resolution with the default tiling and 1k textures', () => {
    expect(photoSettings(false)).toEqual({ maxSamples: 400, renderScale: 1, tiles: null, textureSize: 1024 })
  })
  it('mobile: 200 samples at half resolution in 2×2 tiles with 512 px textures', () => {
    expect(photoSettings(true)).toEqual({ maxSamples: 200, renderScale: 0.5, tiles: 2, textureSize: 512 })
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
