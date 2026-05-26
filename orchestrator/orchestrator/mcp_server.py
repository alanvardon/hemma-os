"""MCP server exposing the orchestrator to Claude Code (Phase 11).

Two tools:
  - implement_feature: start a workflow; returns a plan for approval
  - approve_plan:      resume an awaiting workflow with the user's response

The flow is conversational by design. The workflow pauses at plan approval
(Phase 8's interrupt), the user reviews via Claude Code chat, then
approves or revises. Each tool call:
  - opens the AsyncSqliteSaver
  - drives one ainvoke (or resume) call
  - closes the DB and returns to Claude Code

State lives in .orchestrator/checkpoints.db between calls, keyed by the
thread_id that implement_feature generates and approve_plan replays.

Testing without Claude Code (recommended first step):
  npx @modelcontextprotocol/inspector \\
    /Users/avardon/.pyenv/versions/bk-orchestrator-env/bin/python \\
    -m orchestrator.mcp_server

CRITICAL: always invoke via the full env-scoped python path, not the
"python" shim. MCP servers are subprocesses; pyenv auto-activation
doesn't apply to them (PLAN.md landmine #2).
"""

from pathlib import Path
from uuid import uuid4

from dotenv import load_dotenv

load_dotenv()

from langgraph.types import Command
from mcp.server.fastmcp import FastMCP

from orchestrator.run_log import append_run
from orchestrator.workflow import build_workflow


# AsyncSqliteSaver creates the .db file on demand but not its parent.
# Run once at import (server startup) rather than per-tool-call.
Path(".orchestrator").mkdir(exist_ok=True)

mcp = FastMCP("bostadskalkyl-orchestrator")


def _awaiting_approval(thread_id: str, result: dict, hint: str) -> dict:
    """Shape an interrupt result into the awaiting_approval response.

    The interrupt's value dict is set by orchestrator/workflow.py at the
    interrupt() call site — it carries "kind", "plan", and "ask" keys.
    """
    interrupt_val = result["__interrupt__"][0].value
    return {
        "status": "awaiting_approval",
        "thread_id": thread_id,
        "plan": interrupt_val["plan"],
        "next": hint,
    }


@mcp.tool()
async def implement_feature(request: str) -> dict:
    """Start a feature, fix, or refactor implementation workflow.

    Use this when the user asks to implement, change, or fix something in
    the bostadskalkyl repo. Example user intents:
      - "add a tooltip showing what LTV means"
      - "fix the rounding bug in lagfart"
      - "refactor the modal close handlers"

    The workflow ALWAYS pauses for plan approval before writing any code.
    This tool returns {"status": "awaiting_approval", ...} containing the
    plan and a thread_id. You MUST then:
      1. Show the plan's `plan_text` to the user.
      2. Ask whether they approve, or what they want changed.
      3. Call `approve_plan` with the same thread_id and their response.

    Do NOT call this tool again to "retry" — that starts a fresh workflow
    with a new thread_id, losing the user's review context. To revise an
    in-flight plan, send feedback via `approve_plan` instead.

    Args:
        request: Natural-language description of what to implement.

    Returns:
        Awaiting-approval dict: {
            "status": "awaiting_approval",
            "thread_id": str,
            "plan": {"title": str, "type": str, "plan_text": str},
            "next": str
        }
    """
    thread_id = f"run-{uuid4().hex[:8]}"
    config = {"configurable": {"thread_id": thread_id}}
    append_run(thread_id, request, source="mcp")
    async with build_workflow() as workflow:
        result = await workflow.ainvoke(request, config=config)
    if "__interrupt__" in result:
        return _awaiting_approval(
            thread_id,
            result,
            "Show the plan_text to the user. Ask whether they approve or "
            "want changes. Then call approve_plan with this same thread_id "
            "and their response ('yes' to proceed, or feedback to revise).",
        )
    # Shouldn't happen: the workflow always hits the plan-approval interrupt
    # before doing any side effects. If we reach here, the workflow body
    # was changed in a way that bypasses Phase 8.
    raise RuntimeError(
        "Workflow completed without hitting plan approval interrupt"
    )


@mcp.tool()
async def resume_run(thread_id: str) -> dict:
    """Resume a workflow that failed mid-task without restarting it.

    Use this when a previous `implement_feature` or `approve_plan` call
    returned an error (e.g. push failed, gh pr create failed). Phase 15's
    split of commit/push/PR into three independent @tasks means the
    successful steps are cached in the checkpointer — only the failed
    task (and anything downstream) re-runs.

    Use AFTER fixing the underlying issue. Examples:
      - push failed → authenticate gh, restore network, then resume_run
      - gh pr create failed (no remote, no auth) → fix auth, then resume_run
      - commit failed mid-workflow → investigate, may need manual cleanup
        before resume_run

    Do NOT use this to resume a plan-approval interrupt — that's what
    `approve_plan` is for. resume_run is specifically for recovering
    from a task failure.

    Args:
        thread_id: The thread_id from the prior failed response.

    Returns:
        Same shape as approve_plan: another awaiting_approval (rare,
        only if the workflow re-entered the planning loop somehow), a
        succeeded dict with pr_url, or a failed dict.
    """
    config = {"configurable": {"thread_id": thread_id}}
    # The functional API's resume incantation: ainvoke(None, config)
    # continues a paused/failed workflow from its last checkpoint
    # instead of starting a fresh run.
    async with build_workflow() as workflow:
        result = await workflow.ainvoke(None, config=config)
    if "__interrupt__" in result:
        return _awaiting_approval(
            thread_id,
            result,
            "Workflow paused for plan approval. Show the plan to the "
            "user and call approve_plan with their response.",
        )
    result["thread_id"] = thread_id
    return result


@mcp.tool()
async def approve_plan(thread_id: str, response: str) -> dict:
    """Resume an awaiting workflow with the user's response to the plan.

    Call this ONLY after `implement_feature` (or a prior `approve_plan`)
    returned {"status": "awaiting_approval", "thread_id": ..., "plan": ...}
    and the user has responded to the plan.

    response should be:
      - "yes" → approve the current plan. The workflow proceeds through
        branch creation, implementation (5+ min), QA, and PR. On success
        returns {"status": "succeeded", "pr_url": ..., ...}. On QA failure
        after 3 attempts, returns {"status": "failed", "qa_failures": ...}.
      - Anything else → treated as feedback. The planner regenerates the
        plan incorporating the feedback, and returns ANOTHER
        "awaiting_approval" response. Loop until the user says "yes".

    Loop pattern:
      result = await implement_feature(request)
      while result["status"] == "awaiting_approval":
          # show result["plan"] to user, get their response
          result = await approve_plan(result["thread_id"], response)
      # result["status"] is now "succeeded" or "failed"

    Args:
        thread_id: From the most recent awaiting_approval response.
        response: "yes" to proceed, or feedback text to revise the plan.

    Returns:
        On revision: same awaiting_approval shape (loop again).
        On success: {"status": "succeeded", "branch": str, "pr_url": str, ...}
        On QA exhaustion: {"status": "failed", "qa_failures": str, ...}
    """
    config = {"configurable": {"thread_id": thread_id}}
    async with build_workflow() as workflow:
        result = await workflow.ainvoke(Command(resume=response), config=config)
    if "__interrupt__" in result:
        return _awaiting_approval(
            thread_id,
            result,
            "Plan was revised based on the feedback. Show the new "
            "plan_text to the user and call approve_plan again with their "
            "next response.",
        )
    # Pass the workflow's native status through ("succeeded" or "failed")
    # rather than re-shaping. Phase 15: also inject thread_id so the
    # user has it available in chat for recovery — without this, the id
    # disappears after the first approval cycle and the user can't
    # call resume_run if something fails downstream.
    result["thread_id"] = thread_id
    return result


if __name__ == "__main__":
    mcp.run()
