/* Pure, testable logic for the hero background layers (2D canvas + WebGL
   scene). No DOM, no three.js imports — HeroCanvas2D and HeroScene both
   consume these so the two layers can never disagree on geometry or palette
   parsing. */

/* The hub-pan camera move (Home.tsx) can shift the whole page sideways by
   roughly half the viewport width toward a clicked card. Overscan the hero
   canvases horizontally so the terrain still covers the frame once panned —
   fraction of the hero box's own (pre-overscan) width, added to each side. */
export const OVERSCAN_X = 0.4

export interface OverscanGeometry {
  /* px added to each side of the hero box */
  marginX: number
  /* total canvas width in px (w0 + 2·marginX) */
  width: number
  /* width / w0 — how much wider the canvas is than the hero box */
  spanScale: number
  /* horizontal mask fade stops, re-anchored to where the original 7%/93%
     stops fell on the un-overscanned box (px from the canvas's left edge) */
  fadeInPx: number
  fadeOutPx: number
}

export function overscanGeometry(w0: number): OverscanGeometry {
  const marginX = w0 * OVERSCAN_X
  const width = w0 + marginX * 2
  return {
    marginX,
    width,
    spanScale: width / w0,
    fadeInPx: marginX + w0 * 0.07,
    fadeOutPx: marginX + w0 * 0.93,
  }
}

/* Parse a `#rgb` / `#rrggbb` hex string (as read from the --canvas-* alias
   tokens — getComputedStyle returns the OKLCH tokens verbatim, so the canvas
   layers can only read the hex aliases). Returns 0–255 channels. */
export function parseHexColor(
  value: string,
  fallback: [number, number, number],
): [number, number, number] {
  let v = value.trim().replace('#', '')
  if (v.length === 3) v = v[0] + v[0] + v[1] + v[1] + v[2] + v[2]
  if (v.length !== 6) return fallback
  const n = parseInt(v, 16)
  if (isNaN(n)) return fallback
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/* Copper accent rows — every 6th row, offset 3, matching the 2D canvas. */
export function isCopperRow(row: number): boolean {
  return row % 6 === 3
}

/* Grid density for the WebGL points terrain. Steps down below 900px so
   narrow viewports pay fewer verts; columns grow with the overscan like the
   2D canvas (sqrt curve — the margin may read slightly sparser than the core
   without paying for a full linear match). */
export function terrainGrid(w0: number, spanScale: number): { rows: number; cols: number } {
  const baseCols = w0 < 900 ? 200 : 280
  return { rows: 44, cols: Math.round(baseCols * Math.sqrt(spanScale)) }
}
