import { create } from 'zustand'
import { DEFAULT_INPUTS, type Inputs } from '../lib/calc'
import * as storage from '../lib/storage'
import type { Scenario, LineItem } from '../lib/storage'

const sumAmounts = (items: LineItem[]): number => items.reduce((s, i) => s + (i.amount || 0), 0)

// Info captured on delete so the undo toast can restore exactly.
export interface DeletedInfo {
  deleted: Scenario
  priorActiveId: string | null
  priorDirty: boolean
}

interface AppState {
  inputs: Inputs
  scenarios: Scenario[]
  activeScenarioId: string | null
  isDirty: boolean
  hydrated: boolean
  // Phase 7 — driftkostnad breakdown + savings line items (session-level, not
  // per-scenario). Drift amounts are monthly; the yearly flag is a view toggle.
  driftItems: LineItem[]
  driftYearly: boolean
  savingsItems: LineItem[]

  setField: <K extends keyof Inputs>(key: K, value: Inputs[K]) => void
  hydrate: () => Promise<void>
  saveNewScenario: (name: string) => void
  updateActiveScenario: () => void
  loadScenario: (id: string) => void
  duplicateScenario: (id: string) => void
  deleteScenario: (id: string) => DeletedInfo | null
  restoreScenario: (info: DeletedInfo) => void
  // Drift: persist-only (label edits, add) vs apply (amount edits, remove) which
  // also writes the monthly sum into inputs.driftkostnad — mirrors the legacy
  // split so merely opening the breakdown can't zero out a set driftkostnad.
  setDriftItems: (items: LineItem[]) => void
  applyDriftItems: (items: LineItem[]) => void
  setDriftYearly: (yearly: boolean) => void
  setSavingsItems: (items: LineItem[]) => void
}

export const useStore = create<AppState>((set, get) => {
  // Mirrors app.js saveSession() — fire-and-forget after any session change.
  const persistSession = () => {
    const { inputs, activeScenarioId, isDirty } = get()
    storage.saveSession(inputs, activeScenarioId, isDirty)
  }

  return {
    inputs: DEFAULT_INPUTS,
    scenarios: [],
    activeScenarioId: null,
    isDirty: false,
    hydrated: false,
    driftItems: [],
    driftYearly: false,
    savingsItems: [],

    setField: (key, value) => {
      set((s) => ({ inputs: { ...s.inputs, [key]: value }, isDirty: true }))
      persistSession()
    },

    hydrate: async () => {
      storage.runMigrations()
      const [session, scenarios, driftItems, savingsItems, driftYearly] = await Promise.all([
        storage.loadSession(),
        storage.loadScenarios(),
        storage.loadDriftItems(),
        storage.loadSavingsItems(),
        storage.loadDriftYearly(),
      ])
      set({
        scenarios,
        inputs: session?.inputs ? { ...DEFAULT_INPUTS, ...session.inputs } : DEFAULT_INPUTS,
        activeScenarioId: session?.activeScenarioId ?? null,
        isDirty: session?.isDirty ?? false,
        hydrated: true,
        driftItems,
        savingsItems,
        driftYearly,
      })
    },

    saveNewScenario: (name) => {
      const scenario: Scenario = {
        id: Date.now().toString(),
        name: name.trim() || 'Unnamed scenario',
        savedAt: new Date().toISOString(),
        inputs: get().inputs,
      }
      const scenarios = [...get().scenarios, scenario]
      set({ scenarios, activeScenarioId: scenario.id, isDirty: false })
      storage.saveScenarios(scenarios)
      persistSession()
    },

    updateActiveScenario: () => {
      const { scenarios, activeScenarioId, inputs } = get()
      const updated = scenarios.map((s) =>
        s.id === activeScenarioId ? { ...s, inputs, savedAt: new Date().toISOString() } : s,
      )
      set({ scenarios: updated, isDirty: false })
      storage.saveScenarios(updated)
      persistSession()
    },

    loadScenario: (id) => {
      const s = get().scenarios.find((x) => x.id === id)
      if (!s) return
      set({ inputs: { ...DEFAULT_INPUTS, ...s.inputs }, activeScenarioId: id, isDirty: false })
      persistSession()
    },

    duplicateScenario: (id) => {
      const s = get().scenarios.find((x) => x.id === id)
      if (!s) return
      const copy: Scenario = {
        id: Date.now().toString(),
        name: `${s.name} (copy)`,
        savedAt: new Date().toISOString(),
        inputs: { ...s.inputs },
      }
      const scenarios = [...get().scenarios, copy]
      set({ scenarios })
      storage.saveScenarios(scenarios)
    },

    deleteScenario: (id) => {
      const { scenarios, activeScenarioId, isDirty } = get()
      const deleted = scenarios.find((s) => s.id === id)
      if (!deleted) return null
      const wasActive = activeScenarioId === id
      const remaining = scenarios.filter((s) => s.id !== id)
      set({
        scenarios: remaining,
        activeScenarioId: wasActive ? null : activeScenarioId,
        isDirty: wasActive ? true : isDirty,
      })
      storage.saveScenarios(remaining)
      persistSession()
      return { deleted, priorActiveId: activeScenarioId, priorDirty: isDirty }
    },

    restoreScenario: ({ deleted, priorActiveId, priorDirty }) => {
      const scenarios = [...get().scenarios, deleted]
      const reactivate = priorActiveId === deleted.id
      set({
        scenarios,
        activeScenarioId: reactivate ? deleted.id : get().activeScenarioId,
        isDirty: reactivate ? priorDirty : get().isDirty,
      })
      storage.saveScenarios(scenarios)
      persistSession()
    },

    // Persist only — label edits + adding a (zero) item must NOT touch
    // driftkostnad (matches legacy: add/label → saveDriftItems, no apply).
    setDriftItems: (items) => {
      set({ driftItems: items })
      storage.saveDriftItems(items)
    },

    // Apply — amount edits + removes write the monthly sum into driftkostnad
    // (incl. 0, so clearing items doesn't leave a stale value).
    applyDriftItems: (items) => {
      set({ driftItems: items })
      storage.saveDriftItems(items)
      get().setField('driftkostnad', sumAmounts(items))
    },

    setDriftYearly: (yearly) => {
      set({ driftYearly: yearly })
      storage.saveDriftYearly(yearly)
    },

    setSavingsItems: (items) => {
      set({ savingsItems: items })
      storage.saveSavingsItems(items)
    },
  }
})
