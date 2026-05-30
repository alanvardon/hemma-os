"""Generic gate-retry engine (Phase 42, Part A).

A *retry block* is a guarded loop: one or more PRODUCER steps that mutate the
working tree, plus one or more GATE steps that judge it and return pass/fail +
feedback. The engine re-runs the producers — with the failing gate's feedback
injected — until a gate passes or the retry budget is exhausted.

This module is the engine ONLY. It knows nothing about implementation, QA, or
the manifest: producers and gates are supplied as injected async callables, so
the same driver serves both the built-in spine (Part B) and user-declared
blocks in orchestrator.toml (Part C).

`run_retry_block` is a plain async function (not a @task) and is meant to run in
the entrypoint body, because its optional human gates call interrupt(), which
must run there — the same constraint as steps.run_seam.

Invariant carried from Phase 39: **gates fail closed.** A gate must report
`passed` True or False; a gate slot yielding `passed=None` is a configuration
error and raises (it never defaults to a pass).
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable, Literal

from pydantic import BaseModel, Field

from orchestrator.errors import FatalError
from orchestrator.manifest import StepResult


# Resume/abort vocabulary, shared with run_seam's human gates.
_ABORT_WORDS = frozenset({"abort", "no", "stop"})

# Feedback injection (replaces the old mode="fix"). On attempt 1 a producer gets
# no feedback; on a retry the failing gate's detail is rendered under this
# heading for the producer to read and act on.
_FEEDBACK_HEADING = "## Previous attempt feedback"


class RetryConfigError(FatalError):
    """A retry block is mis-wired — e.g. a gate produced no verdict, or
    on_exhausted='human_gate' was requested without an interrupt function."""


class RetryBlock(BaseModel):
    """Runtime spec for one retry block. Part B wires the built-in impl→QA loop
    onto this; Part C maps a declarative orchestrator.toml block onto it."""

    producers: list[str]
    gates: list[str]
    max_retries: int = Field(default=3, ge=1)
    on_exhausted: Literal["abort", "human_gate", "proceed"] = "abort"


class RetryBlockResult(BaseModel):
    ok: bool                          # a gate passed (clean success)
    proceed: bool                     # should the caller continue past the block?
    attempts: int                     # how many producer attempts ran
    last_feedback: str | None = None  # failing gate's detail on abort/exhaust


def feedback_section(detail: str) -> str:
    """The standard feedback block a producer receives on a retry. Consumers
    (Part B/C producers) append this to their user message; the engine passes
    the raw gate detail and lets the producer format it via this helper."""
    return f"{_FEEDBACK_HEADING}\n\n{detail}"


async def run_retry_block(
    *,
    block: RetryBlock,
    run_producer: Callable[[str, str | None], Awaitable[StepResult]],
    run_gate: Callable[[str], Awaitable[StepResult]],
    check_cancel: Callable[[], None] = lambda: None,
    on_producers_done: Callable[[int], Awaitable[None]] | None = None,
    on_gate_failed: Callable[[int, str], Awaitable[bool]] | None = None,
    interrupt_fn: Callable[[dict], Any] | None = None,
) -> RetryBlockResult:
    """Run a retry block to a verdict.

    `run_producer(step_id, feedback)` runs one producer; `feedback` is None on
    the first attempt and the failing gate's detail on retries. `run_gate(step_id)`
    runs one gate and returns a StepResult whose `passed` is True/False.

    Optional per-attempt human gates (injected, so their interrupt() lives in the
    entrypoint):
      - on_producers_done(attempt): a pause after producers, before gates.
      - on_gate_failed(attempt, feedback) -> keep_going: a decision after a gate
        fails; return False to stop the block immediately.

    `interrupt_fn` is used only for on_exhausted="human_gate".

    Returns a RetryBlockResult; `proceed` tells the caller whether to continue
    past the block (e.g. commit) or treat it as a failure.
    """
    feedback: str | None = None

    for attempt in range(1, block.max_retries + 1):
        for pid in block.producers:
            check_cancel()
            await run_producer(pid, feedback)

        if on_producers_done is not None:
            await on_producers_done(attempt)

        for gid in block.gates:  # ordered; the first gate to fail wins
            check_cancel()
            gate_result = await run_gate(gid)
            if gate_result.passed is None:
                raise RetryConfigError(
                    f"gate step {gid!r} returned no verdict (passed is None); "
                    "a gate must report pass/fail"
                )
            if gate_result.passed is False:
                feedback = gate_result.detail
                break
        else:
            # No gate failed → every gate passed.
            return RetryBlockResult(ok=True, proceed=True, attempts=attempt)

        # A gate failed. Optional human decision before spending another attempt.
        if on_gate_failed is not None:
            keep_going = await on_gate_failed(attempt, feedback or "")
            if not keep_going:
                return RetryBlockResult(
                    ok=False, proceed=False, attempts=attempt, last_feedback=feedback
                )

    return _handle_exhausted(block, feedback, interrupt_fn)


def _handle_exhausted(
    block: RetryBlock,
    feedback: str | None,
    interrupt_fn: Callable[[dict], Any] | None,
) -> RetryBlockResult:
    attempts = block.max_retries

    if block.on_exhausted == "proceed":
        return RetryBlockResult(
            ok=False, proceed=True, attempts=attempts, last_feedback=feedback
        )

    if block.on_exhausted == "human_gate":
        if interrupt_fn is None:
            raise RetryConfigError(
                "on_exhausted='human_gate' requires an interrupt function"
            )
        decision = interrupt_fn({
            "kind": "retry_exhausted",
            "attempts": attempts,
            "feedback": feedback,
            "ask": (
                f"Retry budget ({attempts}) exhausted. "
                "Reply 'abort' to stop, anything else to proceed."
            ),
        })
        proceed = not (
            isinstance(decision, str) and decision.strip().lower() in _ABORT_WORDS
        )
        return RetryBlockResult(
            ok=False, proceed=proceed, attempts=attempts, last_feedback=feedback
        )

    # default: "abort" — the caller treats proceed=False as a failed run.
    return RetryBlockResult(
        ok=False, proceed=False, attempts=attempts, last_feedback=feedback
    )
