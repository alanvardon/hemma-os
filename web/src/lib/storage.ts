// Persistence layer — ported from the vanilla storage.js. SAME localStorage
// keys + the same async Promise API, so (a) a returning user's saved data
// carries over untouched and (b) the planned Supabase migration stays a
// one-file swap (replace these bodies; signatures unchanged).
import type { Inputs } from './calc'

const KEYS = {
  scenarios: 'bostadskalkyl_scenarios_v1',
  session: 'bostadskalkyl_session_v1',
  driftItems: 'bostadskalkyl_drift_items_v1',
  savingsItems: 'bostadskalkyl_savings_items_v1',
} as const
const KEY_THEME = 'bostadskalkyl_theme'

export interface Scenario {
  id: string
  name: string
  savedAt: string
  inputs: Inputs
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

export function loadScenarios(): Promise<Scenario[]> {
  try {
    const raw = localStorage.getItem(KEYS.scenarios)
    return Promise.resolve(raw ? (JSON.parse(raw) as Scenario[]) : [])
  } catch {
    return Promise.resolve([])
  }
}

export function saveScenarios(scenarios: Scenario[]): Promise<void> {
  try {
    localStorage.setItem(KEYS.scenarios, JSON.stringify(scenarios))
  } catch {
    /* ignore */
  }
  return Promise.resolve()
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
