"""Debug CLI for the orchestrator (Phase 10).

Not the production interface — that's the MCP server (Phase 11). This
exists so you can run the workflow end-to-end from a single shell command
and confirm "is the orchestrator itself broken?" without Claude Code +
MCP indirection layers in the picture.

Run:
    python -m orchestrator.cli "add a console.log to App.recalc"
    # or, via the installed script:
    implement-feature add a console.log to App.recalc

Env vars:
    ORCHESTRATOR_DEBUG=1   show full traceback on failure
    HEARTBEAT_INTERVAL=15  seconds between progress pings (default 15)
"""

import asyncio
import os
import sys
import time
import traceback
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

from langgraph.types import Command

from orchestrator.git_ops import BranchCreationError, CommitAndPrError
from orchestrator.workflow import build_workflow


# Known error types get a friendly message; everything else falls through
# to the generic handler. Add new known errors here as the workflow grows.
_KNOWN_ERRORS: tuple[type[Exception], ...] = (
    BranchCreationError,
    CommitAndPrError,
)

_RULE = "=" * 60


def _format_elapsed(seconds: float) -> str:
    mins, secs = divmod(int(seconds), 60)
    return f"{mins}m {secs}s" if mins else f"{secs}s"


@asynccontextmanager
async def _heartbeat(label: str, interval: float | None = None):
    """Print a progress ping every `interval` seconds while the body runs.

    Implementation_task takes 5+ minutes; without this the user thinks the
    CLI has hung. Cancellation is automatic on exit — even if the body
    raises, the heartbeat task is cancelled in the `finally` block.
    """
    if interval is None:
        interval = float(os.environ.get("HEARTBEAT_INTERVAL", "15"))

    async def beat() -> None:
        start = time.monotonic()
        while True:
            await asyncio.sleep(interval)
            print(
                f"  ... {label} ({_format_elapsed(time.monotonic() - start)} elapsed)",
                file=sys.stderr,
            )

    task = asyncio.create_task(beat())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


def _print_success(result: dict) -> None:
    """Format a successful workflow result with the PR URL prominent."""
    print()
    print(_RULE)
    print("Workflow complete")
    print(_RULE)
    print(f"  Branch: {result['branch']}")
    print(f"  PR:     {result['pr_url']}")
    print(_RULE)


def _print_qa_failure(result: dict) -> None:
    """Format a QA-exhausted workflow result (3 attempts, all FAIL)."""
    print()
    print(_RULE)
    print("Workflow failed after 3 implementation attempts")
    print(_RULE)
    print(f"  Branch: {result['branch']}")
    print("  Last QA failures:")
    for line in (result.get("qa_failures") or "").splitlines():
        print(f"    {line}")
    print(_RULE)
    print(
        "The branch and attempted diffs are in your repo; review and decide "
        "what to do with them."
    )


def _report_failure(thread_id: str, exc: Exception) -> None:
    """Print a human-readable error and exit non-zero.

    ORCHESTRATOR_DEBUG=1 enables full traceback. thread_id is always
    surfaced so the user can resume manually after fixing the root cause.
    """
    if os.environ.get("ORCHESTRATOR_DEBUG"):
        traceback.print_exc()
        print()

    if isinstance(exc, _KNOWN_ERRORS):
        print(f"\nWorkflow failed ({type(exc).__name__}):", file=sys.stderr)
        print(f"  {exc}", file=sys.stderr)
    else:
        print(
            f"\nWorkflow failed with unexpected error "
            f"({type(exc).__name__}): {exc}",
            file=sys.stderr,
        )
        print(
            "  Run with ORCHESTRATOR_DEBUG=1 to see the full traceback.",
            file=sys.stderr,
        )

    print(f"\nthread_id: {thread_id}", file=sys.stderr)
    print(
        "Fix the underlying issue, then resume by re-running with the same "
        "thread_id\n(or start a fresh run — the planning checkpoint is "
        "preserved either way).",
        file=sys.stderr,
    )


async def run() -> None:
    request = " ".join(sys.argv[1:]) or "add a dark mode toggle"
    thread_id = f"cli-{uuid.uuid4().hex[:8]}"
    config = {"configurable": {"thread_id": thread_id}}
    Path(".orchestrator").mkdir(exist_ok=True)

    print(f"thread_id: {thread_id}")
    print(f"request:   {request}")

    try:
        async with build_workflow() as workflow:
            async with _heartbeat("planning"):
                result = await workflow.ainvoke(request, config=config)

            # Phase 8: plan-approval interrupt loop. Each user reply
            # either approves ("yes") or triggers a re-plan with feedback.
            while "__interrupt__" in result:
                interrupt_val = result["__interrupt__"][0].value
                print("\n--- Plan for approval ---")
                print(interrupt_val["plan"]["plan_text"])
                print("\n" + interrupt_val["ask"])
                response = input("> ").strip()
                async with _heartbeat("running workflow"):
                    result = await workflow.ainvoke(
                        Command(resume=response), config=config
                    )

            # Workflow returned without an interrupt. Branch on status.
            status = result.get("status")
            if status == "succeeded":
                _print_success(result)
            elif status == "failed":
                _print_qa_failure(result)
                sys.exit(1)
            else:
                # Unknown shape — dump raw so we at least see something.
                print("\n--- Result ---")
                print(result)
    except Exception as exc:
        _report_failure(thread_id, exc)
        sys.exit(1)


def main() -> None:
    """Sync entrypoint for the `implement-feature` console script."""
    asyncio.run(run())


if __name__ == "__main__":
    main()
