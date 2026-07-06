# Plan 36 — CI quality gate: run tests + lint before anything deploys

**Status:** plan · **Owner model:** Sonnet-suitable (YAML only, no app code) ·
**Req:** 1 (of the code-quality batch, build order 36→37→38→39→40→41→42) ·
**Relationship:** first of the batch ON PURPOSE — every later refactor PR
(37–42) is behavior-preserving and needs a red/green signal on the PR itself.
Touches `.github/workflows/` only.

## Goal

CI currently only builds: `deploy.yml` runs `npm --prefix web run build` on
push to main and publishes to Pages. `npm run test` (vitest, ~630 tests) and
`npm run lint` (oxlint) are never executed in CI — a PR with failing tests
merges and deploys clean. Add a PR-level quality gate and make the deploy job
refuse to ship red.

## A. New `ci.yml` — PR gate

New workflow `.github/workflows/ci.yml`, triggered on `pull_request`:

- `actions/checkout` + `actions/setup-node` (node 22, npm cache keyed on
  `web/package-lock.json` — copy the setup block from `deploy.yml`).
- `npm --prefix web ci`
- `npm --prefix web run lint`
- `npm --prefix web run test`
- `npm --prefix web run build` — this is the ONLY real typecheck: the build
  script is `tsc -b && vite build`; `tsc --noEmit` is a no-op here because of
  project references (known gotcha, bit us on 16e/PR #218). No Supabase
  secrets needed — `vite build` doesn't require the env vars to typecheck;
  if the build step complains, pass dummy `VITE_SUPABASE_*` values.
- Pin `ubuntu-24.04` (not `-latest`), matching deploy.yml / plan 01.

## B. Harden `deploy.yml`

In the existing build job, insert before the build step:

```yaml
- name: Test + lint
  run: |
    npm --prefix web ci
    npm --prefix web run lint
    npm --prefix web run test
```

(then drop the duplicate `npm --prefix web ci` from the build step).

## Out of scope

- Branch-protection settings (required checks) — flip on in the GitHub UI
  after ci.yml has run green once; not a file in this repo.
- Expanding oxlint rules / adding Prettier — deliberately deselected.
- Component test coverage (also deselected).

## Verify

- Open the PR for this plan itself: `ci.yml` must appear as a check and pass.
- Temporarily break a test on the branch → check goes red → revert.
- After merge, the Pages deploy on main still succeeds.
