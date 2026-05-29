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
the agent loop is different shape.
"""

from dotenv import load_dotenv

load_dotenv()

import asyncio
import sys

from anthropic import AsyncAnthropic
from claude_agent_sdk import (
    ClaudeAgentOptions,
    ResultMessage,
    create_sdk_mcp_server,
    query,
    tool,
)
from pydantic import BaseModel

from orchestrator.usage import TaskUsage
from orchestrator.prompt_loader import load_prompt

from orchestrator.agents.planning import PlanResult
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

    # Closure-captured holder for the agent's final structured output.
    # The @tool below writes into it; we read it after query() returns.
    captured: dict[str, str] = {}

    # Define the structured-output tool. The agent calls this exactly
    # once when it's done; the call's arguments ARE the structured
    # output. We acknowledge to the agent so it knows the orchestrator
    # received the result.
    @tool(
        "emit_implementation_result",
        "Emit the final implementation result. Call this exactly once when "
        "the work is complete. After calling, stop and do not make further "
        "edits — the orchestrator takes over from here.",
        {"summary": str, "test_plan": str},
    )
    async def emit_implementation_result(args: dict) -> dict:
        captured["summary"] = args["summary"]
        captured["test_plan"] = args["test_plan"]
        return {
            "content": [
                {"type": "text", "text": "Result captured. You may stop now."}
            ]
        }

    # In-process MCP server holding our single tool. No subprocess, no
    # IPC — runs in the same Python process as the orchestrator, which
    # is how the captured dict above can leak state out of the tool.
    orchestrator_mcp = create_sdk_mcp_server(
        name="orchestrator",
        version="1.0.0",
        tools=[emit_implementation_result],
    )

    # Load tool profile from orchestrator.toml (falls back to defaults if
    # absent). The pinned MCP tool for structured output is injected here
    # and does not need to be listed in orchestrator.toml.
    _profile = load_tool_profile("implementation")
    _allowed_tools = _profile.allowed_tools + [
        "mcp__orchestrator__emit_implementation_result"
    ]

    options = ClaudeAgentOptions(
        system_prompt=_IMPLEMENTATION_SYSTEM_PROMPT,
        # File-editing tools from the operator-configurable profile, plus
        # the pinned MCP tool for structured output. Note: no Git, no
        # commit, no PR tools — the orchestrator owns those entirely.
        allowed_tools=_allowed_tools,
        disallowed_tools=_profile.disallowed_tools,
        mcp_servers={"orchestrator": orchestrator_mcp},
        # cwd must be the target repo root — the agent edits files
        # there, not in the orchestrator/ subdirectory.
        cwd=str(REPO_ROOT),
        # acceptEdits = skip per-edit human approval. We're running
        # unattended; the orchestrator already approved the plan with
        # the user. Project-level deny rules in .claude/settings.json
        # still apply (.env, secrets, etc.).
        permission_mode="acceptEdits",
        # Pin the model so behaviour is stable across SDK upgrades.
        model=model,
        # Read CLAUDE.md and the project's .claude/settings.json so
        # the agent inherits project rules and permission deny lists.
        setting_sources=["project"],
    )

    user_message = _build_user_message(plan, mode, qa_failures)

    result_msg: ResultMessage | None = None
    async for msg in query(prompt=user_message, options=options):
        if isinstance(msg, ResultMessage):
            result_msg = msg

    if "summary" not in captured:
        raise RuntimeError(
            "implementation agent did not call emit_implementation_result"
        )

    usage: TaskUsage | None = None
    if result_msg is not None and result_msg.usage:
        u = result_msg.usage
        usage = TaskUsage(
            model=model,
            input_tokens=u.get("input_tokens", 0),
            output_tokens=u.get("output_tokens", 0),
            cache_read_tokens=u.get("cache_read_input_tokens", 0),
            cache_creation_tokens=u.get("cache_creation_input_tokens", 0),
            reported_cost_usd=result_msg.total_cost_usd,
        )

    return ImplementationResult(
        summary=captured["summary"],
        test_plan=captured["test_plan"],
        usage=usage,
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
