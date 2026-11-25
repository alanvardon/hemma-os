// The editor card for the selected item: v41 `fieldsFor` (1593) + `infoHtml` +
// `warnBlock`, with English labels. Sliders edit continuously (the controller
// merges the burst into one undo step); number and select fields commit once.

import type { ReactNode } from 'react'
import { cm, type Geometry } from '../../lib/vindsplanen/attic'
import { FF } from '../../lib/vindsplanen/below'
import { SKY_SIZES, BED_SIZES } from '../../lib/vindsplanen/items'
import type { Item, PlanV2 } from '../../lib/vindsplanen/plan'
import { curvedPlan } from '../../lib/vindsplanen/stairs'
import { realWarnings, INFO_CODES, type Warning } from '../../lib/vindsplanen/warnings'
import { CheckField, CmField, RangeField, SelectField } from './controls'
import { fmt } from './fmt'
import { TYPE_LABEL, infoLines } from './itemText'
import { warningText } from './warningText'

type Patch = Record<string, unknown>

const metres = (v: number) => `${fmt(v)} m`
const SIDES = [['N', 'North side'], ['S', 'South side']] as const

export default function ItemEditor({
  geo, plan, item, warnings, holesOk, onPatch, onDone, onDuplicate, onDelete,
}: {
  geo: Geometry
  plan: PlanV2
  item: Item
  warnings: readonly Warning[]
  holesOk: ReadonlySet<string>
  onPatch: (patch: Patch) => void
  onDone: () => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const id = (k: string) => `vp-f-${k}`
  const it = item
  const B = plan.options.below
  const set = (k: string) => (v: unknown) => onPatch({ [k]: v })

  const pos = (xLabel = 'From the west gable') => (
    <>
      <RangeField id={id('x')} label={xLabel} value={(it as { x: number }).x} min={0} max={geo.L} step={0.05} format={metres} onChange={set('x')} />
      <RangeField id={id('z')} label="Across (− north, + south)" value={(it as { z: number }).z} min={-geo.HALF} max={geo.HALF} step={0.05} format={metres} onChange={set('z')} />
    </>
  )
  const risersOptions = (per: number): [number, string][] => {
    const auto = Math.max(4, Math.round(FF(B) / per))
    return [
      [0, `Automatic (${auto}, ${fmt((FF(B) / auto) * 100, 1)} cm each)`],
      ...[11, 12, 13, 14, 15, 16].map((n): [number, string] => [n, `${n} steps, ${fmt((FF(B) / n) * 100, 1)} cm each`]),
    ]
  }

  let fields: ReactNode = null
  switch (it.type) {
    case 'skylight':
      fields = (
        <>
          <SelectField id={id('slope')} label="Roof slope" value={it.slope} options={[['S', 'South slope'], ['N', 'North slope']]} onChange={set('slope')} />
          <SelectField id={id('bay')} label="Between rafters" value={it.bay} options={geo.BAYS.map((b, i) => [i, `Bay ${i + 1} · centre ${fmt(b.c)} m`] as [number, string])} onChange={set('bay')} />
          <SelectField id={id('size')} label="Size (w × h cm)" value={it.size} options={Object.keys(SKY_SIZES).map((k) => [k, k] as [string, string])} onChange={set('size')} />
          <RangeField id={id('bottom')} label="Bottom edge above the floor" value={it.bottom} min={0.4} max={2} step={0.05} format={(v) => `${cm(v)} cm`} onChange={set('bottom')} />
        </>
      )
      break
    case 'wall':
      fields = (
        <>
          <RangeField id={id('x')} label="From the west gable" value={it.x} min={0} max={geo.L} step={0.05} format={metres} onChange={set('x')} />
          <CheckField id={id('door')} label="Door opening" checked={it.door} onChange={set('door')} />
          {it.door && <RangeField id={id('doorZ')} label="Door position across" value={it.doorZ} min={-0.9} max={0.9} step={0.05} format={metres} onChange={set('doorZ')} />}
        </>
      )
      break
    case 'closet':
      fields = (
        <>
          <SelectField id={id('wall')} label="Against" value={it.wall} options={[['E', 'East gable'], ['W', 'West gable']]} onChange={set('wall')} />
          <SelectField id={id('side')} label="Side" value={it.side} options={SIDES} onChange={set('side')} />
          <CheckField id={id('fit')} label="Fit around the stairs and the window" checked={it.fit} onChange={set('fit')} />
          {!it.fit && (
            <>
              <CmField id={id('d')} label="Depth from the gable" value={it.d} min={30} max={150} onChange={set('d')} />
              <CmField id={id('len')} label="Length from the eaves" value={it.len} min={40} max={250} onChange={set('len')} />
            </>
          )}
        </>
      )
      break
    case 'storage':
      fields = (
        <>
          <RangeField id={id('x')} label="Centre, from the west gable" value={it.x} min={0} max={geo.L} step={0.05} format={metres} onChange={set('x')} />
          <CmField id={id('w')} label="Length along the wall" value={it.w} min={60} max={300} onChange={set('w')} />
          <CmField id={id('d')} label="Depth from the knee wall" value={it.d} min={50} max={160} onChange={set('d')} />
          <SelectField id={id('side')} label="Against" value={it.side} options={[['N', 'North knee wall'], ['S', 'South knee wall']]} onChange={set('side')} />
          <SelectField id={id('door')} label="Door" value={it.door} options={[['slide', 'Sliding door'], ['hinge', 'Hinged door'], ['none', 'Open doorway']]} onChange={set('door')} />
          <CheckField id={id('wrap')} label="Fill the corner by the stairs" checked={it.wrap} onChange={set('wrap')} />
        </>
      )
      break
    case 'spiral':
      fields = (
        <>
          <RangeField id={id('x')} label="Centre, from the west gable" value={it.x} min={0} max={geo.L} step={0.05} format={metres} onChange={set('x')} />
          <RangeField id={id('z')} label="Across (− north, + south)" value={it.z} min={-geo.HALF} max={geo.HALF} step={0.05} format={metres} onChange={set('z')} />
          <SelectField id={id('rot')} label="Bottom step faces" value={it.rot} onChange={set('rot')}
            options={[[0, 'East'], [45, 'North-east'], [90, 'North'], [135, 'North-west'], [180, 'West'], [225, 'South-west'], [270, 'South'], [315, 'South-east']]} />
          <SelectField id={id('dir')} label="Goes up" value={it.dir} options={[['cw', 'Clockwise (seen from above)'], ['ccw', 'Anticlockwise (seen from above)']]} onChange={set('dir')} />
          <CmField id={id('d')} label="Diameter" value={it.d} min={110} max={240} onChange={set('d')} />
          <SelectField id={id('deg')} label="Total turn" value={it.deg} onChange={set('deg')}
            options={[[270, '270° (three-quarter turn)'], [315, '315°'], [360, '360° (full turn)'], [405, '405°'], [450, '450°']]} />
          <SelectField id={id('risers')} label="Number of steps" value={it.risers} options={risersOptions(0.19)} onChange={set('risers')} />
        </>
      )
      break
    case 'curved': {
      const P = curvedPlan(B, it)
      fields = (
        <>
          <RangeField id={id('x')} label="Bottom step, from the west gable" value={it.x} min={0} max={geo.L} step={0.05} format={metres} onChange={set('x')} />
          <RangeField id={id('z')} label="Across (− north, + south)" value={it.z} min={-geo.HALF} max={geo.HALF} step={0.05} format={metres} onChange={set('z')} />
          <SelectField id={id('rot')} label="Start climbing toward" value={it.rot} options={[[0, 'East'], [180, 'West'], [90, 'North'], [270, 'South']]} onChange={set('rot')} />
          <SelectField id={id('turn')} label="Turn" value={it.turn} options={[['L', 'Turn left'], ['R', 'Turn right'], ['N', 'Straight, no turn']]} onChange={set('turn')} />
          <SelectField id={id('risers')} label="Number of steps" value={it.risers} options={risersOptions(0.185)} onChange={set('risers')} />
          {it.turn !== 'N' && <RangeField id={id('a')} label="Steps before the turn" value={it.a} min={0} max={Math.max(0, P.n - 4)} step={1} format={(v) => `${v} steps`} onChange={set('a')} />}
          <CmField id={id('w')} label="Width" value={it.w} min={60} max={140} onChange={set('w')} />
        </>
      )
      break
    }
    case 'stairs':
      fields = (
        <>
          {pos()}
          <SelectField id={id('rot')} label="Direction" value={it.rot} onChange={set('rot')}
            options={[[0, 'Arrive facing east'], [180, 'Arrive facing west'], [90, 'Arrive facing north'], [270, 'Arrive facing south']]} />
          <CmField id={id('w')} label="Width" value={it.w} min={60} max={150} onChange={set('w')} />
          <CmField id={id('run')} label="Length of opening" value={it.run} min={120} max={450} onChange={set('run')} />
          <CmField id={id('drop')} label="Floor-to-floor height" value={it.drop} min={180} max={350} onChange={set('drop')} />
        </>
      )
      break
    default:
      fields = (
        <>
          {pos()}
          <RangeField id={id('rot')} label="Rotation" value={it.rot} min={0} max={345} step={15} format={(v) => `${v}°`} onChange={set('rot')} />
          {it.type === 'bed' ? (
            <SelectField id={id('size')} label="Bed size" value={it.size} options={Object.keys(BED_SIZES).map((k) => [k, `${k} cm`] as [string, string])} onChange={set('size')} />
          ) : (
            <>
              <CmField id={id('w')} label="Width" value={it.w} min={10} max={400} onChange={set('w')} />
              <CmField id={id('d')} label="Depth" value={it.d} min={10} max={400} onChange={set('d')} />
              {it.type !== 'rug' && <CmField id={id('h')} label="Height" value={it.h} min={10} max={260} onChange={set('h')} />}
            </>
          )}
        </>
      )
  }

  const info = infoLines(geo, plan, it, holesOk)
  const real = realWarnings(warnings)
  return (
    <section className="vp-card" aria-label={`Edit ${TYPE_LABEL[it.type].toLowerCase()}`}>
      <h3>{TYPE_LABEL[it.type]}</h3>
      {fields}
      {info.length > 0 && (
        <div className="vp-info">
          {info.map((l) => (
            <span key={l}>{l}</span>
          ))}
        </div>
      )}
      <div className="vp-warns" aria-live="polite">
        {warnings.map((w, i) => (
          <p key={i} className={INFO_CODES.has(w.code) ? 'vp-ok' : 'vp-warn'}>
            {!INFO_CODES.has(w.code) && <span className="vp-sr">Warning: </span>}
            {warningText(w)}
          </p>
        ))}
        {real.length === 0 && <p className="vp-ok">Fits.</p>}
      </div>
      <div className="vp-actions">
        <button type="button" className="btn btn-ghost" onClick={onDone}>Done</button>
        <button type="button" className="btn btn-ghost" onClick={onDuplicate}>Duplicate</button>
        <button type="button" className="btn btn-ghost vp-danger" onClick={onDelete}>Delete</button>
      </div>
    </section>
  )
}
