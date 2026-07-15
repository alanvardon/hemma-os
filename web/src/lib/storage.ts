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
import {
  parseBostadPrefs,
  parseBostadScenarios,
  parseBostadSession,
  parseConstants,
  parseDriftYearly,
  parseInputs,
  salvageBostadPrefs,
  salvageBostadScenarios,
  type BostadPrefs,
  type RejectedRecord,
} from './persistence-schema'
import { supabase } from './supabase'
import { syncCoordinator } from './sync'
import { cachedTombstoneIds, loadTombstoneIds, queueTableDelete, queueTableUpsert, registerTableSync, withoutTombstones } from './sync-table'
import { receiptRpc, rejectLegacyToolOperation, rememberRowRevisions, rememberToolRevision, revisionKey, syncRpcResult } from './sync-rpc'
import { makeImportOnce, materializeImport } from './store-helpers'
import { legacyImportAssignedToActive } from './legacy-data'
import { PersistenceError, reportPersistenceWarning } from './persistence-error'

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
const PREFS_TOOLS = {
  globalConstants: 'bostadskalkyl-global-constants',
  driftItems: 'bostadskalkyl-drift-items',
  savingsItems: 'bostadskalkyl-savings-items',
} as const
const SCEN_LEGACY_FLAG = 'bostadskalkyl_scenarios_legacy_imported_v2'
const PREFS_LEGACY_FLAG = 'bostadskalkyl_prefs_legacy_imported_v2'

/** Application-facing scenario shape. Persistence is validated into branded values internally. */
export interface Scenario {
  id: string
  name: string
  savedAt: string
  inputs: Inputs
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

function warning(source: string, rejected: RejectedRecord[]): void {
  if (!rejected.length) return
  const count = `${rejected.length} ${rejected.length === 1 ? 'post' : 'poster'}`
  reportPersistenceWarning(`Några sparade ${source} kunde inte läsas (${count}). Övriga sparade uppgifter finns kvar.`)
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
  id: s.id, name: s.name, saved_at: s.savedAt,
  inputs: s.inputs, constants: s.constants ?? null,
})

function _readScenCache(): Scenario[] {
  try {
    const raw = syncCoordinator.readScoped(SCEN_CACHE)
    if (!raw) return []
    const parsed = salvageBostadScenarios(JSON.parse(raw))
    warning('scenarier', parsed.rejected)
    return parsed.value
  } catch {
    warning('scenarier', [{ record: 'scenario cache', reason: 'contains invalid JSON' }])
    return []
  }
}
function _readScenCacheFrom(scope: ReturnType<typeof syncCoordinator.captureScope>): Scenario[] {
  try {
    const raw = scope.read(SCEN_CACHE)
    if (!raw) return []
    const parsed = salvageBostadScenarios(JSON.parse(raw))
    warning('scenarier', parsed.rejected)
    return parsed.value
  } catch {
    warning('scenarier', [{ record: 'scenario cache', reason: 'contains invalid JSON' }])
    return []
  }
}
function _writeScenCache(s: Scenario[]): void {
  syncCoordinator.writeScoped(SCEN_CACHE, JSON.stringify(s))
}

const SCEN_RESOURCE = 'scenarios'
registerTableSync(SCEN_RESOURCE, SCEN_TABLE)

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
      if (raw) {
        // An assigned backup is an explicit import: reject the complete batch
        // on any bad record instead of uploading a partial backup unnoticed.
        const valid = parseBostadScenarios(parsed)
        if (!valid.ok) {
          warning('scenarier från säkerhetskopian', valid.issues.map((issue) => ({ record: issue.path, reason: issue.reason })))
          return false
        }
        scenarios = materializeImport('scenario-legacy', raw, () => valid.value)
      }
    } catch {
      warning('scenarier från säkerhetskopian', [{ record: 'backup', reason: 'contains invalid JSON' }])
      return false
    }
    if (!scenarios.length) return true
    if (!scope.isActive()) return false
    try {
      await syncCoordinator.mutate({
        resource: SCEN_RESOURCE, operation: 'upsert', payload: { rows: scenarios.map(toRow), seed: true },
        entityIds: scenarios.map((scenario) => scenario.id),
        expectedRevisions: Object.fromEntries(scenarios.map((scenario) => [`${SCEN_RESOURCE}:${scenario.id}`, null])),
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
  const parsed = salvageBostadScenarios(result.data)
  warning('scenarier', parsed.rejected)
  rememberRowRevisions(SCEN_RESOURCE, result.data as Record<string, unknown>[])
  const rows = withoutTombstones(parsed.value, tombstones)
  if (scope.isActive()) scope.write(SCEN_CACHE, JSON.stringify(rows))
  return rows
}

// The store hands over the whole list each time, but only new or changed rows
// are sent to the server. This keeps optimistic conflicts scoped to the edited
// scenario instead of letting an unchanged stale sibling overwrite a partner's
// newer edit. Never derive deletions from "whatever isn't in my list"; that was a
// data-loss trap — on a fresh device the hydrate read can fail quietly, leaving
// the list `[]`; the first save would then delete the whole household's cloud
// scenarios (plan 43 / audit C1). Real deletions go through deleteScenarios().
// The optimistic cache is updated first, but cache-only is not reported as a
// successful cloud save.
//
// Server tombstones reject a stale device that later tries to recreate an
// acknowledged deleted id; intentional recreation must use a fresh id.
export async function saveScenarios(scenarios: Scenario[]): Promise<void> {
  const parsed = parseBostadScenarios(scenarios)
  if (!parsed.ok) throw new PersistenceError('validation')
  const cached = new Map(_readScenCache().map((scenario) => [scenario.id, JSON.stringify(toRow(scenario))]))
  const changed = parsed.value.filter((scenario) => cached.get(scenario.id) !== JSON.stringify(toRow(scenario)))
  const rows = changed.map(toRow)
  if (!rows.length) { _writeScenCache(parsed.value); return }
  await queueTableUpsert(SCEN_RESOURCE, rows, changed.map((scenario) => scenario.id), () => _writeScenCache(parsed.value))
}

// Explicit deletion — the ONLY path that removes cloud rows. Array `.in()` filter
// so supabase-js quotes the ids itself (no string interpolation — a legacy id
// containing `,` or `)` can't corrupt the filter).
export async function deleteScenarios(ids: string[]): Promise<void> {
  const clean = ids.filter(Boolean)
  if (!clean.length) return
  await queueTableDelete(SCEN_RESOURCE, clean, () => {
    const drop = new Set(clean)
    _writeScenCache(_readScenCache().filter((scenario) => !drop.has(scenario.id)))
  })
}

export function loadSession(): Promise<Session | null> {
  try {
    const raw = syncCoordinator.readScoped(KEYS.session)
    if (!raw) return Promise.resolve(null)
    const parsed = parseBostadSession(JSON.parse(raw))
    if (!parsed.ok) {
      warning('session', parsed.issues.map((issue) => ({ record: issue.path, reason: issue.reason })))
      return Promise.resolve(null)
    }
    return Promise.resolve(parsed.value)
  } catch {
    warning('session', [{ record: 'session', reason: 'contains invalid JSON' }])
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
    if (!raw) return Promise.resolve(null)
    const parsed = parseInputs(JSON.parse(raw))
    if (!parsed.ok) {
      warning('utkast', parsed.issues.map((issue) => ({ record: issue.path, reason: issue.reason })))
      return Promise.resolve(null)
    }
    return Promise.resolve(parsed.value)
  } catch {
    warning('utkast', [{ record: 'draft', reason: 'contains invalid JSON' }])
    return Promise.resolve(null)
  }
}

export function saveDraft(inputs: Inputs): Promise<void> {
  if (!parseInputs(inputs).ok) return Promise.reject(new PersistenceError('validation'))
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

function asPrefs(prefs: BostadPrefs): Prefs {
  return prefs
}

function _readPrefsCacheFrom(scope: ReturnType<typeof syncCoordinator.captureScope>): Prefs {
  try {
    const raw = scope.read(PREFS_CACHE)
    if (!raw) return { globalConstants: null, driftItems: [], savingsItems: [] }
    const parsed = salvageBostadPrefs(JSON.parse(raw))
    warning('inställningar', parsed.rejected)
    return asPrefs(parsed.value)
  } catch {
    warning('inställningar', [{ record: 'preferences cache', reason: 'contains invalid JSON' }])
  }
  return { globalConstants: null, driftItems: [], savingsItems: [] }
}
function _writePrefsCache(p: Prefs): void {
  syncCoordinator.writeScoped(PREFS_CACHE, JSON.stringify(p))
}

type PrefsKey = keyof Prefs

function prefsResource(key: PrefsKey): string {
  return `tool_state:${PREFS_TOOLS[key]}`
}

function registerPrefsSlice(key: PrefsKey): void {
  const tool = PREFS_TOOLS[key]
  const resource = prefsResource(key)
  syncCoordinator.register(resource, async (operation) => {
    const payload = operation.payload as { tool?: unknown; data?: unknown; seed?: unknown }
    if (!payload || payload.tool !== tool || !Object.prototype.hasOwnProperty.call(payload, 'data')) {
      throw { status: 400, message: 'Malformed preferences operation' }
    }
    await rejectLegacyToolOperation(operation, tool)
    const keyName = revisionKey('tool_state', tool)
    const { data, error } = await receiptRpc('sync_apply_tool_state', {
      p_operation_id: operation.id,
      p_tool: tool,
      p_data: payload.data,
      p_expected_revision: operation.expectedRevisions?.[keyName] ?? null,
      p_seed: payload.seed === true,
    })
    if (error) throw error
    return syncRpcResult(data)
  }, (operation) => {
    const payload = operation.payload as { tool?: unknown; data?: unknown; seed?: unknown }
    return operation.operation === 'upsert' && payload?.tool === tool
      && Object.prototype.hasOwnProperty.call(payload, 'data')
      && (payload.seed === undefined || typeof payload.seed === 'boolean')
      && operation.entityIds.length === 1 && operation.entityIds[0] === tool
  })
}

registerPrefsSlice('globalConstants')
registerPrefsSlice('driftItems')
registerPrefsSlice('savingsItems')

const _importScopedPrefs = makeImportOnce(
  () => syncCoordinator.scopedStorageKey(PREFS_LEGACY_FLAG),
  async () => {
    const scope = syncCoordinator.captureScope()
    if (!legacyImportAssignedToActive() || !scope.isActive()) return true
    let legacy: Prefs | null = null
    try {
      const cached = scope.read(PREFS_CACHE)
      if (cached) {
        const parsed = parseBostadPrefs(JSON.parse(cached))
        if (!parsed.ok) {
          warning('inställningar från säkerhetskopian', parsed.issues.map((issue) => ({ record: issue.path, reason: issue.reason })))
          return false
        }
        legacy = asPrefs(parsed.value)
      }
      const gc = scope.read(KEYS.globalConstants)
      const di = scope.read(KEYS.driftItems)
      const si = scope.read(KEYS.savingsItems)
      if (!legacy && (gc !== null || di !== null || si !== null)) {
        const parsed = parseBostadPrefs({
          globalConstants: gc ? JSON.parse(gc) : null,
          driftItems: di ? JSON.parse(di) : [],
          savingsItems: si ? JSON.parse(si) : [],
        })
        if (!parsed.ok) {
          warning('inställningar från säkerhetskopian', parsed.issues.map((issue) => ({ record: issue.path, reason: issue.reason })))
          return false
        }
        legacy = asPrefs(parsed.value)
      }
    } catch {
      warning('inställningar från säkerhetskopian', [{ record: 'backup', reason: 'contains invalid JSON' }])
      return false
    }
    if (!legacy) return true
    if (!scope.isActive()) return false
    try {
      const operations = (Object.keys(PREFS_TOOLS) as PrefsKey[])
        .filter((key) => key !== 'globalConstants' || legacy?.globalConstants !== null)
        .map((key) => {
          const tool = PREFS_TOOLS[key]
          return {
            resource: prefsResource(key), operation: 'upsert' as const,
            payload: { tool, data: legacy![key], seed: true }, entityIds: [tool],
            expectedRevisions: { [revisionKey('tool_state', tool)]: null },
          }
        })
      await syncCoordinator.mutateBatch(operations.map((operation, index) => ({
        ...operation,
        applyLocal: index === operations.length - 1 ? () => scope.write(PREFS_CACHE, JSON.stringify(legacy)) : undefined,
      })))
      return true
    } catch { return false }
  },
)

const _prefsInFlight = new Map<string, Promise<Prefs>>()

async function _loadPrefsSlice<K extends PrefsKey>(
  scope: ReturnType<typeof syncCoordinator.captureScope>, key: K, fallback: Prefs[K],
): Promise<Prefs[K]> {
  const tool = PREFS_TOOLS[key]
  const resource = prefsResource(key)
  if (!scope.isActive() || syncCoordinator.isDirty(resource)) return fallback
  const { data, error } = await supabase.from(STATE).select('data,revision').eq('tool', tool).maybeSingle()
  if (!scope.isActive() || syncCoordinator.isDirty(resource) || error || !data) return fallback
  rememberToolRevision(tool, data)
  const raw = data.data
  const parsed = key === 'globalConstants'
    ? salvageBostadPrefs({ globalConstants: raw, driftItems: [], savingsItems: [] })
    : key === 'driftItems'
      ? salvageBostadPrefs({ globalConstants: null, driftItems: raw, savingsItems: [] })
      : salvageBostadPrefs({ globalConstants: null, driftItems: [], savingsItems: raw })
  warning('inställningar', parsed.rejected)
  return parsed.value[key] as Prefs[K]
}

async function _loadPrefsFor(scope: ReturnType<typeof syncCoordinator.captureScope>): Promise<Prefs> {
  await _importScopedPrefs()
  const cached = _readPrefsCacheFrom(scope)
  const [globalConstants, driftItems, savingsItems] = await Promise.all([
    _loadPrefsSlice(scope, 'globalConstants', cached.globalConstants),
    _loadPrefsSlice(scope, 'driftItems', cached.driftItems),
    _loadPrefsSlice(scope, 'savingsItems', cached.savingsItems),
  ])
  const prefs: Prefs = {
    globalConstants,
    driftItems,
    savingsItems,
  }
  if (scope.isActive()) scope.write(PREFS_CACHE, JSON.stringify(prefs))
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

async function _savePrefsSlice<K extends PrefsKey>(key: K, value: Prefs[K]): Promise<void> {
  const scope = syncCoordinator.captureScope()
  const current = _readPrefsCacheFrom(scope)
  const next = { ...current, [key]: value }
  const valid = parseBostadPrefs(next)
  if (!valid.ok) throw new PersistenceError('validation')
  const tool = PREFS_TOOLS[key]
  const keyName = revisionKey('tool_state', tool)
  await syncCoordinator.mutate({
    resource: prefsResource(key),
    operation: 'upsert',
    payload: { tool, data: value },
    entityIds: [tool],
    expectedRevisions: { [keyName]: syncCoordinator.getRevision(keyName) },
    applyLocal: () => _writePrefsCache(next),
  })
}

// Global default constants — seed new scenarios + back saved scenarios that
// predate the per-scenario constants feature.
export async function loadGlobalConstants(): Promise<Constants | null> {
  return (await _loadPrefs()).globalConstants
}

export async function saveGlobalConstants(c: Constants): Promise<void> {
  await _savePrefsSlice('globalConstants', c)
}

// The scratch draft's constants (parallel to the draft inputs).
export function loadDraftConstants(): Promise<Constants | null> {
  try {
    const raw = syncCoordinator.readScoped(KEYS.draftConstants)
    if (!raw) return Promise.resolve(null)
    const parsed = parseConstants(JSON.parse(raw))
    if (!parsed.ok) {
      warning('utkastets inställningar', parsed.issues.map((issue) => ({ record: issue.path, reason: issue.reason })))
      return Promise.resolve(null)
    }
    return Promise.resolve(parsed.value)
  } catch {
    return Promise.resolve(null)
  }
}

export function saveDraftConstants(c: Constants): Promise<void> {
  if (!parseConstants(c).ok) return Promise.reject(new PersistenceError('validation'))
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
export const saveDriftItems = async (items: LineItem[]): Promise<void> => { await _savePrefsSlice('driftItems', items) }
export const loadSavingsItems = async (): Promise<LineItem[]> => (await _loadPrefs()).savingsItems
export const saveSavingsItems = async (items: LineItem[]): Promise<void> => { await _savePrefsSlice('savingsItems', items) }

export function loadDriftYearly(): Promise<boolean> {
  try {
    const parsed = parseDriftYearly(syncCoordinator.readScoped(KEY_DRIFT_YEARLY))
    if (!parsed.ok) {
      warning('driftvy', [{ record: 'driftYearly', reason: parsed.issues[0].reason }])
      return Promise.resolve(false)
    }
    return Promise.resolve(parsed.value)
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
