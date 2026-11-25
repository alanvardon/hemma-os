// English wording for the structured warnings from lib/vindsplanen/warnings.ts:
// v41's own messages (vindsplanen-v41.html 1068–1291);
// the numbers are the ones v41 printed (whole cm, or one decimal where it did).
// One entry per WarningCode, so adding a code without wording fails the build.

import type { Warning, WarningCode } from '../../lib/vindsplanen/warnings'

type Params = Record<string, number | string>

const nf = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 1 })
const n = (v: unknown): string => nf.format(Number(v))

const WALL: Record<string, string> = { W: 'west end', N: 'north wall', S: 'south wall' }

const TEXT: Record<WarningCode, (p: Params) => string> = {
  'furn-roof-clash': () => 'Hits the roof slope. Move it toward the middle or make it lower.',
  'furn-outside': () => 'Sticks out behind a knee wall or through a gable.',
  'wall-door-low': (p) => `The door can only be ${n(p.h)} cm high here. Move it toward the middle.`,
  'wall-on-rafter': () => 'Sits on a rafter line. That is fine and often easiest to fix to.',
  'sky-wider-than-bay': (p) => `${n(p.w)} cm is wider than the ${n(p.clear)} cm gap between rafters. A rafter would have to be cut and trimmed.`,
  'sky-reaches-ridge': () => 'Too high up. The window reaches the ridge.',
  'sky-overlap': () => 'Overlaps another roof window. Move one of them.',
  'stairs-outside': () => 'The opening runs past a knee wall or gable.',
  'stairs-steep-rise': (p) => `Each step rises ${n(p.rise)} cm, which is steep. Aim for about 18 cm.`,
  'stairs-too-steep': (p) => `Too steep for everyday use (2 × rise + going = ${n(p.blondel)} cm; 60–65 cm is comfortable). Make the stairs longer.`,
  'stairs-shallow': (p) => `Very shallow steps (2 × rise + going = ${n(p.blondel)} cm). The stairs could be shorter.`,
  'stairs-low-head': (p) => `Low headroom on the stairs: ${n(p.head)} cm at the tightest point. Move them toward the middle of the attic.`,
  'up-walkway-narrow': (p) => `Leaves only ${n(p.free)} cm to walk past in the hallway below (about 80 cm is needed), which would block the way to the existing stairs.`,
  'up-outside-hall': () => 'The stairs run outside the hallway below, through a wall. Move or turn them.',
  'up-over-well': (p) => `The first step reaches ${n(p.reach)} cm over the existing stairwell. Start on solid floor: move the stairs west, or extend the hallway floor ${n(p.need)} cm over the stairwell (Room → Floor below).`,
  'up-low-head': (p) => `Low headroom under the roof: ${n(p.head)} cm at the tightest step (aim for 190 or more). Turn toward the middle of the attic sooner.`,
  'up-down-head': (p) => `Someone walking down the existing stairs would have only ${n(p.head)} cm above their head under these stairs.`,
  'up-knee-wall': () => 'The opening in the attic floor reaches behind a knee wall, so that knee wall would need to move or be framed around the stairs.',
  'up-hole-clash': () => 'Its opening overlaps another stair opening. Delete or move the other stairs.',
  'spiral-landing-head': (p) => `Someone on step ${n(p.step)} walks under the top landing with only ${n(p.head)} cm above their head (about 2 m is needed). Turn the spiral further so the landing sits over the lowest steps.`,
  'spiral-shallow': (p) => `The steps are only ${n(p.going)} cm deep along the walking line (about 20 cm or more is needed). Make the spiral wider, turn it further or add steps.`,
  'up-steep-rise': (p) => `Each step is ${n(p.rise)} cm high, which is steep (about 18–20 cm is comfortable). Keep every step the same height.`,
  'up-door-blocked': (p) => {
    const count = Number(p.count)
    const walls = String(p.walls ?? '')
      .split(',')
      .filter(Boolean)
      .map((w) => WALL[w] ?? w)
      .join(', ')
    return `The steps stand in front of ${count > 1 ? `${count} doors` : 'a door'} on the floor below (${walls}). Move the stairs or the door.`
  },
  'storage-hole-overlap': () => 'The storage room overlaps the stair opening. Make it shorter or slide it along.',
  'storage-low-front': (p) => `Only ${n(p.h)} cm high at the front. Make it shallower so the front wall sits where the roof is higher.`,
  'closet-hole-overlap': () => 'The closet overlaps the stair opening. Make it shallower.',
  'closet-door-low': (p) => `The door can only be ${n(p.h)} cm high this far under the slope. Make the closet shorter so its door end sits where the roof is higher.`,
  'closet-shallow': (p) => `Only ${n(p.depth)} cm deep inside: enough for shelves, not for hanging clothes.`,
}

export function warningText(w: Warning): string {
  const f = TEXT[w.code]
  return f ? f(w.params) : w.code
}

export const WARNING_CODES = Object.keys(TEXT) as WarningCode[]
