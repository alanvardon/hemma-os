// The numbers the "Compare variants" table shows for one plan variant (plan
// 149). A thin, pure aggregation over the lib/vindsplanen core — the same
// computeZones / planWarnings the open plan's stats and item list use, so a
// variant's column always matches what opening it would show.

import { deriveGeometry } from '../../lib/vindsplanen/attic'
import type { PlanV2 } from '../../lib/vindsplanen/plan'
import { isUpStair } from '../../lib/vindsplanen/stairs'
import { planWarnings, realWarnings } from '../../lib/vindsplanen/warnings'
import { computeZones } from '../../lib/vindsplanen/zones'

export interface VariantSummary {
  /** m² of floor inside the knee walls. */
  floor: number
  /** m² with standing height (≥ 1.90 m). */
  stand: number
  /** m² that counts as living area, approx. */
  boa: number
  /** Warnings over all items (info notes excluded), as the item list counts them. */
  warnings: number
  /** Stairs of any kind (straight, turning, spiral). */
  stairs: number
  /** Roof windows. */
  windows: number
  // Plan 150: the variant's cost estimate joins here.
}

export function summarizeVariant(plan: PlanV2): VariantSummary {
  const geo = deriveGeometry(plan.options.attic)
  const z = computeZones(geo, plan)
  const warns = planWarnings(geo, plan)
  return {
    floor: z.floor * z.cellArea,
    stand: z.stand * z.cellArea,
    boa: z.boa * z.cellArea,
    warnings: plan.items.reduce((n, it) => n + realWarnings(warns[it.id] ?? []).length, 0),
    stairs: plan.items.filter((it) => it.type === 'stairs' || isUpStair(it)).length,
    windows: plan.items.filter((it) => it.type === 'skylight').length,
  }
}
