// Test-only helpers for the Vindsplanen golden tests: fixture loading, a
// tolerant deep compare, and v41's English warning text (so warnings can be
// compared with what v41 printed, number formatting included). Not imported
// by app code.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect } from 'vitest'
import { atticOf, deriveGeometry, type Geometry } from './attic'
import { importV1 } from './legacy'
import type { PlanV2 } from './plan'
import type { Warning } from './warnings'
import type { Surface, WalkWorld } from './walk'

export const FIXTURE_NAMES = ['example', 'owner-like', 'curved-80', 'spiral', 'straight', 'attic-custom'] as const
export type FixtureName = (typeof FIXTURE_NAMES)[number]

/** Golden data captured from v41 by web/tools/vindsplanen-gold (numbers rounded to 0.1 mm). */
export interface Gold {
  input: Record<string, unknown> & { options: { attic: unknown } }
  afterBuild: { items: { id: string; type: string; d?: number; len?: number }[] }
  makeItems: Record<string, Record<string, unknown>>
  geometry: Record<string, unknown>
  ceil: [number, number, number][]
  warnings: Record<string, string[]>
  skyHoleOk: string[]
  gableFit: boolean
  holes: Record<'KZ' | 'HALF' | 'hw', { holes: [number, number][][]; clash: string[] }>
  info: Record<string, Record<string, unknown>>
  below: Record<string, unknown> & { parts: GoldMesh[] }
  zones: { nx: number; nz: number; cells: string; floor: string; stand: string; boa: string; rooms: string[] }
  walk: {
    feetLevels: number[]
    grid: [number, number, number | string][]
    walks: Record<'below' | 'attic', { start: Record<string, unknown>; steps: WalkStepGold[] }>
    routes: { upNew?: WalkStepGold[]; downOld?: WalkStepGold[] }
  }
  measure: {
    code: string
    attic: boolean
    fields: { v: number; min: number; max: number; raw: boolean; unit: string }[]
    cam: { p: number[]; t: number[] }
    dims: [number[], number[], string][]
    boxes: number[][]
    hl: [number, string][]
    valText: string
  }[]
  measureApply: { code: string; inputs: number[]; below: Record<string, unknown>; gable: Record<string, unknown>; attic: Record<string, unknown> }[]
}

/** [moved 1/0, x, z, feet, where, headroom] after each attempted move. */
export type WalkStepGold = [number, number, number, number, string, number | string]

export interface GoldMesh {
  type: string
  geo: string | null
  params: Record<string, number>
  pos: [number, number, number]
  rot: [number, number, number]
  dir: [number, number, number]
  cut: string
}

const FIXTURES = resolve(__dirname, '__fixtures__')
const cache = new Map<string, unknown>()

export function loadJson<T>(name: string): T {
  if (!cache.has(name)) cache.set(name, JSON.parse(readFileSync(resolve(FIXTURES, name + '.json'), 'utf8')))
  return cache.get(name) as T
}

export const loadGold = (name: FixtureName): Gold => loadJson<Gold>(name)

/** The fixture's plan as the port sees it: the v41 input through importV1. */
export function goldPlan(name: FixtureName): { gold: Gold; plan: PlanV2; geo: Geometry } {
  const gold = loadGold(name)
  const r = importV1(gold.input)
  if (!r.ok) throw new Error(`${name}: import failed (${r.reason})`)
  return { gold, plan: r.plan, geo: deriveGeometry(atticOf(r.plan.options.attic)) }
}

/** Golden numbers: 'Infinity' etc. were stored as strings. */
const num = (v: unknown): number => (typeof v === 'string' ? Number(v) : (v as number))

/**
 * Deep compare `actual` to golden `expected`: numbers within `tol` (default
 * 1 mm), everything else exactly. Keys whose actual value is undefined are
 * treated as absent.
 */
export function expectClose(actual: unknown, expected: unknown, tol = 1e-3, path = '$'): void {
  if (typeof expected === 'number' || (typeof expected === 'string' && /^-?Infinity$|^NaN$/.test(expected) && typeof actual === 'number')) {
    const e = num(expected)
    const a = actual as number
    if (!Number.isFinite(e)) {
      expect(a, path).toBe(e)
      return
    }
    expect(typeof a, path).toBe('number')
    if (Math.abs(a - e) > tol) expect.fail(`${path}: ${a} is not within ${tol} of ${e}`)
    return
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), `${path} is an array`).toBe(true)
    const arr = actual as unknown[]
    expect(arr.length, `${path}.length`).toBe(expected.length)
    expected.forEach((e, i) => expectClose(arr[i], e, tol, `${path}[${i}]`))
    return
  }
  if (expected && typeof expected === 'object') {
    expect(actual && typeof actual === 'object', `${path} is an object`).toBeTruthy()
    const a = actual as Record<string, unknown>
    const ek = Object.keys(expected).sort()
    const ak = Object.keys(a).filter((k) => a[k] !== undefined).sort()
    expect(ak, `${path} keys`).toEqual(ek)
    for (const k of ek) expectClose(a[k], (expected as Record<string, unknown>)[k], tol, `${path}.${k}`)
    return
  }
  expect(actual, path).toEqual(expected)
}

const WALL_NAMES: Record<string, string> = { W: 'west end', N: 'north wall', S: 'south wall' }

/** v41's English text for a warning, byte for byte. */
export function englishWarning(w: Warning): string {
  const p = w.params as Record<string, number> & { walls?: string }
  switch (w.code) {
    case 'furn-roof-clash': return 'Hits the roof slope. Move it toward the middle or make it lower.'
    case 'furn-outside': return 'Sticks out behind a knee wall or through a gable.'
    case 'wall-door-low': return `The door can only be ${p.h} cm high here. Move it toward the middle.`
    case 'wall-on-rafter': return 'Sits on a rafter line. That is fine and often easiest to fix to.'
    case 'sky-wider-than-bay': return `${p.w} cm is wider than the ${p.clear.toFixed(1)} cm gap between rafters. A rafter would have to be cut and trimmed.`
    case 'sky-reaches-ridge': return 'Too high up. The window reaches the ridge.'
    case 'sky-overlap': return 'Overlaps another roof window. Move one of them.'
    case 'stairs-outside': return 'The opening runs past a knee wall or gable.'
    case 'stairs-steep-rise': return `Each step rises ${p.rise.toFixed(1)} cm, which is steep. Aim for about 18 cm.`
    case 'stairs-too-steep': return `Too steep for everyday use (2 × rise + going = ${p.blondel.toFixed(0)} cm; 60–65 cm is comfortable). Make the stairs longer.`
    case 'stairs-shallow': return `Very shallow steps (2 × rise + going = ${p.blondel.toFixed(0)} cm). The stairs could be shorter.`
    case 'stairs-low-head': return `Low headroom on the stairs: ${p.head} cm at the tightest point. Move them toward the middle of the attic.`
    case 'up-walkway-narrow': return `Leaves only ${p.free} cm to walk past in the hallway below (about 80 cm is needed), which would block the way to the existing stairs.`
    case 'up-outside-hall': return 'The stairs run outside the hallway below, through a wall. Move or turn them.'
    case 'up-over-well': return `The first step reaches ${p.reach} cm over the existing stairwell. Start on solid floor: move the stairs west, or extend the hallway floor ${p.need} cm over the stairwell (Room → Floor below).`
    case 'up-low-head': return `Low headroom under the roof: ${p.head} cm at the tightest step (aim for 190 or more). Turn toward the middle of the attic sooner.`
    case 'up-down-head': return `Someone walking down the existing stairs would have only ${p.head} cm above their head under these stairs.`
    case 'up-knee-wall': return 'The opening in the attic floor reaches behind a knee wall, so that knee wall would need to move or be framed around the stairs.'
    case 'up-hole-clash': return 'Its opening overlaps another stair opening. Delete or move the other stairs.'
    case 'spiral-landing-head': return `Someone on step ${p.step} walks under the top landing with only ${p.head} cm above their head (about 2 m is needed). Turn the spiral further so the landing sits over the lowest steps.`
    case 'spiral-shallow': return `The steps are only ${p.going} cm deep along the walking line (about 20 cm or more is needed). Make the spiral wider, turn it further or add steps.`
    case 'up-steep-rise': return `Each step is ${p.rise.toFixed(1)} cm high, which is steep (about 18–20 cm is comfortable). Keep every step the same height.`
    case 'up-door-blocked': {
      const walls = String(p.walls).split(',').map((k) => WALL_NAMES[k]).join(', ')
      return `The steps stand in front of ${p.count > 1 ? p.count + ' doors' : 'a door'} on the floor below (${walls}). Move the stairs or the door.`
    }
    case 'storage-hole-overlap': return 'The storage room overlaps the stair opening. Make it shorter or slide it along.'
    case 'storage-low-front': return `Only ${p.h} cm high at the front. Make it shallower so the front wall sits where the roof is higher.`
    case 'closet-hole-overlap': return 'The closet overlaps the stair opening. Make it shallower.'
    case 'closet-door-low': return `The door can only be ${p.h} cm high this far under the slope. Make the closet shorter so its door end sits where the roof is higher.`
    case 'closet-shallow': return `Only ${p.depth} cm deep inside: enough for shelves, not for hanging clothes.`
  }
}

/** v41's sanitized v1 shape → the PlanV2 the port should produce from it. */
export function v1ToV2(s: Record<string, unknown>): unknown {
  const o = s.options as Record<string, unknown>
  const below = { ...(o.below as Record<string, unknown>) }
  delete below.v
  return {
    v: 2,
    materials: s.materials,
    options: { gable: o.gable, below, knee: o.knee, board: o.board, attic: o.attic, measured: o.measured },
    items: s.items,
  }
}

/** A surface's centre: the mean of a tread's corners, or a rectangle's middle. */
export const surfCentre = (s: Surface): [number, number] =>
  s.poly
    ? s.poly.reduce<[number, number]>((a, q) => [a[0] + q[0] / s.poly.length, a[1] + q[1] / s.poly.length], [0, 0])
    : [(s.rect[0] + s.rect[1]) / 2, (s.rect[2] + s.rect[3]) / 2]

/**
 * The Stage 5 parity route for the owner-like plan (the browser parity script
 * walks the same targets): from the attic down the new stairs, along the
 * hallway, down the old stairs to the ground floor, then the same way back up.
 */
export function walkRoute(world: WalkWorld): [number, number][] {
  const nu = world.surf.filter((s) => s.where === 'new').map(surfCentre)
  const old = world.surf.filter((s) => s.where === 'old').map(surfCentre)
  const gnd = world.surf.find((s) => s.where === 'ground')
  if (!nu.length || !old.length || !gnd?.rect) throw new Error('walkRoute needs both stairs and the ground floor')
  const [bx, bz] = nu[0]
  const [ox] = old[old.length - 1]
  const hall: [number, number][] = [[bx - 0.3, bz], [bx - 0.3, -0.95], [ox, -0.95]]
  const down: [number, number][] = [...[...nu].reverse(), ...hall, ...[...old].reverse(), [gnd.rect[0] + 0.3, surfCentre(gnd)[1]]]
  return [...down, ...[...down].reverse().slice(1), [7.5, 0.4]]
}

/** The deterministic generator the capture hook used for scripted walks. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}
