"""Per-run artifact folder.

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
from orchestrator.agents.test_author import TestAuthorResult
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
    """Write decomposition.md — the task list, for human review. Overwritten on
    re-plan. The checkpointed DecompositionResult is what the per-task loop
    actually executes; this artifact is the readable mirror of it."""
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

    These come from the summarizer (post-retry-block), not the implementation
    producer — which is generic and reports no summary.
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


def _safe_id(task_id: str) -> str:
    """A filesystem-safe fragment from a task id (ids are slugs, but be defensive)."""
    return "".join(c if c.isalnum() or c in "-_" else "-" for c in task_id) or "task"


def write_test_author(thread_id: str, task_id: str, ta: TestAuthorResult) -> None:
    """Write test-author-<task_id>.md — the test-author's verdict for one TDD task.

    Written for EVERY TDD task (Phase 73), testable or not, so the run folder shows
    the test-author's decision for each task — not only the ones that got tests. For
    a testable task it captures the frozen-test snapshot and the failing (RED) suite
    output; for a degraded task it records `testable=false` and the reason it fell
    back to the classic implement→qa path. Best-effort; the checkpointed
    TestAuthorResult is the source of truth."""
    try:
        d = _run_dir(thread_id)
        d.mkdir(parents=True, exist_ok=True)
        snap = f"\n**Frozen snapshot:** `{ta.snapshot}`\n" if ta.snapshot else ""
        red = f"\n## Red output\n\n```\n{ta.red_output}\n```\n" if ta.red_output else ""
        content = (
            f"# Test author — {task_id}\n\n"
            f"**Testable:** {ta.testable}\n\n"
            f"{ta.summary}\n"
            f"{snap}{red}"
        )
        (d / f"test-author-{_safe_id(task_id)}.md").write_text(content, encoding="utf-8")
    except OSError:
        pass


def write_manual_checks(thread_id: str, items: list[dict]) -> None:
    """Write manual-checks.md — the acceptance criteria NOT proven by a test (P73).

    Each item is a degraded TDD task (the test-author judged it untestable / born-
    green / had no script gate, so it ran the classic implement→qa path): its
    title, id, the reason it degraded, and its acceptance_criteria — the spec a
    human must now verify by hand. No-op when there are none. Best-effort."""
    if not items:
        return
    try:
        d = _run_dir(thread_id)
        d.mkdir(parents=True, exist_ok=True)
        lines = [
            "# Manual verification needed",
            "",
            "These tasks were not proven by an automated test (the test-author "
            "degraded them to the classic implement→qa path). Verify each "
            "acceptance criterion by hand:",
            "",
        ]
        for it in items:
            lines.append(f"## {it.get('title')}  (`{it.get('task_id')}`)")
            lines.append("")
            lines.append(f"**Why no test:** {it.get('reason') or '(unspecified)'}")
            lines.append("")
            lines.append(f"**Verify:** {it.get('acceptance_criteria') or '(none given)'}")
            lines.append("")
        (d / "manual-checks.md").write_text("\n".join(lines), encoding="utf-8")
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
