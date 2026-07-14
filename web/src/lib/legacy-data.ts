import { syncCoordinator } from './sync'

export const LEGACY_FINANCIAL_KEYS = [
  'bostadskalkyl_scenarios',
  'bostadskalkyl_scenarios_v1',
  'bostadskalkyl_scenarios_cache_v1',
  'bostadskalkyl_scenarios_supabase_imported',
  'bostadskalkyl_session',
  'bostadskalkyl_session_v1',
  'bostadskalkyl_draft_v1',
  'bostadskalkyl_draft_constants_v1',
  'bostadskalkyl_constants_v1',
  'bostadskalkyl_drift_items',
  'bostadskalkyl_drift_items_v1',
  'bostadskalkyl_savings_items',
  'bostadskalkyl_savings_items_v1',
  'bostadskalkyl_prefs_cache_v1',
  'bostadskalkyl_drift_yearly',
  'bostadskalkyl_budget_v1',
  'bostadskalkyl_budget_cache_v1',
  'bostadskalkyl_budget_supabase_imported',
  'bostadskalkyl_salary_log_v1',
  'bostadskalkyl_salary_cache_v1',
  'bostadskalkyl_salary_supabase_imported',
  'bostadskalkyl_monthend_v1',
  'bostadskalkyl_monthend_cache_v1',
  'bostadskalkyl_monthend_supabase_imported',
  'bostadskalkyl_mortgage_v1',
  'bostadskalkyl_mortgage_cache_v1',
  'bostadskalkyl_mortgage_supabase_imported',
  'bostadskalkyl_house_items_cache_v1',
  'bostadskalkyl_konsult_v1',
  'bostadskalkyl_konsult_cache_v1',
  'bostadskalkyl_konsult_supabase_imported',
  'bostadskalkyl_lonevaxling_v1',
  'bostadskalkyl_lonevaxling_cache_v1',
  'bostadskalkyl_lonevaxling_supabase_imported',
  'bostadskalkyl_studentloan_v1',
  'bostadskalkyl_studentloan_cache_v1',
  'bostadskalkyl_studentloan_supabase_imported',
] as const

export const LEGACY_QUARANTINE_KEY = 'hemma-sync-v1:legacy-quarantine'
const LEGACY_DISMISSED_KEY = 'legacy-import-dismissed'
const LEGACY_IMPORT_MARKER = 'legacy-import-transaction'
const LEGACY_IMPORTED_KEY = 'legacy-import-complete'

interface LegacyEnvelope {
  version: 1
  capturedAt: string
  entries: Record<string, string>
}

function readEnvelope(): LegacyEnvelope | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(LEGACY_QUARANTINE_KEY) ?? 'null') as Partial<LegacyEnvelope> | null
    if (!parsed || parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object') return null
    return parsed as LegacyEnvelope
  } catch { return null }
}

/** Move unowned financial keys into a neutral quarantine, never an identity namespace. */
export function quarantineLegacyData(): boolean {
  const existing = readEnvelope()
  const entries: Record<string, string> = { ...(existing?.entries ?? {}) }
  const found: string[] = []
  for (const key of LEGACY_FINANCIAL_KEYS) {
    try {
      const value = localStorage.getItem(key)
      if (value !== null) { entries[key] = value; found.push(key) }
    } catch { return false }
  }
  if (!found.length) return true
  const envelope: LegacyEnvelope = {
    version: 1,
    capturedAt: existing?.capturedAt ?? new Date().toISOString(),
    entries,
  }
  const serialized = JSON.stringify(envelope)
  try {
    localStorage.setItem(LEGACY_QUARANTINE_KEY, serialized)
    if (localStorage.getItem(LEGACY_QUARANTINE_KEY) !== serialized) return false
    for (const key of found) localStorage.removeItem(key)
    return true
  } catch {
    // Originals remain when quarantine persistence fails.
    return false
  }
}

export function hasLegacyQuarantine(): boolean {
  return !!readEnvelope() && Object.keys(readEnvelope()!.entries).length > 0
}

export function shouldOfferLegacyImport(): boolean {
  return hasLegacyQuarantine()
    && syncCoordinator.readScoped(LEGACY_DISMISSED_KEY) !== '1'
    && syncCoordinator.readScoped(LEGACY_IMPORTED_KEY) !== '1'
}

export function legacyImportAssignedToActive(): boolean {
  return syncCoordinator.readScoped(LEGACY_IMPORTED_KEY) === '1'
}

export function leaveLegacyQuarantined(): void {
  syncCoordinator.writeScoped(LEGACY_DISMISSED_KEY, '1')
}

const OLD_KEY_TARGETS: Record<string, string> = {
  bostadskalkyl_scenarios: 'bostadskalkyl_scenarios_v1',
  bostadskalkyl_session: 'bostadskalkyl_session_v1',
  bostadskalkyl_drift_items: 'bostadskalkyl_drift_items_v1',
  bostadskalkyl_savings_items: 'bostadskalkyl_savings_items_v1',
}

export async function importLegacyToActiveNamespace(): Promise<void> {
  const envelope = readEnvelope()
  if (!envelope) return
  const scope = syncCoordinator.captureScope()
  scope.write(LEGACY_IMPORT_MARKER, JSON.stringify({ version: 1, startedAt: new Date().toISOString() }))

  for (const [source, value] of Object.entries(envelope.entries)) {
    if (!scope.isActive()) throw new Error('Sync identity changed during legacy import')
    // A historical “already imported” flag belongs to an unknown household and
    // must never suppress import for the newly selected namespace.
    if (source.endsWith('_supabase_imported')) continue
    const target = OLD_KEY_TARGETS[source] ?? source
    if (scope.read(target) === null) scope.write(target, value)
  }
  if (!scope.isActive()) throw new Error('Sync identity changed during legacy import')

  scope.write(LEGACY_IMPORTED_KEY, '1')
  scope.remove(LEGACY_DISMISSED_KEY)
  // Commit point: only after every scoped write and identity check succeeded is
  // the neutral quarantine removed. An interrupted import is safe to retry.
  localStorage.removeItem(LEGACY_QUARANTINE_KEY)
  scope.remove(LEGACY_IMPORT_MARKER)
}

export function removeLegacyQuarantine(): void {
  localStorage.removeItem(LEGACY_QUARANTINE_KEY)
}
