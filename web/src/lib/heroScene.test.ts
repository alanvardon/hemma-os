import { describe, it, expect } from 'vitest'
import {
  OVERSCAN_X,
  overscanGeometry,
  parseHexColor,
  isCopperRow,
  terrainGrid,
  scrollProgress,
  dollyFor,
  stepRipple,
  rippleTarget,
  timeBucket,
  greetingFor,
  paletteFor,
  AURORA_MAX,
} from './heroScene'

describe('overscanGeometry', () => {
  it('adds OVERSCAN_X of the hero width to each side', () => {
    const g = overscanGeometry(1000)
    expect(g.marginX).toBe(1000 * OVERSCAN_X)
    expect(g.width).toBe(1000 + 2 * g.marginX)
    expect(g.spanScale).toBeCloseTo(g.width / 1000)
  })

  it('re-anchors the mask fades to the original 7%/93% stops', () => {
    // The vignette must fall at the same visual position on the hero box as
    // before overscanning — marginX px in from the canvas edge, plus the
    // original percentage of the un-overscanned width.
    const g = overscanGeometry(1000)
    expect(g.fadeInPx).toBe(g.marginX + 70)
    expect(g.fadeOutPx).toBe(g.marginX + 930)
  })

  it('scales linearly with the hero width', () => {
    const a = overscanGeometry(500)
    const b = overscanGeometry(1500)
    expect(b.marginX).toBeCloseTo(3 * a.marginX)
    expect(b.spanScale).toBeCloseTo(a.spanScale)
  })
})

describe('parseHexColor', () => {
  const fallback: [number, number, number] = [1, 2, 3]

  it('parses 6-digit hex with or without #', () => {
    expect(parseHexColor('#4d8a62', fallback)).toEqual([0x4d, 0x8a, 0x62])
    expect(parseHexColor('b06b38', fallback)).toEqual([0xb0, 0x6b, 0x38])
  })

  it('expands 3-digit hex', () => {
    expect(parseHexColor('#fa0', fallback)).toEqual([0xff, 0xaa, 0x00])
  })

  it('trims whitespace (getComputedStyle values arrive padded)', () => {
    expect(parseHexColor('  #4d8a62 ', fallback)).toEqual([0x4d, 0x8a, 0x62])
  })

  it('falls back on empty, malformed, or non-hex input', () => {
    expect(parseHexColor('', fallback)).toEqual(fallback)
    expect(parseHexColor('oklch(43% 0.07 153)', fallback)).toEqual(fallback)
    expect(parseHexColor('#12345', fallback)).toEqual(fallback)
  })
})

describe('isCopperRow', () => {
  it('marks every 6th row, offset 3 — matching the 2D canvas', () => {
    const copper = Array.from({ length: 24 }, (_, r) => r).filter(isCopperRow)
    expect(copper).toEqual([3, 9, 15, 21])
  })
})

describe('terrainGrid', () => {
  it('keeps a fixed row count and grows cols with sqrt(spanScale)', () => {
    const g = terrainGrid(1200, 1.8)
    expect(g.rows).toBe(44)
    expect(g.cols).toBe(Math.round(280 * Math.sqrt(1.8)))
  })

  it('steps column density down below 900px', () => {
    expect(terrainGrid(899, 1).cols).toBe(200)
    expect(terrainGrid(900, 1).cols).toBe(280)
  })
})

describe('scrollProgress', () => {
  it('maps scrollY over the hero height, clamped to 0–1', () => {
    expect(scrollProgress(0, 600)).toBe(0)
    expect(scrollProgress(300, 600)).toBe(0.5)
    expect(scrollProgress(600, 600)).toBe(1)
    expect(scrollProgress(2400, 600)).toBe(1)
    expect(scrollProgress(-40, 600)).toBe(0)
  })

  it('is 0 before layout settles (heroHeight 0)', () => {
    expect(scrollProgress(500, 0)).toBe(0)
  })
})

describe('dollyFor', () => {
  it('is identity at rest', () => {
    const d = dollyFor(0)
    expect(d.yOffset).toBeCloseTo(0)
    expect(d.pitchOffset).toBeCloseTo(0)
    expect(d.fogScale).toBe(1)
  })

  it('descends, pitches down and pulls fog in at full scroll', () => {
    const d = dollyFor(1)
    expect(d.yOffset).toBeCloseTo(-0.0825)
    expect(d.pitchOffset).toBeCloseTo(-0.1)
    expect(d.fogScale).toBeCloseTo(1.3)
  })
})

describe('stepRipple', () => {
  it('springs up fast: near-full strength within ~a quarter second', () => {
    let s = 0
    for (let i = 0; i < 15; i++) s = stepRipple(s, 1, 1 / 60) // 0.25s at 60fps
    expect(s).toBeGreaterThan(0.9)
  })

  it('decays slow: still visible at 0.5s, gone (<5%) by ~1.5s', () => {
    let s = 1
    for (let i = 0; i < 30; i++) s = stepRipple(s, 0, 1 / 60) // 0.5s
    expect(s).toBeGreaterThan(0.25)
    for (let i = 0; i < 60; i++) s = stepRipple(s, 0, 1 / 60) // → 1.5s
    expect(s).toBeLessThan(0.05)
  })

  it('is framerate-safe: one 0.5s step lands near thirty 1/60 steps', () => {
    let fine = 1
    for (let i = 0; i < 30; i++) fine = stepRipple(fine, 0, 1 / 60)
    const coarse = stepRipple(1, 0, 0.5)
    expect(Math.abs(fine - coarse)).toBeLessThan(0.01)
  })
})

describe('rippleTarget', () => {
  it('is full while the pointer moved recently, zero after the threshold', () => {
    expect(rippleTarget(0)).toBe(1)
    expect(rippleTarget(249)).toBe(1)
    expect(rippleTarget(250)).toBe(0)
    expect(rippleTarget(5000)).toBe(0)
  })
})

describe('timeBucket', () => {
  it('matches the greeting boundaries at 5/10/18', () => {
    expect(timeBucket(0)).toBe('natt')
    expect(timeBucket(4)).toBe('natt')
    expect(timeBucket(5)).toBe('morgon')
    expect(timeBucket(9)).toBe('morgon')
    expect(timeBucket(10)).toBe('dag')
    expect(timeBucket(17)).toBe('dag')
    expect(timeBucket(18)).toBe('kvall')
    expect(timeBucket(23)).toBe('kvall')
  })
})

describe('greetingFor', () => {
  it('maps each bucket to the hub greeting text', () => {
    expect(greetingFor(timeBucket(3))).toBe('God natt')
    expect(greetingFor(timeBucket(7))).toBe('God morgon')
    expect(greetingFor(timeBucket(12))).toBe('God dag')
    expect(greetingFor(timeBucket(21))).toBe('God kväll')
  })
})

describe('paletteFor', () => {
  const buckets = ['natt', 'morgon', 'dag', 'kvall'] as const

  it('shows the aurora in dark only, hard-capped at AURORA_MAX (plan 69)', () => {
    for (const b of buckets) {
      const dark = paletteFor(b, 'dark').aurora
      expect(dark).toBeGreaterThan(0)
      expect(dark).toBeLessThanOrEqual(AURORA_MAX)
      // Daylight carries no curtain — it read as a washed-out green smudge.
      expect(paletteFor(b, 'light').aurora).toBe(0)
    }
  })

  it('night burns brightest of the dark-theme curtains', () => {
    expect(paletteFor('natt', 'dark').aurora).toBeGreaterThan(paletteFor('dag', 'dark').aurora)
    expect(paletteFor('kvall', 'dark').aurora).toBeGreaterThan(paletteFor('dag', 'dark').aurora)
  })

  it('shapes the day: morning mistiest, midday clearest and brightest', () => {
    const morgon = paletteFor('morgon', 'light')
    const dag = paletteFor('dag', 'light')
    expect(morgon.fogScale).toBeGreaterThan(dag.fogScale)
    for (const b of buckets) {
      expect(dag.alpha).toBeGreaterThanOrEqual(paletteFor(b, 'light').alpha)
    }
  })

  it('warms dusk with copper and thins the night', () => {
    for (const b of buckets) {
      expect(paletteFor('kvall', 'light').copperWeight)
        .toBeGreaterThanOrEqual(paletteFor(b, 'light').copperWeight)
    }
    expect(paletteFor('natt', 'light').dotScale).toBeLessThan(1)
  })

  it('dims the light-theme dot field to half the dark opacity (plan 69)', () => {
    for (const b of buckets) {
      const l = paletteFor(b, 'light')
      const d = paletteFor(b, 'dark')
      expect(l.alpha).toBeLessThan(d.alpha)
      // Only alpha and aurora differ across themes — fog/copper/dot are shared.
      expect({ ...l, alpha: 0, aurora: 0 }).toEqual({ ...d, alpha: 0, aurora: 0 })
    }
  })
})
