// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import {
  activateSyncIdentity,
  prepareSyncForHouseholdTransition,
  restoreSyncAfterFailedHouseholdTransition,
  SYNC_STATUS_EVENT,
  syncCoordinator,
} from './sync'
import type { SyncStatus } from './sync-coordinator'

beforeEach(() => {
  localStorage.clear()
  activateSyncIdentity({ userId: 'online-user', householdId: 'online-house' })
})

it('treats the browser online event only as a retry hint', async () => {
  const statuses: SyncStatus[] = []
  window.addEventListener(SYNC_STATUS_EVENT, (event: Event) => {
    statuses.push((event as CustomEvent<SyncStatus>).detail)
  })
  syncCoordinator.register('online-test', async () => { throw new TypeError('Failed to fetch') })
  await expect(syncCoordinator.mutate({
    resource: 'online-test', operation: 'upsert', payload: { value: 1 }, entityIds: ['1'],
  })).rejects.toMatchObject({ category: 'offline' })

  window.dispatchEvent(new Event('online'))
  await vi.waitFor(() => expect(statuses.filter((status) => status.state === 'waiting').length).toBeGreaterThanOrEqual(2))

  expect(syncCoordinator.isDirty('online-test')).toBe(true)
  expect(statuses.at(-1)?.state).toBe('waiting')
})

it('drains the old household before a transition and ignores racing activation', async () => {
  let release!: () => void
  const request = new Promise<void>((resolve) => { release = resolve })
  syncCoordinator.register('transition-test', async () => request)
  const mutation = syncCoordinator.mutate({
    resource: 'transition-test', operation: 'upsert', payload: { id: 'x' }, entityIds: ['x'],
  })
  const preparing = prepareSyncForHouseholdTransition()
  activateSyncIdentity({ userId: 'other-user', householdId: 'other-house' })
  expect(syncCoordinator.getActiveIdentity()).toEqual({ userId: 'online-user', householdId: 'online-house' })
  release()
  await mutation
  const snapshot = await preparing
  expect(snapshot).toEqual({ userId: 'online-user', householdId: 'online-house' })
  expect(syncCoordinator.getActiveIdentity()).toBeNull()
  restoreSyncAfterFailedHouseholdTransition(snapshot!)
  expect(syncCoordinator.getActiveIdentity()).toEqual(snapshot)
})
