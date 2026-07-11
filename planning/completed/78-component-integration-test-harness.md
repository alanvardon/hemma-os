# Plan 78 — Add a component/integration test harness (RTL + jsdom) and cover the Bolånekoll save-error path it was built to catch

**Status:** plan · **Owner model:** Opus for the harness setup (per-file
environment override + the fetch/mock boundary is a one-time design decision
that every future component test rides on — get it wrong and every test after
it inherits the mistake), Sonnet-suitable to fan out additional component
tests once the harness + first example exist · **Source:** pipeline audit
2026-07-07 · **Req:** 2 of the pipeline-hardening batch (build order
77→78→79→80; independent of plan 77, complements plan 49 — see "Relationship
to plan 49" below) · **Touches:** `web/package.json` (new devDependencies),
`web/vite.config.ts` (test config), `web/src/routes/Bolanekoll.test.tsx` (new),
`web/src/test/setup.ts` (new).

## Finding

All 17 existing test files (`grep -rl` over `web/src/**/*.test.ts`) are pure
Node-environment tests of `lib/*.ts` functions and Zustand store state
transitions — none of them render a React component. `vite.config.ts:16-18`
sets `test.environment: 'node'` globally; there is no `jsdom` dependency in
`package.json`, no `@testing-library/react`, and no `src/**/*.test.tsx` file
anywhere. Zero of the ~38 files in `src/components/` and zero of the 8 files
in `src/routes/` have a test that actually mounts them.

This is not a hypothetical gap — it is the exact gap the two real incidents
this month fell through:

- **PR #236 (audit C1, plan 43):** `saveScenarios` deleted the household's
  cloud rows on a fresh device. `storage.test.ts` now covers this well at the
  function level (`describe('saveScenarios is upsert-only...')`) — but that
  test was written *after* the bug shipped, and a pure function test can only
  catch this class of bug if someone thinks to write the adversarial case.
- **PR #237 (audit H2, plan 44, shipped today):** every mutation handler in
  `Bolanekoll.tsx` called `mortgage-store.ts` (which throws on write errors)
  with no `try/catch` — a failed save showed no toast, left the optimistic
  cache patched as if it succeeded, and threw an unhandled rejection. This bug
  lived in **8 separate handlers** (`handleSavePart`, `handleDeletePart`,
  `handleSavePeriod`, `handleDeletePeriod`, `maybeEnableContributions`,
  `handleSaveVal`, `handleToggleInsats`, `handleSaveInsatsSplit`) and was only
  caught by a manual repo audit, then manually verified with an ad hoc
  Playwright script that blocked the network — nothing in the test suite
  would have caught it, and **nothing in the test suite proves it stays fixed**.
  A future edit that adds a 9th handler without the `try/catch` (or a refactor
  that strips it "by accident") ships silently, exactly as before.

Pure-function tests over `lib/` cannot catch this class of bug because the
bug is in the **wiring**: does the component actually catch what the store
throws, and does the user actually see a toast? That requires rendering the
component and asserting on the DOM.

## Relationship to plan 49

[[49-tests-tax-calcs-and-stores.md]] (already planned, not yet built) adds
Node-environment tests for `mortgage-store.ts` itself, mocking the
`supabase-js` client — it proves the store's read/write/cache contracts in
isolation. This plan is the layer above it: it proves that `Bolanekoll.tsx`
*calls* the store correctly and *reacts* to what it returns/throws. Land them
in either order; they test different layers and share no files. If both land,
78's Bolanekoll test can reuse 49's supabase-mock helper directly instead of
authoring a second one (check for `web/src/lib/__mocks__/supabase.ts` or
equivalent before writing a new mock in this plan).

## Approach

**1. Add the harness (one-time, do first):**

```bash
npm --prefix web install -D jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event
```

`vitest` already lists `jsdom` as an optional peer (visible in
`package-lock.json`), so this pulls a version vitest already resolves against
— no version to pick.

**2. Per-test environment override, not a global switch.** Do NOT change
`vite.config.ts`'s `test.environment` to `'jsdom'` globally — that would slow
down all 17 existing Node tests for no benefit (they don't touch the DOM) and
risks subtly changing their behavior (e.g. any code that branches on
`typeof window`). Instead use Vitest's per-file docblock, which the version in
this repo (4.1.9) supports:

```ts
// @vitest-environment jsdom
```

as the first line of any new `*.test.tsx` file. Update `vite.config.ts:17`'s
`include` glob from `['src/**/*.test.ts']` to `['src/**/*.test.{ts,tsx}']` so
`.tsx` test files are picked up at all — this is the one required config
change, everything else is per-file.

**3. Add `web/src/test/setup.ts`:**

```ts
import '@testing-library/jest-dom/vitest'
```

and wire it via `test.setupFiles: ['./src/test/setup.ts']` in `vite.config.ts`
so `expect(...).toBeInTheDocument()` etc. are available everywhere.

**4. First real test — the exact incident, locked in:** `Bolanekoll.test.tsx`.
Mock `../lib/mortgage-store` (not `../lib/supabase` — this test is about the
component/store boundary, not the store/network boundary; that's plan 49's
job) so one call is scripted to reject:

```ts
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi, describe, it, expect } from 'vitest'
import Bolanekoll from './Bolanekoll'
import * as Store from '../lib/mortgage-store'

vi.mock('../lib/mortgage-store')

describe('Bolanekoll — save failures surface to the user (regression for audit H2 / PR #237)', () => {
  it('shows an error toast and keeps the dialog open when addLoanPart rejects', async () => {
    vi.mocked(Store.addLoanPart).mockRejectedValueOnce({ message: 'Failed to fetch' })
    // ... render, open the "add loan part" dialog, fill the form, submit
    const user = userEvent.setup()
    render(<Bolanekoll />)
    // (drive the actual dialog open → fill → submit sequence here — see the
    // component's own test-id/label conventions once written; this plan does
    // not prescribe exact selectors, the implementer reads the JSX)
    await screen.findByText(/Kunde inte spara/i)
    // the dialog must still be open (data not lost) — assert the input field
    // the user typed into is still present with its value
  })
})
```

The exact selectors depend on reading `Bolanekoll.tsx`'s current JSX (labels,
button text) at implementation time — the load-bearing assertions this test
must make, regardless of selector details, are: (a) the error message renders
somewhere in the DOM, (b) the dialog does NOT close on failure, (c) no
unhandled rejection is thrown (vitest fails the test run on one by default,
which is itself useful signal).

**5. One more component, for breadth, not depth:** a second test for a
component with real conditional logic and no network dependency —
`ScenarioCard.tsx` or `Segmented.tsx` are good candidates (pure props → DOM,
no store mocking needed) — to prove the harness works for the simple case too
and give a template for the "Sonnet can fan out" half of this plan's ownership
split.

## Acceptance criteria

- `web/package.json` has `jsdom`, `@testing-library/react`,
  `@testing-library/jest-dom`, `@testing-library/user-event` as
  devDependencies.
- `vite.config.ts`'s test `include` matches `.tsx`; `setupFiles` points at
  `src/test/setup.ts`.
- `src/routes/Bolanekoll.test.tsx` exists, uses `// @vitest-environment jsdom`,
  mocks `mortgage-store`, and fails (red) if the `try/catch` from PR #237 is
  reverted on any of the 8 handlers listed above — verify this by temporarily
  reverting one handler's `try/catch` locally, confirming the new test goes
  red, then restoring it.
- A second, simpler component test exists proving the harness works without
  store mocking.
- `npm run test` (in `web/`) still runs in well under CI's current wall-clock
  budget — jsdom tests are slower than node tests; if the new files add more
  than a couple of seconds, note it, but do not go further and split into a
  separate `test:integration` script unless it actually becomes a problem —
  that's an unrequested abstraction until proven necessary.
- `npm run build` and `npm run lint` (in `web/`) stay green.

## Out of scope

- Testing every component — this plan proves the harness on the two riskiest
  targets. Broader component coverage is exactly what plan 80's convention
  should drive incrementally on future PRs, not something to batch-write here.
- Snapshot testing — not requested, and snapshot tests tend to be asserted
  blind (`toMatchSnapshot()` then `--u` without reading the diff), which is
  the same failure mode as an unread golden test; explicit assertions only.
