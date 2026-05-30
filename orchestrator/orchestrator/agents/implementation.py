"""Implementation agent — runs Claude Agent SDK in a loop to edit files.

This is the first task that needs the *agent loop* rather than a single
LLM call. Why: implementation requires reading files, deciding what to
change, editing, re-reading, possibly running checks, iterating. That's
the agent harness pattern, and the Claude Agent SDK is what gives it to
us in Python (same loop Claude Code uses, exposed as a library).

The structured-output story differs from planning.py:
  - planning.py uses tool-use-as-structured-output on a single
    messages.create call (force tool_choice, parse tool input)
  - implementation needs the agent to run many turns before producing
    its final result. So instead of forcing tool_choice on the model,
    we *give the agent a custom MCP tool* called
    `emit_implementation_result`. The agent calls it once when it's
    done. We capture the args via a closure into a holder dict.

Same conceptual win — no sentinel parsing — different mechanism because
the agent loop is a different shape. Phase 39: the loop itself (emit tool,
query() loop, fail-closed guard, usage extraction) now lives in
`run_structured_agent`; this module supplies the prompt, the implement/fix
user message, the tools, the emit schema, and the ImplementationResult
factory.
"""

from dotenv import load_dotenv

load_dotenv()

import asyncio
import sys

from pydantic import BaseModel

from orchestrator.usage import TaskUsage
from orchestrator.prompt_loader import load_prompt

from orchestrator.agents.planning import PlanResult
from orchestrator.agents.runner import run_structured_agent
from orchestrator.git_ops import REPO_ROOT
from orchestrator.tool_profile import load_tool_profile


_IMPLEMENTATION_SYSTEM_PROMPT = load_prompt("implementation")


class ImplementationResult(BaseModel):
    # Phase 20: bump on incompatible shape changes (renamed/removed fields);
    # pure additions of optional fields don't need a bump.
    schema_version: int = 1
    summary: str
    test_plan: str
    usage: TaskUsage | None = None


def _build_user_message(
    plan: PlanResult,
    mode: str,
    qa_failures: str | None,
) -> str:
    """Compose the per-run user message for the agent.

    Mirrors the coordinator's old "MODE: implement / PLAN_FILE: ..."
    format but with the actual content inline rather than file paths,
    because the orchestrator passes data, not paths.
    """
    parts = [f"MODE: {mode}", "", "## Plan", "", plan.plan_text]
    if mode == "fix":
        if not qa_failures:
            raise ValueError("fix mode requires qa_failures")
        parts += ["", "## QA failures to address", "", qa_failures]
    return "\n".join(parts)


async def implement(
    plan: PlanResult,
    mode: str = "implement",
    qa_failures: str | None = None,
    model: str = "claude-sonnet-4-6",
) -> ImplementationResult:
    """Run the implementation agent and return its structured result.

    Mode is "implement" for the first attempt, "fix" on retries after
    QA failures (Phase 7). qa_failures is the failure text from QA's
    last verdict; required in fix mode.
    """
    if mode not in ("implement", "fix"):
        raise ValueError(f"unknown mode: {mode!r}")

    # The agent loop, the in-process emit tool, the fail-closed guard, and
    # usage extraction all live in run_structured_agent now (Phase 39). This
    # wrapper supplies the implementation-specific prompt, the implement/fix
    # user message, the tool profile, and the typed ImplementationResult.
    _profile = load_tool_profile("implementation")
    return await run_structured_agent(
        system_prompt=_IMPLEMENTATION_SYSTEM_PROMPT,
        user_message=_build_user_message(plan, mode, qa_failures),
        model=model,
        # File-editing tools from the operator-configurable profile. No Git,
        # no commit, no PR tools — the orchestrator owns those entirely. The
        # pinned emit tool is appended by the runner.
        allowed_tools=_profile.allowed_tools,
        disallowed_tools=_profile.disallowed_tools,
        # cwd must be the target repo root — the agent edits files there,
        # not in the orchestrator/ subdirectory.
        cwd=REPO_ROOT,
        emit_tool_name="emit_implementation_result",
        emit_tool_description=(
            "Emit the final implementation result. Call this exactly once when "
            "the work is complete. After calling, stop and do not make further "
            "edits — the orchestrator takes over from here."
        ),
        emit_tool_fields={"summary": str, "test_plan": str},
        result_factory=lambda captured, usage: ImplementationResult(
            summary=captured["summary"],
            test_plan=captured["test_plan"],
            usage=usage,
        ),
    )


# Standalone test:
#   python -m orchestrator.agents.implementation "tiny test"
# Creates a fake minimal plan, runs the agent, prints the structured
# result. Will actually edit files in the target repo, so:
#   - run on a branch you don't mind being modified
#   - have a clean tree first
if __name__ == "__main__":
    request = " ".join(sys.argv[1:]) or "add a comment '// hello from orchestrator' at the top of app.js"

    async def _main() -> None:
        # Fake plan for standalone testing — bypasses the planning agent.
        # In the real workflow the plan comes from planning_task.
        fake_plan = PlanResult(
            title="standalone implementation test",
            type="feature",
            plan_text=request,
        )
        result = await implement(fake_plan)
        print(result.model_dump_json(indent=2))

    asyncio.run(_main())
