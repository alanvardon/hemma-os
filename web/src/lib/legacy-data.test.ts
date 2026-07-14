import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LEGACY_QUARANTINE_KEY,
  hasLegacyQuarantine,
  importLegacyToActiveNamespace,
  leaveLegacyQuarantined,
  quarantineLegacyData,
  removeLegacyQuarantine,
  shouldOfferLegacyImport,
} from './legacy-data'
import { activateSyncIdentity, syncCoordinator } from './sync'

const mem = new Map<string, string>()
const A = { userId: 'a', householdId: 'ha' }
const B = { userId: 'b', householdId: 'hb' }

beforeEach(() => {
  mem.clear()
  vi.stubGlobal('localStorage', {
    get length() { return mem.size },
    getItem: (key: string) => mem.get(key) ?? null,
    setItem: (key: string, value: string) => { mem.set(key, value) },
    removeItem: (key: string) => { mem.delete(key) },
    key: (index: number) => [...mem.keys()][index] ?? null,
    clear: () => mem.clear(),
  })
  activateSyncIdentity(A)
})

describe('legacy data quarantine', () => {
  it('does not attribute quarantined data to the first active user', () => {
    mem.set('bostadskalkyl_draft_v1', '{"price":1}')
    expect(quarantineLegacyData()).toBe(true)
    expect(syncCoordinator.readScoped('bostadskalkyl_draft_v1')).toBeNull()
    activateSyncIdentity(B)
    expect(syncCoordinator.readScoped('bostadskalkyl_draft_v1')).toBeNull()
    expect(hasLegacyQuarantine()).toBe(true)
  })

  it('reports storage failure and preserves every unscoped original', () => {
    mem.set('bostadskalkyl_draft_v1', '{"price":1}')
    const original = localStorage.setItem.bind(localStorage)
    localStorage.setItem = (key: string, value: string) => {
      if (key === LEGACY_QUARANTINE_KEY) throw new Error('quota')
      original(key, value)
    }
    expect(quarantineLegacyData()).toBe(false)
    expect(mem.get('bostadskalkyl_draft_v1')).toBe('{"price":1}')
    expect(mem.has(LEGACY_QUARANTINE_KEY)).toBe(false)
  })

  it('leave keeps the neutral quarantine and dismisses only for that identity', () => {
    mem.set('bostadskalkyl_draft_v1', '{}')
    quarantineLegacyData()
    leaveLegacyQuarantined()
    expect(shouldOfferLegacyImport()).toBe(false)
    expect(mem.has(LEGACY_QUARANTINE_KEY)).toBe(true)
    activateSyncIdentity(B)
    expect(shouldOfferLegacyImport()).toBe(true)
  })

  it('imports into the exact active namespace and removes quarantine only at commit', async () => {
    mem.set('bostadskalkyl_draft_v1', '{"price":2}')
    quarantineLegacyData()
    await importLegacyToActiveNamespace()
    expect(syncCoordinator.readScoped('bostadskalkyl_draft_v1')).toBe('{"price":2}')
    expect(mem.has(LEGACY_QUARANTINE_KEY)).toBe(false)
    activateSyncIdentity(B)
    expect(syncCoordinator.readScoped('bostadskalkyl_draft_v1')).toBeNull()
  })

  it('keeps quarantine after an interrupted import and retries idempotently', async () => {
    mem.set('bostadskalkyl_draft_v1', '{}')
    mem.set('bostadskalkyl_budget_v1', '{"version":1}')
    quarantineLegacyData()
    const original = localStorage.setItem.bind(localStorage)
    let writes = 0
    localStorage.setItem = (key: string, value: string) => {
      original(key, value)
      if (key.includes('bostadskalkyl_draft_v1') && ++writes === 1) throw new Error('quota')
    }
    await expect(importLegacyToActiveNamespace()).rejects.toThrow()
    expect(mem.has(LEGACY_QUARANTINE_KEY)).toBe(true)
    localStorage.setItem = original
    await importLegacyToActiveNamespace()
    expect(syncCoordinator.readScoped('bostadskalkyl_budget_v1')).toBe('{"version":1}')
    expect(mem.has(LEGACY_QUARANTINE_KEY)).toBe(false)
  })

  it('aborts when identity switches mid-import and leaves quarantine for retry', async () => {
    mem.set('bostadskalkyl_draft_v1', '{}')
    mem.set('bostadskalkyl_budget_v1', '{"version":1}')
    quarantineLegacyData()
    const original = localStorage.setItem.bind(localStorage)
    let switched = false
    localStorage.setItem = (key: string, value: string) => {
      original(key, value)
      if (!switched && key.includes('bostadskalkyl_draft_v1')) {
        switched = true
        activateSyncIdentity(B)
      }
    }
    await expect(importLegacyToActiveNamespace()).rejects.toThrow(/identity changed/i)
    expect(mem.has(LEGACY_QUARANTINE_KEY)).toBe(true)
    expect(syncCoordinator.readScoped('bostadskalkyl_budget_v1')).toBeNull()
  })

  it('removes legacy quarantine separately from the active namespace', () => {
    mem.set('bostadskalkyl_draft_v1', '{}')
    quarantineLegacyData()
    syncCoordinator.writeScoped('cache', 'keep')
    removeLegacyQuarantine()
    expect(hasLegacyQuarantine()).toBe(false)
    expect(syncCoordinator.readScoped('cache')).toBe('keep')
  })
})
