# Plan 43 — Stop `saveScenarios` from wiping the household's cloud scenarios

**Status:** plan · **Owner model:** Opus (small diff, but data-loss semantics —
the delete/upsert trade-off and the useStore call-site audit must be reasoned,
not pattern-matched; highest-stakes change in the batch) ·
**Severity: CRITICAL (C1)** · **Source:** repo audit 2026-07-06 ·
**Req:** 1 of the audit batch (build order 43→44→45→46→47→48→49→50→51→52–56) ·
Touches `web/src/lib/storage.ts` + `web/src/store/useStore.ts` only.

## Finding

`saveScenarios()` (storage.ts:118–134) takes the WHOLE in-memory list, upserts
it, then **deletes every cloud row not in that list**. The list comes from
`hydrate()` → `loadScenarios()`, which on ANY cloud read error (expired token,
offline, transient 5xx) silently falls back to the local cache — empty on a
fresh device. Sequence that loses data:

1. Partner opens the app on a new device; the hydrate read fails quietly.
2. `scenarios` state = `[]`.
3. They save/rename/delete ONE scenario → `saveScenarios` runs its
   delete-not-in-list phase → **every other scenario in the household is
   deleted from the cloud**, with no error shown (`saveScenarios` never rejects).

Secondary flaw on the same lines: storage.ts:130 builds the PostgREST filter by
raw string interpolation — `` .not('id', 'in', `(${ids.join(',')})`) `` — so a
legacy-imported id containing `,` or `)` corrupts the filter and can delete
rows that ARE in the list.

## Fix

Deletions must be explicit, never derived from "whatever isn't in my list".

**storage.ts** — make `saveScenarios` upsert-only and add an explicit delete:

```ts
export async function saveScenarios(scenarios: Scenario[]): Promise<void> {
  _writeScenCache(scenarios)
  try {
    const rows = scenarios.map(toRow)
    if (rows.length) await supabase.from(SCEN_TABLE).upsert(rows, { onConflict: 'id' })
  } catch { /* offline — cache holds the latest */ }
}

// Array form — supabase-js quotes ids itself, no string interpolation.
export async function deleteScenarios(ids: string[]): Promise<void> {
  if (!ids.length) return
  try { await supabase.from(SCEN_TABLE).delete().in('id', ids) } catch { /* offline */ }
}
```

**useStore.ts** — `deleteScenario` (line ~214) additionally calls
`storage.deleteScenarios([id])`. `restoreScenario` needs no change (its
`saveScenarios` re-upserts the row). All other call sites (setField,
setConstants, saveDraftAsScenario, renameScenario, duplicateScenario) keep
calling `saveScenarios` and simply stop deleting things.

## Accepted trade-off

Without delete-not-in-list, a scenario deleted on device A can be re-upserted
by device B holding a stale copy (resurrection). That is strictly safer than
the current behavior (B silently deletes A's data). Note it in the code
comment.

## Acceptance criteria

- Simulate hydrate-with-empty-cache (mock cloud error) → save one scenario →
  pre-existing cloud rows survive.
- Deleting a scenario removes exactly that row in the cloud.
- New unit tests in `storage.test.ts` covering: upsert-only save, explicit
  delete, and that `deleteScenarios` uses the array `.in()` filter (no
  interpolated string).
- `npm run build` + full vitest suite green.
