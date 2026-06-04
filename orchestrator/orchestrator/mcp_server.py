"""MCP server exposing the orchestrator to Claude Code.

Two tools:
  - implement_feature: start a workflow; returns a plan for approval
  - approve_plan:      resume an awaiting workflow with the user's response

The flow is conversational by design. The workflow pauses at plan approval, the
user reviews via Claude Code chat, then approves or revises. Each tool call:
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
from mcp.server.fastmcp import Context, FastMCP

from orchestrator.cancellation import (
    clear_cancelled,
    is_cancelled,
    mark_cancelled,
)
from orchestrator.config import apply_overrides, load_config
from orchestrator.errors import FatalError, RetriableError, UserActionError
from orchestrator.idempotency import reserve as idempotency_reserve
from orchestrator.mcp_progress import run_with_progress
from orchestrator.paths import find_project_root
from orchestrator.run_log import append_run
from orchestrator.workflow import (
    build_workflow,
    IncompatibleCheckpointError,
    IncompatibleManifestError,
)


# AsyncSqliteSaver creates the .db file on demand but not its parent.
# Run once at import (server startup) rather than per-tool-call.
(find_project_root() / ".orchestrator").mkdir(exist_ok=True)

mcp = FastMCP("orchestrator")


def _incompatible_checkpoint(
    thread_id: str, exc: IncompatibleCheckpointError
) -> dict:
    """Shape an IncompatibleCheckpointError into a structured response.

    The workflow body refuses to resume a checkpoint created by a different
    WORKFLOW_VERSION. Surface both versions so the chat can explain why and
    offer "start a fresh implement_feature" as the next step.
    """
    return {
        "status": "incompatible_checkpoint",
        "thread_id": thread_id,
        "stored_version": exc.stored_version,
        "current_version": exc.current_version,
        "next": (
            f"This run was created with workflow v{exc.stored_version}, but the "
            f"current code is v{exc.current_version}. In-flight runs can't be "
            "resumed across an incompatible version change — start a fresh "
            "implement_feature for this work."
        ),
    }


def _incompatible_manifest(
    thread_id: str, exc: IncompatibleManifestError
) -> dict:
    """Shape an IncompatibleManifestError into a structured response.

    The step manifest in orchestrator.toml changed since the run started.
    Surface both hashes so the chat can explain why a resume was refused.
    """
    return {
        "status": "incompatible_manifest",
        "thread_id": thread_id,
        "stored_hash": exc.stored_hash,
        "current_hash": exc.current_hash,
        "next": (
            "The injected-step manifest in orchestrator.toml changed since "
            "this run started, so it can't be resumed. Revert the [steps] "
            "change to resume, or start a fresh implement_feature."
        ),
    }



def _user_action_required(thread_id: str, exc: UserActionError) -> dict:
    """Shape a UserActionError into a structured response.

    The `action` field tells the user exactly what to do before calling
    resume_run. Specific subclasses (CommitAndPrError, DirtyTreeError, etc.)
    are caught by this same handler since they all inherit UserActionError.
    """
    return {
        "status": "user_action_required",
        "thread_id": thread_id,
        "error": str(exc),
        "action": exc.action,
    }


def _retriable_error(thread_id: str, exc: RetriableError) -> dict:
    """Shape a RetriableError into a structured response.

    Transient failures: call resume_run immediately without any manual
    intervention.
    """
    return {
        "status": "retriable_error",
        "thread_id": thread_id,
        "error": str(exc),
        "next": "Transient failure. Call resume_run(thread_id) to retry immediately.",
    }


def _fatal_error(thread_id: str, exc: FatalError) -> dict:
    """Shape a FatalError into a structured response.

    Non-retriable. Fix the root cause and start a fresh implement_feature.
    The specific subclasses IncompatibleCheckpointError and
    IncompatibleManifestError still have their own handlers above so they
    can surface extra structured fields (version numbers, hash values).
    """
    return {
        "status": "fatal",
        "thread_id": thread_id,
        "error": str(exc),
        "next": (
            "This is a non-retriable error. Fix the root cause and start a "
            "fresh implement_feature run."
        ),
    }


def _awaiting_approval(thread_id: str, result: dict, hint: str) -> dict:
    """Shape an interrupt result into the awaiting_approval response.

    The interrupt's value dict is set by orchestrator/workflow.py at the
    interrupt() call site. Plan-approval interrupts carry "plan"; other
    gates (branch/impl/pr approvals, approval_gate steps) carry only
    "kind" and "ask", so `plan` is read defensively.
    """
    interrupt_val = result["__interrupt__"][0].value
    kind = interrupt_val.get("kind")
    # approval_gate steps have their own resume contract: any reply proceeds, the
    # abort words stop the run. Override the (plan-centric) caller hint so the chat
    # surfaces that instead.
    if kind == "step_approval_gate":
        hint = (
            "A pluggable approval_gate step is asking for a decision (see `ask`). "
            "Call approve_plan with this thread_id and the user's reply: "
            "'abort' (or 'no'/'stop') stops the run cleanly; any other reply "
            "proceeds past the gate."
        )
    return {
        "status": "awaiting_approval",
        "thread_id": thread_id,
        "plan": interrupt_val.get("plan"),
        # plan-approval interrupts also carry the decomposed task list so the chat
        # can show plan + tasks together for review. None for other gates.
        "tasks": interrupt_val.get("tasks"),
        "kind": kind,
        "ask": interrupt_val.get("ask"),
        "next": hint,
    }


async def _fetch_existing_state(thread_id: str) -> dict:
    """Return the current state of an existing thread.

    Used when an idempotency_key collides — instead of starting a new
    workflow, peek at the checkpointer for the run already claimed by
    that key and return a response in the same shape the caller would
    get from a fresh implement_feature / approve_plan / resume_run.

    The `replayed: True` marker tells the caller that this is not a
    new run — useful for logging and for avoiding showing the plan
    to the user a second time on a double-click.
    """
    config = {"configurable": {"thread_id": thread_id}}
    async with build_workflow() as workflow:
        snapshot = await workflow.aget_state(config)

    # If the run is paused at an interrupt, its pending tasks carry
    # the interrupt values. Surface the plan exactly like a fresh
    # awaiting_approval would.
    interrupts = []
    for task in snapshot.tasks:
        interrupts.extend(task.interrupts)
    if interrupts:
        interrupt_val = interrupts[0].value
        return {
            "status": "awaiting_approval",
            "thread_id": thread_id,
            "plan": interrupt_val.get("plan"),
            "tasks": interrupt_val.get("tasks"),  # decomposed task list
            "next": (
                "Replayed from idempotency key. Show the plan to the user "
                "and call approve_plan with this thread_id."
            ),
            "replayed": True,
        }

    # Workflow completed (status: succeeded / failed / cancelled).
    # snapshot.values is the entrypoint's return dict.
    if isinstance(snapshot.values, dict) and "status" in snapshot.values:
        result = dict(snapshot.values)
        result["thread_id"] = thread_id
        result["replayed"] = True
        return result

    # Reservation exists but no completed state and no interrupt — the
    # run is mid-task. The caller should poll or call resume_run after
    # whatever they're waiting on has settled.
    return {
        "status": "in_progress",
        "thread_id": thread_id,
        "next": (
            "A run is already underway for this idempotency key. Poll "
            "again later, or call resume_run if you believe the run has "
            "stalled."
        ),
        "replayed": True,
    }


@mcp.tool()
async def implement_feature(
    request: str,
    approve_plan: bool | None = None,
    base_branch: str | None = None,
    idempotency_key: str | None = None,
    ctx: Context | None = None,
) -> dict:
    """Start a feature, fix, or refactor implementation workflow.

    Use this when the user asks to implement, change, or fix something in
    the target repo. Example user intents:
      - "add a tooltip showing what LTV means"
      - "fix the rounding bug in the X calculation"
      - "refactor the modal close handlers"

    The workflow ALWAYS pauses for plan approval before writing any code
    (unless `approve_plan=False` is passed, or `ORCHESTRATOR_APPROVE_PLAN`
    is set in the environment). When it pauses, this tool returns
    {"status": "awaiting_approval", ...} containing the plan and a
    thread_id. You MUST then:
      1. Show the plan's `plan_text` to the user.
      2. Ask whether they approve, or what they want changed.
      3. Call `approve_plan` with the same thread_id and their response.

    Do NOT call this tool again to "retry" — that starts a fresh workflow
    with a new thread_id, losing the user's review context. To revise an
    in-flight plan, send feedback via `approve_plan` instead.

    Idempotency: when `idempotency_key` is provided, the first call with
    that key claims it and runs the workflow as normal. A second call with
    the SAME key (e.g. double-click, retry,
    CI re-run) returns the existing thread's current state — same
    `thread_id`, no new run, with `replayed: True` added so the caller
    can tell. Keys must match `[A-Za-z0-9._-]+` and are ≤128 chars.

    Args:
        request: Natural-language description of what to implement.
        approve_plan: Per-invocation override for the plan-approval gate.
            None = use `orchestrator.toml` / env var. False = skip the
            approval pause and run straight through to PR. True = require
            approval regardless of config.
        base_branch: Per-invocation override for the PR base branch.
        idempotency_key: Optional caller-supplied key. Reusing a key
            returns the existing run instead of starting a new one.

    Returns:
        Awaiting-approval dict (or, if approve_plan was overridden to
        False, the final succeeded/failed dict). When an idempotency
        key replays an existing run, the dict carries `replayed: True`.
    """
    # The idempotency claim happens BEFORE any other side effect (run_log entry,
    # workflow build). If the key collides, return the original run's state without
    # writing anything new.
    if idempotency_key is not None:
        candidate_thread_id = f"run-{uuid4().hex[:8]}"
        existing = idempotency_reserve(idempotency_key, candidate_thread_id)
        if existing is not None:
            return await _fetch_existing_state(existing)
        thread_id = candidate_thread_id
    else:
        thread_id = f"run-{uuid4().hex[:8]}"

    config = {"configurable": {"thread_id": thread_id}}
    append_run(thread_id, request, source="mcp", idempotency_key=idempotency_key)
    effective_config = apply_overrides(
        load_config(),
        approve_plan=approve_plan,
        base_branch=base_branch,
    )
    # Stream via run_with_progress so the MCP client sees per-task progress
    # notifications during the 5+ min runs. ctx is
    # injected by FastMCP; None when called outside the MCP transport
    # (tests, ad-hoc invocations).
    try:
        async with build_workflow(config=effective_config) as workflow:
            result = await run_with_progress(workflow, request, config, ctx)
    except (IncompatibleCheckpointError, IncompatibleManifestError) as exc:
        # These FatalError subclasses get their own handlers for structured fields.
        if isinstance(exc, IncompatibleCheckpointError):
            return _incompatible_checkpoint(thread_id, exc)
        return _incompatible_manifest(thread_id, exc)
    except UserActionError as exc:
        return _user_action_required(thread_id, exc)
    except RetriableError as exc:
        return _retriable_error(thread_id, exc)
    except FatalError as exc:
        return _fatal_error(thread_id, exc)
    if "__interrupt__" in result:
        return _awaiting_approval(
            thread_id,
            result,
            "Show the plan_text to the user. Ask whether they approve or "
            "want changes. Then call approve_plan with this same thread_id "
            "and their response ('yes' to proceed, or feedback to revise).",
        )
    # With approve_plan overridden to False the workflow can complete on
    # the first call — pass the result straight through.
    result["thread_id"] = thread_id
    return result


@mcp.tool()
async def resume_run(
    thread_id: str, force: bool = False, ctx: Context | None = None
) -> dict:
    """Resume a workflow that failed mid-task without restarting it.

    Use this when a previous `implement_feature` or `approve_plan` call
    returned an error (e.g. push failed, gh pr create failed). commit/push/PR
    are three independent @tasks, so the successful steps are cached in the
    checkpointer — only the failed task (and anything downstream) re-runs.

    Use AFTER fixing the underlying issue. Examples:
      - push failed → authenticate gh, restore network, then resume_run
      - gh pr create failed (no remote, no auth) → fix auth, then resume_run
      - commit failed mid-workflow → investigate, may need manual cleanup
        before resume_run

    Do NOT use this to resume a plan-approval interrupt — that's what
    `approve_plan` is for. resume_run is specifically for recovering
    from a task failure.

    If the thread has been marked cancelled via `cancel_run`, resume_run
    refuses with {"status": "refused_cancelled", ...} unless `force=True`
    is passed (which clears the cancel flag first).

    Args:
        thread_id: The thread_id from the prior failed response.
        force: When the thread is cancelled, set True to clear the
            cancel flag and resume anyway. Default False refuses.

    Returns:
        Same shape as approve_plan: another awaiting_approval (rare,
        only if the workflow re-entered the planning loop somehow), a
        succeeded dict with pr_url, or a failed dict. If the thread is
        cancelled and `force` is False, a refused_cancelled dict.
    """
    if is_cancelled(thread_id):
        if not force:
            return {
                "status": "refused_cancelled",
                "thread_id": thread_id,
                "next": (
                    "This run was cancelled via cancel_run. Call resume_run "
                    "again with force=True to clear the cancel flag and resume."
                ),
            }
        clear_cancelled(thread_id)

    config = {"configurable": {"thread_id": thread_id}}
    # The functional API's resume incantation: passing None to
    # the entrypoint continues a paused/failed workflow from its
    # last checkpoint instead of starting a fresh run. We route
    # through run_with_progress so the resumed run streams MCP
    # progress events the same way a fresh run does.
    try:
        async with build_workflow() as workflow:
            result = await run_with_progress(workflow, None, config, ctx)
    except (IncompatibleCheckpointError, IncompatibleManifestError) as exc:
        if isinstance(exc, IncompatibleCheckpointError):
            return _incompatible_checkpoint(thread_id, exc)
        return _incompatible_manifest(thread_id, exc)
    except UserActionError as exc:
        return _user_action_required(thread_id, exc)
    except RetriableError as exc:
        return _retriable_error(thread_id, exc)
    except FatalError as exc:
        return _fatal_error(thread_id, exc)
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
async def cancel_run(thread_id: str) -> dict:
    """Signal cancellation for a running or paused workflow.

    The workflow checks the cancel flag between @task boundaries; the
    task currently executing (if any) completes before cancellation
    takes effect. LLM tokens already spent on the in-flight task are
    NOT refunded — "cancel" means "stop after the current task," not
    "abort instantly."

    Use this when:
      - A run is stuck in a plan-approval loop you no longer want to drive
      - An implementation_task is mid-flight and the request was wrong
      - A QA-retry loop is wasting attempts on something unfixable

    The cancel flag is persisted in `.orchestrator/checkpoints.db`. To
    resume a cancelled thread later, call `resume_run(thread_id,
    force=True)` — that clears the flag and re-enters the workflow.

    Args:
        thread_id: The thread_id of the run to cancel.

    Returns:
        {"status": "cancellation_signalled", "thread_id": thread_id}
    """
    mark_cancelled(thread_id)
    return {
        "status": "cancellation_signalled",
        "thread_id": thread_id,
        "next": (
            "The workflow will exit at the next task boundary. To resume "
            "the run later, call resume_run with force=True."
        ),
    }


@mcp.tool()
async def approve_plan(
    thread_id: str, response: str, ctx: Context | None = None
) -> dict:
    """Resume an awaiting workflow with the user's response to the plan.

    Call this ONLY after `implement_feature` (or a prior `approve_plan`)
    returned {"status": "awaiting_approval", "thread_id": ..., "plan": ...}
    and the user has responded to the plan.

    response should be:
      - "yes" → approve the current plan. The workflow proceeds through
        branch creation, implementation (5+ min), QA, and PR. On success
        returns {"status": "succeeded", "pr_url": ..., ...}. On QA failure
        after 3 attempts, returns {"status": "failed", "qa_failures": ...}.
        If QA passes but the build made no changes, returns
        {"status": "no_changes", "branch": ...} — no commit, no PR.
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
        On an empty build: {"status": "no_changes", "branch": str, ...}
    """
    config = {"configurable": {"thread_id": thread_id}}
    # Stream via run_with_progress. "yes" on approval kicks off the longest
    # section of the workflow (planning → impl → QA → commit → push → PR), so this
    # is the call that benefits most from progress notifications.
    try:
        async with build_workflow() as workflow:
            result = await run_with_progress(
                workflow, Command(resume=response), config, ctx
            )
    except (IncompatibleCheckpointError, IncompatibleManifestError) as exc:
        if isinstance(exc, IncompatibleCheckpointError):
            return _incompatible_checkpoint(thread_id, exc)
        return _incompatible_manifest(thread_id, exc)
    except UserActionError as exc:
        return _user_action_required(thread_id, exc)
    except RetriableError as exc:
        return _retriable_error(thread_id, exc)
    except FatalError as exc:
        return _fatal_error(thread_id, exc)
    if "__interrupt__" in result:
        return _awaiting_approval(
            thread_id,
            result,
            "Plan was revised based on the feedback. Show the new "
            "plan_text to the user and call approve_plan again with their "
            "next response.",
        )
    # Pass the workflow's native status through ("succeeded" or "failed")
    # rather than re-shaping. Also inject thread_id so the user has it
    # available in chat for recovery — without this, the id
    # disappears after the first approval cycle and the user can't
    # call resume_run if something fails downstream.
    result["thread_id"] = thread_id
    return result


if __name__ == "__main__":
    mcp.run()
