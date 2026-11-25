// The editor card for the selected item: v41 `fieldsFor` (1593) + `infoHtml` +
// `warnBlock`, with Swedish labels. Sliders edit continuously (the controller
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
const SIDES = [['N', 'Norra sidan'], ['S', 'Södra sidan']] as const

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

  const pos = (xLabel = 'Från västra gaveln') => (
    <>
      <RangeField id={id('x')} label={xLabel} value={(it as { x: number }).x} min={0} max={geo.L} step={0.05} format={metres} onChange={set('x')} />
      <RangeField id={id('z')} label="Tvärs (− norr, + söder)" value={(it as { z: number }).z} min={-geo.HALF} max={geo.HALF} step={0.05} format={metres} onChange={set('z')} />
    </>
  )
  const risersOptions = (per: number): [number, string][] => {
    const auto = Math.max(4, Math.round(FF(B) / per))
    return [
      [0, `Automatiskt (${auto}, ${fmt((FF(B) / auto) * 100, 1)} cm per steg)`],
      ...[11, 12, 13, 14, 15, 16].map((n): [number, string] => [n, `${n} steg, ${fmt((FF(B) / n) * 100, 1)} cm per steg`]),
    ]
  }

  let fields: ReactNode = null
  switch (it.type) {
    case 'skylight':
      fields = (
        <>
          <SelectField id={id('slope')} label="Takfall" value={it.slope} options={[['S', 'Södra takfallet'], ['N', 'Norra takfallet']]} onChange={set('slope')} />
          <SelectField id={id('bay')} label="Mellan sparrar" value={it.bay} options={geo.BAYS.map((b, i) => [i, `Fack ${i + 1} · mitt ${fmt(b.c)} m`] as [number, string])} onChange={set('bay')} />
          <SelectField id={id('size')} label="Storlek (b × h cm)" value={it.size} options={Object.keys(SKY_SIZES).map((k) => [k, k] as [string, string])} onChange={set('size')} />
          <RangeField id={id('bottom')} label="Underkant över golvet" value={it.bottom} min={0.4} max={2} step={0.05} format={(v) => `${cm(v)} cm`} onChange={set('bottom')} />
        </>
      )
      break
    case 'wall':
      fields = (
        <>
          <RangeField id={id('x')} label="Från västra gaveln" value={it.x} min={0} max={geo.L} step={0.05} format={metres} onChange={set('x')} />
          <CheckField id={id('door')} label="Dörröppning" checked={it.door} onChange={set('door')} />
          {it.door && <RangeField id={id('doorZ')} label="Dörrens läge tvärs" value={it.doorZ} min={-0.9} max={0.9} step={0.05} format={metres} onChange={set('doorZ')} />}
        </>
      )
      break
    case 'closet':
      fields = (
        <>
          <SelectField id={id('wall')} label="Mot" value={it.wall} options={[['E', 'Östra gaveln'], ['W', 'Västra gaveln']]} onChange={set('wall')} />
          <SelectField id={id('side')} label="Sida" value={it.side} options={SIDES} onChange={set('side')} />
          <CheckField id={id('fit')} label="Anpassa efter trappan och fönstret" checked={it.fit} onChange={set('fit')} />
          {!it.fit && (
            <>
              <CmField id={id('d')} label="Djup från gaveln" value={it.d} min={30} max={150} onChange={set('d')} />
              <CmField id={id('len')} label="Längd från takfoten" value={it.len} min={40} max={250} onChange={set('len')} />
            </>
          )}
        </>
      )
      break
    case 'storage':
      fields = (
        <>
          <RangeField id={id('x')} label="Mitt, från västra gaveln" value={it.x} min={0} max={geo.L} step={0.05} format={metres} onChange={set('x')} />
          <CmField id={id('w')} label="Längd längs väggen" value={it.w} min={60} max={300} onChange={set('w')} />
          <CmField id={id('d')} label="Djup från knäväggen" value={it.d} min={50} max={160} onChange={set('d')} />
          <SelectField id={id('side')} label="Mot" value={it.side} options={[['N', 'Norra knäväggen'], ['S', 'Södra knäväggen']]} onChange={set('side')} />
          <SelectField id={id('door')} label="Dörr" value={it.door} options={[['slide', 'Skjutdörr'], ['hinge', 'Svängdörr'], ['none', 'Öppen dörröppning']]} onChange={set('door')} />
          <CheckField id={id('wrap')} label="Fyll hörnet vid trappan" checked={it.wrap} onChange={set('wrap')} />
        </>
      )
      break
    case 'spiral':
      fields = (
        <>
          <RangeField id={id('x')} label="Mitt, från västra gaveln" value={it.x} min={0} max={geo.L} step={0.05} format={metres} onChange={set('x')} />
          <RangeField id={id('z')} label="Tvärs (− norr, + söder)" value={it.z} min={-geo.HALF} max={geo.HALF} step={0.05} format={metres} onChange={set('z')} />
          <SelectField id={id('rot')} label="Nedersta steget pekar mot" value={it.rot} onChange={set('rot')}
            options={[[0, 'Öster'], [45, 'Nordost'], [90, 'Norr'], [135, 'Nordväst'], [180, 'Väster'], [225, 'Sydväst'], [270, 'Söder'], [315, 'Sydost']]} />
          <SelectField id={id('dir')} label="Går upp" value={it.dir} options={[['cw', 'Medurs (sett uppifrån)'], ['ccw', 'Moturs (sett uppifrån)']]} onChange={set('dir')} />
          <CmField id={id('d')} label="Diameter" value={it.d} min={110} max={240} onChange={set('d')} />
          <SelectField id={id('deg')} label="Total vridning" value={it.deg} onChange={set('deg')}
            options={[[270, '270° (tre kvarts varv)'], [315, '315°'], [360, '360° (helt varv)'], [405, '405°'], [450, '450°']]} />
          <SelectField id={id('risers')} label="Antal steg" value={it.risers} options={risersOptions(0.19)} onChange={set('risers')} />
        </>
      )
      break
    case 'curved': {
      const P = curvedPlan(B, it)
      fields = (
        <>
          <RangeField id={id('x')} label="Nedersta steget, från västra gaveln" value={it.x} min={0} max={geo.L} step={0.05} format={metres} onChange={set('x')} />
          <RangeField id={id('z')} label="Tvärs (− norr, + söder)" value={it.z} min={-geo.HALF} max={geo.HALF} step={0.05} format={metres} onChange={set('z')} />
          <SelectField id={id('rot')} label="Börja gå mot" value={it.rot} options={[[0, 'Öster'], [180, 'Väster'], [90, 'Norr'], [270, 'Söder']]} onChange={set('rot')} />
          <SelectField id={id('turn')} label="Sväng" value={it.turn} options={[['L', 'Sväng vänster'], ['R', 'Sväng höger'], ['N', 'Rak, ingen sväng']]} onChange={set('turn')} />
          <SelectField id={id('risers')} label="Antal steg" value={it.risers} options={risersOptions(0.185)} onChange={set('risers')} />
          {it.turn !== 'N' && <RangeField id={id('a')} label="Steg före svängen" value={it.a} min={0} max={Math.max(0, P.n - 4)} step={1} format={(v) => `${v} steg`} onChange={set('a')} />}
          <CmField id={id('w')} label="Bredd" value={it.w} min={60} max={140} onChange={set('w')} />
        </>
      )
      break
    }
    case 'stairs':
      fields = (
        <>
          {pos()}
          <SelectField id={id('rot')} label="Riktning" value={it.rot} onChange={set('rot')}
            options={[[0, 'Kommer upp mot öster'], [180, 'Kommer upp mot väster'], [90, 'Kommer upp mot norr'], [270, 'Kommer upp mot söder']]} />
          <CmField id={id('w')} label="Bredd" value={it.w} min={60} max={150} onChange={set('w')} />
          <CmField id={id('run')} label="Öppningens längd" value={it.run} min={120} max={450} onChange={set('run')} />
          <CmField id={id('drop')} label="Våning till våning" value={it.drop} min={180} max={350} onChange={set('drop')} />
        </>
      )
      break
    default:
      fields = (
        <>
          {pos()}
          <RangeField id={id('rot')} label="Rotation" value={it.rot} min={0} max={345} step={15} format={(v) => `${v}°`} onChange={set('rot')} />
          {it.type === 'bed' ? (
            <SelectField id={id('size')} label="Sängstorlek" value={it.size} options={Object.keys(BED_SIZES).map((k) => [k, `${k} cm`] as [string, string])} onChange={set('size')} />
          ) : (
            <>
              <CmField id={id('w')} label="Bredd" value={it.w} min={10} max={400} onChange={set('w')} />
              <CmField id={id('d')} label="Djup" value={it.d} min={10} max={400} onChange={set('d')} />
              {it.type !== 'rug' && <CmField id={id('h')} label="Höjd" value={it.h} min={10} max={260} onChange={set('h')} />}
            </>
          )}
        </>
      )
  }

  const info = infoLines(geo, plan, it, holesOk)
  const real = realWarnings(warnings)
  return (
    <section className="vp-card" aria-label={`Redigera ${TYPE_LABEL[it.type].toLowerCase()}`}>
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
            {!INFO_CODES.has(w.code) && <span className="vp-sr">Varning: </span>}
            {warningText(w)}
          </p>
        ))}
        {real.length === 0 && <p className="vp-ok">Passar.</p>}
      </div>
      <div className="vp-actions">
        <button type="button" className="btn btn-ghost" onClick={onDone}>Klar</button>
        <button type="button" className="btn btn-ghost" onClick={onDuplicate}>Duplicera</button>
        <button type="button" className="btn btn-ghost vp-danger" onClick={onDelete}>Ta bort</button>
      </div>
    </section>
  )
}
