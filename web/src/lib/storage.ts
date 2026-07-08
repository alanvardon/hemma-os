// Persistence layer — Phase 16f: saved scenarios live in the Supabase
// `scenarios` table, and the global prefs (globalConstants + driftItems +
// savingsItems) in the shared `tool_state` blob (tool = 'bostadskalkyl-prefs').
// Everything else — session, draft, draftConstants, theme, driftYearly — stays
// per-device localStorage by design (scratch buffers + device state). Every
// exported signature is unchanged, so useStore.ts is untouched. supabase-js
// never throws — it returns { data, error } — so reads fall back to a
// write-through cache and the fire-and-forget writes swallow failures.
//
// Legacy v1 keys (KEYS.scenarios / globalConstants / driftItems / savingsItems)
// become read-only one-time import SOURCES + backups; NEW *_cache keys hold the
// write-through cache, so the cache write can't clobber the legacy data before
// the first-login import uploads it (the key-split from 16b/16c/16e).
import type { Inputs, Constants } from './calc'
import { supabase } from './supabase'
import { genId } from './id'
import { makeImportOnce } from './store-helpers'

const KEYS = {
  scenarios: 'bostadskalkyl_scenarios_v1',
  session: 'bostadskalkyl_session_v1',
  draft: 'bostadskalkyl_draft_v1',
  draftConstants: 'bostadskalkyl_draft_constants_v1',
  globalConstants: 'bostadskalkyl_constants_v1',
  driftItems: 'bostadskalkyl_drift_items_v1',
  savingsItems: 'bostadskalkyl_savings_items_v1',
} as const
const KEY_THEME = 'bostadskalkyl_theme'
const KEY_DRIFT_YEARLY = 'bostadskalkyl_drift_yearly'

const SCEN_CACHE = 'bostadskalkyl_scenarios_cache_v1'
const PREFS_CACHE = 'bostadskalkyl_prefs_cache_v1'
const IMPORT_FLAG = 'bostadskalkyl_scenarios_supabase_imported'
const SCEN_TABLE = 'scenarios'
const STATE = 'tool_state'
const PREFS_TOOL = 'bostadskalkyl-prefs'

export interface Scenario {
  id: string
  name: string
  savedAt: string
  inputs: Inputs
  // Per-scenario statutory constants. Absent on scenarios saved before this
  // feature — those fall back to the global defaults at read time.
  constants?: Constants
}

// A line item in the driftkostnad breakdown or the savings list. `amount` is
// always stored as a MONTHLY figure for drift (the yearly toggle is a view).
export interface LineItem {
  id: string
  label: string
  amount: number
}

export interface Session {
  inputs: Inputs
  activeScenarioId: string | null
  isDirty: boolean
}

// One-time migration from the original unversioned keys (matches storage.js).
const MIGRATIONS: [string, string][] = [
  ['bostadskalkyl_scenarios', KEYS.scenarios],
  ['bostadskalkyl_session', KEYS.session],
  ['bostadskalkyl_drift_items', KEYS.driftItems],
  ['bostadskalkyl_savings_items', KEYS.savingsItems],
]

export function runMigrations(): void {
  for (const [from, to] of MIGRATIONS) {
    try {
      const oldVal = localStorage.getItem(from)
      if (oldVal !== null && localStorage.getItem(to) === null) {
        localStorage.setItem(to, oldVal)
        localStorage.removeItem(from)
      }
    } catch {
      /* storage unavailable — ignore */
    }
  }
}

// ── Scenarios (Supabase `scenarios` table) ──────────────────────────────────
// The one non-snake row type: `savedAt` (camelCase) ↔ `saved_at` column; the
// nested inputs/constants keep their camelCase keys inside jsonb. Mapping lives
// only here. toRow also coalesces the NOT-NULL columns so a legacy row missing
// one still inserts (learned from 16e).
const toRow = (s: Scenario): Record<string, unknown> => ({
  id: s.id || genId('scen'), name: s.name ?? '', saved_at: s.savedAt ?? '',
  inputs: s.inputs ?? {}, constants: s.constants ?? null,
})
const fromRow = (r: Record<string, unknown>): Scenario => ({
  id: r.id as string, name: (r.name as string) ?? '', savedAt: (r.saved_at as string) ?? '',
  inputs: r.inputs as Inputs, constants: (r.constants as Constants) ?? undefined,
})

function _readScenCache(): Scenario[] {
  try { const raw = localStorage.getItem(SCEN_CACHE); const d = raw ? JSON.parse(raw) : null; return Array.isArray(d) ? d : [] } catch { return [] }
}
function _writeScenCache(s: Scenario[]): void {
  try { localStorage.setItem(SCEN_CACHE, JSON.stringify(s)) } catch { /* quota */ }
}

// Newest-first (by saved_at), matching the table order used on load.
export async function loadScenarios(): Promise<Scenario[]> {
  await _importLocalOnce()
  const { data, error } = await supabase.from(SCEN_TABLE).select('*').order('saved_at', { ascending: false })
  if (error || !data) return _readScenCache()
  const rows = (data as Record<string, unknown>[]).map(fromRow)
  _writeScenCache(rows)
  return rows
}

// The store hands over the WHOLE list each time. UPSERT-ONLY: write every row,
// never delete. Deriving deletions from "whatever isn't in my list" was a
// data-loss trap — on a fresh device the hydrate read can fail quietly, leaving
// the list `[]`; the first save would then delete the whole household's cloud
// scenarios (plan 43 / audit C1). Real deletions go through deleteScenarios().
// Never rejects — the store fires this and forgets; the optimistic cache holds
// the latest and the next successful save reconciles cloud.
//
// Trade-off: a scenario deleted on device A can be re-upserted by device B
// holding a stale copy (resurrection). That is strictly safer than the old
// behaviour, where B would silently delete A's data.
export async function saveScenarios(scenarios: Scenario[]): Promise<void> {
  _writeScenCache(scenarios)
  try {
    const rows = scenarios.map(toRow)
    if (rows.length) await supabase.from(SCEN_TABLE).upsert(rows, { onConflict: 'id' })
  } catch { /* offline — cache holds the latest */ }
}

// Explicit deletion — the ONLY path that removes cloud rows. Array `.in()` filter
// so supabase-js quotes the ids itself (no string interpolation — a legacy id
// containing `,` or `)` can't corrupt the filter). Never rejects.
export async function deleteScenarios(ids: string[]): Promise<void> {
  const clean = ids.filter(Boolean)
  if (!clean.length) return
  try { await supabase.from(SCEN_TABLE).delete().in('id', clean) } catch { /* offline */ }
}

export function loadSession(): Promise<Session | null> {
  try {
    const raw = localStorage.getItem(KEYS.session)
    return Promise.resolve(raw ? (JSON.parse(raw) as Session) : null)
  } catch {
    return Promise.resolve(null)
  }
}

export function saveSession(
  inputs: Inputs,
  activeScenarioId: string | null,
  isDirty: boolean,
): Promise<void> {
  try {
    localStorage.setItem(KEYS.session, JSON.stringify({ inputs, activeScenarioId, isDirty }))
  } catch {
    /* ignore */
  }
  return Promise.resolve()
}

// The scratch draft (the unsaved "New scenario" buffer). Separate from saved
// scenarios so it survives reloads and shows on the dashboard until saved.
// Retire the legacy single-session key once its inputs have been carried over to
// the draft — otherwise a discarded draft would regenerate from it on reload.
export function clearSession(): Promise<void> {
  try {
    localStorage.removeItem(KEYS.session)
  } catch {
    /* ignore */
  }
  return Promise.resolve()
}

export function loadDraft(): Promise<Inputs | null> {
  try {
    const raw = localStorage.getItem(KEYS.draft)
    return Promise.resolve(raw ? (JSON.parse(raw) as Inputs) : null)
  } catch {
    return Promise.resolve(null)
  }
}

export function saveDraft(inputs: Inputs): Promise<void> {
  try {
    localStorage.setItem(KEYS.draft, JSON.stringify(inputs))
  } catch {
    /* ignore */
  }
  return Promise.resolve()
}

export function clearDraft(): Promise<void> {
  try {
    localStorage.removeItem(KEYS.draft)
  } catch {
    /* ignore */
  }
  return Promise.resolve()
}

// ── Global prefs blob (globalConstants + drift + savings) ────────────────────
// One tool_state row (tool = 'bostadskalkyl-prefs') holds all three slices.
// Each load/save reads/writes its slice of the shared blob.
interface Prefs { globalConstants: Constants | null; driftItems: LineItem[]; savingsItems: LineItem[] }

function _readPrefsCache(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_CACHE)
    const d = raw ? JSON.parse(raw) : null
    if (d && typeof d === 'object') return {
      globalConstants: d.globalConstants ?? null,
      driftItems: Array.isArray(d.driftItems) ? d.driftItems : [],
      savingsItems: Array.isArray(d.savingsItems) ? d.savingsItems : [],
    }
  } catch { /* ignore */ }
  return { globalConstants: null, driftItems: [], savingsItems: [] }
}
function _writePrefsCache(p: Prefs): void {
  try { localStorage.setItem(PREFS_CACHE, JSON.stringify(p)) } catch { /* quota */ }
}

// Dedupe concurrent reads (hydrate() loads all three slices in one Promise.all)
// so they share a single fetch; cleared once settled so a later save re-reads.
let _prefsInFlight: Promise<Prefs> | null = null
function _loadPrefs(): Promise<Prefs> {
  if (_prefsInFlight) return _prefsInFlight
  const p = (async () => {
    await _importLocalOnce()
    const { data, error } = await supabase.from(STATE).select('data').eq('tool', PREFS_TOOL).maybeSingle()
    if (error) return _readPrefsCache()
    const blob = (data?.data as Partial<Prefs>) || {}
    const prefs: Prefs = {
      globalConstants: blob.globalConstants ?? null,
      driftItems: Array.isArray(blob.driftItems) ? blob.driftItems : [],
      savingsItems: Array.isArray(blob.savingsItems) ? blob.savingsItems : [],
    }
    _writePrefsCache(prefs)
    return prefs
  })()
  _prefsInFlight = p
  void p.finally(() => { if (_prefsInFlight === p) _prefsInFlight = null })
  return p
}

// Read current blob, merge the patched slice, upsert. Never rejects (callers
// fire-and-forget). Merges against the cloud current so a sibling slice isn't
// clobbered (whole-blob last-write-wins across concurrent edits — accepted).
async function _savePrefs(patch: Partial<Prefs>): Promise<void> {
  const current = await _loadPrefs()
  const merged: Prefs = { ...current, ...patch }
  _writePrefsCache(merged)
  try { await supabase.from(STATE).upsert({ tool: PREFS_TOOL, data: merged }, { onConflict: 'household_id,tool' }) } catch { /* offline */ }
}

// Global default constants — seed new scenarios + back saved scenarios that
// predate the per-scenario constants feature.
export async function loadGlobalConstants(): Promise<Constants | null> {
  return (await _loadPrefs()).globalConstants
}

export async function saveGlobalConstants(c: Constants): Promise<void> {
  await _savePrefs({ globalConstants: c })
}

// The scratch draft's constants (parallel to the draft inputs).
export function loadDraftConstants(): Promise<Constants | null> {
  try {
    const raw = localStorage.getItem(KEYS.draftConstants)
    return Promise.resolve(raw ? (JSON.parse(raw) as Constants) : null)
  } catch {
    return Promise.resolve(null)
  }
}

export function saveDraftConstants(c: Constants): Promise<void> {
  try {
    localStorage.setItem(KEYS.draftConstants, JSON.stringify(c))
  } catch {
    /* ignore */
  }
  return Promise.resolve()
}

export function clearDraftConstants(): Promise<void> {
  try {
    localStorage.removeItem(KEYS.draftConstants)
  } catch {
    /* ignore */
  }
  return Promise.resolve()
}

export function loadTheme(): Promise<string | null> {
  try {
    return Promise.resolve(localStorage.getItem(KEY_THEME))
  } catch {
    return Promise.resolve(null)
  }
}

export function saveTheme(theme: string): Promise<void> {
  try {
    localStorage.setItem(KEY_THEME, theme)
  } catch {
    /* ignore */
  }
  return Promise.resolve()
}

// ── Drift breakdown + savings line items (Phase 7) — prefs blob slices ───────
export const loadDriftItems = async (): Promise<LineItem[]> => (await _loadPrefs()).driftItems
export const saveDriftItems = async (items: LineItem[]): Promise<void> => { await _savePrefs({ driftItems: items }) }
export const loadSavingsItems = async (): Promise<LineItem[]> => (await _loadPrefs()).savingsItems
export const saveSavingsItems = async (items: LineItem[]): Promise<void> => { await _savePrefs({ savingsItems: items }) }

// ── First-login import (one-time, idempotent) ───────────────────────────────
// Upsert the legacy localStorage scenarios (keyed on id) + seed the prefs blob
// from the three legacy pref keys, but only if no cloud prefs row exists yet (so
// a partner's saved prefs aren't clobbered). One flag gates both. On any error
// it leaves the flag unset and clears the guard to retry.
function _readLegacyScenarios(): Scenario[] {
  try {
    const raw = localStorage.getItem(KEYS.scenarios)
    const arr = raw ? JSON.parse(raw) : null
    if (!Array.isArray(arr)) return []
    return arr.map((s: Partial<Scenario>) => ({
      id: s.id || genId('scen'), name: s.name ?? '', savedAt: s.savedAt ?? '',
      inputs: (s.inputs ?? {}) as Inputs, constants: s.constants,
    }))
  } catch { return [] }
}

// The three legacy pref keys as one blob, or null when none exist (nothing to
// seed → don't write a defaults row).
function _readLegacyPrefs(): Prefs | null {
  try {
    const gc = localStorage.getItem(KEYS.globalConstants)
    const di = localStorage.getItem(KEYS.driftItems)
    const si = localStorage.getItem(KEYS.savingsItems)
    if (gc == null && di == null && si == null) return null
    return {
      globalConstants: gc ? JSON.parse(gc) : null,
      driftItems: di ? JSON.parse(di) : [],
      savingsItems: si ? JSON.parse(si) : [],
    }
  } catch { return null }
}

const _importLocalOnce = makeImportOnce(IMPORT_FLAG, async () => {
  const legacyScen = _readLegacyScenarios()
  if (legacyScen.length) {
    const { error } = await supabase.from(SCEN_TABLE).upsert(legacyScen.map(toRow), { onConflict: 'id' })
    if (error) return false
  }
  const legacyPrefs = _readLegacyPrefs()
  if (legacyPrefs) {
    const { data, error: selErr } = await supabase.from(STATE).select('tool').eq('tool', PREFS_TOOL).maybeSingle()
    if (selErr) return false
    if (!data) {
      const { error } = await supabase.from(STATE).upsert({ tool: PREFS_TOOL, data: legacyPrefs }, { onConflict: 'household_id,tool' })
      if (error) return false
    }
  }
  return true
})

export function loadDriftYearly(): Promise<boolean> {
  try {
    return Promise.resolve(localStorage.getItem(KEY_DRIFT_YEARLY) === 'true')
  } catch {
    return Promise.resolve(false)
  }
}

export function saveDriftYearly(yearly: boolean): Promise<void> {
  try {
    localStorage.setItem(KEY_DRIFT_YEARLY, String(yearly))
  } catch {
    /* ignore */
  }
  return Promise.resolve()
}
