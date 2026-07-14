// store-helpers.ts — the two genuinely-identical fragments extracted out of the
// per-tool stores (plan 55). Everything else about first-login import (what to
// upload, which tables) stays per-store — only this shell is shared.

import { genId } from './id'
import { syncCoordinator } from './sync'

// The one-time-import guard: dedupes concurrent calls within a session (the
// returned function memoizes its in-flight promise), sets the flag only once
// `run` reports success, and clears the in-memory guard on failure/throw so the
// very next call retries from scratch. `run` returns true = mark done, false =
// retry next call.
export function makeImportOnce(flagKey: string | (() => string), run: () => Promise<boolean>): () => Promise<void> {
  const inFlights = new Map<string, Promise<void>>()
  return function importOnce(): Promise<void> {
    const key = typeof flagKey === 'function' ? flagKey() : flagKey
    const existing = inFlights.get(key)
    if (existing) return existing
    const inFlight = (async () => {
      let already = true
      try { already = localStorage.getItem(key) === '1' } catch { already = false }
      if (already) return
      let done: boolean
      try { done = await run() } catch { done = false }
      if (!done) { inFlights.delete(key); return }
      try { localStorage.setItem(key, '1') } catch { /* ignore */ }
    })()
    inFlights.set(key, inFlight)
    void inFlight.finally(() => { if (inFlights.get(key) === inFlight) inFlights.delete(key) })
    return inFlight
  }
}

// Guarantee id/created_at on a record about to be inserted — generates them
// only if missing, so re-stamping an already-stamped record is a no-op.
export function stamp<T extends object>(record: T, prefix: string): T & { id: string; created_at: string } {
  const r = record as Record<string, unknown>
  return { ...record, id: (r.id as string) || genId(prefix), created_at: (r.created_at as string) || new Date().toISOString() } as T & { id: string; created_at: string }
}

interface MaterializedImport<T> { version: 1; source: string; value: T }

function sourceHash(source: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Persist generated import IDs/timestamps before enqueueing so retries are exact. */
export function materializeImport<T>(resource: string, source: string, create: () => T): T {
  const scope = syncCoordinator.captureScope()
  const base = `import-materialized:${resource}:${sourceHash(source)}`
  for (let collision = 0; ; collision += 1) {
    if (!scope.isActive()) throw new Error('Sync identity changed during import materialization')
    const key = `${base}:${collision}`
    const raw = scope.read(key)
    if (raw !== null) {
      try {
        const saved = JSON.parse(raw) as Partial<MaterializedImport<T>>
        if (saved.version === 1 && saved.source === source && 'value' in saved) return saved.value as T
      } catch { /* preserve a corrupt or hash-colliding slot */ }
      continue
    }
    const value = create()
    const serialized = JSON.stringify({ version: 1, source, value } satisfies MaterializedImport<T>)
    scope.write(key, serialized)
    if (!scope.isActive() || scope.read(key) !== serialized) throw new Error('Import journal could not be verified')
    return value
  }
}
