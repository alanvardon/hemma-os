import { create } from 'zustand'
import { DEFAULT_INPUTS, type Inputs } from '../lib/calc'
import * as storage from '../lib/storage'
import type { Scenario } from '../lib/storage'

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

  setField: <K extends keyof Inputs>(key: K, value: Inputs[K]) => void
  hydrate: () => Promise<void>
  saveNewScenario: (name: string) => void
  updateActiveScenario: () => void
  loadScenario: (id: string) => void
  duplicateScenario: (id: string) => void
  deleteScenario: (id: string) => DeletedInfo | null
  restoreScenario: (info: DeletedInfo) => void
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

    setField: (key, value) => {
      set((s) => ({ inputs: { ...s.inputs, [key]: value }, isDirty: true }))
      persistSession()
    },

    hydrate: async () => {
      storage.runMigrations()
      const [session, scenarios] = await Promise.all([storage.loadSession(), storage.loadScenarios()])
      set({
        scenarios,
        inputs: session?.inputs ? { ...DEFAULT_INPUTS, ...session.inputs } : DEFAULT_INPUTS,
        activeScenarioId: session?.activeScenarioId ?? null,
        isDirty: session?.isDirty ?? false,
        hydrated: true,
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
  }
})
