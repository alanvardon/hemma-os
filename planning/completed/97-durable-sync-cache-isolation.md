# Plan 97 — Durable offline outbox and household-scoped caches

**Status:** completed · **Priority:** High · **Effort:** L · **Depends on:** plan 93
· **Owner model:** GPT-5.6 Sol — the outbox, identity isolation, replay ordering,
and recovery semantics require frontier-level reasoning

## Goal

Replace the current “write-through cache implies eventual sync” assumption with
an explicit, durable operation outbox. Prevent a successful cloud read from
overwriting unsynced local edits, and prevent household financial caches from
bleeding across account or household changes on the same device.

## Failure being fixed

Today a failed blob save remains only in the cache. The next successful `load()`
accepts the older cloud value and overwrites that cache. Deletes are not queued
at all. Supabase sessions plus budgets, salaries, mortgage history, month-end
records, scenarios, and drafts remain in `localStorage` after sign-out.

## Decisions locked

1. Offline writes are either durably queued or rejected; never silently
   described as synced.
2. The outbox is operation-based (`upsert`, `delete`) and includes entity/tool,
   payload or ids, local operation id, local revision/time, user id, and
   household id.
3. A dirty local record/blob wins over an older cloud read until replay succeeds
   or the user resolves a conflict.
4. Caches and outbox entries are namespaced by household and user. Never replay
   an operation under a different membership.
5. Sign-out does not silently destroy unsynced work. Offer clear choices:
   preserve on this device or remove local household data after warning.
6. Household switch quarantines the old namespace immediately and reloads the
   new household from its own namespace.
7. The UI exposes `Sparar`, `Sparat`, `Väntar på anslutning`, and `Kunde inte
   spara` states without implying a server acknowledgement that did not occur.

## Implementation shape

- Add a focused sync coordinator under `web/src/lib/`; keep domain calculations
  and React independent of it.
- Start with `tool_state` blobs and Bostadskalkyl scenarios. Fan out only after
  the replay and namespace tests are green.
- Replay in deterministic order, stop/reclassify permanent errors, and make
  replay idempotent. Deletes must have tombstones so stale devices cannot
  immediately resurrect them unnoticed.
- Subscribe to browser online events only as a retry hint; a successful request
  is the source of truth for connectivity.
- Provide one explicit “remove local data from this device” action.

## Out of scope

- Silent automatic merge of competing financial edits.
- Background sync that requires a service worker; foreground replay is enough.
- Production-data inspection.

## Tests

- Failed save → reload → local dirty value remains visible → retry succeeds →
  dirty flag clears.
- Failed delete → reload → tombstone remains → retry deletes cloud row.
- Cloud read cannot overwrite a newer dirty value.
- Operations from household A never replay after switching to B.
- Sign-out/remove-device-data behavior is covered, including pending work.
- Malformed outbox entries fail safely and do not block valid later entries.

## Acceptance criteria

- Every store has a documented `cloud/cache/outbox` contract.
- No comment claims eventual sync unless replay code and tests prove it.
- Offline and failed writes are visibly distinguishable from server-synced data.
- Shared-device data removal is available and tested.
- Full frontend gates pass; manually verify offline/edit/reconnect/reload at mobile
  and desktop widths with fictional data.
