# web/ — agent instructions

## Verify gates (run before opening a PR)

From `web/`:

- `npm run build` — the only real typecheck (`tsc -b` + `vite build`; plain
  `tsc --noEmit` is a no-op here).
- `npm test` — Vitest (`vitest run`).
- `npm run lint` — Oxlint.

## Before opening a PR that touches store/async code

If the change touches `src/store/useStore.ts`, `src/lib/storage.ts`, or any
component's data-mutation handlers (save/delete/import), answer this before
writing the PR description:

**Does this change what happens when a write succeeds, fails, or the cache and
cloud disagree?** If yes, a pure-function/state-transition unit test is not
enough — add (or extend) one of:

- a store-layer test with a mocked Supabase client (pattern:
  `src/store/useStore.test.ts`'s `vi.mock('../lib/supabase', ...)`, or the
  shared `createSupabaseMock()` in `src/lib/testSupabaseMock.ts`) asserting the
  success AND failure path, not just success.
- a component test (`// @vitest-environment jsdom`, harness from plan 78)
  asserting the user actually sees the failure — a toast, a dialog staying
  open, a retry affordance. "The store throws" is not the same as "the user
  finds out."
- for a cross-page flow (save → reload → still there), extend
  `web/e2e/save-sync.spec.ts` (plan 79) rather than writing a new one-off
  manual Playwright script that leaves no artifact — if you found yourself
  reaching for `page.route` to verify by hand, that verification belongs in the
  suite, not just in the PR description.

This question exists because of two incidents (PR #236 scenario-wipe, #237
save-error swallowing) that both passed CI clean and were only caught by a
manual audit afterward — in both cases the missing test was exactly this kind,
not a missing pure-function test.
