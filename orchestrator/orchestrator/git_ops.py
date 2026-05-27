"""Deterministic git operations used by workflow tasks.

The orchestrator has a hard split:
  - cognition (planning, implementation, QA) → LLM-driven, probabilistic
  - control  (branch creation, commit, PR)   → subprocess, deterministic

This module owns the deterministic side. No prompts, no models, no
structured output — just shell commands wrapped in Python. Ports of
.claude/skills/create-feature-branch.md (Phase 6a) and
.claude/skills/commit-and-open-pr.md (Phase 6d), with Phase 15 splitting
the PR-creation pipeline into three idempotent steps (commit, push,
pr_create) so a failure at any step is recoverable via @task caching.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

from orchestrator.agents.planning import PlanResult
from orchestrator.paths import find_project_root


REPO_ROOT = find_project_root()


class BranchCreationError(RuntimeError):
    """Raised when create_branch can't safely create a new branch.

    Three distinct cases all collapse into this exception: dirty tree,
    cannot-reach-main, and branch-already-exists. The message carries the
    detail. The orchestrator treats this as a terminal workflow failure
    — planning's checkpoint is preserved so you can fix the underlying
    issue and re-trigger without re-paying for the LLM call.
    """


def _sanitize_type(raw: str, max_len: int = 20) -> str:
    """Sanitize a free-form plan type into a safe git branch prefix.

    Strips to [a-z0-9-], truncates to max_len, rejects empty result.
    Needed because PlanResult.type is now a free-form str — a planner
    that emits type="add a tooltip" would otherwise produce an invalid
    git ref like "add a tooltip/the-slug".
    """
    sanitized = re.sub(r"[^a-z0-9]+", "-", raw.lower()).strip("-")
    sanitized = sanitized[:max_len].rstrip("-")
    if not sanitized:
        raise BranchCreationError(
            f"plan type {raw!r} produced an empty branch prefix after sanitization"
        )
    return sanitized


def _slugify(title: str, max_len: int = 50) -> str:
    """Convert a plan title into a kebab-case branch slug.

    Rules (matching .claude/skills/create-feature-branch.md):
      - lowercase
      - non-alphanumeric runs → single hyphen
      - strip leading/trailing hyphens
      - truncate to max_len, and strip a trailing hyphen if the cut
        landed mid-word (otherwise you'd get `feature/some-title-`).

    Example: "LTV calculation rounding error" → "ltv-calculation-rounding-error"
    """
    s = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return s[:max_len].rstrip("-")


def _run(args: list[str]) -> subprocess.CompletedProcess:
    """Run a git command in REPO_ROOT, raising on non-zero exit.

    capture_output keeps git's chatter off the orchestrator's stdout —
    workflow output shouldn't be mixed with raw shell noise. The caller
    reads .stdout / .stderr if it needs them.
    """
    return subprocess.run(
        args,
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    )


def verify_clean_tree() -> None:
    """Raise BranchCreationError if the working tree has uncommitted changes.

    Pre-flight check used at the very start of the workflow (so a dirty
    tree fails before paying for any LLM calls) and again inside
    create_branch (defence in depth — the tree might have become dirty
    between plan approval and branch creation).
    """
    status = _run(["git", "status", "--porcelain"])
    if status.stdout.strip():
        raise BranchCreationError(
            f"working tree is dirty. Commit or stash your changes, then "
            f"retry.\n\n{status.stdout.strip()}"
        )


def create_branch(plan: PlanResult, max_slug_length: int = 50) -> str:
    """Create a feature branch from main based on the plan's title and type.

    Returns the branch name on success. Raises BranchCreationError if:
      - the working tree is dirty (would lose uncommitted changes)
      - main can't be reached (offline, fetch failure, ...)
      - the derived branch already exists

    Leaves HEAD on the new branch. Subsequent tasks (implementation,
    commit) assume that.

    Direct port of .claude/skills/create-feature-branch.md. Same five
    steps in the same order — review them side by side once.
    """
    # 1. Working tree must be clean. We can't safely switch branches
    # otherwise — uncommitted work would either be lost or carried into
    # the new branch (both bad).
    verify_clean_tree()

    # 2. Sync with origin/main first. Branching from a stale local main
    # is how you end up with PRs that conflict from day one.
    try:
        _run(["git", "checkout", "main"])
        _run(["git", "pull"])
    except subprocess.CalledProcessError as e:
        raise BranchCreationError(
            f"cannot reach main: {(e.stderr or e.stdout).strip()}"
        ) from e

    # 3. Derive the branch name. `<type>/<kebab-slug>` — same scheme as
    # your current coordinator. Sanitize type since it's now free-form.
    type_prefix = _sanitize_type(plan.type)
    slug = _slugify(plan.title, max_slug_length)
    branch_name = f"{type_prefix}/{slug}"

    # 4. Refuse to clobber an existing branch. If the user retries a
    # request that already produced a branch, they need to either delete
    # it first or pick a different title.
    existing = _run(["git", "branch", "--list", branch_name])
    if existing.stdout.strip():
        raise BranchCreationError(f"branch already exists: {branch_name}")

    # 5. Create and switch.
    _run(["git", "checkout", "-b", branch_name])
    return branch_name


class CommitAndPrError(RuntimeError):
    """Raised when any of commit/push/pr_create can't safely complete.

    Phase 15 split the monolithic commit_and_pr into three idempotent
    steps, but they share one error type because callers treat them
    uniformly: log, surface the thread_id, await a `resume_run` from
    the user once the underlying issue is fixed.
    """


class PreHookError(Exception):
    """Raised when a pre-hook script exits with a non-zero status.

    The `output` attribute carries the script's stdout, which is surfaced
    as the abort reason so hook authors can write clear, actionable messages.
    The `returncode` is 124 when the script timed out (POSIX `timeout(1)`
    convention).
    """

    def __init__(self, script: str, output: str, returncode: int) -> None:
        super().__init__(
            f"pre-hook {script!r} failed (exit {returncode}): {output}"
        )
        self.script = script
        self.output = output
        self.returncode = returncode


_BASE_BRANCH = "main"  # kept for push/pr_create defaults; override via config.pr.base_branch


def _current_branch() -> str:
    return _run(["git", "rev-parse", "--abbrev-ref", "HEAD"]).stdout.strip()


def _assert_on_branch(branch: str) -> None:
    """Refuse to touch the wrong branch.

    The single most important check we make at this layer — accidentally
    committing to main is the failure mode that takes the longest to
    recover from. Phase 15 calls this from each split task so the check
    isn't lost when the monolithic function is.
    """
    current = _current_branch()
    if current != branch:
        raise CommitAndPrError(
            f"wrong branch: expected {branch!r}, got {current!r}"
        )


def commit(branch: str, title: str, summary: str, base_branch: str = "main") -> str:
    """Stage and commit any uncommitted changes; return the HEAD SHA.

    **Idempotent.** If the working tree is already clean AND the branch
    is ahead of `_BASE_BRANCH`, assume a previous attempt's commit is
    already in place and return HEAD's SHA without re-committing. This
    is the resume-after-failure path: if a previous workflow committed
    locally but failed before push/PR creation, the next attempt sees
    the commit already present and proceeds to push.

    If the working tree is clean AND the branch is NOT ahead of base,
    there's genuinely nothing to commit (the implementation phase made
    no edits, or the changes were already reverted) — raise.

    Returns:
        The commit SHA (full 40-char hex).
    """
    _assert_on_branch(branch)

    dirty = bool(_run(["git", "status", "--porcelain"]).stdout.strip())
    ahead = int(
        _run(
            ["git", "rev-list", f"{base_branch}..HEAD", "--count"]
        ).stdout.strip()
        or "0"
    )

    if not dirty and ahead > 0:
        # Previous attempt's commit is still here. Return its SHA.
        return _run(["git", "rev-parse", "HEAD"]).stdout.strip()
    if not dirty and ahead == 0:
        raise CommitAndPrError("no changes to commit")

    # Stage everything. .gitignore excludes .env, .orchestrator/, caches;
    # project pre-commit hooks are the second line of defence. `git add
    # .` is the documented safe default for this project.
    _run(["git", "add", "."])

    # Compose the commit message. Type prefix from the branch name
    # (e.g. "feature/foo" → "feature"). Scope omitted — we can't infer
    # it deterministically.
    type_prefix = branch.split("/", 1)[0] if "/" in branch else "feature"
    subject = f"{type_prefix}: {title.lower()}"
    commit_msg = f"{subject}\n\n- {summary}"

    try:
        _run(
            [
                "git",
                "commit",
                "--author=Claude <claude@anthropic.com>",
                "-m",
                commit_msg,
            ]
        )
    except subprocess.CalledProcessError as e:
        raise CommitAndPrError(
            f"commit failed: {(e.stderr or e.stdout).strip()}"
        ) from e

    return _run(["git", "rev-parse", "HEAD"]).stdout.strip()


def push(branch: str) -> None:
    """Push branch to origin with upstream tracking.

    **Idempotent.** `git push` is naturally a no-op when the remote is
    already up to date ("Everything up-to-date"), and `-u` re-asserting
    upstream tracking is a no-op if already set.
    """
    _assert_on_branch(branch)
    try:
        _run(["git", "push", "-u", "origin", branch])
    except subprocess.CalledProcessError as e:
        raise CommitAndPrError(
            f"push failed: {(e.stderr or e.stdout).strip()}"
        ) from e


def pr_create(
    branch: str,
    title: str,
    summary: str,
    test_plan: str,
    base_branch: str = "main",
    draft: bool = False,
    reviewers: list[str] | None = None,
    labels: list[str] | None = None,
) -> str:
    """Open a PR for the branch and return its URL.

    **Idempotent.** If a PR already exists for this branch (any state —
    open, closed, merged), return its URL instead of trying to open
    another. This handles the case where a previous attempt successfully
    opened the PR but the workflow failed afterwards (or where the user
    is `resume_run`-ing a thread whose pr_create_task already succeeded
    on a prior invocation — the LangGraph cache should cover that, but
    the in-function check is defence in depth).
    """
    _assert_on_branch(branch)

    # Check for an existing PR. `gh pr view <branch>` exits non-zero if
    # none exists — that's the signal to create one.
    try:
        existing = _run(["gh", "pr", "view", branch, "--json", "url"])
        url = json.loads(existing.stdout).get("url")
        if url:
            return url
    except subprocess.CalledProcessError:
        # No PR exists; fall through to create one.
        pass

    body = (
        f"## Summary\n{summary}\n\n"
        f"## Test plan\n{test_plan}\n\n"
        "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
    )
    cmd = ["gh", "pr", "create", "--title", title, "--body", body, "--base", base_branch]
    if draft:
        cmd.append("--draft")
    for reviewer in (reviewers or []):
        cmd += ["--reviewer", reviewer]
    for label in (labels or []):
        cmd += ["--label", label]
    try:
        result = _run(cmd)
    except subprocess.CalledProcessError as e:
        raise CommitAndPrError(
            f"gh pr create failed: {(e.stderr or e.stdout).strip()}"
        ) from e

    # `gh pr create` prints the URL on the last non-empty stdout line.
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    if not lines:
        raise CommitAndPrError("gh pr create produced no output")
    return lines[-1].strip()


if __name__ == "__main__":
    # Standalone test for create_branch only:
    #   python -m orchestrator.git_ops "Stress test for variable rates" feature
    # No LLM call; doesn't touch the checkpointer. Just exercises the
    # subprocess plumbing against your real repo.
    #
    # commit/push/pr_create aren't exposed here because (a) their
    # inputs are awkward to pass as positional args (multi-line summary,
    # markdown test plan) and (b) their side effects — a real commit,
    # push, and PR opening on GitHub — make ad-hoc testing expensive.
    # Test them via the workflow end-to-end run instead.
    title = sys.argv[1] if len(sys.argv) > 1 else "test branch creation"
    branch_type = sys.argv[2] if len(sys.argv) > 2 else "feature"
    fake_plan = PlanResult(title=title, type=branch_type, plan_text="(test)")
    try:
        print(f"created: {create_branch(fake_plan)}")
    except BranchCreationError as e:
        print(f"FAILED: {e}", file=sys.stderr)
        sys.exit(1)
