// Material: floor, ceiling panelling, rafters and walls (v41 Materials tab).
// The scene owns the real textures; the swatches here are flat colours that
// only hint at the choice. The ids are the plan's (lib/vindsplanen/items.ts).

import { MATERIAL_OPTIONS, type MaterialCategory } from '../../lib/vindsplanen/items'
import type { PlanV2 } from '../../lib/vindsplanen/plan'

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
