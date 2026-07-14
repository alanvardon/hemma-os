# Cloud, cache, and outbox contracts

All household financial storage uses the active `(user id, household id)`
namespace. A user id without a confirmed household id cannot select a cache or
outbox. Switching identity immediately makes the prior namespace unavailable.

Every mutation below is written to the durable local outbox before its local
cache is changed or a foreground cloud request starts. A successful cloud
response removes only that operation. Offline/auth failures stay pending;
validation failures are retained for explicit retry or warned discard. Revision
conflicts are retained with two explicit resolutions: reload the cloud entity
chain, or keep the local chain against the server revision returned by the
conflict.
Reads for a dirty resource return its scoped cache so an older cloud response
cannot overwrite local work. Deletes remove the cached row and retain a delete
operation as the tombstone until cloud acknowledgement.

| Store | Cloud | Scoped cache | Outbox and dirty-read contract |
| --- | --- | --- | --- |
| `tool-store` (`konsultkalkyl`, `lonevaxling`, `studentloan`, `hushallsbudget`) | One revisioned `tool_state` row per tool | One validated blob per tool | Receipt-backed conditional blob write; dirty blob wins reads until acknowledgement or resolution |
| `storage` scenarios | Revisioned `scenarios` rows | Whole scenario list | Conditional row write/delete plus durable tombstones; dirty list wins reads |
| `storage` preferences | Three `tool_state` rows: global constants, drift items, savings items | Combined view cache | Each slice has its own revision and outbox resource, so sibling slices cannot overwrite each other |
| `salary-store` | Revisioned `salary_submissions` | Versioned submissions envelope | Conditional row insert/delete; dirty log wins reads |
| `huskalendern-store` | Revisioned `house_items` | Versioned items envelope | Conditional full-row write/delete; dirty items win reads |
| `manadsavslut-store` | Revisioned items, payments, settings, and settlement RPCs | One versioned items/payments/settings envelope | Settlement/unsettlement checks every affected revision atomically. Durable operation receipts make a lost response retry return the original result |
| `mortgage-store` | Five revisioned mortgage tables, revisioned settings, cascade RPC | One versioned mortgage envelope | Cascade deletion checks the parent and exact child set/revisions before recording tombstones and deleting atomically |

Foreground replay is ordered by local revision and operation id. Entries carry
operation id, operation kind (`upsert` or `delete`), resource, payload/ids,
expected server revisions, local revision/time, user id, and household id.
Server acknowledgements advance the preconditions on later queued edits to the
same entity before the earlier operation leaves the outbox. This preserves
offline edit chains. Server receipts make the same operation id idempotent even
when the transaction commits but its response is lost. Every replay revalidates both
identity fields. Malformed entries move to the namespace quarantine and cannot
block later valid entries. The browser `online` event only requests a retry; it
is never treated as proof of connectivity.

Plan 97 outbox entries that predate expected revisions are never replayed as
unconditional writes. They become visible conflicts and require the same reload
or keep decision. The database accepts financial mutations only through the
authenticated, household-derived revision RPCs; clients from before this
protocol must be refreshed immediately when the migration is rolled out.

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
