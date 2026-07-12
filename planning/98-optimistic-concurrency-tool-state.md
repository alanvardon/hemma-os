# Plan 98 — Detect concurrent household edits

**Status:** proposed · **Priority:** Medium · **Effort:** M–L · **Depends on:**
plans 93 and 97 · **Owner model:** GPT-5.6 Sol — owns conflict semantics, migration/RPC
design, hostile-caller tests, and UI resolution behavior · **Requires approval:**
schema/RPC changes

## Goal

Turn `updated_at` from unused metadata into real optimistic concurrency control.
Two partners or devices must not silently overwrite changes made from the same
stale base revision.

## Confirmed problems

- `tool-store.ts` unconditionally upserts an entire JSON blob.
- `storage.ts:_savePrefs` reads a shared preferences blob, patches one slice,
  then overwrites the whole row.
- Row-store updates do not send an expected version.
- No store compares `updated_at`, despite comments describing last-write-wins.

## Decisions locked

1. Use a server-issued revision (`updated_at` or explicit integer version) as a
   write precondition; do not compare client clocks.
2. Zero matched rows is a conflict, not success.
3. Financial conflicts are surfaced for user choice; do not silently merge or
   choose the newest device timestamp.
4. Independently edited Bostadskalkyl preference slices should use separate
   `tool_state.tool` rows unless an atomic JSON-path RPC is demonstrably simpler.
5. New database behavior goes in a new repeatable migration; never edit an
   applied migration.

## Implementation

- Return data plus revision from every load.
- Add household-scoped conditional update RPC(s), or equivalent PostgREST update
  filters that atomically match the expected revision and return the new one.
- Preserve RLS semantics inside any SECURITY DEFINER RPC: derive household from
  `auth.uid()`, pin `search_path=''`, schema-qualify names, validate all arguments,
  and grant execution only to `authenticated`.
- Add a small conflict surface showing “this changed on another device,” with
  Reload cloud version and Keep my version actions. Label each accurately.

## Out of scope

- Collaborative real-time editing.
- Field-level automatic merge of financial data.
- Replacing text ids/dates (plan 99).

## Tests

- Two clients load revision A; client 1 saves B; client 2 save-from-A is rejected.
- Moving a row/blob to another household remains impossible.
- Preference-slice changes no longer overwrite sibling slices.
- Conflict resolution produces a new server revision and consistent cache.
- Add SQL tests for RLS and hostile RPC arguments.

## Acceptance criteria

- No changed store describes itself as last-write-wins without a tested rule.
- Every mutable cloud entity in scope carries an expected revision on update.
- Conflicts are visible and recoverable without silent data loss.
- Database, frontend, and browser checks pass with fictional two-user data.
