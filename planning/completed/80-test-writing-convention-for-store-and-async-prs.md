# Plan 80 — Lock in a test-writing convention: PRs touching store/async logic add an integration test, not just a unit test

**Status:** plan · **Owner model:** Sonnet-suitable (documenting an existing,
already-reasoned-through decision — the reasoning happened in plans 78/79; this
plan just writes it down where the next PR will actually see it) ·
**Source:** pipeline audit 2026-07-07, in direct response to the user's own
question about the testing *process* · **Req:** 4 of the pipeline-hardening
batch (build order 77→78→79→**80 last** — this plan references concrete tools
from 78/79 that need to exist first, or it prescribes a workflow nothing
supports yet) · **Touches:** `web/CLAUDE.md` or the repo's top-level
`CLAUDE.md` (whichever the coding agent actually reads first — check both;
add to the one already containing verify-gate instructions), no application
code.

## Finding

This is the gap the user asked about directly: not "is there a bug," but "is
there a **process** that would have caught it before it shipped." Looking at
what actually happened:

- Both real incidents this batch (#236 scenario-wipe, #237 save-error
  swallowing) were caught by a **manual repo audit**, not by a test written
  alongside the original feature. The original PRs that introduced
  `saveScenarios`'s delete-not-in-list behavior and the un-caught
  `mortgage-store` handlers presumably passed CI (lint + unit tests + build)
  cleanly — the gap wasn't "tests failed," it's "the kind of test that would
  have caught this was never written," because nothing in the workflow
  prompts for it.
- The existing 17 test files are uniformly excellent at what they cover (pure
  functions, golden values, store state transitions) — this is not a
  "the team doesn't write good tests" problem, it's a **"nobody is asked to
  write the *other* kind of test"** problem. Every one of the 17 files is a
  unit test; none is an integration test; there was never a moment in any PR's
  lifecycle where "does this touch an async/store boundary, and if so where's
  the integration test" was a question anyone had to answer.
- This is exactly why plans 78 and 79 had to exist as separate infrastructure
  plans in the first place — the tooling (jsdom/RTL harness, Playwright CI
  job) didn't exist for anyone to reach for, so even a conscientious PR
  couldn't easily add the right kind of test even if someone thought to.

Tooling alone doesn't fix this — plan 78 landing doesn't make the next PR use
it unless something prompts for it. The missing piece is a **checklist
question that fires at the right moment**, written down somewhere the coding
agent (and the user) actually reads before opening a PR.

## Approach

Add a short section to the project's `CLAUDE.md` (wherever the existing
"verify gates" instructions already live — per [[project_web_architecture]]
that's documented as `npm run build` / `npm test` / `npm run lint` in `web/`;
add this immediately after that block so it's read in the same pass) — do not
create a new separate process document; a second file nobody re-reads is worse
than one paragraph in the file that's already load-bearing.

Proposed addition:

```markdown
## Before opening a PR that touches store/async code

If the change touches a `*-store.ts` file, `storage.ts`, `useStore.ts`, or any
component's data-mutation handlers (save/delete/import), answer this before
writing the PR description:

**Does this change what happens when a write succeeds, fails, or the cache and
cloud disagree?** If yes, a pure-function/state-transition unit test is not
enough — add (or extend) one of:
- a store-layer test with a mocked Supabase client (pattern: `useStore.test.ts`'s
  `vi.mock('../lib/supabase', ...)`, or plan 49's shared mock once it exists)
  asserting the success AND failure path, not just success.
- a component test (`// @vitest-environment jsdom`, see plan 78) asserting the
  user actually sees the failure — a toast, a dialog staying open, a retry
  affordance. "The store throws" is not the same as "the user finds out."
- for a cross-page flow (save → reload → still there), extend
  `web/e2e/save-sync.spec.ts` (plan 79) rather than writing a new one-off
  manual Playwright script that leaves no artifact — if you found yourself
  reaching for `page.route` to verify by hand, that verification belongs in
  the suite, not just in the PR description.

This question exists because of two incidents (PR #236, #237) that both
passed CI clean and were only caught by a manual audit afterward — in both
cases the missing test was exactly this kind, not a missing pure-function
test.
```

Keep it to this one question. A longer checklist gets skipped; a single
sharp question ("does this change success/fail/conflict behavior?") is
answerable in one read and catches the actual failure mode seen twice.

## Acceptance criteria

- The relevant `CLAUDE.md` contains the section above (or a close paraphrase
  preserving the one-question structure and the PR #236/#237 justification —
  don't genericize away the concrete evidence, it's what makes the rule
  credible rather than cargo-culted).
- Plans 78 and 79 are either shipped or explicitly referenced as "install
  this first" — do not merge this plan's doc change before at least plan 78
  exists, or the convention points at tooling that isn't there yet.
- No test files or application code change in this plan — it is pure process
  documentation.

## Out of scope

- Enforcing the checklist mechanically (e.g. a CI check that greps diffs for
  `store.ts` changes and fails if no `.test.` file changed in the same PR).
  That's a plausible future escalation if the honor-system version proves
  insufficient, but this is a two-person repo where the "PR" step is already
  the user or their coding agent reading their own diff — start with the
  documented convention and only build the mechanical gate if it turns out to
  get skipped in practice.
- A general contribution guide / CONTRIBUTING.md — out of scope; this is one
  paragraph in the file already governing agent behavior, not a new
  onboarding document nobody asked for.
