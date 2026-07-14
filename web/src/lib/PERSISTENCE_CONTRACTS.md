# Cloud, cache, and outbox contracts

All household financial storage uses the active `(user id, household id)`
namespace. A user id without a confirmed household id cannot select a cache or
outbox. Switching identity immediately makes the prior namespace unavailable.

Every mutation below is written to the durable local outbox before its local
cache is changed or a foreground cloud request starts. A successful cloud
response removes only that operation. Offline/auth failures stay pending;
validation/conflict failures are retained for explicit retry or a warned discard-and-reload resolution.
Reads for a dirty resource return its scoped cache so an older cloud response
cannot overwrite local work. Deletes remove the cached row and retain a delete
operation as the tombstone until cloud acknowledgement.

| Store | Cloud | Scoped cache | Outbox and dirty-read contract |
| --- | --- | --- | --- |
| `tool-store` (`konsultkalkyl`, `lonevaxling`, `studentloan`, `hushallsbudget`) | One `tool_state` row per tool | One validated blob per tool | Idempotent whole-blob `upsert`; dirty blob wins cloud |
| `storage` scenarios | `scenarios` rows | Whole scenario list | Row `upsert` plus explicit `delete` tombstones; dirty list wins cloud |
| `storage` preferences | `tool_state:bostadskalkyl-prefs` | Constants/drift/savings blob | Idempotent whole-blob `upsert`; dirty blob wins cloud |
| `salary-store` | `salary_submissions` | Versioned submissions envelope | Row `upsert` and `delete`; dirty log wins cloud |
| `huskalendern-store` | `house_items` | Versioned items envelope | Full-row idempotent `upsert` and `delete`; dirty items win cloud |
| `manadsavslut-store` | `monthend_items`, `monthend_payments`, settings `tool_state`, settlement RPCs | One versioned items/payments/settings envelope | Row/settings `upsert`, row `delete`, and entity-specific settle/unsettle replay. A lost response clears only when the persisted payment matches the queued payload |
| `mortgage-store` | Five mortgage row tables, settings `tool_state`, cascade-delete RPC | One versioned mortgage envelope | Full-row `upsert`, row `delete`, settings `upsert`, and entity-specific loan-part cascade tombstone; linked cached rows stay hidden while pending |

Foreground replay is ordered by local revision and operation id. Entries carry
operation id, operation kind (`upsert` or `delete`), resource, payload/ids,
local revision/time, user id, and household id. Every replay revalidates both
identity fields. Malformed entries move to the namespace quarantine and cannot
block later valid entries. The browser `online` event only requests a retry; it
is never treated as proof of connectivity.

## Local-only state and shared devices

Bostadskalkyl session, draft, draft constants, and drift display preference are
also household/user scoped. Theme, Riksbank public-data caches, and transient UI
cues remain device-only because they contain no household financial records.

Pre-namespace keys are copied into a neutral legacy quarantine, not attributed
to the first signer. The authenticated user must explicitly import them into a
confirmed household. Import uses a write-ahead journal: the neutral quarantine
is retained while deterministic scoped writes run, identity is checked before
each step and commit, and an interrupted import resumes idempotently. Partial
scoped writes are never mounted because the auth gate remains closed until the
commit marker is written. Device cleanup removes every household namespace for
the signed-out user; neutral legacy quarantine is a separate warned action.
