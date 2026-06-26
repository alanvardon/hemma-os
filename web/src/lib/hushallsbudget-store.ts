/* hushallsbudget-store.ts — persistence for the budget baseline (the pot).
   Ported from budget.js's loadState/save. Same localStorage key as the vanilla
   tool (bostadskalkyl_budget_v1) so existing budgets migrate untouched. */

import { defaultState, type BudgetState } from './hushallsbudget'

export const STORAGE_KEY = 'bostadskalkyl_budget_v1'

// Read + forward-migrate the saved budget. Returns null when there's nothing
// valid stored so the caller can fall back to the example budget.
export function loadBudget(): BudgetState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as BudgetState
    if (!s || s.version !== 1 || !Array.isArray(s.incomes) || !Array.isArray(s.costs) || !Array.isArray(s.savings)) return null
    if (!Array.isArray(s.people) || s.people.length !== 2) s.people = ['Alan', 'Partner']
    // Joint savings + joint income were removed from the UI — fold any legacy
    // joint rows into person A so saved budgets keep their money and render.
    s.savings.forEach((r) => { if (r.owner === 'joint') r.owner = 'a' })
    s.incomes.forEach((r) => { if (r.owner === 'joint') r.owner = 'a' })
    // Categories are newer than some saved budgets: seed a starter set and
    // drop any uncategorised joint costs into the last category so nothing
    // disappears (the user can then drag them into place).
    if (!Array.isArray(s.categories) || !s.categories.length) s.categories = defaultState().categories
    if (typeof s.catSeq !== 'number') s.catSeq = 0
    const valid: Record<string, boolean> = {}
    s.categories.forEach((c) => { valid[c.id] = true })
    const fallback = s.categories[s.categories.length - 1].id
    s.costs.forEach((r) => {
      if (r.owner === 'joint' && (!r.category || !valid[r.category])) r.category = fallback
    })
    return s
  } catch {
    return null
  }
}

export function saveBudget(state: BudgetState): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* private mode / quota */ }
}
