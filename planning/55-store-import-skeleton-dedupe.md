# Plan 55 — Dedupe the first-login-import skeleton across stores

**Status:** plan · **Severity: LOW (L4)** · **Source:** repo audit 2026-07-06 ·
**Req:** 13 of the audit batch · **Sequencing:** AFTER plans 47/49 (don't
refactor untested code; 47 also rewrites the same functions) ·
Touches `web/src/lib/tool-store.ts`, `mortgage-store.ts`,
`manadsavslut-store.ts`, `salary-store.ts`, `storage.ts`.

## Finding

Plan 38 extracted the single-blob skeleton into `createToolStateStore`, but
three shape-identical fragments are still hand-copied:

1. **The one-time-import guard** — the `_importOnce` promise + IMPORT_FLAG
   localStorage check + "on error, clear guard and don't set flag" dance is
   character-for-character quadruplicated: tool-store.ts:66–84,
   mortgage-store.ts:225–255, manadsavslut-store.ts:167–194,
   salary-store.ts:122–137, storage.ts:346–372. Any bug fix (e.g. the flag
   semantics) currently needs 5 edits.
2. **`stamp()`** — identical in mortgage-store.ts:68–71 and
   manadsavslut-store.ts:59–62 (salary-store inlines the same logic).
3. **storage.ts's prefs blob** (198–372) re-implements most of the tool-store
   factory (in-flight dedupe, cache read/write, import) instead of using it.

The audit accepts the DELIBERATE divergence (row stores ≠ blob stores — forcing
one factory would obscure both; see tool-store.ts header). This plan extracts
only the genuinely identical parts.

## Fix

New tiny module `web/src/lib/store-helpers.ts`:

```ts
// The one-time-import guard: dedupes concurrent calls, sets the flag only on
// success, clears the in-memory guard on failure so the next call retries.
export function makeImportOnce(flagKey: string, run: () => Promise<boolean>): () => Promise<void>
// `run` returns true = mark done, false = retry next call.

export function stamp<T extends object>(record: T, prefix: string): T & { id: string; created_at: string }
```

Port the five call sites onto it; each store keeps its own `run` body (what to
upload is genuinely per-store). For storage.ts, ALSO evaluate porting the
prefs blob onto `createToolStateStore` (it fits the blob shape — the only
extra is the `_prefsInFlight` read-dedupe, which could move into the factory
as an option); if it fights, take just the import guard + stamp and stop.

Behavior-preserving refactor — no schema, no signatures, no UX change. The
plan-49 store tests are the safety net; run the full suite before/after.

## Acceptance criteria

- One implementation of the import-guard pattern and of `stamp` in the tree
  (grep proves it).
- All store tests (plan 49) and the full suite green, unchanged.
- No change in requests made on first login (verify via the plan-49 mock
  call logs).
