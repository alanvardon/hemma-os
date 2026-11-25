// Room tab: view options (per device), the attic's own measurements (A1–A8),
// the floor below with its doors, knee-wall and insulated-ceiling bays, and the
// east-gable window. v41 Room tab (1700–1771, 2043–2080).

import { cm, type Geometry } from '../../lib/vindsplanen/attic'
import { FF } from '../../lib/vindsplanen/below'
import { gableWindowFit, SUN_IDS } from '../../lib/vindsplanen/items'
import type { BelowDoor, Below, PlanV2, ViewPrefs } from '../../lib/vindsplanen/plan'
import { CheckField, CmField, CmInput, SelectField } from './controls'
import { patchAttic, patchBelow, patchGable, toggleBay } from './planOps'

const SUN_LABEL: Record<(typeof SUN_IDS)[number], string> = {
  morning: 'Morning sun from the east',
  midday: 'Midday sun from the south',
  evening: 'Evening sun from the west',
  overcast: 'Overcast',
  night: 'Evening, lamps on',
}

// [key, label, min cm, max cm] for the floor-below numbers (v41 renderBelow rows).
const BELOW_ROWS: [keyof Below, string, number, number][] = [
  ['ceil', 'Ceiling height', 180, 320],
  ['slab', 'Attic floor thickness', 10, 60],
  ['hallLen', 'Hallway length from the east wall', 100, 850],
  ['hall', 'Hallway width beside the stairwell', 60, 300],
  ['hw', 'Half the house’s inside width', 120, 240],
  ['len', 'Stairwell opening, east–west', 60, 500],
  ['sw', 'Stairwell opening, width', 60, 200],
  ['east', 'Landing: top of the stairs to the east wall', 0, 600],
  ['off', 'Stairwell from the long wall', 0, 200],
  ['screen', 'Slatted screen length (west part)', 0, 500],
  ['fill', 'Floor extended over the stairwell (west end)', 0, 50],
  ['ret', 'Railing out from the white post', 0, 200],
]

// A-measurements: [key, label, min, max, count?] in display units.
const ATTIC_ROWS: [keyof Geometry['attic'], string, number, number, boolean?][] = [
  ['len', 'A1 · Attic length, gable to gable', 400, 1500],
  ['knee', 'A2 · Width between the knee walls', 100, 440],
  ['kneeH', 'A3 · Knee wall height', 0, 160],
  ['ridge', 'A4 · Ridge height', 180, 400],
  ['r0', 'A5 · West gable to the first rafter (middle)', 5, 300],
  ['cc', 'A6 · Rafter spacing, centre to centre', 30, 200],
  ['rn', 'A7 · Number of rafters on one side', 1, 20, true],
  ['rd', 'A8 · Rafter depth below the panelling', 8, 35],
  ['rw', 'A8 · Rafter thickness', 3, 12],
]

export default function RoomPanel({
  geo, plan, view, onView, onChange, onMeasure,
}: {
  geo: Geometry
  plan: PlanV2
  view: ViewPrefs
  onView: (v: ViewPrefs) => void
  onChange: (next: PlanV2) => void
  onMeasure: (code: string) => void
}) {
  const B = plan.options.below
  const g = plan.options.gable
  const K = plan.options.knee
  const board = plan.options.board
  const setDoor = (i: number, patch: Partial<BelowDoor>) =>
    onChange(patchBelow(plan, { doors: B.doors.map((d, k) => (k === i ? { ...d, ...patch } : d)) }))
  const fit = gableWindowFit(geo, g).fits

  return (
    <div className="vp-pane">
      <div className="vp-group">
        <h2>Light and view</h2>
        <p className="vp-note">Only applies to this device.</p>
        <SelectField id="vp-sun" label="Lighting" value={view.sun} options={SUN_IDS.map((s) => [s, SUN_LABEL[s]] as [typeof s, string])} onChange={(sun) => onView({ ...view, sun })} />
        <SelectField id="vp-quality" label="Quality" value={view.quality} options={[['nice', 'High (shading, sharper shadows)'], ['fast', 'Fast (for phones)']]} onChange={(quality) => onView({ ...view, quality })} />
        <CheckField id="vp-zones" label="Headroom zones" checked={view.zones} onChange={(zones) => onView({ ...view, zones })} />
        <CheckField id="vp-rafters" label="Show rafters" checked={view.rafters} onChange={(rafters) => onView({ ...view, rafters })} />
        <CheckField id="vp-cutaway" label="Hide the nearest walls" checked={view.cutaway} onChange={(cutaway) => onView({ ...view, cutaway })} />
        <CheckField id="vp-dims" label="Show measurements on the model" checked={view.dims} onChange={(dims) => onView({ ...view, dims })} />
      </div>

      <div className="vp-group">
        <h2>Attic measurements</h2>
        <p className="vp-note">The model redraws as soon as a measurement changes. The codes match the Measure tab.</p>
        <div className="vp-card">
          {ATTIC_ROWS.map(([k, label, min, max, count]) => (
            <CmField
              key={k}
              id={`vp-a-${k}`}
              label={label}
              value={plan.options.attic[k]}
              min={min}
              max={max}
              count={count}
              onChange={(v) => onChange(patchAttic(plan, { [k]: v }))}
            />
          ))}
        </div>
      </div>

      <div className="vp-group">
        <h2>Floor below</h2>
        <div className="vp-card">
          <button type="button" className="btn btn-primary" onClick={() => onMeasure('B1')}>
            Measure the floor below, step by step
          </button>
          <CheckField id="vp-b-show" label="Show the floor below" checked={B.show} onChange={(show) => onChange(patchBelow(plan, { show }))} />
          <SelectField id="vp-b-side" label="Stairwell side" value={B.side} options={[['S', 'South'], ['N', 'North']]} onChange={(side) => onChange(patchBelow(plan, { side }))} />
          {BELOW_ROWS.map(([k, label, min, max]) => (
            <CmField key={k} id={`vp-b-${k}`} label={label} value={B[k] as number} min={min} max={max} onChange={(v) => onChange(patchBelow(plan, { [k]: v }))} />
          ))}

          <h3 className="vp-sub">Doors on the floor below</h3>
          {B.doors.length > 0 && (
            <div className="vp-doors">
              <div className="vp-door vp-door-head" aria-hidden="true">
                {['Wall', 'Type', 'Centre cm', 'Width cm', 'Handle', ''].map((t, i) => (
                  <span key={i}>{t}</span>
                ))}
              </div>
              {B.doors.map((d, i) => {
                const at = d.wall === 'W' ? 'Centre, cm from the north wall' : 'Centre, cm from the east wall'
                return (
                  <div className="vp-door" key={i}>
                    <select aria-label={`Door ${i + 1}, wall`} value={d.wall} onChange={(e) => setDoor(i, { wall: e.target.value as BelowDoor['wall'] })}>
                      <option value="S">South</option>
                      <option value="N">North</option>
                      <option value="W">West end</option>
                    </select>
                    <select aria-label={`Door ${i + 1}, type`} value={d.kind} onChange={(e) => setDoor(i, { kind: e.target.value as BelowDoor['kind'] })}>
                      <option value="door">Door</option>
                      <option value="panel">Cupboard</option>
                    </select>
                    <CmInput ariaLabel={`Door ${i + 1}, ${at}`} title={at} value={d.at} min={0} max={850} onChange={(v) => setDoor(i, { at: v })} />
                    <CmInput ariaLabel={`Door ${i + 1}, width in cm`} title="Width, cm" value={d.w} min={30} max={200} onChange={(v) => setDoor(i, { w: v })} />
                    <select aria-label={`Door ${i + 1}, handle side seen from the hallway`} value={d.flip ? 'L' : 'R'} onChange={(e) => setDoor(i, { flip: e.target.value === 'L' })}>
                      <option value="R">Right</option>
                      <option value="L">Left</option>
                    </select>
                    <button type="button" className="btn btn-ghost" aria-label={`Remove door ${i + 1}`} onClick={() => onChange(patchBelow(plan, { doors: B.doors.filter((_, k) => k !== i) }))}>
                      ✕
                    </button>
                  </div>
                )
              })}
            </div>
          )}
          <p className="vp-note">
            Each door: wall, type, centre position (cm from the east wall, or from the north wall at the west end), width, and which side the handle is on when you stand in the hallway facing the door.
          </p>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onChange(patchBelow(plan, { doors: [...B.doors, { wall: 'S', at: 1.5, w: 0.82, kind: 'door', flip: false }] }))}
          >
            + Door
          </button>
          <p className="vp-note">
            Floor to floor: {cm(FF(B))} cm. The door positions are estimated from photos. The landing length, screen length, hallway width and house width are read off photos and still need measuring.
          </p>
        </div>
      </div>

      <div className="vp-group">
        <h2>Knee walls</h2>
        <div className="vp-card">
          <p className="vp-note">Tick a bay to remove its knee wall and floor the eaves behind it. Bays are counted from the west gable, between the rafters.</p>
          {([['N', 'North side'], ['S', 'South side']] as const).map(([side, label]) => (
            <fieldset className="vp-bays" key={side}>
              <legend>{label}</legend>
              {geo.BAYS.map((_, i) => (
                <label key={i}>
                  <input
                    type="checkbox"
                    aria-label={`${label}, bay ${i + 1}, open`}
                    checked={K[side].includes(i)}
                    onChange={(e) => onChange({ ...plan, options: { ...plan.options, knee: { ...K, [side]: toggleBay(K[side], i, e.target.checked) } } })}
                  />
                  <span>{i + 1}</span>
                </label>
              ))}
            </fieldset>
          ))}
        </div>
      </div>

      <div className="vp-group">
        <h2>Insulated ceiling</h2>
        <div className="vp-card">
          <p className="vp-note">
            Tick a bay to fill the rafters with {cm(geo.RAFT_D)} cm of insulation and cover them with plasterboard, on both sides. The ceiling comes {cm(geo.BOARD_D)} cm lower ({cm(geo.BOARD_DY)} cm measured straight down), so the top of the room drops to {cm(geo.H - geo.BOARD_DY)} cm.
          </p>
          <fieldset className="vp-bays">
            <legend>Bays, from the west gable</legend>
            {geo.BAYS.map((_, i) => (
              <label key={i}>
                <input
                  type="checkbox"
                  aria-label={`Bay ${i + 1}, insulated and boarded`}
                  checked={board.includes(i)}
                  onChange={(e) => onChange({ ...plan, options: { ...plan.options, board: toggleBay(board, i, e.target.checked) } })}
                />
                <span>{i + 1}</span>
              </label>
            ))}
          </fieldset>
        </div>
      </div>

      <div className="vp-group">
        <h2>East gable window</h2>
        <div className="vp-card">
          <CheckField id="vp-g-on" label="Window in the east gable" checked={g.on} onChange={(on) => onChange(patchGable(plan, { on }))} />
          <CmField id="vp-g-w" label="Width" value={g.w} min={30} max={250} disabled={!g.on} onChange={(w) => onChange(patchGable(plan, { w }))} />
          <CmField id="vp-g-h" label="Height" value={g.h} min={30} max={220} disabled={!g.on} onChange={(h) => onChange(patchGable(plan, { h }))} />
          <CmField id="vp-g-sill" label="Sill above the floor" value={g.sill} min={0} max={200} disabled={!g.on} onChange={(sill) => onChange(patchGable(plan, { sill }))} />
          <CmField id="vp-g-off" label="Offset from the middle" value={g.off} min={-150} max={150} disabled={!g.on} onChange={(off) => onChange(patchGable(plan, { off }))} />
          {!g.on ? (
            <p className="vp-note">Shows the vent that is there today.</p>
          ) : fit ? (
            <p className="vp-ok">Placeholder size until you have measured. It fits under the roof.</p>
          ) : (
            <p className="vp-warn">
              <span className="vp-sr">Warning: </span>Does not fit under the roof slope at this size and height, so it is not drawn. Make it narrower or lower.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
