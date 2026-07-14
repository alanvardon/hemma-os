import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSyncCoordinator,
  type KeyValueStorage,
  type SyncOperation,
  type SyncStatus,
} from './sync-coordinator'

class MemoryStorage implements KeyValueStorage {
  readonly values = new Map<string, string>()
  failSetKey: string | null = null
  get length(): number { return this.values.size }
  clear(): void { this.values.clear() }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  removeItem(key: string): void { this.values.delete(key) }
  setItem(key: string, value: string): void {
    if (key === this.failSetKey) throw new Error('storage write failed')
    this.values.set(key, value)
  }
}

const A = { userId: 'user-a', householdId: 'house-a' }
const B = { userId: 'user-b', householdId: 'house-b' }

describe('sync coordinator', () => {
  let storage: MemoryStorage
  let statuses: SyncStatus[]
  let sequence: number

  beforeEach(() => {
    storage = new MemoryStorage()
    statuses = []
    sequence = 0
  })

  function make() {
    return createSyncCoordinator({
      storage,
      now: () => `2026-07-13T12:00:0${sequence}.000Z`,
      createId: () => `op-${++sequence}`,
      publishStatus: (status) => statuses.push(status),
    })
  }

  it('durably queues before replay and clears the entry only after success', async () => {
    const coordinator = make()
    coordinator.activate(A)
    const seen: SyncOperation[] = []
    coordinator.register('tool_state:test', async (operation) => {
      expect(coordinator.getOutbox()).toHaveLength(1)
      seen.push(operation)
    })

    await coordinator.mutate({
      resource: 'tool_state:test',
      operation: 'upsert',
      payload: { tool: 'test', data: { value: 2 } },
      entityIds: ['test'],
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      id: 'op-1', userId: A.userId, householdId: A.householdId,
      localRevision: 1, operation: 'upsert',
    })
    expect(coordinator.getOutbox()).toEqual([])
    expect(statuses.map((status) => status.state)).toEqual(['saving', 'saved'])
  })

  it('keeps a failed write dirty across a coordinator reload, then retries and clears it', async () => {
    const first = make()
    first.activate(A)
    first.register('tool_state:test', async () => { throw new TypeError('Failed to fetch') })

    await expect(first.mutate({
      resource: 'tool_state:test', operation: 'upsert', payload: { value: 9 }, entityIds: ['test'],
    })).rejects.toMatchObject({ category: 'offline' })
    expect(first.isDirty('tool_state:test')).toBe(true)

    const second = make()
    second.activate(A)
    const replay = vi.fn(async () => {})
    second.register('tool_state:test', replay)
    await second.replay()

    expect(replay).toHaveBeenCalledTimes(1)
    expect(second.isDirty('tool_state:test')).toBe(false)
  })

  it('rejects new mutations while a namespace transition is paused', async () => {
    const coordinator = make()
    coordinator.activate(A)
    coordinator.register('test', async () => {})

    coordinator.pauseMutations()
    await expect(coordinator.mutate({
      resource: 'test', operation: 'upsert', payload: { value: 1 }, entityIds: ['one'],
    })).rejects.toMatchObject({ category: 'auth' })
    expect(coordinator.getOutbox()).toEqual([])

    coordinator.resumeMutations()
    await coordinator.mutate({
      resource: 'test', operation: 'upsert', payload: { value: 2 }, entityIds: ['two'],
    })
    expect(coordinator.getOutbox()).toEqual([])
  })

  it('drains an older pending operation before a newer mutation reaches cloud', async () => {
    const coordinator = make()
    coordinator.activate(A)
    let offline = true
    let cloud = 0
    coordinator.register('ordered', async (operation) => {
      if (offline) throw new TypeError('Failed to fetch')
      cloud = (operation.payload as { value: number }).value
    })
    await expect(coordinator.mutate({
      resource: 'ordered', operation: 'upsert', payload: { value: 1 }, entityIds: ['one'],
    })).rejects.toMatchObject({ category: 'offline' })

    offline = false
    await coordinator.mutate({
      resource: 'ordered', operation: 'upsert', payload: { value: 2 }, entityIds: ['two'],
    })

    expect(cloud).toBe(2)
    expect(coordinator.getOutbox()).toEqual([])
  })

  it('never exposes or replays household A operations while household B is active', async () => {
    const coordinator = make()
    coordinator.activate(A)
    coordinator.register('scenarios', async () => { throw new TypeError('offline') })
    await expect(coordinator.mutate({
      resource: 'scenarios', operation: 'delete', payload: { ids: ['s1'] }, entityIds: ['s1'],
    })).rejects.toBeTruthy()

    coordinator.activate(B)
    const replay = vi.fn(async () => {})
    coordinator.register('scenarios', replay)
    await coordinator.replay()

    expect(replay).not.toHaveBeenCalled()
    expect(coordinator.getOutbox()).toEqual([])
    coordinator.activate(A)
    expect(coordinator.getOutbox()).toHaveLength(1)
  })

  it('keeps a delete tombstone until the delete succeeds', async () => {
    const coordinator = make()
    coordinator.activate(A)
    coordinator.register('scenarios', async () => { throw new TypeError('offline') })
    await expect(coordinator.mutate({
      resource: 'scenarios', operation: 'delete', payload: { ids: ['s1'] }, entityIds: ['s1'],
    })).rejects.toBeTruthy()

    expect(coordinator.getOutbox()[0]).toMatchObject({ operation: 'delete', entityIds: ['s1'] })
    expect(coordinator.isDirty('scenarios')).toBe(true)
  })

  it('isolates malformed entries and still replays later valid entries', async () => {
    const coordinator = make()
    coordinator.activate(A)
    storage.setItem(coordinator.outboxStorageKey(), JSON.stringify([
      { nope: true },
      {
        version: 1, id: 'valid', operation: 'upsert', resource: 'test', payload: { ok: true },
        entityIds: ['x'], userId: A.userId, householdId: A.householdId,
        localRevision: 2, createdAt: '2026-07-13T12:00:00.000Z', state: 'pending', attempts: 0,
      },
    ]))
    const replay = vi.fn(async () => {})
    coordinator.register('test', replay)

    await coordinator.replay()

    expect(replay).toHaveBeenCalledTimes(1)
    expect(coordinator.getOutbox()).toEqual([])
    expect(JSON.parse(storage.getItem(coordinator.quarantineStorageKey())!)).toHaveLength(1)
  })

  it('preserves the original outbox until malformed entries are durably quarantined', async () => {
    const coordinator = make()
    coordinator.activate(A)
    const replay = vi.fn(async () => {})
    coordinator.register('test', replay)
    const raw = JSON.stringify([
      { nope: true },
      {
        version: 1, id: 'valid', operation: 'upsert', resource: 'test', payload: { ok: true },
        entityIds: ['x'], userId: A.userId, householdId: A.householdId,
        localRevision: 2, createdAt: '2026-07-13T12:00:00.000Z', state: 'pending', attempts: 0,
      },
    ])
    storage.setItem(coordinator.outboxStorageKey(), raw)
    storage.failSetKey = coordinator.quarantineStorageKey()

    await coordinator.replay()

    expect(storage.getItem(coordinator.outboxStorageKey())).toBe(raw)
    expect(replay).not.toHaveBeenCalled()

    storage.failSetKey = null
    await coordinator.replay()
    expect(replay).toHaveBeenCalledTimes(1)
    expect(coordinator.getOutbox()).toEqual([])
    expect(JSON.parse(storage.getItem(coordinator.quarantineStorageKey())!)).toHaveLength(1)
  })

  it('quarantines wrong-identity entries without blocking valid work', async () => {
    const coordinator = make()
    coordinator.activate(A)
    const replay = vi.fn(async () => {})
    coordinator.register('test', replay)
    const base = {
      version: 1 as const, operation: 'upsert' as const, resource: 'test', payload: { ok: true },
      entityIds: ['x'], householdId: A.householdId,
      createdAt: '2026-07-13T12:00:00.000Z', state: 'pending' as const, attempts: 0,
    }
    storage.setItem(coordinator.outboxStorageKey(), JSON.stringify([
      { ...base, id: 'wrong-user', userId: B.userId, localRevision: 1 },
      { ...base, id: 'valid', userId: A.userId, localRevision: 2 },
    ]))

    await coordinator.replay()

    expect(replay).toHaveBeenCalledTimes(1)
    expect(coordinator.getOutbox()).toEqual([])
    expect(JSON.parse(storage.getItem(coordinator.quarantineStorageKey())!)).toMatchObject([
      { id: 'wrong-user' },
    ])
  })

  it('quarantines unknown resources and invalid payloads before later valid work', async () => {
    const coordinator = make()
    coordinator.activate(A)
    const replay = vi.fn(async () => {})
    coordinator.register(
      'test',
      replay,
      (operation) => (operation.payload as { ok?: unknown })?.ok === true,
    )
    const base = {
      version: 1 as const, operation: 'upsert' as const, entityIds: ['x'],
      userId: A.userId, householdId: A.householdId,
      createdAt: '2026-07-13T12:00:00.000Z', state: 'pending' as const, attempts: 0,
    }
    storage.setItem(coordinator.outboxStorageKey(), JSON.stringify([
      { ...base, id: 'unknown', resource: 'obsolete:v0', payload: {}, localRevision: 1 },
      { ...base, id: 'invalid', resource: 'test', payload: { ok: false }, localRevision: 2 },
      { ...base, id: 'valid', resource: 'test', payload: { ok: true }, localRevision: 3 },
    ]))

    await coordinator.replay()

    expect(replay).toHaveBeenCalledTimes(1)
    expect(coordinator.getOutbox()).toEqual([])
    expect(JSON.parse(storage.getItem(coordinator.quarantineStorageKey())!)).toMatchObject([
      { id: 'unknown', quarantineReason: 'unknown-resource' },
      { id: 'invalid', quarantineReason: 'malformed-payload' },
    ])
  })

  it('retains unknown entries when their quarantine cannot be written', async () => {
    const coordinator = make()
    coordinator.activate(A)
    const raw = JSON.stringify([{
      version: 1, id: 'unknown', operation: 'upsert', resource: 'obsolete:v0', payload: {},
      entityIds: ['x'], userId: A.userId, householdId: A.householdId,
      localRevision: 1, createdAt: '2026-07-13T12:00:00.000Z', state: 'pending', attempts: 0,
    }])
    storage.setItem(coordinator.outboxStorageKey(), raw)
    storage.failSetKey = coordinator.quarantineStorageKey()

    await coordinator.replay()

    expect(storage.getItem(coordinator.outboxStorageKey())).toBe(raw)
    storage.failSetKey = null
    await coordinator.replay()
    expect(coordinator.getOutbox()).toEqual([])
  })

  it('quarantines invalid outbox JSON instead of silently discarding it', () => {
    const coordinator = make()
    coordinator.activate(A)
    storage.setItem(coordinator.outboxStorageKey(), '{broken')
    expect(coordinator.getOutbox()).toEqual([])
    expect(JSON.parse(storage.getItem(coordinator.quarantineStorageKey())!)).toMatchObject([
      { raw: '{broken', reason: 'invalid-json' },
    ])
  })

  it('replays deterministically by revision and operation id', async () => {
    const coordinator = make()
    coordinator.activate(A)
    const calls: string[] = []
    coordinator.register('test', async (operation) => { calls.push(operation.id) })
    const base = {
      version: 1 as const, operation: 'upsert' as const, resource: 'test', payload: {}, entityIds: ['x'],
      userId: A.userId, householdId: A.householdId, createdAt: '2026-07-13T12:00:00.000Z',
      state: 'pending' as const, attempts: 0,
    }
    storage.setItem(coordinator.outboxStorageKey(), JSON.stringify([
      { ...base, id: 'b', localRevision: 2 },
      { ...base, id: 'c', localRevision: 1 },
      { ...base, id: 'a', localRevision: 2 },
    ]))

    await coordinator.replay()
    expect(calls).toEqual(['c', 'a', 'b'])
  })

  it('stops replay immediately when the active identity changes mid-loop', async () => {
    const coordinator = make()
    coordinator.activate(A)
    const calls: string[] = []
    coordinator.register('test', async (operation) => {
      calls.push(operation.id)
      if (operation.id === 'first') coordinator.activate(B)
    })
    const base = {
      version: 1 as const, operation: 'upsert' as const, resource: 'test', payload: {}, entityIds: ['x'],
      userId: A.userId, householdId: A.householdId, createdAt: '2026-07-13T12:00:00.000Z',
      state: 'pending' as const, attempts: 0,
    }
    storage.setItem(coordinator.outboxStorageKey(), JSON.stringify([
      { ...base, id: 'first', localRevision: 1 },
      { ...base, id: 'second', localRevision: 2 },
    ]))

    await coordinator.replay()

    expect(calls).toEqual(['first'])
    coordinator.activate(A)
    expect(coordinator.getOutbox().map((entry) => entry.id)).toEqual(['first', 'second'])
  })

  it('marks permanent failures without blocking a later valid operation', async () => {
    const coordinator = make()
    coordinator.activate(A)
    const calls: string[] = []
    coordinator.register('test', async (operation) => {
      calls.push(operation.id)
      if (operation.id === 'op-1') throw { status: 400, message: 'bad input' }
    })

    await expect(coordinator.mutate({
      resource: 'test', operation: 'upsert', payload: { bad: true }, entityIds: ['bad'],
    })).rejects.toMatchObject({ category: 'validation' })
    await coordinator.mutate({
      resource: 'test', operation: 'upsert', payload: { good: true }, entityIds: ['good'],
    })

    expect(calls).toEqual(['op-1', 'op-2'])
    expect(coordinator.getOutbox()).toMatchObject([{ id: 'op-1', state: 'failed' }])
  })

  it('removes only the active namespace from this device', () => {
    const coordinator = make()
    coordinator.activate(A)
    coordinator.writeScoped('cache', 'A')
    coordinator.activate(B)
    coordinator.writeScoped('cache', 'B')

    coordinator.removeActiveNamespace()

    coordinator.activate(B)
    expect(coordinator.readScoped('cache')).toBeNull()
    coordinator.activate(A)
    expect(coordinator.readScoped('cache')).toBe('A')
  })
})
