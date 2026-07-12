# Plan 93 — Make cloud-write and household-claim failures explicit

**Status:** proposed · **Priority:** High · **Effort:** M · **Owner model:**
GPT-5.6 Sol — owns the persistence error contract, AuthGate state model, call-site
fan-out, and verification

## Why this exists

Several blob/scenario writes rely on `try/catch`, but Supabase normally resolves
failed requests as `{ error }`; it does not throw. The UI can therefore report a
save as complete when nothing reached the cloud. `AuthGate` similarly unlocks
the app after `claim_household()` returns `null`, placing the user in an
unlabelled cache-only state.

Confirmed locations:

- `web/src/lib/tool-store.ts:89-96`
- `web/src/lib/storage.ts:126-140,249-256`
- `web/src/components/AuthGate.tsx:51-58`
- raw backend messages at `AuthGate.tsx:136-140` and `lib/household.ts:50-58`

## Decisions locked

1. Every Supabase mutation must inspect its returned `error`.
2. A persistence API must not resolve as success when the cloud rejected it.
3. Household provisioning is a hard gate: routes do not mount until a household
   id is confirmed.
4. User-facing errors are stable, concise Swedish copy; raw Postgres/Supabase
   messages are not rendered.
5. This plan exposes failures but does not promise offline replay. Plan 94 owns
   durable queuing.

## Implementation

### 1. Define one mutation result/error contract

Add a small shared persistence error type/helper in `web/src/lib/`. It must
retain a machine-readable category (`offline`, `auth`, `conflict`, `validation`,
`unknown`) without passing raw backend text to components.

Update `tool-store.save`, scenario save/delete, prefs save, and any other
fire-and-forget mutation found by a fresh audit to return or reject explicitly.
Call sites must handle the result; do not replace silent failure with an
unhandled rejected promise.

### 2. Make AuthGate fail closed

Represent provisioning as `loading | ready | error`. On error, render a themed
Swedish recovery surface with Retry and Sign out. Do not mount the router and do
not claim that cached edits will sync.

### 3. Normalize UI messages

Map known auth/invite/persistence error categories to Swedish copy. Technical
details may be logged in development only and must not include tokens, emails,
financial payloads, or raw database rows.

## Out of scope

- Durable offline outbox/replay (plan 97).
- Cross-device conflict detection (plan 98).
- Service-worker/offline shell work (plan 90).
- Changing RLS, schema, or authentication meaning.

## Tests

- `tool-store.test.ts`: an upsert resolving `{ error }` is reported as failure.
- `storage.test.ts`: scenario save, scenario delete, and prefs save cover
  resolved errors, not only thrown exceptions.
- AuthGate component test: claim failure keeps children unmounted; Retry retries;
  sign-out remains available.
- UI test: raw mock constraint/schema text never appears in rendered copy.

## Acceptance criteria

- No Supabase mutation in `web/src/lib` ignores the returned `error`.
- Save/delete failure is visible and never produces a success flash.
- A failed household claim cannot enter any tool route.
- `npm run lint`, `npm run test`, and `npm run build` pass.
- Verify claim failure and recovery at 390×844 and desktop in both themes.

## Sequencing

Build first. Plans 97 and 98 depend on the explicit result contract established
here. Coordinate with plans 90–92 where the same toast/dialog call sites move.
