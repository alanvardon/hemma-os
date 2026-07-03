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

/* ── Plan 28b: scroll dolly + pointer ripple ─────────────────────── */

/* How far the user has scrolled from the hero toward the Tools grid, 0–1.
   The dolly maps this to a camera descent, so it must be well-defined even
   before layout settles (heroHeight 0). */
export function scrollProgress(scrollY: number, heroHeight: number): number {
  if (heroHeight <= 0) return 0
  return Math.min(1, Math.max(0, scrollY / heroHeight))
}

/* Camera/fog targets for a given scroll progress: descend ~15% of the camera
   height, pitch down 0.1 rad, and pull the fog in 30% — descending past the
   ridge, not fading a poster. */
export function dollyFor(progress: number): {
  yOffset: number
  pitchOffset: number
  fogScale: number
} {
  return {
    yOffset: -0.0825 * progress,
    pitchOffset: -0.1 * progress,
    fogScale: 1 + 0.3 * progress,
  }
}

/* The ripple strength springs up quickly while the pointer moves and decays
   over ~1.5s once it stops — asymmetric exponential step, framerate-safe. */
export function stepRipple(current: number, target: number, dt: number): number {
  const rate = target > current ? 12 : 2.2
  return current + (target - current) * (1 - Math.exp(-dt * rate))
}

/* ── Plan 28c: time-of-day palette + aurora ──────────────────────── */

/* The single source of truth for the hour buckets — the hub greeting
   (Home.tsx) and the scene lighting both derive from this, so the text can
   never say "God kväll" while the terrain lights for midday. */
export type TimeBucket = 'natt' | 'morgon' | 'dag' | 'kvall'

export function timeBucket(hour: number): TimeBucket {
  return hour < 5 ? 'natt' : hour < 10 ? 'morgon' : hour < 18 ? 'dag' : 'kvall'
}

export function greetingFor(bucket: TimeBucket): string {
  switch (bucket) {
    case 'natt': return 'God natt'
    case 'morgon': return 'God morgon'
    case 'dag': return 'God dag'
    case 'kvall': return 'God kväll'
  }
}

/* Scene lighting per (bucket × theme). All values are lerp TARGETS for the
   render loop:
   - fogScale multiplies view distance in the fog falloff (>1 = mistier)
   - alpha is the base dot opacity (dag brightest, natt dimmest)
   - copperWeight warms every dot toward copper (dusk light on the peaks)
   - dotScale scales point size (natt reads sparser)
   - aurora is the curtain intensity — dark theme only, capped at 0.35,
     kväll/natt pushed above a dark afternoon */
export interface ScenePalette {
  fogScale: number
  alpha: number
  copperWeight: number
  dotScale: number
  aurora: number
}

const AURORA_MAX = 0.35

const PALETTES: Record<TimeBucket, ScenePalette> = {
  morgon: { fogScale: 1.25, alpha: 0.6, copperWeight: 0.06, dotScale: 1, aurora: 0.2 },
  dag: { fogScale: 0.95, alpha: 0.72, copperWeight: 0, dotScale: 1, aurora: 0.16 },
  kvall: { fogScale: 1.05, alpha: 0.68, copperWeight: 0.32, dotScale: 1, aurora: 0.3 },
  natt: { fogScale: 1.15, alpha: 0.55, copperWeight: 0.1, dotScale: 0.88, aurora: AURORA_MAX },
}

export function paletteFor(bucket: TimeBucket, theme: 'light' | 'dark'): ScenePalette {
  const p = PALETTES[bucket]
  return { ...p, aurora: theme === 'dark' ? Math.min(p.aurora, AURORA_MAX) : 0 }
}

/* Target strength from pointer recency: full while the pointer is actively
   moving, zero once it has been still for a beat (the decay above supplies
   the smoothing). */
export function rippleTarget(msSinceMove: number): number {
  return msSinceMove < 250 ? 1 : 0
}
