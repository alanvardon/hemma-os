// Persistence layer — Phase 16f: saved scenarios live in the Supabase
// `scenarios` table, and the global prefs (globalConstants + driftItems +
// savingsItems) in the shared `tool_state` blob (tool = 'bostadskalkyl-prefs').
// Session/drafts/driftYearly are household+user scoped; theme stays device-only.
// Every
// exported signature is unchanged, so useStore.ts is untouched. supabase-js
// never throws — it returns { data, error } — so reads fall back to a
// durable cache/outbox mutation rejects until Supabase accepts it; callers
// surface stable user-facing status while queued work remains recoverable.
//
// Legacy v1 keys (KEYS.scenarios / globalConstants / driftItems / savingsItems)
// become read-only one-time import SOURCES + backups; NEW *_cache keys hold the
// write-through cache, so the cache write can't clobber the legacy data before
// the first-login import uploads it (the key-split from 16b/16c/16e).
import type { Inputs, Constants } from './calc'
import { supabase } from './supabase'
import { genId } from './id'
import { syncCoordinator } from './sync'
import { cachedTombstoneIds, loadTombstoneIds, withoutTombstones } from './sync-table'
import { makeImportOnce, materializeImport } from './store-helpers'
import { legacyImportAssignedToActive } from './legacy-data'

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
const SCEN_TABLE = 'scenarios'
const STATE = 'tool_state'
const PREFS_TOOL = 'bostadskalkyl-prefs'
const SCEN_LEGACY_FLAG = 'bostadskalkyl_scenarios_legacy_imported_v2'
const PREFS_LEGACY_FLAG = 'bostadskalkyl_prefs_legacy_imported_v2'

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
  // Unscoped data cannot safely be assigned to whichever account signs in
  // first on a shared device. The explicit legacy-import flow owns these keys.
  void MIGRATIONS
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
  try { const raw = syncCoordinator.readScoped(SCEN_CACHE); const d = raw ? JSON.parse(raw) : null; return Array.isArray(d) ? d : [] } catch { return [] }
}
function _readScenCacheFrom(scope: ReturnType<typeof syncCoordinator.captureScope>): Scenario[] {
  try { const raw = scope.read(SCEN_CACHE); const d = raw ? JSON.parse(raw) : null; return Array.isArray(d) ? d : [] } catch { return [] }
}
function _writeScenCache(s: Scenario[]): void {
  syncCoordinator.writeScoped(SCEN_CACHE, JSON.stringify(s))
}

const SCEN_RESOURCE = 'scenarios'
syncCoordinator.register(SCEN_RESOURCE, async (operation) => {
  if (operation.operation === 'upsert') {
    const rows = (operation.payload as { rows?: unknown })?.rows
    if (!Array.isArray(rows)) throw { status: 400, message: 'Malformed scenario upsert' }
    if (!rows.length) return
    const seed = (operation.payload as { seed?: unknown }).seed === true
    if (seed) {
      for (const row of rows) {
        const { error } = await supabase.from(SCEN_TABLE).upsert([row], { onConflict: 'id', ignoreDuplicates: true })
        if ((error as { code?: string } | null)?.code === '23505') continue
        if (error) throw error
      }
    } else {
      const { error } = await supabase.from(SCEN_TABLE).upsert(rows, { onConflict: 'id' })
      if (error) throw error
    }
    return
  }
  const ids = (operation.payload as { ids?: unknown })?.ids
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
    throw { status: 400, message: 'Malformed scenario delete' }
  }
  if (!ids.length) return
  const { error } = await supabase.rpc('delete_household_rows', {
    p_resource: SCEN_RESOURCE,
    p_ids: ids,
  })
  if (error) throw error
}, (operation) => {
  const payload = operation.payload as { rows?: unknown; ids?: unknown; seed?: unknown }
  if (operation.operation === 'upsert') {
    if (!Array.isArray(payload?.rows) || !payload.rows.every((row) => !!row && typeof row === 'object'
      && typeof (row as { id?: unknown }).id === 'string' && !!(row as { id?: string }).id)
      || (payload.seed !== undefined && typeof payload.seed !== 'boolean')) return false
    const ids = payload.rows.map((row) => (row as { id: string }).id)
    return ids.length === operation.entityIds.length && ids.every((id, index) => id === operation.entityIds[index])
  }
  return Array.isArray(payload?.ids) && payload.ids.every((id) => typeof id === 'string' && !!id)
    && payload.ids.length === operation.entityIds.length
    && payload.ids.every((id, index) => id === operation.entityIds[index])
})

const _importScopedScenarios = makeImportOnce(
  () => syncCoordinator.scopedStorageKey(SCEN_LEGACY_FLAG),
  async () => {
    const scope = syncCoordinator.captureScope()
    if (!legacyImportAssignedToActive() || !scope.isActive()) return true
    let scenarios: Scenario[] = []
    try {
      // Prefer the last write-through cache: it may contain a failed local save
      // newer than the pre-cloud import backup.
      const raw = scope.read(SCEN_CACHE) ?? scope.read(KEYS.scenarios)
      const parsed = raw ? JSON.parse(raw) : []
      if (Array.isArray(parsed) && raw) scenarios = materializeImport('scenario-legacy', raw, () => parsed.map((scenario: Partial<Scenario>) => ({
        id: scenario.id || genId('scen'), name: scenario.name ?? '', savedAt: scenario.savedAt ?? '',
        inputs: (scenario.inputs ?? {}) as Inputs, constants: scenario.constants,
      })))
    } catch { return false }
    if (!scenarios.length) return true
    if (!scope.isActive()) return false
    try {
      await syncCoordinator.mutate({
        resource: SCEN_RESOURCE, operation: 'upsert', payload: { rows: scenarios.map(toRow), seed: true },
        entityIds: scenarios.map((scenario) => scenario.id),
        applyLocal: () => scope.write(SCEN_CACHE, JSON.stringify(scenarios)),
      })
      return true
    } catch { return false }
  },
)

// Newest-first (by saved_at), matching the table order used on load.
export async function loadScenarios(): Promise<Scenario[]> {
  const scope = syncCoordinator.captureScope()
  await _importScopedScenarios()
  const fallback = () => withoutTombstones(_readScenCacheFrom(scope), cachedTombstoneIds(scope, SCEN_RESOURCE))
  if (!scope.isActive() || syncCoordinator.isDirty(SCEN_RESOURCE)) return fallback()
  const [result, tombstones] = await Promise.all([
    supabase.from(SCEN_TABLE).select('*').order('saved_at', { ascending: false }),
    loadTombstoneIds(scope, SCEN_RESOURCE),
  ])
  if (!scope.isActive() || syncCoordinator.isDirty(SCEN_RESOURCE)) return fallback()
  if (result.error || !result.data) return fallback()
  const rows = withoutTombstones((result.data as Record<string, unknown>[]).map(fromRow), tombstones)
  if (scope.isActive()) scope.write(SCEN_CACHE, JSON.stringify(rows))
  return rows
}

// The store hands over the WHOLE list each time. UPSERT-ONLY: write every row,
// never delete. Deriving deletions from "whatever isn't in my list" was a
// data-loss trap — on a fresh device the hydrate read can fail quietly, leaving
// the list `[]`; the first save would then delete the whole household's cloud
// scenarios (plan 43 / audit C1). Real deletions go through deleteScenarios().
// The optimistic cache is updated first, but cache-only is not reported as a
// successful cloud save.
//
// Server tombstones reject a stale device that later tries to recreate an
// acknowledged deleted id; intentional recreation must use a fresh id.
export async function saveScenarios(scenarios: Scenario[]): Promise<void> {
  const rows = scenarios.map(toRow)
  if (!rows.length) { _writeScenCache(scenarios); return }
  await syncCoordinator.mutate({
    resource: SCEN_RESOURCE,
    operation: 'upsert',
    payload: { rows },
    entityIds: scenarios.map((scenario) => scenario.id),
    applyLocal: () => _writeScenCache(scenarios),
  })
}

// Explicit deletion — the ONLY path that removes cloud rows. Array `.in()` filter
// so supabase-js quotes the ids itself (no string interpolation — a legacy id
// containing `,` or `)` can't corrupt the filter).
export async function deleteScenarios(ids: string[]): Promise<void> {
  const clean = ids.filter(Boolean)
  if (!clean.length) return
  await syncCoordinator.mutate({
    resource: SCEN_RESOURCE,
    operation: 'delete',
    payload: { ids: clean },
    entityIds: clean,
    applyLocal: () => {
      const drop = new Set(clean)
      _writeScenCache(_readScenCache().filter((scenario) => !drop.has(scenario.id)))
    },
  })
}

export function loadSession(): Promise<Session | null> {
  try {
    const raw = syncCoordinator.readScoped(KEYS.session)
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
    syncCoordinator.writeScoped(KEYS.session, JSON.stringify({ inputs, activeScenarioId, isDirty }))
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
    syncCoordinator.removeScoped(KEYS.session)
  } catch {
    /* ignore */
  }
  return Promise.resolve()
}

export function loadDraft(): Promise<Inputs | null> {
  try {
    const raw = syncCoordinator.readScoped(KEYS.draft)
    return Promise.resolve(raw ? (JSON.parse(raw) as Inputs) : null)
  } catch {
    return Promise.resolve(null)
  }
}

export function saveDraft(inputs: Inputs): Promise<void> {
  try {
    syncCoordinator.writeScoped(KEYS.draft, JSON.stringify(inputs))
  } catch {
    /* ignore */
  }
  return Promise.resolve()
}

export function clearDraft(): Promise<void> {
  try {
    syncCoordinator.removeScoped(KEYS.draft)
  } catch {
    /* ignore */
  }
  return Promise.resolve()
}

// ── Global prefs blob (globalConstants + drift + savings) ────────────────────
// One tool_state row (tool = 'bostadskalkyl-prefs') holds all three slices.
// Each load/save reads/writes its slice of the shared blob.
interface Prefs { globalConstants: Constants | null; driftItems: LineItem[]; savingsItems: LineItem[] }

function _readPrefsCacheFrom(scope: ReturnType<typeof syncCoordinator.captureScope>): Prefs {
  try {
    const raw = scope.read(PREFS_CACHE)
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
  syncCoordinator.writeScoped(PREFS_CACHE, JSON.stringify(p))
}

const PREFS_RESOURCE = `tool_state:${PREFS_TOOL}`
syncCoordinator.register(PREFS_RESOURCE, async (operation) => {
  const payload = operation.payload as { tool?: unknown; data?: unknown; seed?: unknown }
  if (!payload || payload.tool !== PREFS_TOOL || !('data' in payload)) {
    throw { status: 400, message: 'Malformed preferences operation' }
  }
  const { error } = payload.seed === true
    ? await supabase.from(STATE).insert({ tool: PREFS_TOOL, data: payload.data })
    : await supabase.from(STATE).upsert(
      { tool: PREFS_TOOL, data: payload.data }, { onConflict: 'household_id,tool' },
    )
  if (payload.seed === true && (error as { code?: string } | null)?.code === '23505') return
  if (error) throw error
}, (operation) => {
  const payload = operation.payload as { tool?: unknown; data?: unknown; seed?: unknown }
  return operation.operation === 'upsert' && payload?.tool === PREFS_TOOL && Object.prototype.hasOwnProperty.call(payload, 'data')
    && (payload.seed === undefined || typeof payload.seed === 'boolean')
    && operation.entityIds.length === 1 && operation.entityIds[0] === PREFS_TOOL
})

const _importScopedPrefs = makeImportOnce(
  () => syncCoordinator.scopedStorageKey(PREFS_LEGACY_FLAG),
  async () => {
    const scope = syncCoordinator.captureScope()
    if (!legacyImportAssignedToActive() || !scope.isActive()) return true
    let legacy: Prefs | null = null
    try {
      const cached = scope.read(PREFS_CACHE)
      if (cached) {
        const parsed = JSON.parse(cached) as Partial<Prefs>
        legacy = {
          globalConstants: parsed.globalConstants ?? null,
          driftItems: Array.isArray(parsed.driftItems) ? parsed.driftItems : [],
          savingsItems: Array.isArray(parsed.savingsItems) ? parsed.savingsItems : [],
        }
      }
      const gc = scope.read(KEYS.globalConstants)
      const di = scope.read(KEYS.driftItems)
      const si = scope.read(KEYS.savingsItems)
      if (!legacy && (gc !== null || di !== null || si !== null)) legacy = {
        globalConstants: gc ? JSON.parse(gc) : null,
        driftItems: di ? JSON.parse(di) : [],
        savingsItems: si ? JSON.parse(si) : [],
      }
    } catch { return false }
    if (!legacy) return true
    if (!scope.isActive()) return false
    try {
      await syncCoordinator.mutate({
        resource: PREFS_RESOURCE, operation: 'upsert', payload: { tool: PREFS_TOOL, data: legacy, seed: true },
        entityIds: [PREFS_TOOL], applyLocal: () => scope.write(PREFS_CACHE, JSON.stringify(legacy)),
      })
      return true
    } catch { return false }
  },
)

const _prefsInFlight = new Map<string, Promise<Prefs>>()

async function _loadPrefsFor(scope: ReturnType<typeof syncCoordinator.captureScope>): Promise<Prefs> {
  await _importScopedPrefs()
  if (!scope.isActive() || syncCoordinator.isDirty(PREFS_RESOURCE)) return _readPrefsCacheFrom(scope)
  const { data, error } = await supabase.from(STATE).select('data').eq('tool', PREFS_TOOL).maybeSingle()
  if (!scope.isActive() || syncCoordinator.isDirty(PREFS_RESOURCE)) return _readPrefsCacheFrom(scope)
  if (error) return _readPrefsCacheFrom(scope)
  const blob = (data?.data as Partial<Prefs>) || {}
  const prefs: Prefs = {
    globalConstants: blob.globalConstants ?? null,
    driftItems: Array.isArray(blob.driftItems) ? blob.driftItems : [],
    savingsItems: Array.isArray(blob.savingsItems) ? blob.savingsItems : [],
  }
  scope.write(PREFS_CACHE, JSON.stringify(prefs))
  return prefs
}

function _loadPrefs(): Promise<Prefs> {
  const scope = syncCoordinator.captureScope()
  const key = `${scope.identity.userId}\u0000${scope.identity.householdId}`
  const existing = _prefsInFlight.get(key)
  if (existing) return existing
  const loading = _loadPrefsFor(scope)
  _prefsInFlight.set(key, loading)
  void loading.finally(() => { if (_prefsInFlight.get(key) === loading) _prefsInFlight.delete(key) })
  return loading
}

// Read current blob, merge the patched slice, then upsert. Merges against the cloud current so a sibling slice isn't
// clobbered (whole-blob last-write-wins across concurrent edits — accepted).
async function _savePrefs(patch: Partial<Prefs>): Promise<void> {
  const scope = syncCoordinator.captureScope()
  const current = await _loadPrefsFor(scope)
  if (!scope.isActive()) throw new Error('Sync identity changed while preferences were loading')
  const merged: Prefs = { ...current, ...patch }
  await syncCoordinator.mutate({
    resource: PREFS_RESOURCE,
    operation: 'upsert',
    payload: { tool: PREFS_TOOL, data: merged },
    entityIds: [PREFS_TOOL],
    applyLocal: () => _writePrefsCache(merged),
  })
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
    const raw = syncCoordinator.readScoped(KEYS.draftConstants)
    return Promise.resolve(raw ? (JSON.parse(raw) as Constants) : null)
  } catch {
    return Promise.resolve(null)
  }
}

export function saveDraftConstants(c: Constants): Promise<void> {
  try {
    syncCoordinator.writeScoped(KEYS.draftConstants, JSON.stringify(c))
  } catch {
    /* ignore */
  }
  return Promise.resolve()
}

export function clearDraftConstants(): Promise<void> {
  try {
    syncCoordinator.removeScoped(KEYS.draftConstants)
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

export function loadDriftYearly(): Promise<boolean> {
  try {
    return Promise.resolve(syncCoordinator.readScoped(KEY_DRIFT_YEARLY) === 'true')
  } catch {
    return Promise.resolve(false)
  }
}

export function saveDriftYearly(yearly: boolean): Promise<void> {
  try {
    syncCoordinator.writeScoped(KEY_DRIFT_YEARLY, String(yearly))
  } catch {
    /* ignore */
  }
  return Promise.resolve()
}
