# Plan 94 — Make mortgage loan-part deletion atomic

**Status:** proposed · **Priority:** Medium · **Effort:** S–M · **Owner model:**
GPT-5.6 Sol — owns the financial deletion decision checkpoint, transactional RPC,
RLS safety, and rollback tests · **Requires approval:** migration/RPC or
foreign-key behavior

## Problem

`web/src/lib/mortgage-store.ts:317-327` deletes a loan part, then separately
deletes its payments and rate periods. It checks only the parent-delete error.
`loan_part_id` has no foreign key, so a partial failure leaves orphaned financial
history while the cache claims everything was removed.

## Decisions to confirm before implementation

This plan deliberately does not guess financial deletion meaning. Confirm one:

- **Cascade:** deleting a loan part permanently deletes its linked payment/rate
  history; or
- **Detach/archive:** preserve history and clear/archive the association.

The current implementation attempts cascade, so that is the working assumption,
but implementation must stop for confirmation because this changes persisted
financial-data semantics.

## Implementation after confirmation

Preferred: one household-scoped transactional RPC that validates the caller's
household and performs the chosen operation atomically. Consider proper foreign
keys only after auditing legacy orphan values and confirming delete behavior.

If SECURITY DEFINER is used: derive the household server-side, pin
`search_path=''`, schema-qualify every object, reject unauthenticated callers,
and never accept a caller-supplied household id.

The client updates its cache only after the transaction succeeds and surfaces a
stable failure message through plan 93's contract.

## Tests

- Success changes parent and dependents together.
- Forced mid-operation failure rolls back all changes.
- Another household's loan-part id changes zero rows/raises a safe error.
- Cache remains unchanged on failure.
- Legacy orphan preflight is documented before adding constraints.

## Acceptance criteria

- There is one network mutation for the complete semantic operation.
- No dependent request error can be ignored.
- The chosen cascade/detach behavior is documented in code and UI copy.
- SQL/RLS tests, store tests, lint, frontend tests, and build pass.
