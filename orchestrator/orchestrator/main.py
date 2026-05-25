import asyncio
import os
import sys
import traceback
import uuid
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

from langgraph.types import Command

from orchestrator.git_ops import BranchCreationError, CommitAndPrError
from orchestrator.workflow import build_workflow


# Anything in this tuple gets a friendly one-paragraph error message
# instead of a traceback. Add new known-error types here as the workflow
# grows. Unknown exceptions fall through to the generic handler.
_KNOWN_ERRORS: tuple[type[Exception], ...] = (
    BranchCreationError,
    CommitAndPrError,
)


def _report_failure(thread_id: str, exc: Exception) -> None:
    """Print a human-readable error and exit non-zero.

    Set ORCHESTRATOR_DEBUG=1 in the environment to see the full traceback.
    The thread_id is always surfaced so the user can resume manually with
    Command(resume=...) after fixing the underlying issue.
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
    thread_id = f"demo-{uuid.uuid4().hex[:8]}"
    config = {"configurable": {"thread_id": thread_id}}
    Path(".orchestrator").mkdir(exist_ok=True)

    print(f"thread_id: {thread_id}")

    try:
        async with build_workflow() as workflow:
            result = await workflow.ainvoke(request, config=config)

            # Phase 8: handle plan-approval interrupts. Loop until the
            # user approves ("yes") or the workflow completes without
            # further interrupts.
            while "__interrupt__" in result:
                interrupt_val = result["__interrupt__"][0].value
                print("\n--- Plan for approval ---")
                print(interrupt_val["plan"]["plan_text"])
                print("\n" + interrupt_val["ask"])
                response = input("> ").strip()
                result = await workflow.ainvoke(
                    Command(resume=response), config=config
                )

            print("\n--- Result ---")
            print(result)
    except Exception as exc:
        _report_failure(thread_id, exc)
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(run())
