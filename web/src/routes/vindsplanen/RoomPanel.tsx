// Rummet: view options (per device), the attic's own measurements (A1–A8),
// the floor below with its doors, knee-wall and insulated-ceiling bays, and the
// east-gable window. v41 Room tab (1700–1771, 2043–2080).

import { cm, type Geometry } from '../../lib/vindsplanen/attic'
import { FF } from '../../lib/vindsplanen/below'
import { gableWindowFit, SUN_IDS } from '../../lib/vindsplanen/items'
import type { BelowDoor, Below, PlanV2, ViewPrefs } from '../../lib/vindsplanen/plan'
import { CheckField, CmField, CmInput, SelectField } from './controls'
import { patchAttic, patchBelow, patchGable, toggleBay } from './planOps'

const SUN_LABEL: Record<(typeof SUN_IDS)[number], string> = {
  morning: 'Morgonsol från öster',
  midday: 'Middagssol från söder',
  evening: 'Kvällssol från väster',
  overcast: 'Mulet',
  night: 'Kväll, lampor tända',
}

// [key, label, min cm, max cm] for the floor-below numbers (v41 renderBelow rows).
const BELOW_ROWS: [keyof Below, string, number, number][] = [
  ['ceil', 'Takhöjd', 180, 320],
  ['slab', 'Vindsgolvets tjocklek', 10, 60],
  ['hallLen', 'Hallens längd från östra väggen', 100, 850],
  ['hall', 'Hallens bredd intill trapphålet', 60, 300],
  ['hw', 'Husets halva invändiga bredd', 120, 240],
  ['len', 'Trapphålets öppning, öst–väst', 60, 500],
  ['sw', 'Trapphålets öppning, bredd', 60, 200],
  ['east', 'Avsats: trappans topp till östra väggen', 0, 600],
  ['off', 'Trapphål från långväggen', 0, 200],
  ['screen', 'Spjälskärmens längd (västra delen)', 0, 500],
  ['fill', 'Golv utdraget över trapphålet (västra änden)', 0, 50],
  ['ret', 'Räcke ut från den vita stolpen', 0, 200],
]

// A-measurements: [key, label, min, max, count?] in display units.
const ATTIC_ROWS: [keyof Geometry['attic'], string, number, number, boolean?][] = [
  ['len', 'A1 · Vindens längd, gavel till gavel', 400, 1500],
  ['knee', 'A2 · Bredd mellan knävägg och knävägg', 100, 440],
  ['kneeH', 'A3 · Knävägghöjd', 0, 160],
  ['ridge', 'A4 · Höjd till nock', 180, 400],
  ['r0', 'A5 · Västra gaveln till första sparren (mitt)', 5, 300],
  ['cc', 'A6 · Sparrarnas avstånd, c/c', 30, 200],
  ['rn', 'A7 · Antal sparrar på ena sidan', 1, 20, true],
  ['rd', 'A8 · Sparrens djup under panelen', 8, 35],
  ['rw', 'A8 · Sparrens tjocklek', 3, 12],
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
        <h2>Ljus och vy</h2>
        <p className="vp-note">Gäller bara den här enheten.</p>
        <SelectField id="vp-sun" label="Ljus" value={view.sun} options={SUN_IDS.map((s) => [s, SUN_LABEL[s]] as [typeof s, string])} onChange={(sun) => onView({ ...view, sun })} />
        <SelectField id="vp-quality" label="Kvalitet" value={view.quality} options={[['nice', 'Fin (skuggning, skarpare skuggor)'], ['fast', 'Snabb (för mobiler)']]} onChange={(quality) => onView({ ...view, quality })} />
        <CheckField id="vp-zones" label="Huvudhöjdszoner" checked={view.zones} onChange={(zones) => onView({ ...view, zones })} />
        <CheckField id="vp-rafters" label="Visa sparrar" checked={view.rafters} onChange={(rafters) => onView({ ...view, rafters })} />
        <CheckField id="vp-cutaway" label="Dölj närmaste väggar" checked={view.cutaway} onChange={(cutaway) => onView({ ...view, cutaway })} />
        <CheckField id="vp-dims" label="Visa måtten på modellen" checked={view.dims} onChange={(dims) => onView({ ...view, dims })} />
      </div>

      <div className="vp-group">
        <h2>Vinden, mått</h2>
        <p className="vp-note">Modellen ritas om direkt när ett mått ändras. Måtten har samma koder som i Mät.</p>
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
        <h2>Våningen under</h2>
        <div className="vp-card">
          <button type="button" className="btn btn-primary" onClick={() => onMeasure('B1')}>
            Mät våningen under, steg för steg
          </button>
          <CheckField id="vp-b-show" label="Visa våningen under" checked={B.show} onChange={(show) => onChange(patchBelow(plan, { show }))} />
          <SelectField id="vp-b-side" label="Trapphålets sida" value={B.side} options={[['S', 'Söder'], ['N', 'Norr']]} onChange={(side) => onChange(patchBelow(plan, { side }))} />
          {BELOW_ROWS.map(([k, label, min, max]) => (
            <CmField key={k} id={`vp-b-${k}`} label={label} value={B[k] as number} min={min} max={max} onChange={(v) => onChange(patchBelow(plan, { [k]: v }))} />
          ))}

          <h3 className="vp-sub">Dörrar på våningen under</h3>
          {B.doors.length > 0 && (
            <div className="vp-doors">
              <div className="vp-door vp-door-head" aria-hidden="true">
                {['Vägg', 'Typ', 'Mitt cm', 'Bredd cm', 'Handtag', ''].map((t, i) => (
                  <span key={i}>{t}</span>
                ))}
              </div>
              {B.doors.map((d, i) => {
                const at = d.wall === 'W' ? 'Mitt, cm från norra väggen' : 'Mitt, cm från östra väggen'
                return (
                  <div className="vp-door" key={i}>
                    <select aria-label={`Dörr ${i + 1}, vägg`} value={d.wall} onChange={(e) => setDoor(i, { wall: e.target.value as BelowDoor['wall'] })}>
                      <option value="S">Södra</option>
                      <option value="N">Norra</option>
                      <option value="W">Västra änden</option>
                    </select>
                    <select aria-label={`Dörr ${i + 1}, typ`} value={d.kind} onChange={(e) => setDoor(i, { kind: e.target.value as BelowDoor['kind'] })}>
                      <option value="door">Dörr</option>
                      <option value="panel">Skåp</option>
                    </select>
                    <CmInput ariaLabel={`Dörr ${i + 1}, ${at}`} title={at} value={d.at} min={0} max={850} onChange={(v) => setDoor(i, { at: v })} />
                    <CmInput ariaLabel={`Dörr ${i + 1}, bredd i cm`} title="Bredd, cm" value={d.w} min={30} max={200} onChange={(v) => setDoor(i, { w: v })} />
                    <select aria-label={`Dörr ${i + 1}, handtagssida sett från hallen`} value={d.flip ? 'L' : 'R'} onChange={(e) => setDoor(i, { flip: e.target.value === 'L' })}>
                      <option value="R">Höger</option>
                      <option value="L">Vänster</option>
                    </select>
                    <button type="button" className="btn btn-ghost" aria-label={`Ta bort dörr ${i + 1}`} onClick={() => onChange(patchBelow(plan, { doors: B.doors.filter((_, k) => k !== i) }))}>
                      ✕
                    </button>
                  </div>
                )
              })}
            </div>
          )}
          <p className="vp-note">
            Varje dörr: vägg, typ, mittläge (cm från östra väggen, eller från norra väggen i västra änden), bredd och vilken sida handtaget sitter på när du står i hallen och tittar mot dörren.
          </p>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onChange(patchBelow(plan, { doors: [...B.doors, { wall: 'S', at: 1.5, w: 0.82, kind: 'door', flip: false }] }))}
          >
            + Dörr
          </button>
          <p className="vp-note">
            Våning till våning: {cm(FF(B))} cm. Dörrarnas lägen är uppskattade från foton. Avsatsens längd, skärmens längd, hallens bredd och husets bredd är avlästa från foton och behöver fortfarande mätas.
          </p>
        </div>
      </div>

      <div className="vp-group">
        <h2>Knävägg</h2>
        <div className="vp-card">
          <p className="vp-note">Kryssa i ett fack för att ta bort dess knävägg och golvlägga takfoten bakom. Facken räknas från västra gaveln, mellan sparrarna.</p>
          {([['N', 'Norra sidan'], ['S', 'Södra sidan']] as const).map(([side, label]) => (
            <fieldset className="vp-bays" key={side}>
              <legend>{label}</legend>
              {geo.BAYS.map((_, i) => (
                <label key={i}>
                  <input
                    type="checkbox"
                    aria-label={`${label}, fack ${i + 1}, öppen`}
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
        <h2>Isolerat tak</h2>
        <div className="vp-card">
          <p className="vp-note">
            Kryssa i ett fack för att fylla sparrarna med {cm(geo.RAFT_D)} cm isolering och täcka dem med gips, på båda sidor. Taket kommer {cm(geo.BOARD_D)} cm lägre ({cm(geo.BOARD_DY)} cm mätt rakt ned), så rummets topp sjunker till {cm(geo.H - geo.BOARD_DY)} cm.
          </p>
          <fieldset className="vp-bays">
            <legend>Fack, från västra gaveln</legend>
            {geo.BAYS.map((_, i) => (
              <label key={i}>
                <input
                  type="checkbox"
                  aria-label={`Fack ${i + 1}, isolerat och gipsat`}
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
        <h2>Fönster i östra gaveln</h2>
        <div className="vp-card">
          <CheckField id="vp-g-on" label="Fönster i östra gaveln" checked={g.on} onChange={(on) => onChange(patchGable(plan, { on }))} />
          <CmField id="vp-g-w" label="Bredd" value={g.w} min={30} max={250} disabled={!g.on} onChange={(w) => onChange(patchGable(plan, { w }))} />
          <CmField id="vp-g-h" label="Höjd" value={g.h} min={30} max={220} disabled={!g.on} onChange={(h) => onChange(patchGable(plan, { h }))} />
          <CmField id="vp-g-sill" label="Underkant över golvet" value={g.sill} min={0} max={200} disabled={!g.on} onChange={(sill) => onChange(patchGable(plan, { sill }))} />
          <CmField id="vp-g-off" label="Förskjutning från mitten" value={g.off} min={-150} max={150} disabled={!g.on} onChange={(off) => onChange(patchGable(plan, { off }))} />
          {!g.on ? (
            <p className="vp-note">Visar ventilen som sitter där idag.</p>
          ) : fit ? (
            <p className="vp-ok">Platshållarstorlek tills du har mätt. Den ryms under taket.</p>
          ) : (
            <p className="vp-warn">
              <span className="vp-sr">Varning: </span>Ryms inte under taklutningen i den här storleken och höjden, så den ritas inte. Gör den smalare eller lägre.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
