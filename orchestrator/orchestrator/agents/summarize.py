"""Summarizer agent (Phase 42) — the linchpin of the spine migration.

Before Phase 42, `implementation.py` did two jobs: it edited files AND emitted a
structured `ImplementationResult{summary, test_plan}` that fed the commit/PR.
Those two fields were the only reason implementation needed a special result
type, which blocked it from becoming a *generic* retry-block producer.

This module relocates that concern. The summarizer is a read-only agent that
runs ONCE after the impl→QA retry block passes: it reads the plan + `git diff
HEAD` and emits both fields. A diff-derived summary is more accurate than an
agent's self-report (which drifts from what it actually changed), and being
read-only it carries no risk to the tree.

It is the sibling of the docs agent (Phase 41): both are post-block, pre-commit,
read-the-diff agents. They stay separate — the summarizer *produces commit/PR
metadata* (read-only); the docs agent *edits `.md` files*.

Built on Phase 39's `run_structured_agent`, like every other agent.
"""

from __future__ import annotations

from pydantic import BaseModel

from orchestrator.agents.runner import run_structured_agent
from orchestrator.config import load_config
from orchestrator.git_ops import REPO_ROOT
from orchestrator.prompt_loader import load_prompt
from orchestrator.usage import TaskUsage


class SummaryResult(BaseModel):
    # Phase 20: bump on incompatible shape changes (renamed/removed fields);
    # pure additions of optional fields don't need a bump.
    schema_version: int = 1
    summary: str       # commit body + PR body
    test_plan: str     # PR "test plan" section
    usage: TaskUsage | None = None


async def summarize(
    plan_text: str, model: str
) -> SummaryResult:
    """Run the read-only summarizer agent and return its structured result.

    Reads the plan (in the user message) and the working-tree diff (via Bash),
    then emits {summary, test_plan}. Tools/timeout come from [workflow.summarize]
    (Phase 40); the tool set is read-only — no Edit/Write.
    """
    _cfg = load_config().workflow.summarize
    return await run_structured_agent(
        # Package-shipped prompt (orchestrator/prompts/summarize.md), loaded via
        # the same loader as planning/implementation/qa — so it inherits the
        # .orchestrator/prompts/ override path and never depends on a local-only
        # file, the rule every spine agent follows.
        system_prompt=load_prompt("summarize"),
        user_message="\n".join(["## Plan", "", plan_text]),
        model=model,
        allowed_tools=_cfg.allowed_tools,
        disallowed_tools=_cfg.disallowed_tools,
        # Same repo root as implementation/QA — the agent runs `git diff HEAD`
        # against the target repo's tree, not the orchestrator/ subdirectory.
        cwd=REPO_ROOT,
        timeout=_cfg.timeout,
        emit_tool_name="emit_summary",
        emit_tool_description=(
            "Emit the commit/PR summary and test plan. Call this exactly once "
            "when done. `summary` is the commit body / PR description; "
            "`test_plan` is the markdown verification checklist. After calling, "
            "stop — the orchestrator takes over."
        ),
        emit_tool_fields={"summary": str, "test_plan": str},
        result_factory=lambda captured, usage: SummaryResult(
            summary=captured.get("summary", "") or "",
            test_plan=captured.get("test_plan", "") or "",
            usage=usage,
        ),
    )
