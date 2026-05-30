"""Shared agent-loop runner (Phase 39).

`implementation.py`, `qa.py`, and `steps.execute_llm_agent` all ran the SAME
agent-loop body and differed only in their result schema:

  1. a closure-captured `@tool` for structured output
  2. `create_sdk_mcp_server(...)`
  3. `ClaudeAgentOptions(...)` assembly, pinning the emit tool into allowed_tools
  4. the `async for msg in query(...)` loop, capturing the ResultMessage
  5. a fail-closed guard: a missing emit must raise, never default a verdict
  6. `TaskUsage` extraction from `result_msg.usage`

Items 1–6 are genuine duplication and live here now. The per-agent **result
model** is NOT duplication — it is the contract the workflow depends on, so it
stays typed in each caller, supplied via `result_factory`. Each agent shrinks to
a thin wrapper that passes its prompt, tools, emit-tool schema, and factory.

Fail-closed is centralised: if the agent never calls its emit tool, the runner
raises `FatalError`. (`steps.execute_llm_agent` catches and re-wraps this as its
own `StepError` to preserve that module's contract.)
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable, TypeVar

from claude_agent_sdk import (
    ClaudeAgentOptions,
    ResultMessage,
    create_sdk_mcp_server,
    query,
    tool,
)

from orchestrator.errors import FatalError
from orchestrator.usage import TaskUsage

R = TypeVar("R")


def _extract_usage(result_msg: ResultMessage | None, model: str) -> TaskUsage | None:
    """Build a TaskUsage from the SDK's ResultMessage, or None if absent.

    Identical logic previously inlined in all three call sites.
    """
    if result_msg is None or not result_msg.usage:
        return None
    u = result_msg.usage
    return TaskUsage(
        model=model,
        input_tokens=u.get("input_tokens", 0),
        output_tokens=u.get("output_tokens", 0),
        cache_read_tokens=u.get("cache_read_input_tokens", 0),
        cache_creation_tokens=u.get("cache_creation_input_tokens", 0),
        reported_cost_usd=result_msg.total_cost_usd,
    )


async def run_structured_agent(
    *,
    system_prompt: str,
    user_message: str,
    model: str,
    allowed_tools: list[str],
    disallowed_tools: list[str],
    cwd: Path,
    emit_tool_name: str,
    emit_tool_description: str,
    emit_tool_fields: dict[str, type],
    result_factory: Callable[[dict, TaskUsage | None], R],
) -> R:
    """Run one agent-loop turn-cycle that ends when the agent calls its emit
    tool, then build a typed result from the captured args.

    The emit tool is created in-process and its args are captured via a closure
    into `captured`. The pinned MCP tool name is appended to `allowed_tools` here,
    so callers pass only their own (operator-configurable) tools.

    Fail-closed: if the agent never calls the emit tool, raise FatalError.
    """
    captured: dict = {}

    @tool(emit_tool_name, emit_tool_description, emit_tool_fields)
    async def _emit(args: dict) -> dict:
        captured.update(args)
        return {"content": [{"type": "text", "text": "Captured. You may stop now."}]}

    server = create_sdk_mcp_server(
        name="orchestrator", version="1.0.0", tools=[_emit]
    )
    options = ClaudeAgentOptions(
        system_prompt=system_prompt,
        allowed_tools=allowed_tools + [f"mcp__orchestrator__{emit_tool_name}"],
        disallowed_tools=disallowed_tools,
        mcp_servers={"orchestrator": server},
        cwd=str(cwd),
        permission_mode="acceptEdits",
        model=model,
        setting_sources=["project"],
    )

    result_msg: ResultMessage | None = None
    async for msg in query(prompt=user_message, options=options):
        if isinstance(msg, ResultMessage):
            result_msg = msg

    if not captured:
        raise FatalError(f"agent did not call {emit_tool_name}")

    return result_factory(captured, _extract_usage(result_msg, model))
