# #6 — Pin the CI runner

## Decision locked

Pin both `runs-on: ubuntu-latest` → **`ubuntu-24.04`** in
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml).

## Is `ubuntu-latest` best practice?

Short answer: it's fine for a solo project, but pinning is the better default for a
**deploy** pipeline.

- `ubuntu-latest` currently resolves to `ubuntu-24.04`. The risk is that "latest"
  **silently migrates** to the next LTS image (24.04 → 26.04) when GitHub flips it,
  which can break a previously-green pipeline with **zero code changes** (toolchain
  versions, preinstalled packages, and default behaviours shift between images).
- Pinning `ubuntu-24.04` makes builds **reproducible** and lets you **bump
  deliberately** after you've tested the new image.
- What you're already doing well: actions are pinned (`actions/checkout@v4`,
  `setup-node@v4`, `upload-pages-artifact@v3`, `deploy-pages@v4`) and Node is
  pinned (`node-version: 22`). 👍

## Change

Two one-line edits:

- [deploy.yml:28](../.github/workflows/deploy.yml#L28) — `build` job: `runs-on: ubuntu-24.04`
- [deploy.yml:64](../.github/workflows/deploy.yml#L64) — `deploy` job: `runs-on: ubuntu-24.04`

## Considered, deferred

**SHA-pinning the actions** (e.g. `actions/checkout@<40-char-sha>` instead of
`@v4`) hardens against a compromised/retagged action — best practice for
security-sensitive pipelines, but verbose and needs periodic SHA bumps
(Dependabot helps). Overkill for a personal GitHub Pages deploy; revisit if you
ever add secrets or deploy elsewhere.

## Verification

Push → the Actions run goes green on `ubuntu-24.04`. Re-pin to `ubuntu-26.04` (or
back to `latest`) deliberately once that image is out and tested.

## Effort

**Trivial.** Ship first.
