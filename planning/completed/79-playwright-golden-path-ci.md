# Plan 79 — Wire a minimal Playwright suite into CI covering the save/sync golden path

**Status:** plan · **Owner model:** Opus (the one hard call — network-mock
strategy vs. a live local-Supabase service in CI — has to be reasoned through
once; the individual test scenarios that follow the chosen pattern are
Sonnet-suitable) · **Source:** pipeline audit 2026-07-07 · **Req:** 3 of the
pipeline-hardening batch (build order 77→78→79→80; no hard dependency on 78,
but do 78 first if effort allows — it establishes the jsdom/RTL habit before
this heavier Playwright investment) · **Touches:** `web/playwright.config.ts`
(new), `web/e2e/save-sync.spec.ts` (new), `.github/workflows/ci.yml` (new
job), `web/package.json` (new devDependency + script).

## Finding

The coding agent already runs Playwright by hand before merging risky
changes — [[project_web_landmines.md]]'s "Playwright / verification" section
documents real gotchas learned the hard way (same-hash-URL `page.goto` doesn't
reload, GL canvas needs rAF-timed reads, headless Chrome needs
`--enable-unsafe-swiftshader --use-angle=swiftshader`, AnimatePresence exit
takes ~160ms). PR #237's fix was manually verified this way: "Playwright,
network blocked via `page.route` on the local Supabase host... the toast now
reads the real message... the dialog stays open... no row is added." That
verification was real, careful, and **entirely non-repeatable** — it ran once,
in one session, and left no artifact. The next regression in the same save
path gets no help from it; someone has to notice and re-derive the same
verification from scratch.

The two shipped incidents (#236, #237) are both **cross-cutting flows** — save
→ reload → confirm data survived, or save → network fails → confirm the user
sees it — exactly what end-to-end tests are for and unit/component tests
structurally can't fully replace (a component test proves the toast renders in
isolation; an E2E test proves the whole page, real router, and real dialog
lifecycle work together). Zero of this exists as a repeatable suite today.

## Decision: mock the network boundary, don't stand up live Supabase in CI

Two ways to give Playwright something to test against in CI:

1. **Mock Supabase's REST calls with `page.route`**, the same technique
   already used for manual verification of PR #237. Deterministic, no
   external service, starts in milliseconds, runs anywhere.
2. **Spin up the local Supabase stack** (`supabase start`, per
   [[project_dev_server]]) as a CI service container, seed it, run against a
   real backend.

**Choose (1).** This is a two-person household app with no team writing
integration-critical backend logic day-to-day — the risk this suite exists to
catch is "does the frontend correctly react to success/failure," not "does
our SQL/RLS work" (that's covered by the fact that `supabase/migrations/` are
reviewed by hand and the dev-local-Supabase setup already lets the coding
agent manually verify against a real backend before merging, per
[[project_dev_server]]). A live-Supabase CI job would add real setup time and
flakiness risk (container startup, migration drift, port contention) for a
class of bug this project has not actually hit. If backend/RLS regressions
start actually happening, that's the trigger to revisit this decision — don't
build the heavier version speculatively now.

## Approach

**1. Install and configure:**

```bash
npm --prefix web install -D @playwright/test
npx --prefix web playwright install --with-deps chromium
```

`web/playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  webServer: {
    command: 'npm run preview -- --port 5175',
    port: 5175,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: 'http://localhost:5175',
    // Headless Chrome needs software WebGL for the hero canvas — see
    // project_web_landmines.md; NOT --disable-gpu, that breaks the GL path.
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] },
  },
})
```

Run against `vite preview` (the production build), not `vite dev` — this
exercises the actual deployed bundle, catching build-only issues the dev
server wouldn't.

**2. `web/e2e/save-sync.spec.ts` — the golden path, informed by the landmines:**

- Intercept `**/rest/v1/scenarios**` (or the relevant mortgage/loan-part
  endpoint) with `page.route` and script both a success response and a
  network-failure response (`route.abort()` or a 500 body), matching the
  pattern from PR #237's manual verification.
- **Success path:** create a scenario (or loan part) → save → assert the
  optimistic UI updates immediately → reload via `page.reload()` (NOT a
  same-hash `page.goto` — per the landmine, that's a same-document nav and
  won't actually reload/reset state) → assert the saved item is still there.
- **Failure path:** script the mocked endpoint to fail → attempt the same save
  → assert an error toast appears with the real error text → assert the
  dialog/form stays open with the user's input intact → assert no phantom row
  appears in the UI.
- Use `page.waitForSelector`/explicit text assertions, not fixed `sleep()` —
  the landmines note `AnimatePresence` exit takes ~160ms and toasts have their
  own duration; wait on the actual DOM state, not a guessed delay.

**3. Wire into CI as a separate job (not blocking on the same job as
lint/test/build, so a slow Playwright install doesn't gate the fast checks):**

```yaml
  e2e:
    runs-on: ubuntu-24.04
    needs: quality
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with: { node-version: 22, cache: npm, cache-dependency-path: web/package-lock.json }
      - run: npm --prefix web ci
      - run: npm --prefix web run build
      - run: npx --prefix web playwright install --with-deps chromium
      - run: npx --prefix web playwright test
```

`needs: quality` means E2E only runs once lint/unit/build are already green —
no point spending the Playwright install time on a build that was already
broken.

**4. If plan 77 (branch protection) already landed, add `CI / e2e` to the
required-status-checks contexts once this job is proven stable for a few PRs
— don't add it as a required check on day one, in case the mock-network setup
needs a shakeout period first.**

## Acceptance criteria

- `web/e2e/save-sync.spec.ts` exists and passes locally (`npx playwright
  test`) and in CI.
- The failure-path test would have failed against the pre-PR-#237 code (verify
  by checking it out at the parent commit of `f91c021` and confirming the new
  spec goes red — this proves the test actually exercises the bug class, not
  just happy-path theater).
- CI gains an `e2e` job that runs after `quality`, using the mocked-network
  approach — no live Supabase service container.
- `npm run build`/`npm run test`/`npm run lint` in `web/` remain unaffected
  (Playwright is fully additive).

## Out of scope

- A live-Supabase CI job — explicitly rejected above; revisit only if
  backend/RLS bugs start actually occurring.
- Visual regression / screenshot diffing — the landmines explicitly warn
  screenshots false-positive against the WebGL hero and animated content;
  stick to DOM/text assertions.
- Covering every tool's save path — start with one (whichever of
  Bostadskalkyl/Bolånekoll had the incident most recently, i.e. Bolånekoll) and
  let plan 80's convention grow coverage per-PR from here, same reasoning as
  plan 78's "out of scope."
