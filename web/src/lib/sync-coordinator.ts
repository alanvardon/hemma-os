import { PersistenceError, toPersistenceError, type PersistenceErrorCategory } from './persistence-error'

export interface KeyValueStorage {
  readonly length: number
  clear(): void
  getItem(key: string): string | null
  key(index: number): string | null
  removeItem(key: string): void
  setItem(key: string, value: string): void
}

export interface SyncIdentity {
  userId: string
  householdId: string
}

export type SyncOperationKind = 'upsert' | 'delete'
export type SyncOperationState = 'pending' | 'failed'

export interface SyncOperation {
  version: 1
  id: string
  operation: SyncOperationKind
  resource: string
  payload: unknown
  entityIds: string[]
  userId: string
  householdId: string
  localRevision: number
  createdAt: string
  state: SyncOperationState
  attempts: number
  lastErrorCategory?: PersistenceErrorCategory
}

export type SyncSaveState = 'idle' | 'saving' | 'saved' | 'waiting' | 'failed'

export interface SyncStatus {
  state: SyncSaveState
  pending: number
}

export interface MutationInput {
  resource: string
  operation: SyncOperationKind
  payload: unknown
  entityIds: string[]
  /** Runs only after the operation is durably queued, before foreground replay. */
  applyLocal?: (operation: SyncOperation) => void
}

type ReplayHandler = (operation: SyncOperation) => Promise<void>
type ReplayValidator = (operation: SyncOperation) => boolean

interface CoordinatorAdapters {
  storage: KeyValueStorage
  now?: () => string
  createId?: () => string
  publishStatus?: (status: SyncStatus) => void
}

const ROOT = 'hemma-sync-v1'
const OUTBOX = 'outbox'
const QUARANTINE = 'quarantine'

function validIdentity(identity: SyncIdentity | null): identity is SyncIdentity {
  return !!identity?.userId && !!identity.householdId
}

function validOperation(raw: unknown): raw is SyncOperation {
  if (!raw || typeof raw !== 'object') return false
  const op = raw as Partial<SyncOperation>
  return op.version === 1
    && typeof op.id === 'string' && !!op.id
    && (op.operation === 'upsert' || op.operation === 'delete')
    && typeof op.resource === 'string' && !!op.resource
    && Array.isArray(op.entityIds) && op.entityIds.every((id) => typeof id === 'string')
    && typeof op.userId === 'string' && !!op.userId
    && typeof op.householdId === 'string' && !!op.householdId
    && typeof op.localRevision === 'number' && Number.isSafeInteger(op.localRevision) && op.localRevision > 0
    && typeof op.createdAt === 'string' && !!op.createdAt
    && (op.state === 'pending' || op.state === 'failed')
    && typeof op.attempts === 'number' && Number.isSafeInteger(op.attempts) && op.attempts >= 0
}

function permanent(category: PersistenceErrorCategory): boolean {
  return category === 'validation' || category === 'conflict'
}

export function createSyncCoordinator(adapters: CoordinatorAdapters) {
  const { storage } = adapters
  const handlers = new Map<string, ReplayHandler>()
  const validators = new Map<string, ReplayValidator>()
  let identity: SyncIdentity | null = null
  let fallbackSequence = 0
  let replayInFlight: Promise<void> | null = null
  let mutationsPaused = false

  const now = adapters.now ?? (() => new Date().toISOString())
  const createId = adapters.createId ?? (() => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
    fallbackSequence += 1
    return `sync-${Date.now()}-${fallbackSequence}`
  })
  const publishStatus = adapters.publishStatus ?? (() => undefined)

  function namespacePrefix(target: SyncIdentity = requireIdentity()): string {
    return `${ROOT}:${encodeURIComponent(target.userId)}:${encodeURIComponent(target.householdId)}:`
  }

  function requireIdentity(): SyncIdentity {
    if (!validIdentity(identity)) throw new Error('Sync identity is not active')
    return identity
  }

  function scopedStorageKey(base: string): string {
    return namespacePrefix() + base
  }

  function captureScope() {
    const captured = { ...requireIdentity() }
    const prefix = namespacePrefix(captured)
    return {
      identity: captured,
      isActive: () => identityMatches(captured),
      read: (base: string): string | null => {
        try { return storage.getItem(prefix + base) } catch { return null }
      },
      write: (base: string, value: string): void => { storage.setItem(prefix + base, value) },
      remove: (base: string): void => { storage.removeItem(prefix + base) },
    }
  }

  function outboxStorageKey(): string { return scopedStorageKey(OUTBOX) }
  function quarantineStorageKey(): string { return scopedStorageKey(QUARANTINE) }

  function readScoped(base: string): string | null {
    if (!validIdentity(identity)) return null
    try { return storage.getItem(scopedStorageKey(base)) } catch { return null }
  }

  function writeScoped(base: string, value: string): void {
    requireIdentity()
    storage.setItem(scopedStorageKey(base), value)
  }

  function removeScoped(base: string): void {
    if (!validIdentity(identity)) return
    storage.removeItem(scopedStorageKey(base))
  }

  function quarantineMalformed(malformed: unknown[]): boolean {
    if (!malformed.length) return true
    let current: unknown[] = []
    try {
      const raw = storage.getItem(quarantineStorageKey())
      const parsed = raw ? JSON.parse(raw) : []
      if (Array.isArray(parsed)) current = parsed
    } catch { /* replace an unreadable quarantine */ }
    try {
      storage.setItem(quarantineStorageKey(), JSON.stringify([...current, ...malformed]))
      return true
    } catch {
      publishStatus({ state: 'failed', pending: 0 })
      return false
    }
  }

  function getOutbox(): SyncOperation[] {
    if (!validIdentity(identity)) return []
    let parsed: unknown
    let raw: string | null = null
    try {
      raw = storage.getItem(outboxStorageKey())
      parsed = raw ? JSON.parse(raw) : []
    } catch {
      if (!quarantineMalformed([{ raw, reason: 'invalid-json' }])) return []
      storage.setItem(outboxStorageKey(), '[]')
      return []
    }
    if (!Array.isArray(parsed)) {
      if (!quarantineMalformed([parsed])) return []
      storage.setItem(outboxStorageKey(), '[]')
      return []
    }
    const valid: SyncOperation[] = []
    const malformed: unknown[] = []
    const active = requireIdentity()
    for (const entry of parsed) {
      if (validOperation(entry)
        && entry.userId === active.userId
        && entry.householdId === active.householdId) valid.push(entry)
      else malformed.push(entry)
    }
    if (malformed.length) {
      // Never discard evidence unless it was first copied durably into the
      // namespace quarantine. Quota/private-mode failures block replay until
      // quarantine storage becomes writable again.
      if (!quarantineMalformed(malformed)) return []
      storage.setItem(outboxStorageKey(), JSON.stringify(valid))
    }
    return valid
  }

  function writeOutbox(entries: SyncOperation[]): void {
    storage.setItem(outboxStorageKey(), JSON.stringify(entries))
  }

  function pendingCount(): number {
    return getOutbox().length
  }

  function emit(state: SyncSaveState): void {
    publishStatus({ state, pending: pendingCount() })
  }

  function register(resource: string, handler: ReplayHandler, validator?: ReplayValidator): () => void {
    handlers.set(resource, handler)
    if (validator) validators.set(resource, validator)
    return () => {
      if (handlers.get(resource) === handler) handlers.delete(resource)
      if (validators.get(resource) === validator) validators.delete(resource)
    }
  }

  function activate(nextIdentity: SyncIdentity): void {
    if (!validIdentity(nextIdentity)) throw new Error('A user and household are required for sync')
    identity = { ...nextIdentity }
  }

  function quarantineActive(): void {
    identity = null
  }

  function getActiveIdentity(): SyncIdentity | null {
    return validIdentity(identity) ? { ...identity } : null
  }

  function isDirty(resource: string): boolean {
    return getOutbox().some((operation) => operation.resource === resource)
  }

  function nextRevision(entries: SyncOperation[]): number {
    return entries.reduce((max, entry) => Math.max(max, entry.localRevision), 0) + 1
  }

  function identityMatches(expected: SyncIdentity): boolean {
    return validIdentity(identity)
      && identity.userId === expected.userId
      && identity.householdId === expected.householdId
  }

  async function attempt(operation: SyncOperation): Promise<boolean> {
    const active = requireIdentity()
    if (operation.userId !== active.userId || operation.householdId !== active.householdId) return false
    const handler = handlers.get(operation.resource)
    if (!handler) return false
    try {
      await handler(operation)
      // Membership/session changes can happen while a request is in flight.
      // Never touch the new namespace or continue replay under it. Leaving the
      // old operation queued is safe because every registered replay is
      // required to be idempotent.
      if (!identityMatches(active)) {
        emit('waiting')
        return false
      }
      const remaining = getOutbox().filter((entry) => entry.id !== operation.id)
      writeOutbox(remaining)
      emit(remaining.length ? 'waiting' : 'saved')
      return true
    } catch (error) {
      const persistenceError = toPersistenceError(error)
      const entries = getOutbox().map((entry): SyncOperation => entry.id === operation.id
        ? {
            ...entry,
            attempts: entry.attempts + 1,
            state: permanent(persistenceError.category) ? 'failed' : 'pending',
            lastErrorCategory: persistenceError.category,
          }
        : entry)
      writeOutbox(entries)
      emit(persistenceError.category === 'offline' || persistenceError.category === 'auth' ? 'waiting' : 'failed')
      throw persistenceError
    }
  }

  async function mutateBatch(inputs: MutationInput[]): Promise<void> {
    if (!inputs.length) return
    if (mutationsPaused) throw new PersistenceError('auth')
    const active = requireIdentity()
    const entries = getOutbox()
    let revision = nextRevision(entries)
    const operations = inputs.map((input): SyncOperation => ({
      version: 1,
      id: createId(),
      operation: input.operation,
      resource: input.resource,
      payload: input.payload,
      entityIds: input.entityIds.filter((id) => typeof id === 'string' && !!id),
      userId: active.userId,
      householdId: active.householdId,
      localRevision: revision++,
      createdAt: now(),
      state: 'pending',
      attempts: 0,
    }))
    try {
      // Journal the complete logical batch before the first cloud request.
      writeOutbox([...entries, ...operations])
      inputs.forEach((input, index) => input.applyLocal?.(operations[index]))
    } catch (error) {
      emit('failed')
      throw toPersistenceError(error)
    }
    await replay()
    const operationIds = new Set(operations.map((operation) => operation.id))
    const retained = getOutbox().find((entry) => operationIds.has(entry.id))
    if (retained) {
      const blocker = getOutbox()
        .filter((entry) => entry.localRevision <= retained.localRevision)
        .sort((a, b) => a.localRevision - b.localRevision || a.id.localeCompare(b.id))[0]
      throw new PersistenceError(blocker?.lastErrorCategory ?? retained.lastErrorCategory ?? 'unknown')
    }
  }

  async function mutate(input: MutationInput): Promise<void> {
    await mutateBatch([input])
  }

  function discardMalformedOperation(operation: SyncOperation, reason: string): boolean {
    if (!quarantineMalformed([{ ...operation, quarantineReason: reason }])) return false
    writeOutbox(getOutbox().filter((entry) => entry.id !== operation.id))
    return true
  }

  async function replayNow(): Promise<void> {
    const active = requireIdentity()
    while (identityMatches(active)) {
      const ordered = getOutbox()
        .filter((operation) => operation.userId === active.userId && operation.householdId === active.householdId)
        .sort((a, b) => a.localRevision - b.localRevision || a.id.localeCompare(b.id))
      let progressed = false
      for (const operation of ordered) {
        if (operation.state === 'failed') continue
        if (!handlers.has(operation.resource)) {
          if (!discardMalformedOperation(operation, 'unknown-resource')) return
          progressed = true
          continue
        }
        const validator = validators.get(operation.resource)
        if (validator && !validator(operation)) {
          if (!discardMalformedOperation(operation, 'malformed-payload')) return
          progressed = true
          continue
        }
        emit('saving')
        try {
          const completed = await attempt(operation)
          if (!completed || !identityMatches(active)) return
          progressed = true
        } catch (error) {
          const category = toPersistenceError(error).category
          if (!permanent(category)) return
          progressed = true
        }
      }
      // Recompute after the pass so operations appended while a request was in
      // flight are drained in the same serialized namespace queue.
      const pending = getOutbox().some((operation) => operation.state === 'pending' && handlers.has(operation.resource))
      if (!progressed || !pending) return
    }
  }

  function replay(): Promise<void> {
    if (!validIdentity(identity)) return Promise.resolve()
    if (replayInFlight) return replayInFlight
    const active = replayNow()
    replayInFlight = active
    void active.finally(() => { if (replayInFlight === active) replayInFlight = null })
    return active
  }

  function waitForIdle(): Promise<void> {
    return replayInFlight ?? Promise.resolve()
  }

  function pauseMutations(): void {
    mutationsPaused = true
  }

  function resumeMutations(): void {
    mutationsPaused = false
  }

  function retryFailed(): Promise<void> {
    const entries = getOutbox().map((entry): SyncOperation => ({ ...entry, state: 'pending' }))
    writeOutbox(entries)
    return replay()
  }

  function discardFailed(): number {
    const entries = getOutbox()
    const remaining = entries.filter((entry) => entry.state !== 'failed')
    const removed = entries.length - remaining.length
    writeOutbox(remaining)
    emit(remaining.length ? 'waiting' : 'idle')
    return removed
  }

  function removeNamespace(target: SyncIdentity): void {
    if (!validIdentity(target)) return
    const prefix = namespacePrefix(target)
    const keys: string[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key?.startsWith(prefix)) keys.push(key)
    }
    for (const key of keys) storage.removeItem(key)
  }

  function removeUserNamespaces(userId: string): void {
    if (!userId) return
    const prefix = `${ROOT}:${encodeURIComponent(userId)}:`
    const keys: string[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key?.startsWith(prefix)) keys.push(key)
    }
    for (const key of keys) storage.removeItem(key)
  }

  function removeActiveNamespace(): void {
    const active = getActiveIdentity()
    if (active) removeNamespace(active)
  }

  return {
    activate,
    quarantineActive,
    getActiveIdentity,
    register,
    mutate,
    mutateBatch,
    replay,
    waitForIdle,
    pauseMutations,
    resumeMutations,
    retryFailed,
    discardFailed,
    isDirty,
    getOutbox,
    readScoped,
    writeScoped,
    removeScoped,
    scopedStorageKey,
    captureScope,
    outboxStorageKey,
    quarantineStorageKey,
    removeActiveNamespace,
    removeNamespace,
    removeUserNamespaces,
  }
}
