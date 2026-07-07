# Plan 77 — Turn on required-status-checks branch protection for `main`

**Status:** plan · **Owner model:** Haiku (single GitHub API/settings call, no
judgment — the check name and repo are already known) · **Source:** pipeline
audit 2026-07-07 · **Req:** 1 of the pipeline-hardening batch (build order
77→78→79→80 — do this one first, it's free and closes the biggest actual gap
for zero engineering cost) · **Touches:** GitHub repo settings only (Settings →
Branches → branch protection rule for `main`), no files in the repo.

## Finding

`gh api repos/alanvardon/hemma-os/branches/main/protection` returns `404
"Branch not protected"`. `main` has **no branch protection rule at all** — not
"protected but checks not required," genuinely unprotected. `.github/workflows/ci.yml`
runs oxlint + vitest + `tsc -b`/vite build on every `pull_request`, and it has
been green for the last 10+ merges (`gh run list` shows an unbroken streak
through PRs #229–#237). But GitHub isn't the thing enforcing that streak — it's
purely the user's own discipline of always working through a branch+PR and
waiting for CI before merging ([[feedback_branch_first]]). Nothing on GitHub's
side stops:

- A direct push to `main` (no PR, no CI run at all).
- Merging a PR whose `CI / quality` job is still running or has failed — the
  merge button is not blocked.
- A future collaborator (or a differently-configured agent run) who doesn't
  know the informal convention.

This is the cheapest possible fix in the whole assessment — it costs one API
call / one settings screen, and it converts CI from "a thing that happens" into
"a thing that is actually load-bearing." Do this before any of the testing work
in plans 78–80, because those plans only pay off if their new checks are
enforced, not advisory.

## Fix

Enable required status checks on `main` requiring the `CI` workflow's `quality`
job (the job name in `.github/workflows/ci.yml:11` is `quality`, and the
workflow name at `.github/workflows/ci.yml:1` is `CI` — the check shows up in
GitHub as `CI / quality`).

Via `gh api` (repo is public, so no extra scopes needed beyond repo admin):

```bash
gh api -X PUT repos/alanvardon/hemma-os/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["CI / quality"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null
}
EOF
```

Notes on the fields, since a wrong value here silently defeats the point:

- `"strict": true` means the branch must be up to date with `main` before the
  check counts — without this, a PR opened before a breaking change on `main`
  can merge green even though it would fail against current `main`.
- `enforce_admins: false` — the user merges their own PRs as repo admin; if
  this were `true` the user would lock themselves out of ever merging with a
  red check for a legitimate emergency fix. Leave it off deliberately; this is
  a solo-maintainer repo, not a team with a bypass-abuse risk.
- `required_pull_request_reviews: null` and `restrictions: null` — do not add a
  required-reviewer rule. This is a one-person repo; a required-review rule
  would just force an approve-your-own-PR ritual with no safety benefit.
- Do **not** also require the `Deploy Hemma·OS to GitHub Pages` workflow as a
  status check on `main` — that workflow only *runs* on push to `main` (it has
  no `pull_request` trigger), so GitHub would never see it complete before
  merge and the PR would hang forever waiting on a check that can't fire.

If `gh api` access to branch protection is unavailable in this session (some
`gh` auth tokens lack the `repo` scope needed for admin endpoints), do it
manually instead: repo Settings → Branches → Add branch protection rule →
branch name pattern `main` → check "Require status checks to pass before
merging" → search box → select `CI / quality` → check "Require branches to be
up to date before merging" → Create.

## Acceptance criteria

- `gh api repos/alanvardon/hemma-os/branches/main/protection` returns 200 (not
  404), and the JSON's `required_status_checks.contexts` includes `"CI /
  quality"`.
- Opening a throwaway PR with a deliberately failing test (e.g. temporarily
  break an assertion, push, observe, then close without merging) shows the
  merge button disabled/red on GitHub until CI passes — confirms the rule is
  actually wired to the right check name, not a typo'd context string that
  matches nothing.
- No change to any file in the repo; this is a settings-only plan.
