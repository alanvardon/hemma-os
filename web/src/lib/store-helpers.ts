// store-helpers.ts — the two genuinely-identical fragments extracted out of the
// per-tool stores (plan 55). Everything else about first-login import (what to
// upload, which tables) stays per-store — only this shell is shared.

import { genId } from './id'

// The one-time-import guard: dedupes concurrent calls within a session (the
// returned function memoizes its in-flight promise), sets the flag only once
// `run` reports success, and clears the in-memory guard on failure/throw so the
// very next call retries from scratch. `run` returns true = mark done, false =
// retry next call.
export function makeImportOnce(flagKey: string, run: () => Promise<boolean>): () => Promise<void> {
  let inFlight: Promise<void> | null = null
  return function importOnce(): Promise<void> {
    if (inFlight) return inFlight
    inFlight = (async () => {
      let already = true
      try { already = localStorage.getItem(flagKey) === '1' } catch { already = false }
      if (already) return
      let done: boolean
      try { done = await run() } catch { done = false }
      if (!done) { inFlight = null; return }
      try { localStorage.setItem(flagKey, '1') } catch { /* ignore */ }
    })()
    return inFlight
  }
}

// Guarantee id/created_at on a record about to be inserted — generates them
// only if missing, so re-stamping an already-stamped record is a no-op.
export function stamp<T extends object>(record: T, prefix: string): T & { id: string; created_at: string } {
  const r = record as Record<string, unknown>
  return { ...record, id: (r.id as string) || genId(prefix), created_at: (r.created_at as string) || new Date().toISOString() } as T & { id: string; created_at: string }
}
