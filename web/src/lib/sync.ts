import { createSyncCoordinator, type KeyValueStorage, type SyncIdentity, type SyncStatus } from './sync-coordinator'

export const SYNC_STATUS_EVENT = 'hemma:sync-status'

const browserStorage: KeyValueStorage = {
  get length() { return typeof localStorage === 'undefined' ? 0 : localStorage.length },
  clear: () => { if (typeof localStorage !== 'undefined') localStorage.clear() },
  getItem: (key) => typeof localStorage === 'undefined' ? null : localStorage.getItem(key),
  key: (index) => typeof localStorage === 'undefined' ? null : localStorage.key(index),
  removeItem: (key) => { if (typeof localStorage !== 'undefined') localStorage.removeItem(key) },
  setItem: (key, value) => {
    if (typeof localStorage === 'undefined') throw new Error('Local storage is unavailable')
    localStorage.setItem(key, value)
  },
}

function publishStatus(status: SyncStatus): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(SYNC_STATUS_EVENT, { detail: status }))
}

export const syncCoordinator = createSyncCoordinator({ storage: browserStorage, publishStatus })

let onlineListenerInstalled = false
const REMOVE_JOURNAL_KEY = 'hemma-sync-v1:pending-device-removal'
interface SyncTransition {
  kind: 'household' | 'signout'
  identity: SyncIdentity
  removeLocalData: boolean
}
let transition: SyncTransition | null = null

export function activateSyncIdentity(identity: SyncIdentity): void {
  // Auth callbacks can race a sign-out request. The snapshotted namespace owns
  // that transaction until success/failure finalizes it.
  if (transition) return
  syncCoordinator.activate(identity)
  if (typeof window !== 'undefined' && !onlineListenerInstalled) {
    onlineListenerInstalled = true
    // `online` is only a retry hint. A successful replay request is the sole
    // evidence that the cloud accepted an operation.
    window.addEventListener('online', () => { void syncCoordinator.replay() })
  }
  void syncCoordinator.replay()
}

export function quarantineSyncIdentity(): void {
  syncCoordinator.quarantineActive()
}

export function removeActiveDeviceData(): void {
  syncCoordinator.removeActiveNamespace()
}

function transitionMatches(kind: SyncTransition['kind'], identity: SyncIdentity): boolean {
  return !!transition
    && transition.kind === kind
    && transition.identity.userId === identity.userId
    && transition.identity.householdId === identity.householdId
}

function beginSyncTransition(kind: SyncTransition['kind'], removeLocalData = false): SyncIdentity | null {
  if (transition) throw new Error('A sync transition is already active')
  const snapshot = syncCoordinator.getActiveIdentity()
  if (!snapshot) return null
  transition = { kind, identity: { ...snapshot }, removeLocalData }
  syncCoordinator.pauseMutations()
  return snapshot
}

async function drainAndQuarantine(kind: SyncTransition['kind'], identity: SyncIdentity): Promise<void> {
  await syncCoordinator.waitForIdle()
  if (!transitionMatches(kind, identity)) throw new Error('Sync transition changed while waiting')
  syncCoordinator.quarantineActive()
}

export async function prepareSyncForSignOut(removeLocalData: boolean): Promise<SyncIdentity | null> {
  const snapshot = beginSyncTransition('signout', removeLocalData)
  if (!snapshot) return null
  try {
    // Persist removal intent before server sign-out. If this write fails, the
    // user remains signed in and the namespace is restored unchanged.
    if (removeLocalData) {
      localStorage.setItem(REMOVE_JOURNAL_KEY, JSON.stringify(snapshot))
    } else {
      const raw = localStorage.getItem(REMOVE_JOURNAL_KEY)
      if (raw) {
        const pending = JSON.parse(raw) as Partial<SyncIdentity>
        if (pending.userId === snapshot.userId && pending.householdId === snapshot.householdId) {
          localStorage.removeItem(REMOVE_JOURNAL_KEY)
          if (localStorage.getItem(REMOVE_JOURNAL_KEY) !== null) {
            throw new Error('Stale device-removal intent could not be cleared')
          }
        }
      }
    }
    await drainAndQuarantine('signout', snapshot)
    return snapshot
  } catch (error) {
    restoreSyncAfterFailedSignOut(snapshot)
    throw error
  }
}

export async function prepareSyncForHouseholdTransition(): Promise<SyncIdentity | null> {
  const snapshot = beginSyncTransition('household')
  if (!snapshot) return null
  try {
    await drainAndQuarantine('household', snapshot)
    return snapshot
  } catch (error) {
    restoreSyncAfterFailedHouseholdTransition(snapshot)
    throw error
  }
}

export function restoreSyncAfterFailedSignOut(identity: SyncIdentity): void {
  if (!transitionMatches('signout', identity)) return
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(REMOVE_JOURNAL_KEY)
    if (raw) {
      const pending = JSON.parse(raw) as Partial<SyncIdentity>
      if (pending.userId === identity.userId && pending.householdId === identity.householdId) {
        localStorage.removeItem(REMOVE_JOURNAL_KEY)
      }
    }
  } catch {
    // Restoring the authenticated namespace is more important than cleaning a
    // failed removal intent. A signed-out retry screen handles any stale entry.
  }
  transition = null
  syncCoordinator.resumeMutations()
  activateSyncIdentity(identity)
}

export function restoreSyncAfterFailedHouseholdTransition(identity: SyncIdentity): void {
  if (!transitionMatches('household', identity)) return
  transition = null
  syncCoordinator.resumeMutations()
  activateSyncIdentity(identity)
}

export function completeSyncHouseholdTransition(identity: SyncIdentity): void {
  if (!transitionMatches('household', identity)) return
  transition = null
  syncCoordinator.resumeMutations()
  syncCoordinator.quarantineActive()
}

export function completeSyncSignOut(identity: SyncIdentity, removeLocalData: boolean): void {
  if (!transitionMatches('signout', identity)) return
  try {
    if (removeLocalData) {
      syncCoordinator.removeUserNamespaces(identity.userId)
      localStorage.removeItem(REMOVE_JOURNAL_KEY)
    }
  } finally {
    // Server sign-out has already succeeded. A local cleanup failure must not
    // reactivate a signed-out financial namespace; the journal enables retry.
    transition = null
    syncCoordinator.resumeMutations()
    syncCoordinator.quarantineActive()
  }
}

export function hasPendingDeviceRemoval(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(REMOVE_JOURNAL_KEY) !== null
  } catch {
    return false
  }
}

export function retryPendingDeviceRemoval(): void {
  const raw = localStorage.getItem(REMOVE_JOURNAL_KEY)
  if (!raw) return
  const parsed = JSON.parse(raw) as Partial<SyncIdentity>
  if (!parsed.userId || !parsed.householdId) throw new Error('Malformed device-removal journal')
  const target = { userId: parsed.userId, householdId: parsed.householdId }
  syncCoordinator.removeUserNamespaces(target.userId)
  localStorage.removeItem(REMOVE_JOURNAL_KEY)
}
