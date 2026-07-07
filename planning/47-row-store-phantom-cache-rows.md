# Plan 47 — Row stores: no phantom cache rows on failed writes

**Status:** plan · **Owner model:** Sonnet-suitable (repetitive reorder across
~25 functions with one fixed rule: throw before cache patch; plan-49 tests are
the net — do NOT run this without them or without plan 44 landed) ·
**Severity: MEDIUM (M1)** · **Source:** repo audit 2026-07-06 ·
**Req:** 5 of the audit batch · **Depends on:** plan 44 (routes must surface
errors first, or this change makes failures LOOK like lost input) ·
Touches `web/src/lib/mortgage-store.ts`, `manadsavslut-store.ts`,
`salary-store.ts`.

## Finding

The blob stores (tool-store.ts factory + storage.ts prefs) genuinely self-heal:
the next `save()` re-uploads the whole blob, so an offline edit survives in the
cache until it syncs. The ROW stores do not. Their mutation functions patch the
optimistic localStorage cache BEFORE checking the Supabase error, e.g.
mortgage-store.ts `addLoanPart` (267–273): insert → `_patchCache` →
`if (error) throw`. Same pattern across mortgage/manadsavslut/salary stores.

Consequence: a failed insert leaves a row that exists ONLY in the cache. There
is no retry mechanism for cached-but-unpersisted rows (the one-time import only
reads the LEGACY key, never the cache), so the phantom row renders as saved
until the next successful cloud read overwrites the cache — then it silently
vanishes. Combined with H2 (plan 44) this is exactly how financial rows
disappear without a trace.

## Fix (decision: fail honest, not fail fancy)

Reorder every row-store mutation to patch the cache **only on success**:

```ts
export async function addLoanPart(record: Omit<LoanPart, 'id' | 'created_at'>): Promise<LoanPart> {
  const saved = stamp(record, 'part') as LoanPart
  const { error } = await supabase.from(T.parts).insert(_row(saved, COLS.parts))
  if (error) throw error                       // ← before the cache patch
  _patchCache(e => { e.loan_parts.push(saved) })
  return saved
}
```

Apply to every add/update/remove/settle in the three stores (mortgage-store
~15 functions, manadsavslut-store ~8, salary-store add/remove/importJSON).
Reads (`list*`) and the import path are untouched.

Explicitly REJECTED alternative: a "pending writes" retry queue. It buys
offline-first UX at the cost of conflict resolution, ordering and dedupe
machinery — wrong trade for a two-person app. With this plan, offline behavior
becomes: reads serve the cache (unchanged), writes fail visibly (plan 44
toasts) and the user retries when back online. Honest and simple.

## Acceptance criteria

- Grep check: no `_patchCache`/`_writeCache` call precedes its `if (error)
  throw` in any row-store mutation.
- New store unit tests (mock supabase client, see plan 49's harness): failed
  insert → cache unchanged + throws; successful insert → cache patched.
- Manual: offline add in Bolånekoll → error toast, row does NOT appear;
  reload online → list is consistent.
