/* hushallsbudget-store.ts — persistence for the budget baseline (the pot).
   Phase 16d: reads and writes the whole BudgetState as one row in the shared
   `tool_state` table (tool = 'hushallsbudget', Decision 9 — camelCase keys stay
   camelCase inside jsonb), with a localStorage write-through cache for offline.
   The persistence skeleton (cache, first-login import, load/save) lives in
   ./tool-store (createToolStateStore); only the `_migrate` transform and the key
   strings are tool-specific. Both exported signatures are async, so the call
   sites in Hushallsbudget.tsx / Home.tsx don't change. */

import { defaultState, type BudgetState } from './hushallsbudget'
import { createToolStateStore } from './tool-store'

// Legacy pre-Supabase budget — import source + backup. (Exported name kept for
// back-compat; it is no longer the write target.)
export const STORAGE_KEY = 'bostadskalkyl_budget_v1'

// Forward-migrate a loaded budget blob to the current shape. Returns null when
// there's nothing valid so the caller can fall back to the example budget.
// Idempotent — runs on localStorage blobs and cloud blobs alike (cloud rows
// were themselves born from a migrated blob).
export function migrateBudget(raw: unknown): BudgetState | null {
  const s = raw as BudgetState
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
    if (r.owner === 'joint' && r.source !== 'bolanekoll' && (!r.category || !valid[r.category])) r.category = fallback
  })
  return s
}

const store = createToolStateStore<BudgetState>({
  tool: 'hushallsbudget',
  storageKey: STORAGE_KEY,
  cacheKey: 'bostadskalkyl_budget_cache_v1',
  importFlag: 'bostadskalkyl_budget_supabase_imported',
  merge: migrateBudget,
})

// Read the shared budget. `null` means no budget stored yet, so the caller falls
// back to the example budget.
export const loadBudget = store.load
// Persist the whole budget blob. Never rejects — the sole caller fires and
// forgets (`void saveBudget(...)`).
export const saveBudget = store.save
