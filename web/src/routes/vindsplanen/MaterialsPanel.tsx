// Material: floor, ceiling panelling, rafters and walls (v41 Materials tab).
// The scene owns the real textures; the swatches here are flat colours that
// only hint at the choice. The ids are the plan's (lib/vindsplanen/items.ts).

import { useMemo, useState } from 'react'
import type { Geometry } from '../../lib/vindsplanen/attic'
import { MATERIAL_OPTIONS, type MaterialCategory } from '../../lib/vindsplanen/items'
import { PRICES_NONE, type PlanV2, type PriceKey } from '../../lib/vindsplanen/plan'
import { costLines, costTotal, quantities, ZERO_M2 } from '../../lib/vindsplanen/quantities'
import { fmt, fmtKr } from './fmt'

const CATEGORY: Record<MaterialCategory, string> = {
  floor: 'Floor',
  panel: 'Ceiling panelling',
  rafter: 'Rafters',
  walls: 'Walls (knee walls, gables, partitions)',
}

// name (English) + a flat swatch colour per option id (v41 MATS).
const OPTION: Record<MaterialCategory, Record<string, [string, string]>> = {
  floor: {
    oak: ['Oak', '#b98c5a'],
    whiteoak: ['White-oiled oak', '#dcc8a8'],
    pine: ['Pine boards', '#d6aa72'],
    smoked: ['Smoked oak', '#6e4b31'],
    grey: ['Grey-washed boards', '#aba59c'],
    lino: ['Linoleum, sage', '#8e9f88'],
    chip: ['Chipboard (today)', '#c8a679'],
  },
  panel: {
    pine: ['Natural pine (today)', '#dcc093'],
    white: ['White-painted panelling', '#efede7'],
    grey: ['Light grey panelling', '#cdd2ce'],
    green: ['Deep green panelling', '#3e5a4b'],
    board: ['Smooth white board', '#f2f0eb'],
  },
  rafter: {
    natural: ['Natural (today)', '#b98152'],
    white: ['Painted white', '#efece6'],
    black: ['Black', '#2b2826'],
    ceiling: ['Same as ceiling', '#d8d4cc'],
  },
  walls: {
    white: ['White', '#eeebe5'],
    warm: ['Warm white', '#ece2d3'],
    sage: ['Sage green', '#a8b49f'],
    clay: ['Clay', '#c79f86'],
    navy: ['Navy', '#36455c'],
    pine: ['Pine panelling', '#dcc093'],
  },
}

const LINE: Record<PriceKey, { label: string; word: string; counts: string }> = {
  floor: { label: 'Floor', word: 'floor', counts: 'The floor inside the knee walls plus the floored eaves of opened bays, minus stair openings.' },
  panel: { label: 'Ceiling panel', word: 'ceiling panel', counts: 'The sloped ceiling of the bays that are not insulated, minus roof windows.' },
  walls: {
    label: 'Walls',
    word: 'walls',
    counts: 'Knee walls (room side), gables, partition walls (both faces), storage rooms and closets, minus doors and the gable window.',
  },
  insulation: { label: 'Insulated ceiling', word: 'insulated ceiling', counts: 'The plasterboard surface of the insulated bays, minus roof windows.' },
}

const INVALID = 'Enter an amount of 0 or more'

/** Parses a price as typed: "450", "450,5", "1 250". '' = not entered (null); invalid = undefined (never corrected). */
function parsePrice(text: string): number | null | undefined {
  const t = text.replace(/[\s ]/g, '').replace(',', '.')
  if (t === '') return null
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(t)) return undefined
  const v = Number(t)
  return Number.isFinite(v) ? v : undefined
}

function PriceRow({ k, m2, price, kr, onPrice }: { k: PriceKey; m2: number; price: number | null; kr: number | null; onPrice: (v: number | null) => void }) {
  const id = `vp-price-${k}`
  const [draft, setDraft] = useState<string | null>(null)
  const invalid = draft !== null && parsePrice(draft) === undefined
  const commit = () => {
    if (draft === null) return
    const v = parsePrice(draft)
    if (v === undefined) return // keep the text and the message; the stored price is untouched
    setDraft(null)
    if (v !== price) onPrice(v)
  }
  return (
    <div className="vp-cost-line" data-line={k}>
      <label htmlFor={id}>{LINE[k].label}</label>
      <span className="vp-cost-area">{fmt(m2, 1)}&nbsp;m²</span>
      <span className="vp-cost-input">
        <input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? `${id}-err` : undefined}
          value={draft ?? (price === null ? '' : String(price).replace('.', ','))}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
          }}
        />
        <span className="vp-unit">kr/m²</span>
      </span>
      <output className="vp-cost-amount" htmlFor={id}>
        {kr === null ? <span className="vp-cost-missing">Price missing</span> : fmtKr(kr)}
      </output>
      {invalid && (
        <p className="vp-cost-err" id={`${id}-err`} role="alert">
          {INVALID}
        </p>
      )}
    </div>
  )
}

function CostGroup({ geo, plan, onChange }: { geo: Geometry; plan: PlanV2; onChange: (next: PlanV2) => void }) {
  const lines = useMemo(() => costLines(quantities(geo, plan), plan.prices), [geo, plan])
  const total = costTotal(lines)
  // No priced line with area: the total would be a meaningless 0 kr, so show no figure.
  const noEstimate = total.missing.length > 0 && lines.every((l) => l.kr === null || Math.abs(l.m2) < ZERO_M2)
  return (
    <div className="vp-group" role="group" aria-labelledby="vp-cost-h">
      <h2 id="vp-cost-h">Quantities and cost</h2>
      <div className="vp-cost">
        {lines.map((l) => (
          <PriceRow
            key={l.key}
            k={l.key}
            m2={l.m2}
            price={l.price}
            kr={l.kr}
            onPrice={(v) => onChange({ ...plan, prices: { ...PRICES_NONE, ...plan.prices, [l.key]: v } })}
          />
        ))}
      </div>
      {noEstimate ? (
        <p className="vp-cost-total">Enter prices to see an estimate.</p>
      ) : (
        <div className="vp-cost-total">
          <p>
            Estimated material cost: <b>{fmtKr(total.kr)}</b>
          </p>
          {total.missing.length > 0 && <p className="vp-note">Price missing for: {total.missing.map((k) => LINE[k].word).join(', ')}.</p>}
        </div>
      )}
      <p className="vp-note">Estimate incl. VAT, excluding waste, labour and delivery.</p>
      <details className="vp-cost-counts">
        <summary>What’s counted</summary>
        <ul>
          {lines.map((l) => (
            <li key={l.key}>
              <b>{LINE[l.key].label}.</b> {LINE[l.key].counts}
            </li>
          ))}
        </ul>
        <p className="vp-note">Gross areas, with no allowance for waste.</p>
      </details>
    </div>
  )
}

export default function MaterialsPanel({ geo, plan, onChange }: { geo: Geometry; plan: PlanV2; onChange: (next: PlanV2) => void }) {
  return (
    <div className="vp-pane">
      {(Object.keys(MATERIAL_OPTIONS) as MaterialCategory[]).map((cat) => (
        <div className="vp-group" key={cat} role="group" aria-labelledby={`vp-mat-${cat}`}>
          <h2 id={`vp-mat-${cat}`}>{CATEGORY[cat]}</h2>
          <div className="vp-swatches">
            {MATERIAL_OPTIONS[cat].map((key) => {
              const [name, color] = OPTION[cat][key] ?? [key, '#ccc']
              const on = plan.materials[cat] === key
              return (
                <button
                  key={key}
                  type="button"
                  className="vp-swatch"
                  aria-pressed={on}
                  onClick={() => {
                    if (!on) onChange({ ...plan, materials: { ...plan.materials, [cat]: key } })
                  }}
                >
                  <i style={{ background: color }} aria-hidden="true" />
                  <span>{name}</span>
                </button>
              )
            })}
          </div>
        </div>
      ))}
      <CostGroup geo={geo} plan={plan} onChange={onChange} />
    </div>
  )
}
