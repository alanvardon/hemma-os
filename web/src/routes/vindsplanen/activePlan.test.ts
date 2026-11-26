import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTIVE_PLAN_KEY, activePlanId, resolveActivePlan, setActivePlanId } from './activePlan'

const mem = new Map<string, string>()
const memoryStorage = {
  getItem: (key: string) => mem.get(key) ?? null,
  setItem: (key: string, value: string) => { mem.set(key, value) },
  removeItem: (key: string) => { mem.delete(key) },
}
const blockedStorage = {
  getItem: () => { throw new Error('blocked') },
  setItem: () => { throw new Error('blocked') },
  removeItem: () => { throw new Error('blocked') },
}

const rows = [{ id: 'oldest' }, { id: 'middle' }, { id: 'newest' }]

describe('active Vindsplanen variant', () => {
  beforeEach(() => {
    mem.clear()
    vi.stubGlobal('localStorage', memoryStorage)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('stores, reads and forgets the id under vp-active-plan-v1', () => {
    expect(ACTIVE_PLAN_KEY).toBe('vp-active-plan-v1')
    expect(activePlanId()).toBeNull()
    setActivePlanId('middle')
    expect(mem.get(ACTIVE_PLAN_KEY)).toBe('middle')
    expect(activePlanId()).toBe('middle')
    setActivePlanId(null)
    expect(activePlanId()).toBeNull()
  })

  it('opens the stored variant when it exists', () => {
    setActivePlanId('newest')
    expect(resolveActivePlan(rows)).toBe(rows[2])
  })

  it('falls back to the oldest row for a missing or unknown id', () => {
    expect(resolveActivePlan(rows)).toBe(rows[0])
    setActivePlanId('deleted-elsewhere')
    expect(resolveActivePlan(rows)).toBe(rows[0])
    expect(resolveActivePlan([])).toBeNull()
  })

  it('never throws when storage is blocked', () => {
    vi.stubGlobal('localStorage', blockedStorage)
    expect(activePlanId()).toBeNull()
    expect(() => setActivePlanId('middle')).not.toThrow()
    expect(() => setActivePlanId(null)).not.toThrow()
    expect(resolveActivePlan(rows)).toBe(rows[0])
  })
})
