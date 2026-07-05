/* hushallsbudget-store.ts — persistence for the budget baseline (the pot).
   Phase 16d: reads and writes the whole BudgetState as one row in the shared
   `tool_state` table (tool = 'hushallsbudget', Decision 9 — camelCase keys stay
   camelCase inside jsonb), with a localStorage write-through CACHE for offline.
   Both exported signatures were made async in commit 1, so the call sites in
   Hushallsbudget.tsx / Home.tsx don't change here. supabase-js never throws — it
   returns { data, error } — so we check `error` and fall back to the cache.

   Two localStorage keys, deliberately separate (as in salary/manadsavslut):
   - STORAGE_KEY  — the PRE-Supabase budget. Now the one-time import SOURCE and a
     permanent backup; never written after the swap. Keeping it distinct from the
     cache is what makes the first-login import safe: the cache write can never
     clobber the original before it's uploaded.
   - CACHE_KEY    — the write-through offline cache of the cloud blob. */

import { defaultState, type BudgetState } from './hushallsbudget'
import { supabase } from './supabase'

// Legacy pre-Supabase budget — import source + backup. (Exported name kept for
// back-compat; it is no longer the write target.)
export const STORAGE_KEY = 'bostadskalkyl_budget_v1'
const CACHE_KEY = 'bostadskalkyl_budget_cache_v1'
const IMPORT_FLAG = 'bostadskalkyl_budget_supabase_imported'
const STATE = 'tool_state'
const TOOL = 'hushallsbudget'

// Forward-migrate a loaded budget blob to the current shape. Returns null when
// there's nothing valid so the caller can fall back to the example budget.
// Idempotent — runs on localStorage blobs and cloud blobs alike (cloud rows
// were themselves born from a migrated blob).
function _migrate(raw: unknown): BudgetState | null {
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
    if (r.owner === 'joint' && (!r.category || !valid[r.category])) r.category = fallback
  })
  return s
}

// ── localStorage cache (offline fallback) ───────────────────────────────────
function _readCache(): BudgetState | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    return _migrate(JSON.parse(raw))
  } catch {
    return null
  }
}

function _writeCache(state: BudgetState): void {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(state)) } catch { /* private mode / quota — cache is best-effort */ }
}

// The pre-Supabase budget, migrated, ready to upsert. Read-only: STORAGE_KEY is
// never written after the swap, so the original survives even if the upload
// fails.
function _readLegacy(): BudgetState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return _migrate(JSON.parse(raw))
  } catch {
    return null
  }
}

// ── First-login import (one-time, idempotent) ───────────────────────────────
// On the first authenticated load after the household exists, seed the shared
// budget from the legacy localStorage blob — but ONLY if no cloud row exists yet
// (so a partner's already-saved budget is never clobbered). The first member to
// log in seeds it; everyone else no-ops. On any error (offline / RLS not ready)
// it does NOT set the flag and clears the in-memory guard, so it retries next
// call. `_importOnce` dedupes concurrent calls within a session.
let _importOnce: Promise<void> | null = null
function _importLocalOnce(): Promise<void> {
  if (_importOnce) return _importOnce
  _importOnce = (async () => {
    let already = true
    try { already = localStorage.getItem(IMPORT_FLAG) === '1' } catch { already = false }
    if (already) return
    const legacy = _readLegacy()
    if (legacy) {
      // Only seed if the household has no budget row yet.
      const { data, error: selErr } = await supabase.from(STATE).select('tool').eq('tool', TOOL).maybeSingle()
      if (selErr) { _importOnce = null; return } // retry next call — don't mark done
      if (!data) {
        const { error } = await supabase.from(STATE).upsert({ tool: TOOL, data: legacy }, { onConflict: 'household_id,tool' })
        if (error) { _importOnce = null; return } // retry next call
      }
    }
    try { localStorage.setItem(IMPORT_FLAG, '1') } catch { /* ignore */ }
  })()
  return _importOnce
}

// ── Public API (signatures unchanged since commit 1) ─────────────────────────

// Read the shared budget. Runs the one-time legacy import first (so a seeded
// blob appears in this very call), then reads cloud; on any error (offline / RLS
// / down) serves the last-known cache so the page still renders. `null` means no
// budget stored yet, so the caller falls back to the example budget.
export async function loadBudget(): Promise<BudgetState | null> {
  await _importLocalOnce()
  const { data, error } = await supabase.from(STATE).select('data').eq('tool', TOOL).maybeSingle()
  if (error) return _readCache()          // offline / down → cache
  if (!data) return null                   // no cloud budget yet
  const state = _migrate(data.data)
  if (state) _writeCache(state)
  return state
}

// Persist the whole budget blob. Updates the cache optimistically, then upserts
// to the cloud (household_id fills from the column default; conflict key =
// (household_id, tool)). Never rejects — the sole caller fires this and forgets
// (`void saveBudget(...)`), and the pre-Supabase store never threw either; an
// offline write just lives on in the cache until the next successful save.
export async function saveBudget(state: BudgetState): Promise<void> {
  _writeCache(state)
  await supabase.from(STATE).upsert({ tool: TOOL, data: state }, { onConflict: 'household_id,tool' })
}
