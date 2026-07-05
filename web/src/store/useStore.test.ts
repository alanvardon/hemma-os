import { describe, it, expect, beforeEach, vi } from 'vitest'

// The storage facade is cloud-backed now; the store's fire-and-forget writes go
// through Supabase. Stub the client so these unit tests never touch the network
// (and can't hit a local Supabase on :54321). Every terminal resolves cleanly.
vi.mock('../lib/supabase', () => {
  const chain: Record<string, unknown> = {}
  Object.assign(chain, {
    select: () => chain, insert: () => chain, upsert: () => chain,
    update: () => chain, delete: () => chain, eq: () => chain,
    in: () => chain, not: () => chain, order: () => chain,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null }),
  })
  return { supabase: { from: () => chain } }
})

import { useStore } from './useStore'
import { DEFAULT_INPUTS, DEFAULT_CONSTANTS } from '../lib/calc'

beforeEach(() => {
  useStore.setState({
    inputs: { ...DEFAULT_INPUTS },
    constants: DEFAULT_CONSTANTS,
    mode: 'draft',
    activeScenarioId: null,
    scenarios: [],
    draftInputs: null,
    draftConstants: null,
    globalConstants: DEFAULT_CONSTANTS,
    driftItems: [],
    driftYearly: false,
    savingsItems: [],
  })
})

describe('drift breakdown → driftkostnad', () => {
  it('applyDriftItems writes the monthly sum into driftkostnad', () => {
    useStore.getState().applyDriftItems([
      { id: 'a', label: 'Electricity', amount: 1200 },
      { id: 'b', label: 'Water', amount: 800 },
    ])
    expect(useStore.getState().inputs.driftkostnad).toBe(2000)
    expect(useStore.getState().driftItems).toHaveLength(2)
  })

  it('setDriftItems persists WITHOUT touching driftkostnad (anti-clobber on add/label)', () => {
    const before = useStore.getState().inputs.driftkostnad // 3000 default
    useStore.getState().setDriftItems([{ id: 'a', label: 'Electricity', amount: 0 }])
    expect(useStore.getState().inputs.driftkostnad).toBe(before)
    expect(useStore.getState().driftItems).toHaveLength(1)
  })

  it('clearing all items via apply zeroes driftkostnad (no stale value)', () => {
    useStore.getState().applyDriftItems([])
    expect(useStore.getState().inputs.driftkostnad).toBe(0)
  })
})

describe('scenarios — hybrid save model', () => {
  it('saveDraftAsScenario turns the draft into a bound, auto-saving scenario', () => {
    useStore.setState({ inputs: { ...DEFAULT_INPUTS, newPrice: 7_000_000 }, mode: 'draft', draftInputs: { ...DEFAULT_INPUTS, newPrice: 7_000_000 } })
    const id = useStore.getState().saveDraftAsScenario('Lidingö')
    const s = useStore.getState()
    expect(s.scenarios).toHaveLength(1)
    expect(s.scenarios[0].name).toBe('Lidingö')
    expect(s.scenarios[0].inputs.newPrice).toBe(7_000_000)
    expect(s.mode).toBe('bound')
    expect(s.activeScenarioId).toBe(id)
    expect(s.draftInputs).toBeNull()
  })

  it('setField auto-saves into the active scenario when bound', () => {
    const id = useStore.getState().saveDraftAsScenario('A')
    useStore.getState().setField('newPrice', 8_000_000)
    const s = useStore.getState()
    expect(s.inputs.newPrice).toBe(8_000_000)
    expect(s.scenarios.find((x) => x.id === id)!.inputs.newPrice).toBe(8_000_000)
  })

  it('setField writes to the draft (not any scenario) when in draft mode', () => {
    useStore.getState().setField('deposit', 999_000)
    const s = useStore.getState()
    expect(s.draftInputs?.deposit).toBe(999_000)
    expect(s.scenarios).toHaveLength(0)
  })

  it('openScenario binds and loads inputs; an unknown id returns false', () => {
    const id = useStore.getState().saveDraftAsScenario('A')
    useStore.setState({ inputs: { ...DEFAULT_INPUTS }, mode: 'draft', activeScenarioId: null })
    expect(useStore.getState().openScenario(id)).toBe(true)
    expect(useStore.getState().mode).toBe('bound')
    expect(useStore.getState().activeScenarioId).toBe(id)
    expect(useStore.getState().openScenario('does-not-exist')).toBe(false)
  })

  it('duplicateScenario returns a fresh id and adds a copy', () => {
    const id = useStore.getState().saveDraftAsScenario('A')
    const copyId = useStore.getState().duplicateScenario(id)
    expect(copyId).not.toBeNull()
    expect(copyId).not.toBe(id)
    expect(useStore.getState().scenarios).toHaveLength(2)
  })

  it('delete + restore round-trips a scenario', () => {
    const id = useStore.getState().saveDraftAsScenario('A')
    const info = useStore.getState().deleteScenario(id)
    expect(info).not.toBeNull()
    expect(useStore.getState().scenarios).toHaveLength(0)
    useStore.getState().restoreScenario(info!)
    expect(useStore.getState().scenarios).toHaveLength(1)
  })

  it('discardDraft clears the scratch draft', () => {
    useStore.setState({ draftInputs: { ...DEFAULT_INPUTS } })
    useStore.getState().discardDraft()
    expect(useStore.getState().draftInputs).toBeNull()
  })
})

describe('per-scenario + global constants', () => {
  it('setConstants on a bound scenario writes through to it', () => {
    const id = useStore.getState().saveDraftAsScenario('A')
    useStore.getState().setConstants({ ...DEFAULT_CONSTANTS, lagfartPct: 3 })
    expect(useStore.getState().constants.lagfartPct).toBe(3)
    expect(useStore.getState().scenarios.find((s) => s.id === id)!.constants!.lagfartPct).toBe(3)
  })

  it('a saved scenario freezes its own constants — editing global later does not leak in', () => {
    useStore.setState({ constants: { ...DEFAULT_CONSTANTS, lagfartPct: 2.5 }, mode: 'draft' })
    const id = useStore.getState().saveDraftAsScenario('B')
    useStore.getState().setGlobalConstants({ ...DEFAULT_CONSTANTS, lagfartPct: 9 })
    expect(useStore.getState().scenarios.find((s) => s.id === id)!.constants!.lagfartPct).toBe(2.5)
  })

  it('openScenario falls back to global constants when the scenario has none', () => {
    useStore.setState({
      scenarios: [{ id: 'old', name: 'Old', savedAt: '2025-01-01', inputs: { ...DEFAULT_INPUTS } }],
      globalConstants: { ...DEFAULT_CONSTANTS, lagfartPct: 4 },
    })
    expect(useStore.getState().openScenario('old')).toBe(true)
    expect(useStore.getState().constants.lagfartPct).toBe(4)
  })

  it('setConstants in draft mode writes to the draft, not any scenario', () => {
    useStore.getState().setConstants({ ...DEFAULT_CONSTANTS, pantbrevPct: 5 })
    expect(useStore.getState().draftConstants?.pantbrevPct).toBe(5)
    expect(useStore.getState().scenarios).toHaveLength(0)
  })
})

describe('savings entries', () => {
  it('setSavingsItems stores the entries (their total augments the P&L)', () => {
    useStore.getState().setSavingsItems([
      { id: 's1', label: 'Buffer', amount: 50_000 },
      { id: 's2', label: 'ISK', amount: 25_000 },
    ])
    const total = useStore.getState().savingsItems.reduce((s, i) => s + i.amount, 0)
    expect(total).toBe(75_000)
  })
})
