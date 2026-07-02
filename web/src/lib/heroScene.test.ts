import { describe, it, expect } from 'vitest'
import {
  OVERSCAN_X,
  overscanGeometry,
  parseHexColor,
  isCopperRow,
  terrainGrid,
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
