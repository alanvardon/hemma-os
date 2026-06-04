"""Per-run artifact folder (Phase 33).

Writes each run's plan, implementation summary, test-plan, QA verdict,
and token usage to disk under:

    .orchestrator/runs/{thread_id}/          ← before branch exists
    .orchestrator/runs/{thread_id}-{slug}/   ← after create_branch

All writes are best-effort: OSError is swallowed so a disk problem
never takes down the workflow. The checkpointer is the source of truth;
these files are for human debugging only.

Usage in workflow.py:
    from orchestrator.run_artifacts import (
        write_plan, write_summary, write_qa, write_usage,
        rename_with_branch,
    )
"""

import json
from pathlib import Path

from orchestrator.agents.decompose import DecompositionResult
from orchestrator.agents.planning import PlanResult
from orchestrator.agents.qa import QaResult
from orchestrator.agents.summarize import SummaryResult
from orchestrator.paths import find_project_root

def _runs_dir() -> Path:
    """Resolve the runs directory lazily.

    Why: tests monkeypatch.chdir() after import, so a module-level
    constant would freeze to the real repo and leak test artifacts there.
    """
    return find_project_root() / ".orchestrator" / "runs"


def _run_dir(thread_id: str) -> Path:
    """Resolve the current artifact folder for a given thread_id.

    Checks for an existing {thread_id}-{slug} folder first (post-branch),
    then falls back to the bare {thread_id} folder (pre-branch or
    branch creation failed). Creates the folder if it doesn't exist yet.
    """
    runs = _runs_dir()
    runs.mkdir(parents=True, exist_ok=True)
    matches = sorted(runs.glob(f"{thread_id}-*"))
    if matches:
        return matches[0]
    return runs / thread_id


def write_plan(thread_id: str, plan: PlanResult) -> None:
    """Write plan.md — overwritten on each re-plan."""
    try:
        d = _run_dir(thread_id)
        d.mkdir(parents=True, exist_ok=True)
        content = f"# {plan.title}\n\n**Type:** {plan.type}\n\n{plan.plan_text}\n"
        (d / "plan.md").write_text(content, encoding="utf-8")
    except OSError:
        pass


def write_decomposition(thread_id: str, decomposition: DecompositionResult) -> None:
    """Write decomposition.md — the task list (Phase 55). Overwritten on re-plan.

    Execution-inert in Phase 55: this artifact and the checkpointed DecompositionResult
    are the only consumers of the task list — nothing drives work off it yet."""
    try:
        d = _run_dir(thread_id)
        d.mkdir(parents=True, exist_ok=True)
        lines = ["# Task decomposition", ""]
        for i, t in enumerate(decomposition.tasks, 1):
            lines.append(f"## {i}. {t.title}  (`{t.id}`)")
            lines.append("")
            lines.append(t.description)
            if t.acceptance_criteria:
                lines.append("")
                lines.append(f"**Acceptance:** {t.acceptance_criteria}")
            lines.append("")
        (d / "decomposition.md").write_text("\n".join(lines), encoding="utf-8")
    except OSError:
        pass


def write_summary(thread_id: str, summary: SummaryResult) -> None:
    """Write summary.md and test-plan.md.

    Phase 42: these come from the summarizer (post-retry-block), not the
    implementation producer — which is now generic and reports no summary.
    """
    try:
        d = _run_dir(thread_id)
        d.mkdir(parents=True, exist_ok=True)
        (d / "summary.md").write_text(summary.summary, encoding="utf-8")
        (d / "test-plan.md").write_text(summary.test_plan, encoding="utf-8")
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


def write_usage(thread_id: str, usage: dict) -> None:
    """Write usage.json — final token/cost summary for the run."""
    try:
        d = _run_dir(thread_id)
        d.mkdir(parents=True, exist_ok=True)
        (d / "usage.json").write_text(
            json.dumps(usage, indent=2), encoding="utf-8"
        )
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
        runs = _runs_dir()
        src = runs / thread_id
        dst = runs / f"{thread_id}-{slug}"
        if src.exists() and not dst.exists():
            src.rename(dst)
    except OSError:
        pass
