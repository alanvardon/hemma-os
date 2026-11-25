// Material: floor, ceiling panelling, rafters and walls (v41 Materials tab).
// The scene owns the real textures; the swatches here are flat colours that
// only hint at the choice. The ids are the plan's (lib/vindsplanen/items.ts).

import { MATERIAL_OPTIONS, type MaterialCategory } from '../../lib/vindsplanen/items'
import type { PlanV2 } from '../../lib/vindsplanen/plan'

const CATEGORY: Record<MaterialCategory, string> = {
  floor: 'Golv',
  panel: 'Takpanel',
  rafter: 'Sparrar',
  walls: 'Väggar (knävägg, gavlar, mellanväggar)',
}

// name (Swedish) + a flat swatch colour per option id (v41 MATS).
const OPTION: Record<MaterialCategory, Record<string, [string, string]>> = {
  floor: {
    oak: ['Ekgolv', '#b98c5a'],
    whiteoak: ['Vitoljad ek', '#dcc8a8'],
    pine: ['Furugolv', '#d6aa72'],
    smoked: ['Rökt ek', '#6e4b31'],
    grey: ['Gråtvättade bräder', '#aba59c'],
    lino: ['Linoleum, salvia', '#8e9f88'],
    chip: ['Spånskiva (idag)', '#c8a679'],
  },
  panel: {
    pine: ['Naturfuru (idag)', '#dcc093'],
    white: ['Vitmålad panel', '#efede7'],
    grey: ['Ljusgrå panel', '#cdd2ce'],
    green: ['Djupgrön panel', '#3e5a4b'],
    board: ['Slät vit skiva', '#f2f0eb'],
  },
  rafter: {
    natural: ['Natur (idag)', '#b98152'],
    white: ['Vitmålade', '#efece6'],
    black: ['Svarta', '#2b2826'],
    ceiling: ['Som taket', '#d8d4cc'],
  },
  walls: {
    white: ['Vit', '#eeebe5'],
    warm: ['Varmvit', '#ece2d3'],
    sage: ['Salviagrön', '#a8b49f'],
    clay: ['Lera', '#c79f86'],
    navy: ['Mörkblå', '#36455c'],
    pine: ['Furupanel', '#dcc093'],
  },
}

export default function MaterialsPanel({ plan, onChange }: { plan: PlanV2; onChange: (next: PlanV2) => void }) {
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
    </div>
  )
}
