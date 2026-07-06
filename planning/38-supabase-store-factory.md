# Plan 38 — Supabase tool-store factory: stop copy-pasting the persistence skeleton

**Status:** plan · **Owner model:** Opus-suitable (needs judgment about where
the abstraction stops) · **Req:** 3 (build order 36→…→42, after 37) ·
**Relationship:** the sixth time this pattern was pasted (16b–16g each cloned
the previous store); the seventh tool should get persistence in ~10 lines.
Touches `web/src/lib/*-store.ts` + one new file; public store APIs unchanged
so no route churn.

## Goal

All six `*-store.ts` files re-implement the same Supabase + localStorage
write-through skeleton: key constants, `_readCache`/`_writeCache`/
`_readLegacy` (identical try/catch JSON blocks), and the `_importLocalOnce`
first-login import guard, which is duplicated near-verbatim in
`konsult-store.ts:50-68`, `lonevaxling-store.ts:50-68`,
`manadsavslut-store.ts:173-199`, `hushallsbudget-store.ts:89-108`.
`konsult-store.ts` and `lonevaxling-store.ts` (88 lines each) differ only in
names/types — confirmed by diffing them with identifiers stripped. Extract a
factory; ~250 lines of boilerplate go away.

## A. `lib/tool-store.ts` — the factory

`createToolStateStore<T>(cfg)` where cfg =
`{ tool, storageKey, cacheKey, importFlag, table = 'tool_state', merge }`:

- `merge(raw: unknown): T` — per-store sanitizer (each store already has a
  `_merge`; it stays custom, it IS the store's schema knowledge).
- Provides: `readCache()`, `writeCache(data)`, `readLegacy()`, and
  `importLocalOnce()` with the promise-dedup guard + error-resets exactly as
  the current copies behave (select `tool` → maybeSingle → upsert with
  `onConflict: 'household_id,tool'` → set import flag; on any error, null the
  in-flight promise so a later call retries).
- `load()` / `save(data)` wrappers combining Supabase read/upsert with the
  local cache write-through, matching current semantics.

## B. Migration order (safest first)

1. `konsult-store.ts` + `lonevaxling-store.ts` — pure wins, each shrinks to
   config + `_merge` + exported API.
2. `hushallsbudget-store.ts` (135 lines) — same shape.
3. `salary-store.ts` (251 lines) — uses the cache/import helpers; its
   submission-list logic stays local.
4. `mortgage-store.ts` (536) + `manadsavslut-store.ts` (385) are ROW-based
   (per-row tables, not a single state blob) — do NOT force them into the
   blob factory. Adopt only the pieces that fit (`readCache`/`writeCache`,
   `genId` already from plan 37). If a row-store factory isn't an obvious
   win while in there, leave them and note it.

## C. Keep the trust boundary honest

While touching each `_merge`, tighten the post-`JSON.parse` gap flagged in
review: `salary-store.ts:203-206` casts `parsed as SalarySubmission[]` after
only an `Array.isArray` check; `mortgage-store.ts:174-178` casts row arrays
without field checks. Cheap field-level guards inside each `merge` (id is
string, amounts are finite numbers) — no zod, no new dependency.

## Out of scope

- Changing any store's exported function signatures (routes must not change).
- Supabase schema / RLS / `supabase/` dir.

## Verify

- `npm run test` — storage/useStore/manadsavslut/hushallsbudget suites green.
- `npm run build`.
- In `npm run dev` with a signed-in household: open each migrated tool, edit
  a value, reload → persisted; then dev-tools offline, edit, reload → local
  cache serves it (write-through intact).
- Fresh-profile check of `importLocalOnce`: clear the import flag + seed a
  legacy localStorage key, reload, confirm one-time upsert fires once.
