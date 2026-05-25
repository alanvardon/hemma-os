"""Deterministic git operations used by workflow tasks.

The orchestrator has a hard split:
  - cognition (planning, implementation, QA) → LLM-driven, probabilistic
  - control  (branch creation, commit, PR)   → subprocess, deterministic

This module owns the deterministic side. No prompts, no models, no
structured output — just shell commands wrapped in Python. Ports of
.claude/skills/create-feature-branch.md (Phase 6a) and
.claude/skills/commit-and-open-pr.md (Phase 6d).
"""

import re
import subprocess
import sys
from pathlib import Path

from orchestrator.agents.planning import PlanResult


# Where to run git commands. The bostadskalkyl repo is the parent of the
# orchestrator/ subproject. Resolving from __file__ rather than process
# cwd so this works whether you launch from orchestrator/, the project
# root, or anywhere else.
REPO_ROOT = Path(__file__).resolve().parent.parent.parent


class BranchCreationError(RuntimeError):
    """Raised when create_branch can't safely create a new branch.

    Three distinct cases all collapse into this exception: dirty tree,
    cannot-reach-main, and branch-already-exists. The message carries the
    detail. The orchestrator treats this as a terminal workflow failure
    — planning's checkpoint is preserved so you can fix the underlying
    issue and re-trigger without re-paying for the LLM call.
    """


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


def create_branch(plan: PlanResult) -> str:
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
    # your current coordinator.
    slug = _slugify(plan.title)
    branch_name = f"{plan.type}/{slug}"

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
    """Raised when commit_and_pr can't safely complete.

    Collapses several distinct failure modes (wrong branch, empty diff,
    push failure, gh pr create failure) into one exception type. The
    orchestrator treats this as a terminal workflow failure — the
    implementation's checkpoint is preserved so you can fix the
    underlying issue (e.g. log in to gh) and re-trigger without
    re-paying for the LLM call.
    """


def commit_and_pr(
    branch: str,
    title: str,
    summary: str,
    test_plan: str,
) -> str:
    """Stage all changes on the current branch, commit, push, open a PR.

    Returns the PR URL on success. Raises CommitAndPrError if:
      - the current branch doesn't match `branch` (refuse to commit to
        the wrong place — most likely main if create_branch_task was
        skipped)
      - there are no changes to commit
      - git push fails (network, auth, permissions)
      - `gh pr create` fails (no remote, no gh auth, PR already exists)

    Port of .claude/skills/commit-and-open-pr.md. Differences from the
    skill:
      - The skill staged specific files plus .workflow/<branch>/* state
        files. Here we use `git add .` — the orchestrator's checkpointer
        replaces the .workflow/ directory entirely, and project hooks
        + .gitignore block secrets and noise.
      - The skill's "scope" field is inferred from the diff by an LLM.
        Deterministic Python can't do that reliably, so we omit it
        (the skill explicitly permits this when scope is unclear).
      - `test_plan` arrives as a string (from ImplementationResult),
        not a file path — no read-from-disk branch.
    """
    # 1. Verify the current branch. If create_branch_task was skipped
    # for any reason, the only way we get here is on main — and a
    # commit-to-main is the single most important thing this function
    # must refuse.
    current = _run(["git", "rev-parse", "--abbrev-ref", "HEAD"]).stdout.strip()
    if current != branch:
        raise CommitAndPrError(
            f"wrong branch: expected {branch!r}, got {current!r}"
        )

    # 2. Guard against an empty diff. Better to fail loudly than to
    # create an empty commit.
    status = _run(["git", "status", "--porcelain"])
    if not status.stdout.strip():
        raise CommitAndPrError("no changes to commit")

    # 3. Stage everything. .gitignore excludes .env, .orchestrator/,
    # caches, etc; project pre-commit hooks block sensitive content as
    # a second line of defence. `git add .` is the documented safe
    # default for this project (see CLAUDE.md / user memory).
    _run(["git", "add", "."])

    # 4. Compose the commit message.
    # Type prefix derived from the branch name (e.g. "feature/foo" →
    # "feature"). Matches the convention in
    # .claude/skills/commit-and-open-pr.md. Scope is omitted because
    # we can't infer it deterministically; the skill explicitly allows
    # this.
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

    # 5. Push and set upstream. -u is important on first push of a new
    # branch — without it the branch exists on origin but isn't tracking,
    # and subsequent `git pull` / `gh pr create` behave inconsistently.
    try:
        _run(["git", "push", "-u", "origin", branch])
    except subprocess.CalledProcessError as e:
        raise CommitAndPrError(
            f"push failed: {(e.stderr or e.stdout).strip()}"
        ) from e

    # 6. Open the PR. test_plan arrives as markdown bullets from
    # ImplementationResult; we embed it directly. Body includes the
    # Claude Code attribution per the skill's template.
    pr_body = (
        f"## Summary\n{summary}\n\n"
        f"## Test plan\n{test_plan}\n\n"
        "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
    )
    try:
        result = _run(
            [
                "gh",
                "pr",
                "create",
                "--title",
                title,
                "--body",
                pr_body,
            ]
        )
    except subprocess.CalledProcessError as e:
        raise CommitAndPrError(
            f"gh pr create failed: {(e.stderr or e.stdout).strip()}"
        ) from e

    # 7. `gh pr create` prints the PR URL on stdout (last line). Earlier
    # lines may contain progress messages; take the last non-empty line.
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
    # commit_and_pr isn't exposed here because (a) its inputs are
    # awkward to pass as positional args (multi-line summary, markdown
    # test plan) and (b) its side effects — a real PR opening on
    # GitHub — make ad-hoc testing expensive. Test it via the workflow
    # end-to-end run instead.
    title = sys.argv[1] if len(sys.argv) > 1 else "test branch creation"
    branch_type = sys.argv[2] if len(sys.argv) > 2 else "feature"
    fake_plan = PlanResult(title=title, type=branch_type, plan_text="(test)")
    try:
        print(f"created: {create_branch(fake_plan)}")
    except BranchCreationError as e:
        print(f"FAILED: {e}", file=sys.stderr)
        sys.exit(1)
