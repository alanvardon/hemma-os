// Pure plan edits used by the panels: add / duplicate / remove / patch an item
// and the option setters. No React, no storage; the controller records the
// result as one edit.

import { atticOf, clamp, deriveGeometry, type Attic } from '../../lib/vindsplanen/attic'
import { makeItem } from '../../lib/vindsplanen/items'
import { sanitizeShape, type Below, type Gable, type Item, type ItemType, type PlanV2, type Site } from '../../lib/vindsplanen/plan'

let counter = 1
/** A fresh item id (v41 `newId`). */
export const newItemId = (): string => 'i' + Date.now().toString(36) + counter++

export function addItem(plan: PlanV2, type: ItemType, id: string): { plan: PlanV2; item: Item } {
  const item = makeItem(deriveGeometry(plan.options.attic), plan, type, id)
  return { plan: { ...plan, items: [...plan.items, item] }, item }
}

export function duplicateItem(plan: PlanV2, id: string, newId: string): { plan: PlanV2; item: Item } | null {
  const src = plan.items.find((i) => i.id === id)
  if (!src) return null
  const geo = deriveGeometry(plan.options.attic)
  const copy: Item = { ...src, id: newId }
  if (copy.type === 'skylight') copy.bay = (copy.bay + 1) % geo.BAYS.length
  else if ('x' in copy) copy.x = clamp(copy.x + 0.3, 0, geo.L)
  return { plan: { ...plan, items: [...plan.items, copy] }, item: copy }
}

export const removeItem = (plan: PlanV2, id: string): PlanV2 => ({ ...plan, items: plan.items.filter((i) => i.id !== id) })

export const patchItem = (plan: PlanV2, id: string, patch: Record<string, unknown>): PlanV2 => ({
  ...plan,
  items: plan.items.map((i) => (i.id === id ? ({ ...i, ...patch } as Item) : i)),
})

export const patchBelow = (plan: PlanV2, patch: Partial<Below>): PlanV2 => ({ ...plan, options: { ...plan.options, below: { ...plan.options.below, ...patch } } })
export const patchGable = (plan: PlanV2, patch: Partial<Gable>): PlanV2 => ({ ...plan, options: { ...plan.options, gable: { ...plan.options.gable, ...patch } } })

export const patchSite = (plan: PlanV2, patch: Partial<Site>): PlanV2 => ({ ...plan, options: { ...plan.options, site: { ...plan.options.site, ...patch } } })

/**
 * Change one attic measurement. `atticOf` normalises it; the rest of the plan
 * is re-validated against the new geometry (what v41's reload did), so bays
 * and positions that no longer exist are dropped or clamped.
 */
export function patchAttic(plan: PlanV2, patch: Partial<Attic>): PlanV2 {
  const next: PlanV2 = { ...plan, options: { ...plan.options, attic: atticOf({ ...plan.options.attic, ...patch }) } }
  return sanitizeShape(next) ?? next
}

/** Toggle bay `i` in a bay list, keeping it sorted as v41 does (default sort). */
export function toggleBay(list: readonly number[], i: number, on: boolean): number[] {
  const set = new Set(list)
  if (on) set.add(i)
  else set.delete(i)
  return [...set].sort()
}
