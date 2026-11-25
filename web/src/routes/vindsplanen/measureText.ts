// English copy for the Measure tab's coded steps (v41 `walkSteps`, 1868–1960).
// The registry in lib/vindsplanen/measure.ts carries codes, fields and camera
// data; the words are the route's. A D step is worded from the door it measures.

import { fieldDisplay, type MeasureStep } from '../../lib/vindsplanen/measure'

export interface StepText {
  title: string
  sub: string
  how: string
  /** One label per field, in the registry's order. */
  fields: string[]
}

const TODAY = 'Measure the attic as it is today, before anything is taken out or insulated.'
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

const nf = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 1 })

export function stepText(st: MeasureStep, side: 'N' | 'S'): StepText {
  const longWall = side === 'S' ? 'south' : 'north'
  const farWall = side === 'S' ? 'north' : 'south'
  switch (st.code) {
    case 'A1':
      return { title: 'Attic length', sub: 'West gable wall to east gable wall', how: `Along the floor down the middle of the attic, from the west gable wall to the east gable wall (the one with the window). ${TODAY}`, fields: ['West gable to east gable'] }
    case 'A2':
      return { title: 'Width between the knee walls', sub: 'South knee wall to north knee wall', how: `Across the floor, from the face of the low south wall to the face of the low north wall, at right angles to them. ${TODAY}`, fields: ['Knee wall to knee wall'] }
    case 'A3':
      return { title: 'Knee wall height', sub: 'Floor to the top of the knee wall', how: `From the floor straight up to where the low wall meets the sloping ceiling. ${TODAY}`, fields: ['Floor to top of knee wall'] }
    case 'A4':
      return { title: 'Ridge height', sub: 'Floor to the highest point of the ceiling', how: `From the floor straight up to the ceiling at its highest point, along the middle of the attic. Measure to the panelling, not to a beam that hangs below it. ${TODAY}`, fields: ['Floor to ceiling at the top'] }
    case 'A5':
      return { title: 'First rafter', sub: 'West gable wall to the middle of the first rafter', how: `Along the sloping ceiling (or along the floor, using a level), from the west gable wall to the middle of the first rafter. ${TODAY}`, fields: ['West gable to middle of rafter'] }
    case 'A6':
      return { title: 'Rafter spacing', sub: 'Middle of one rafter to the middle of the next', how: `From the middle of one rafter to the middle of the next one (the same as from the left side of one to the left side of the next). If they are not evenly spaced, measure each gap. ${TODAY}`, fields: ['Centre to centre'] }
    case 'A7':
      return { title: 'Number of rafters', sub: 'On one side of the roof', how: `Count the rafters on one slope, from gable to gable. Do not count the gable walls themselves. ${TODAY}`, fields: ['Rafters on one side'] }
    case 'A8':
      return { title: 'Rafter size', sub: 'How deep and how thick one rafter is', how: `On one rafter: how far it sticks out below the panelling (its depth), and how thick it is from side to side. ${TODAY}`, fields: ['Depth below the panelling', 'Thickness'] }
    case 'B1':
      return { title: 'Ceiling height', sub: 'Hallway floor to ceiling', how: 'Stand in the hallway and measure from the floor straight up to the ceiling.', fields: ['Floor to ceiling'] }
    case 'B2':
      return { title: 'Floor to floor', sub: 'Hallway floor to attic floor', how: 'At the stairwell, measure from the hallway floor up to the attic floor surface (through the hatch or up the stair opening). This gives the thickness of the floor between.', fields: ['Hallway floor to attic floor'] }
    case 'B3':
      return { title: 'Hallway length', sub: 'East wall to the west end wall', how: 'From the east wall (with the window) along the hallway to the west end wall (with the doors).', fields: ['East wall to west end'] }
    case 'B4':
      return { title: 'Stairwell length', sub: 'East wall to the end of the opening', how: 'Along the stairwell: from the east wall to the west end of the stairwell opening, where the slatted screen starts.', fields: ['East wall to end of opening'] }
    case 'B5':
      return { title: 'Stairwell width', sub: 'Long wall to the screen line', how: `Across the stairwell: from the ${longWall} wall to the line of the slatted screen and railing.`, fields: ['Wall to screen line'] }
    case 'B6':
      return { title: 'Hallway beside the stairwell', sub: 'Screen line to the opposite wall', how: `From the slatted screen and railing across the hallway to the ${farWall} wall.`, fields: ['Screen line to wall'] }
    case 'B7':
      return { title: 'Slatted screen', sub: 'West end to the white post', how: 'Along the screen: from its west end to the white post where the low railing starts.', fields: ['Screen length'] }
    case 'B8':
      return { title: 'The old stairs', sub: 'Number of steps, step height, width', how: 'Count the steps from the ground floor up to this hallway (count each step you lift your foot onto, including the top one), measure the height of one step, and the width of the stairs.', fields: ['Number of steps', 'Height of one step', 'Width of the stairs'] }
    case 'B9':
      return {
        title: 'Old stairs: shape',
        sub: 'Step depth, and how the steps turn',
        how: 'On a straight part of the old stairs, measure from the front edge of one step to the front edge of the next, flat along the step. Then, walking up, count the tapered steps in the turn (narrow at the post, wide at the wall), and the straight steps after the turn before you step onto the landing. Together with B8 these decide how far the old stairs run under the hallway floor, and so the headroom on the way down.',
        fields: ['Step depth', 'Tapered steps in the turn', 'Straight steps after the turn'],
      }
    case 'W1':
      return { title: 'Hallway window', sub: 'In the east wall at the end of the hallway', how: 'Downstairs, at the window in the east wall: measure along the wall from the north wall (the stairwell side) to the nearest edge of the window opening, then its width, its height, and from the floor up to the sill. Measure the opening in the wall, not the frame.', fields: ['North wall to window edge', 'Width', 'Height', 'Floor to sill'] }
    case 'W2':
      return { title: 'Attic window', sub: 'In the east gable wall of the attic', how: 'In the attic, at the window in the east gable wall: measure along the wall from the corner with the north knee wall to the nearest edge of the window opening, then its width, its height, and from the floor up to the sill. If there is no window there, skip this and untick it under Room → East gable window.', fields: ['North knee wall to window edge', 'Width', 'Height', 'Floor to sill'] }
  }
  // D steps: the door being measured.
  const d = st.door
  const isW = d?.wall === 'W'
  const what = d?.kind === 'panel' ? 'cupboard' : 'door'
  const where = isW ? 'west end wall' : `${d?.wall === 'N' ? 'north' : 'south'} wall`
  const ref = isW ? 'north wall' : 'east wall'
  return {
    title: `${cap(what)} in the ${where}`,
    sub: `${cap(ref)} to its nearest edge, and its width`,
    how: `Measure along the floor from the ${ref} to the nearest edge of the ${what} opening (inside the frame), then the width of the opening.`,
    fields: [`From ${ref} to the edge`, 'Opening width'],
  }
}

export const GROUPS: { code: 'A' | 'B' | 'W' | 'D'; title: string; note: string }[] = [
  { code: 'A', title: 'A · The attic', note: 'Measure today, before anything is taken out' },
  { code: 'B', title: 'B · Floor below', note: 'The hallway and the stairwell under the new stairs' },
  { code: 'W', title: 'W · Windows', note: 'Both windows in the east wall, one above the other' },
  { code: 'D', title: 'D · Doors on the floor below', note: 'Where each door sits along its wall' },
]

/** v41 `valText`: the step's current values. */
export const valueText = (st: MeasureStep): string =>
  st.fields.map((f) => (f.raw ? String(fieldDisplay(f)) : `${nf.format(fieldDisplay(f))} cm`)).join(' · ')

/** v41 `whenText`. */
export const whenText = (v: string): string => v
