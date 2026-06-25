import { describe, it, expect, beforeEach } from 'vitest'
import { useStore } from './useStore'
import { DEFAULT_INPUTS } from '../lib/calc'

beforeEach(() => {
  useStore.setState({ inputs: { ...DEFAULT_INPUTS }, driftItems: [], driftYearly: false, savingsItems: [] })
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
