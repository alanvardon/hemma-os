"""Per-run artifact folder (Phase 33).

Writes each run's plan, implementation summary, test-plan, and QA
verdict to disk as readable markdown under:

    .orchestrator/runs/{thread_id}/          ← before branch exists
    .orchestrator/runs/{thread_id}-{slug}/   ← after create_branch

All writes are best-effort: OSError is swallowed so a disk problem
never takes down the workflow. The checkpointer is the source of truth;
these files are for human debugging only.

Usage in workflow.py:
    from orchestrator.run_artifacts import (
        write_plan, write_implementation, write_qa, rename_with_branch
    )
"""

from pathlib import Path

from orchestrator.agents.implementation import ImplementationResult
from orchestrator.agents.planning import PlanResult
from orchestrator.agents.qa import QaResult

_RUNS_DIR = Path(".orchestrator") / "runs"


def _run_dir(thread_id: str) -> Path:
    """Resolve the current artifact folder for a given thread_id.

    Checks for an existing {thread_id}-{slug} folder first (post-branch),
    then falls back to the bare {thread_id} folder (pre-branch or
    branch creation failed). Creates the folder if it doesn't exist yet.
    """
    _RUNS_DIR.mkdir(parents=True, exist_ok=True)
    matches = sorted(_RUNS_DIR.glob(f"{thread_id}-*"))
    if matches:
        return matches[0]
    return _RUNS_DIR / thread_id


def write_plan(thread_id: str, plan: PlanResult) -> None:
    """Write plan.md — overwritten on each re-plan."""
    try:
        d = _run_dir(thread_id)
        d.mkdir(parents=True, exist_ok=True)
        content = f"# {plan.title}\n\n**Type:** {plan.type}\n\n{plan.plan_text}\n"
        (d / "plan.md").write_text(content, encoding="utf-8")
    except OSError:
        pass


def write_implementation(thread_id: str, impl: ImplementationResult) -> None:
    """Write summary.md and test-plan.md — latest attempt wins."""
    try:
        d = _run_dir(thread_id)
        d.mkdir(parents=True, exist_ok=True)
        (d / "summary.md").write_text(impl.summary, encoding="utf-8")
        (d / "test-plan.md").write_text(impl.test_plan, encoding="utf-8")
    except OSError:
        pass


def write_qa(thread_id: str, qa: QaResult) -> None:
    """Write qa.md — latest attempt wins."""
    try:
        d = _run_dir(thread_id)
        d.mkdir(parents=True, exist_ok=True)
        failures_section = (
            f"\n## Failures\n\n{qa.failures}\n" if qa.failures else ""
        )
        content = f"# QA Result: {qa.result}{failures_section}\n"
        (d / "qa.md").write_text(content, encoding="utf-8")
    except OSError:
        pass


def rename_with_branch(thread_id: str, branch: str) -> None:
    """Rename {thread_id}/ → {thread_id}-{slug}/ after branch creation.

    Slug is the part after the first '/' in the branch name, e.g.
    'feature/dark-mode-toggle' → 'dark-mode-toggle'.
    If the bare folder doesn't exist or rename fails, silently no-op.
    """
    try:
        slug = branch.split("/", 1)[-1] if "/" in branch else branch
        src = _RUNS_DIR / thread_id
        dst = _RUNS_DIR / f"{thread_id}-{slug}"
        if src.exists() and not dst.exists():
            src.rename(dst)
    except OSError:
        pass
