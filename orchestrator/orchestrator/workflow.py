import asyncio
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

logger = logging.getLogger(__name__)


# Phase 20: workflow body version. Bump on INCOMPATIBLE changes to the
# entrypoint body — reordered/removed tasks, new required tasks, changed
# control flow that a half-finished checkpoint can't safely resume into.
# Pure additive changes (a new optional gate, a new trailing task that
# legacy checkpoints simply haven't reached) don't strictly require a bump.
# On every resume, the version stored at run creation is compared against
# this constant; a mismatch refuses the resume with a clear error instead
# of risking a confusing deserialization failure mid-run.
# 1.0.0 → 1.1.0 (Phase 33): the body gained the manifest-hash gate and five
# run_seam() insertion points, plus new tasks (record_manifest_hash_task and
# the per-step tasks built by _make_script_task / _make_ai_agent_task). That's
# a body change, so the bump makes any checkpoint created before Phase 33
# refuse to resume (clean version error) rather than resume into a changed
# task graph. (Phase 33's later refinements — per-id step task names, after_qa
# firing only on PASS, approval_gate abort — all landed before 1.1.0 shipped, so
# they fold into this same version.)
# 1.1.0 → 1.2.0 (Phase 41): docs_task is now a permanent spine task, inserted
# after the before_commit seam and before commit_task. A new required task in
# the body is a control-flow change, so the bump refuses resume of any run
# created before Phase 41 (clean version error) rather than resuming into a
# task graph that lacks the docs step.
# 1.2.0 → 1.3.0 (Phase 42): the hand-written impl↔QA retry loop is replaced by
# the generic retry engine (retry_block.run_retry_block), implementation is now
# a generic producer @task (no ImplementationResult), and a new summarize_task
# runs after the block to derive the commit/PR summary + test_plan from the diff.
# New/removed task names and changed control flow = a body change, so the bump
# refuses resume of any run created before Phase 42 rather than resuming into a
# shifted task graph.
# 1.3.0 → 1.4.0 (Phase 46): the impl↔QA loop is no longer inline in the body —
# it now runs through run_seam("after_branch") as a declarative `build` step
# (synthesized by default; overridable in orchestrator.toml). The per-attempt
# `after_impl` and pass-only `after_qa` seams are removed (→ after_branch /
# before_commit), and a build that exhausts its budget raises BuildFailed instead
# of returning the failed dict inline. The control-flow reshape is a body change,
# so the bump refuses resume of any run created before Phase 46.
# 1.4.0 → 1.5.0 (Phase 47): the after_branch build is no longer synthesized — it
# is declared explicitly in orchestrator.toml (no _ensure_default_build). A run
# with no after_branch build now reaches the empty-diff guard and returns
# status="no_changes" rather than running an invisible default loop. Removing the
# synthesis step is a body change; the bump refuses resume of any pre-47 run.
# 1.5.0 → 1.6.0 (Phase 48): AiAgentStep's `dir` + `agent` split is merged into a
# single project-root-relative `agent` path. The ai_agent @task signature drops
# its `dir` positional and the step's hashed form changes (no `dir` key), so a
# pre-48 checkpoint would replay a @task with the wrong arity — the bump refuses
# resume of any pre-48 run. (Config-shape change only; no control-flow reshape.)
# 1.6.0 → 1.7.0 (Phase 49): the four positional seams (before_plan / after_plan /
# after_branch / before_commit) collapse into one `[[steps.work]]` list that runs
# between branch and summarize. The before_plan / after_plan / before_commit
# run_seam dispatch points are removed from the body and after_branch is renamed
# to work; before_commit steps now run before summarize (so they're in its diff).
# That control-flow reshape is a body change — the bump refuses resume of any
# pre-49 run.
# 1.7.0 → 1.8.0 (Phase 51): the build's two human pauses move off the global
# [workflow.implementation]/[workflow.qa] human_in_loop flags onto the build
# step's own human_in_loop = { after_producer, on_gate_fail }, handled inside
# _run_build_step; the interrupt kinds rename implementation_approval →
# build_producer_pause and qa_failure → build_gate_failed. The build step's
# hashed form gains a human_in_loop key and the body's interrupt wiring changes,
# so the bump refuses resume of any pre-51 run.
# 1.8.0 → 1.9.0 (Phase 52): the retry-block loop becomes a growable budget — under
# on_exhausted="approval_gate" a human may reply with a count at the exhaustion
# prompt to grant more attempts (optionally capped by retry.max_total_attempts).
# The loop structure changes (fixed range → dynamic while-loop), so the bump
# refuses resume of any pre-52 run.
# 1.9.0 → 1.10.0 (Phase 55): a new decompose_task runs after planning (and re-runs
# on plan-feedback regeneration), turning the plan into an ordered task list; the
# plan_approval interrupt payload gains a `tasks` key. A new required body task +
# a changed interrupt payload shape is a body change, so the bump refuses resume of
# any pre-55 run. The step is execution-inert (nothing consumes the list yet —
# Phase 56), but the task graph still changed, hence the bump.
# 1.10.0 → 1.11.0 (Phase 56): the single impl⇄QA build is replaced by a per-task
# execution station (_run_task_loop) that runs one produce⇄gate build per decomposed
# task, followed by an optional whole-diff final_qa. The work region's task-graph
# shape changes (N per-task builds instead of one, driven by the checkpointed
# decompose result; a new final_qa), so the bump refuses resume of any pre-56 run.
# The task list itself needs no separate hash gate — it's a checkpointed decompose
# result that replays deterministically, and each task's build @tasks replay
# positionally (same "rely on existing guards" reasoning as Phase 42's no-new-hash).
# 1.11.0 unchanged (Phase 58): the entrypoint body was carved into named helpers
# (_gate_checkpoint_and_manifest / _plan_and_approve / _ship / _finalize) with NO
# change to @task names, count, or execution order. Task identity is position-based
# and calling @tasks from module-level helpers is already established (run_seam /
# _run_build_step), so the task graph is byte-for-byte identical — a graph-preserving
# refactor needs no bump (same reasoning as the "pure additive" note at the top).
WORKFLOW_VERSION = "1.11.0"


from orchestrator.errors import FatalError


class IncompatibleCheckpointError(FatalError):
    """Raised on resume when the checkpoint was created by a different
    WORKFLOW_VERSION than the code now attempting to resume it.

    Carries both versions so callers can show a clear message and decide
    whether to abandon the run and start fresh.
    """

    def __init__(self, stored_version: str, current_version: str) -> None:
        self.stored_version = stored_version
        self.current_version = current_version
        super().__init__(
            f"checkpoint was created with workflow v{stored_version}; "
            f"current is v{current_version}. This run cannot be safely "
            f"resumed — start a fresh run."
        )


class IncompatibleManifestError(FatalError):
    """Phase 33: raised on resume when the step manifest in orchestrator.toml
    was edited since the run started. The resolved manifest is snapshotted
    into the first checkpoint; a different hash on resume means the injected
    step graph changed underneath the run, so we refuse rather than resume
    into a shifted graph. Extends Phase 20's version gate with a second hash.
    """

    def __init__(self, stored_hash: str, current_hash: str) -> None:
        self.stored_hash = stored_hash
        self.current_hash = current_hash
        super().__init__(
            f"step manifest changed since this run started "
            f"(snapshot {stored_hash}, current {current_hash}). In-flight "
            f"runs can't absorb a manifest edit — start a fresh run."
        )

# LangGraph's Functional API: @entrypoint marks the top-level workflow
# function, @task marks a checkpointable unit of work. Together they let
# you write a workflow as ordinary async Python and get durability,
# tracing, and resume-on-crash semantics for free.
from langgraph.func import entrypoint, task
from langgraph.types import interrupt

# AsyncSqliteSaver replaces Phase 2's MemorySaver. Same checkpointer API,
# but state is written to a SQLite file on disk — durable across process
# restarts and crashes. The .aio submodule is the async variant; the
# sync variant lives in langgraph.checkpoint.sqlite.
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

# JsonPlusSerializer is the default serde the checkpointer uses to encode
# task inputs/outputs into the SQLite blob columns. We override it below
# with an explicit allowlist of custom types — see _CUSTOM_SERDE.
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer

from langgraph.config import get_config

from orchestrator.agents.decompose import decompose, DecompositionResult
from orchestrator.agents.planning import plan, PlanResult
from orchestrator.agents.qa import qa, QaResult
from orchestrator.agents.summarize import summarize, SummaryResult
from orchestrator.agents.runner import run_structured_agent
from orchestrator.prompt_loader import load_prompt
from orchestrator.retry_block import RetryBlock, feedback_section, run_retry_block
from orchestrator.audit import AuditSink, NoopAuditSink, audited, build_sink, emit_event
from orchestrator.cancellation import WorkflowCancelled, raise_if_cancelled
from orchestrator.config import OrchestratorConfig, load_config
from orchestrator.manifest import (
    ApprovalGateStep,
    AiAgentStep,
    BuildStep,
    ScriptStep,
    StepResult,
    WorkflowManifest,
    load_manifest,
)
from orchestrator.steps import StepError, execute_ai_agent, execute_script
from orchestrator.usage import TaskUsage, aggregate_usage
from orchestrator.git_ops import (
    commit,
    create_branch,
    ensure_on_main,
    pr_create,
    push,
    verify_clean_tree,
    working_tree_has_changes,
    PreHookError,
)
from orchestrator.paths import find_project_root
from orchestrator.pre_hooks import run_pre_hooks
from orchestrator.run_artifacts import (
    rename_with_branch,
    write_decomposition,
    write_plan,
    write_qa,
    write_summary,
    write_usage,
)


# Future LangGraph versions will refuse to deserialize types that aren't
# on this allowlist (the warning today; a hard error tomorrow). Register
# every Pydantic model that flows through a @task so resume keeps working
# across upgrades. Each entry is (module_path, class_name).
_ALLOWED_MSGPACK_MODULES = [
    ("orchestrator.agents.planning", "PlanResult"),
    # Phase 55: the decomposer's task list. `Task` rides inside DecompositionResult,
    # so only the container type needs registering.
    ("orchestrator.agents.decompose", "DecompositionResult"),
    # Phase 42: ImplementationResult is gone — implementation is now a generic
    # producer returning StepResult; SummaryResult (the relocated commit/PR
    # summary + test_plan) takes its slot. QaResult stays (QA is hard-baked).
    ("orchestrator.agents.summarize", "SummaryResult"),
    ("orchestrator.agents.qa", "QaResult"),
    ("orchestrator.usage", "TaskUsage"),
    # Phase 33: one registered type for ALL injected steps, so the allowlist
    # stays closed however many steps users add.
    ("orchestrator.manifest", "StepResult"),
]

_CUSTOM_SERDE = JsonPlusSerializer(
    allowed_msgpack_modules=_ALLOWED_MSGPACK_MODULES,
)


# @task wraps an async function so LangGraph can:
#   - record its inputs and outputs to the checkpointer
#   - skip re-running it on resume if its inputs haven't changed
#   - surface it as a span in the LangSmith trace tree
# @task knows nothing about which checkpointer is in use — that's
# configured on the @entrypoint below.
# Phase 20: the version gate's storage mechanism. This task records the
# WORKFLOW_VERSION current at the moment a run is first created. Because
# @task results are checkpointed and replayed (not recomputed) on resume,
# calling it at the top of the body returns:
#   - on the first run: the live WORKFLOW_VERSION (and persists it)
#   - on every resume:   the CACHED value — the version that created the run
# That cached value is exactly "what version of the workflow created this
# checkpoint", which LangGraph doesn't expose natively (see the landmine in
# phase_20_schema_versioning.md). The body compares it against the live
# constant and refuses the resume on mismatch.
#
# Adding this as a new task is safe for checkpoints created before Phase 20:
# @task cache keys are per-function-name, so inserting a new name doesn't
# shift the keys of existing tasks. A legacy checkpoint simply runs this
# task fresh on resume (returning the live version → no false mismatch).
@task
async def record_version_task() -> str:
    return WORKFLOW_VERSION


# Phase 33: manifest snapshot. Mirrors record_version_task EXACTLY — takes no
# input and recomputes the hash itself, so its checkpointed value is
# unambiguously "the manifest hash at run-creation time" with nothing that
# could look input-dependent. Returns the live hash on the first run (and
# persists it), the cached creation-time hash on every resume. The body
# compares it against the freshly-loaded manifest and refuses the resume if
# orchestrator.toml's steps changed mid-run.
@task
async def record_manifest_hash_task() -> str:
    return load_manifest().manifest_hash()


# Phase 33: per-step task factories. Each injected step is wrapped in a @task
# NAMED for its step id (`step:<id>`) — so it appears under its own id in the
# LangSmith trace tree and gets its own checkpoint identity, instead of every
# script (or every ai_agent) step collapsing onto one shared task name.
#
# A fresh wrapper is built per call on purpose. LangGraph derives a task's
# identity from its NAME plus its call position in the entrypoint body — not
# from the function object or its inputs — so a freshly-built, deterministically
# named task replays correctly on resume. (It also sidesteps task()'s mutation
# of func.__name__: each wrapper closes over its own fresh function, so names
# never clobber each other.) Step inputs are primitives, not Pydantic Step
# models, so the serde allowlist needs only StepResult.
#
# `attempt` is carried purely for context (it tags the trace inputs and the
# approval_gate payload); per-attempt distinctness comes from call position, not
# from this value.
def _make_script_task(step_id: str, *, as_gate: bool = False):
    async def run_script_step(
        step_id: str, path: str, timeout: int, repo_root: str, attempt: int = 0
    ) -> StepResult:
        return await execute_script(
            ScriptStep(id=step_id, path=path, timeout=timeout),
            Path(repo_root),
            as_gate=as_gate,
        )

    return task(run_script_step, name=f"step:{step_id}")


def _make_ai_agent_task(step_id: str, *, as_gate: bool = False):
    async def run_ai_agent_step(
        step_id: str,
        agent: str,
        model: str,
        repo_root: str,
        plan_text: str,
        attempt: int = 0,
        feedback: str | None = None,
    ) -> StepResult:
        return await execute_ai_agent(
            AiAgentStep(id=step_id, agent=agent, model=model),
            Path(repo_root),
            plan_text,
            feedback=feedback,
            as_gate=as_gate,
        )

    return task(run_ai_agent_step, name=f"step:{step_id}")


class StepGateAborted(RuntimeError):
    """Phase 33: raised when a human pause is resumed with an abort decision
    ('abort'/'no'/'stop') — an approval_gate step, or a human_in_loop review
    pause on an ai_agent step / retry-block producer (Phase 44). Propagates out
    of run_seam to the entrypoint body, which converts it into a clean
    status="aborted" return. All seams run before the commit line, so an abort
    never leaves a half-shipped state.
    """

    def __init__(self, step_id: str) -> None:
        self.step_id = step_id
        super().__init__(f"workflow aborted at step {step_id!r}")


class BuildFailed(RuntimeError):
    """Phase 46: a `build` step ran its full retry budget without a passing gate
    under on_exhausted="abort" (or a human declined to keep retrying). Carries
    the failing gate's last feedback so the entrypoint body can return the clean
    status="failed" dict (preserving the pre-46 contract: a QA-exhausted run ends
    `failed` with `qa_failures`, never a raw exception). Build steps are
    pre-commit, so nothing is half-shipped.
    """

    def __init__(self, step_id: str, attempts: int, last_feedback: str | None) -> None:
        self.step_id = step_id
        self.attempts = attempts
        self.last_feedback = last_feedback
        super().__init__(
            f"build step {step_id!r} did not pass its gate(s) after "
            f"{attempts} attempt(s)"
        )


# Resume values (case-insensitive) that mean "stop the run" at an approval_gate.
# Anything else proceeds — replying to a gate is how you resume past it.
_GATE_ABORT_WORDS = frozenset({"abort", "no", "stop"})


def _is_abort(decision) -> bool:
    """True if a human's resume value at a gate/pause is an abort word.

    Phase 60: the single home for the abort decision check that every interrupt
    site (approval_gate, ai_agent review, build producer/gate pauses, retry review)
    used to inline. A non-string decision (or any non-abort word) is not an abort —
    the run proceeds."""
    return isinstance(decision, str) and decision.strip().lower() in _GATE_ABORT_WORDS


def _record_usage(usage_by_task: dict, key: str, result) -> None:
    """Append `result`'s token usage under `key`, if it has any (Phase 60).

    The single home for the `if result.usage: usage_by_task[...].append(...)` pair
    that every agent step inlined. setdefault covers both the pre-seeded spine keys
    (planning/qa/...) and dynamic step ids; a result with no usage is a no-op."""
    if result.usage:
        usage_by_task.setdefault(key, []).append(result.usage)


class AutonomousCeilingExceeded(WorkflowCancelled):
    """Phase 37: a fully-autonomous run hit its time or cost safety ceiling.

    Subclasses WorkflowCancelled so it stops the run through the SAME between-task
    path as a user cancel — but carries a `reason` the entrypoint surfaces so a
    caller can tell a budget trip from a human `cancel_run`. No cancel marker is
    written (unlike cancel_run), so the thread can still be resumed with a larger
    budget."""

    def __init__(self, thread_id: str, reason: str):
        super().__init__(thread_id)
        self.reason = reason


async def run_seam(
    seam: str,
    manifest: WorkflowManifest,
    plan_text: str,
    check_cancel,
    usage_by_task: dict,
    attempt: int = 0,
    *,
    builtin_producers: dict | None = None,
    builtin_gates: dict | None = None,
    thread_id: str | None = None,
    audit=None,
    autonomous: bool = False,
) -> None:
    """Run every injected step at `seam`, in declared order.

    A plain async helper (not a @task) so a pause — an approval_gate step, or an
    ai_agent step with human_in_loop — can call interrupt(), which must run in
    the entrypoint body. Script and ai_agent steps dispatch to their @tasks
    (checkpointed); an ai_agent's review pause fires after its @task returns, so
    resume replays the cached result rather than re-running the agent. Cancel is
    checked before each step (between-step semantics, inherited from the spine).
    Each ai_agent step's usage is accumulated under its own `id`.

    Phase 46: a `build` step at this seam dispatches to _run_build_step.
    `builtin_producers`/`builtin_gates` are the spine's own implementation/QA
    callables, injected so a build can reference the built-in `implementation`
    producer / `qa` gate without a [steps.defs.*] entry. `thread_id`/`audit` are
    forwarded so a build's per-step human_in_loop pauses (Phase 51) can emit
    interrupt audit events.
    """
    steps = manifest.for_seam(seam)
    if not steps:
        return
    repo_root = str(find_project_root())
    for step in steps:
        check_cancel()
        if isinstance(step, ApprovalGateStep):
            # Phase 37: in autonomous mode an approval_gate has no one to answer
            # it, so auto-proceed (treat as approved) rather than deadlock. The
            # bypass is recorded so it's visible in the audit trail.
            if autonomous:
                if audit is not None and thread_id is not None:
                    emit_event(audit, thread_id, "auto_approved",
                               payload={"kind": "step_approval_gate", "step_id": step.id})
                continue
            # A human checkpoint. The resume value decides: an abort word
            # ('abort'/'no'/'stop') stops the run cleanly via StepGateAborted;
            # anything else (including 'yes' or empty) proceeds — replying is
            # how you resume past the gate.
            decision = interrupt({
                "kind": "step_approval_gate",
                "step_id": step.id,
                "ask": step.ask,
                "attempt": attempt,
            })
            if _is_abort(decision):
                raise StepGateAborted(step.id)
            continue
        if isinstance(step, ScriptStep):
            step_task = _make_script_task(step.id)
            await step_task(step.id, step.path, step.timeout, repo_root, attempt)
        elif isinstance(step, AiAgentStep):
            step_task = _make_ai_agent_task(step.id)
            result = await step_task(
                step.id, step.agent, step.model, repo_root, plan_text, attempt
            )
            _record_usage(usage_by_task, step.id, result)
            if step.human_in_loop and not autonomous:
                # Pause AFTER the agent ran (its @task output is checkpointed, so
                # resume replays it instead of re-running) to let a human review
                # the result. Same abort contract as an approval_gate step.
                # Phase 37: skipped entirely in autonomous mode.
                decision = interrupt({
                    "kind": "step_ai_agent_review",
                    "step_id": step.id,
                    "detail": result.detail,
                    "attempt": attempt,
                })
                if _is_abort(decision):
                    raise StepGateAborted(step.id)
        elif isinstance(step, BuildStep):
            # Phase 46: a declarative build step. Runs on the SAME generic engine
            # the built-in spine uses, with producers and gates resolved from
            # manifest.defs (or the injected built-ins).
            await _run_build_step(
                step, manifest, plan_text, check_cancel, usage_by_task,
                builtin_producers=builtin_producers,
                builtin_gates=builtin_gates,
                thread_id=thread_id,
                audit=audit,
                autonomous=autonomous,
            )


async def _run_build_step(
    block_step: BuildStep,
    manifest: WorkflowManifest,
    plan_text: str,
    check_cancel,
    usage_by_task: dict,
    *,
    builtin_producers: dict | None = None,
    builtin_gates: dict | None = None,
    thread_id: str | None = None,
    audit=None,
    autonomous: bool = False,
) -> None:
    """Execute a declarative [[steps.*]] type="build" step (Phase 46).

    Wraps the generic engine (retry_block.run_retry_block). Producer/gate ids
    resolve in order: a [steps.defs.*] entry (run via the SAME @task factories
    run_seam uses, so they inherit checkpoint/replay) → else an injected built-in
    callable (`builtin_producers`/`builtin_gates`: the spine's own implementation
    producer / QA gate) → else an unknown-reference error. A gate's verdict is its
    StepResult.passed (script: exit code; ai_agent: the emitted `passed`); on a
    retry, the failing gate's feedback is injected into producer ai_agents.

    Phase 51: the two human pauses are driven by THIS build step's
    `human_in_loop` config (not global flags), so they work for any producer/gate:
    `after_producer` pauses after the producers, before the gates, every attempt
    (kind `build_producer_pause`); `on_gate_fail` pauses on a failing gate (kind
    `build_gate_failed`) where an abort word stops the run and anything else
    retries. Phase 52: under on_exhausted="approval_gate" the exhaustion prompt
    also accepts a count — a human may grant more attempts (bounded by the optional
    retry.max_total_attempts) and the loop keeps going. A non-proceed outcome (gate
    never passed under on_exhausted="abort", or a human aborted) raises BuildFailed,
    which the entrypoint body turns into
    the clean status="failed" return — seams are pre-commit, so nothing is
    half-shipped. Phase 44: if the block succeeds and a producer ai_agent set
    human_in_loop, pause once for review of its final output. interrupt() (for
    on_exhausted="approval_gate", the gate-fail pause, and the success review) is
    reachable because this helper, like run_seam, runs in the entrypoint body.
    """
    repo_root = str(find_project_root())
    defs = manifest.defs
    builtin_producers = builtin_producers or {}
    builtin_gates = builtin_gates or {}
    hil = block_step.human_in_loop

    async def on_producers_done(attempt: int) -> None:
        # Phase 51: optional pause after the producer(s), before the gate(s),
        # every attempt — driven by this build's human_in_loop.after_producer
        # (the generic replacement for the old implementation_approval).
        # Phase 37: suppressed in autonomous mode.
        if hil.after_producer and not autonomous:
            if audit is not None and thread_id is not None:
                emit_event(audit, thread_id, "interrupt",
                           payload={"kind": "build_producer_pause", "step_id": block_step.id})
            interrupt({
                "kind": "build_producer_pause",
                "step_id": block_step.id,
                "ask": "Producer complete. Proceed to the gate?",
                "attempt": attempt,
            })

    async def on_gate_failed(attempt: int, feedback: str) -> bool:
        # Always log a gate failure (scripted gates and LLM gates alike) so it's
        # visible in the log; the retry budget lives on the build's retry.max, so
        # the message reports the attempt number without a total.
        logger.error(
            "gate FAIL (attempt %d):\n%s",
            attempt,
            feedback or "(no failure details)",
        )
        # Phase 51: optional pause on a gate failure — driven by this build's
        # human_in_loop.on_gate_fail (the generic replacement for the old
        # qa_failure). An abort word stops the run; anything else retries.
        # Phase 37: suppressed in autonomous mode (the loop just retries).
        if hil.on_gate_fail and not autonomous:
            if audit is not None and thread_id is not None:
                emit_event(audit, thread_id, "interrupt",
                           payload={"kind": "build_gate_failed", "step_id": block_step.id})
            decision = interrupt({
                "kind": "build_gate_failed",
                "step_id": block_step.id,
                "failures": feedback,
                "ask": (
                    f"Gate FAIL (attempt {attempt}). "
                    "Retry? Reply 'yes' or 'abort'."
                ),
            })
            if _is_abort(decision):
                return False  # stop now; don't spend another attempt
        return True
    # Final result of each producer, so a human_in_loop producer's gate-passing
    # output can be surfaced for review once the block succeeds (Phase 44). On
    # resume the producer @tasks replay from checkpoint and repopulate this.
    last_producer_result: dict[str, StepResult] = {}

    async def run_producer(pid: str, feedback: str | None) -> StepResult:
        if pid not in defs:
            if pid in builtin_producers:
                result = await builtin_producers[pid](pid, feedback)
                last_producer_result[pid] = result
                return result
            raise StepError(
                f"build step {block_step.id!r}: producer {pid!r} has no "
                f"[steps.defs.*] entry and is not a built-in producer."
            )
        d = defs[pid]
        if isinstance(d, ScriptStep):
            step_task = _make_script_task(d.id)
            result = await step_task(d.id, d.path, d.timeout, repo_root)
        else:  # AiAgentStep — feedback is injected into its user message
            step_task = _make_ai_agent_task(d.id)
            result = await step_task(
                d.id, d.agent, d.model, repo_root, plan_text, 0, feedback
            )
        _record_usage(usage_by_task, d.id, result)
        last_producer_result[pid] = result
        return result

    async def run_gate(gid: str) -> StepResult:
        if gid not in defs:
            if gid in builtin_gates:
                return await builtin_gates[gid](gid)
            raise StepError(
                f"build step {block_step.id!r}: gate {gid!r} has no "
                f"[steps.defs.*] entry and is not a built-in gate."
            )
        d = defs[gid]
        if isinstance(d, ScriptStep):
            step_task = _make_script_task(d.id, as_gate=True)
            result = await step_task(d.id, d.path, d.timeout, repo_root)
        else:  # AiAgentStep gate — emits a `passed` verdict, runs read-only
            step_task = _make_ai_agent_task(d.id, as_gate=True)
            result = await step_task(d.id, d.agent, d.model, repo_root, plan_text)
        _record_usage(usage_by_task, d.id, result)
        return result

    block = RetryBlock(
        producers=block_step.produce,
        gates=block_step.gate,
        max_retries=block_step.retry.max,
        on_exhausted=block_step.retry.on_exhausted,
        max_total_attempts=block_step.retry.max_total_attempts,
    )
    result = await run_retry_block(
        block=block,
        run_producer=run_producer,
        run_gate=run_gate,
        check_cancel=check_cancel,
        on_producers_done=on_producers_done,
        on_gate_failed=on_gate_failed,
        interrupt_fn=interrupt,  # used only when on_exhausted="approval_gate"
        autonomous=autonomous,   # Phase 37: unbounded budget; loop until a gate passes
    )
    if not result.proceed:
        raise BuildFailed(block_step.id, result.attempts, result.last_feedback)

    # Phase 44: pause ONCE after the block SUCCEEDS (result.ok — a real gate
    # pass, whether first try or after retries) if any producer ai_agent opted
    # into human_in_loop, so a human can review the final, gate-passing output.
    # Intermediate failed attempts never pause; nor does an exhausted-but-proceed
    # block (result.ok is False there — on_exhausted governs that path). The flag
    # is honoured on producers only; a gate is a read-only judge run every
    # attempt, so its human_in_loop is ignored.
    if result.ok and not autonomous:  # Phase 37: no review pause in autonomous mode
        reviewed = [
            pid
            for pid in block_step.produce
            if pid in defs
            and isinstance(defs[pid], AiAgentStep)
            and defs[pid].human_in_loop
        ]
        if reviewed:
            detail = "\n\n".join(
                f"[{pid}] {last_producer_result[pid].detail}".rstrip()
                for pid in reviewed
                if pid in last_producer_result
            )
            decision = interrupt({
                "kind": "step_retry_review",
                "step_id": block_step.id,
                "producers": reviewed,
                "detail": detail,
                "attempts": result.attempts,
            })
            if _is_abort(decision):
                raise StepGateAborted(block_step.id)


# ---------------------------------------------------------------------------
# Phase 56: the per-task execution station (Option B).
# Loops the FROZEN task list from the decomposer (Phase 55) and runs each task as
# a produce⇄gate build via the SAME engine the spine used before — _run_build_step
# / run_retry_block — with the [workflow.task_build] recipe. This REPLACES the
# single hard-baked impl⇄QA build as the spine's implementation mechanism.
#
# Two nested loops: the OUTER per-task loop here (new), wrapping the INNER
# per-attempt retry inside each task's build (unchanged engine). The task list is
# a checkpointed decompose_task result, so it replays deterministically on resume;
# each task's build @tasks replay positionally — no separate task-list hash gate is
# needed (same "rely on existing guards" reasoning as Phase 42's no-new-hash note).
# ---------------------------------------------------------------------------


def _compose_task_plan(plan_text: str, task) -> str:
    """The producer's plan text for one task: the overall plan + THIS task's slice.
    The agent reads the working tree itself for cumulative state, so the diff is
    implicit; only the task focus is injected here."""
    parts = [plan_text, "", f"## Current task: {task.title}", "", task.description]
    if task.acceptance_criteria:
        parts += ["", f"Acceptance criteria: {task.acceptance_criteria}"]
    return "\n".join(parts)


def _compose_task_qa(plan_text: str, task) -> str:
    """The QA gate's plan text for one task: judge ONLY this task. The diff may
    include earlier completed tasks, so the note tells QA not to fail the review
    for unrelated prior changes (the whole-diff acceptance is the optional
    final_qa pass)."""
    parts = [plan_text, "", f"## Evaluate ONLY this task: {task.title}", "", task.description]
    if task.acceptance_criteria:
        parts += ["", f"Acceptance criteria: {task.acceptance_criteria}"]
    parts += [
        "",
        "Note: the diff may also include earlier, already-completed tasks. Judge "
        "ONLY whether the task above is correctly implemented; do not fail the "
        "review for unrelated changes from earlier tasks.",
    ]
    return "\n".join(parts)


async def _run_task_loop(
    decomposition,
    manifest,
    plan_result,
    config,
    check_cancel,
    usage_by_task: dict,
    qa_holder: dict,
    *,
    thread_id: str,
    audit,
    autonomous: bool = False,
) -> None:
    """Run the decomposed task list, one produce⇄gate build per task (Phase 56).

    Each task reuses _run_build_step with a synthetic BuildStep built from
    [workflow.task_build], so per-task retry/feedback (Phase 42), human pauses
    (Phase 51), and the growable budget (Phase 52) all come for free. The built-in
    `implementation` producer / `qa` gate are made task-aware by composing this
    task's context into the plan text. A task that exhausts its budget raises
    BuildFailed(step_id="task:<id>") → the entrypoint's clean status="failed".
    Runs in the entrypoint body so its interrupt()s are reachable."""
    tb = config.workflow.task_build
    for task in decomposition.tasks:
        impl_plan = _compose_task_plan(plan_result.plan_text, task)
        qa_plan = PlanResult(
            title=plan_result.title,
            type=plan_result.type,
            plan_text=_compose_task_qa(plan_result.plan_text, task),
        )

        async def _impl(step_id: str, feedback: str | None, _p: str = impl_plan) -> StepResult:
            async with audited(audit, thread_id, "implementation"):
                result = await implementation_task(
                    _p, feedback, config.resolved_model(config.workflow.implementation)
                )
            _record_usage(usage_by_task, "implementation", result)
            return result

        async def _qa(step_id: str, _qp: PlanResult = qa_plan) -> StepResult:
            async with audited(audit, thread_id, "qa"):
                qa_result = await qa_task(_qp, config.resolved_model(config.workflow.qa))
            _record_usage(usage_by_task, "qa", qa_result)
            write_qa(thread_id, qa_result)
            qa_holder["qa"] = qa_result
            return StepResult(
                step_id="qa",
                kind="ai_agent",
                ok=True,
                passed=(qa_result.result == "PASS"),
                detail=qa_result.failures or "",
            )

        synthetic = BuildStep(
            id=f"task:{task.id}",
            produce=tb.produce,
            gate=tb.gate,
            ungated=not tb.gate,  # gate=[] → producer runs once (rely on final_qa)
            retry=tb.retry,
            human_in_loop=tb.human_in_loop,
        )
        await _run_build_step(
            synthetic, manifest, impl_plan, check_cancel, usage_by_task,
            builtin_producers={"implementation": _impl},
            builtin_gates={"qa": _qa},
            thread_id=thread_id,
            audit=audit,
            autonomous=autonomous,
        )


async def _run_final_qa(
    config,
    manifest,
    plan_result,
    check_cancel,
    usage_by_task: dict,
    qa_holder: dict,
    *,
    thread_id: str,
    audit,
) -> None:
    """Phase 56: optional single whole-diff acceptance check after all tasks pass.

    Default no-op ([workflow.final_qa].gate is empty — QA runs per-task). When
    configured, runs each gate over the WHOLE diff: the built-in `qa` (judged
    against the overall plan) or a [steps.defs.*] script/agent gate. A FAIL raises
    BuildFailed(step_id="final_qa") → the clean status="failed" return (no PR)."""
    gates = config.workflow.final_qa.gate
    if not gates:
        return
    repo_root = str(find_project_root())
    for gid in gates:
        check_cancel()
        if gid == "qa" and gid not in manifest.defs:
            async with audited(audit, thread_id, "qa"):
                qa_result = await qa_task(plan_result, config.resolved_model(config.workflow.qa))
            _record_usage(usage_by_task, "qa", qa_result)
            write_qa(thread_id, qa_result)
            qa_holder["qa"] = qa_result
            passed, detail = (qa_result.result == "PASS"), (qa_result.failures or "")
        else:
            d = manifest.defs.get(gid)
            if d is None:
                raise StepError(
                    f"final_qa gate {gid!r} has no [steps.defs.*] entry and is "
                    f"not the built-in 'qa'"
                )
            if isinstance(d, ScriptStep):
                res = await _make_script_task(d.id, as_gate=True)(d.id, d.path, d.timeout, repo_root)
            else:
                res = await _make_ai_agent_task(d.id, as_gate=True)(
                    d.id, d.agent, d.model, repo_root, plan_result.plan_text
                )
            _record_usage(usage_by_task, d.id, res)
            passed, detail = (res.passed is True), res.detail
        if not passed:
            raise BuildFailed("final_qa", 1, detail)


@task
async def planning_task(request: str, model: str) -> PlanResult:
    # Phase 59: `model` is required — every caller resolves it via
    # config.resolved_model(...), so a default here would be dead and a drift trap.
    return await plan(request, model=model)


# Phase 55: the decomposer. Runs after planning (and again after each plan-feedback
# regeneration), turning the approved plan into an ordered task list. Its
# DecompositionResult is checkpointed (on the serde allowlist), so a re-execution of
# the entrypoint body after the plan-approval interrupt replays it for free. The
# step is EXECUTION-INERT in Phase 55 — the list is surfaced for review and written
# to the run folder, but nothing drives work off it yet (Phase 56 adds that loop).
@task
async def decompose_task(
    plan_text: str, model: str, max_tasks: int = 0
) -> DecompositionResult:
    # Phase 59: `model` required (resolved by the caller); see planning_task.
    return await decompose(plan_text, model, max_tasks)


# Pre-flight check. Runs FIRST in the workflow — before planning — so a
# dirty working tree fails fast with zero LLM cost and no wasted approval
# round. Defence in depth: create_branch_task also calls verify_clean_tree
# internally, since the tree could be dirtied between approval and branch
# creation (the user has time to make edits during plan review).
#
# Phase 29: after the tree check, run any user-defined pre-hook scripts
# from `.orchestrator/pre-hooks/` (configurable). A non-zero exit from
# any script raises PreHookError, which propagates out of the task and
# aborts the workflow — same pattern as DirtyTreeError from
# verify_clean_tree. The hook's stdout becomes the displayed abort reason.
@task
async def verify_clean_tree_task() -> None:
    await asyncio.to_thread(verify_clean_tree)
    _cfg = load_config()
    await asyncio.to_thread(ensure_on_main, _cfg.pr.base_branch)
    await asyncio.to_thread(run_pre_hooks, _cfg.pre_hooks.dir, _cfg.pre_hooks.timeout)


# Deterministic git task (Phase 6a). Wraps the synchronous create_branch
# function with asyncio.to_thread so it doesn't block the event loop —
# subprocess.run is blocking, and even fast git commands shouldn't stall
# the loop. The @task wrapper means a successful branch creation is
# checkpointed: on resume, we don't re-run git checkout, we read the
# branch name back from the checkpoint and move on.
@task
async def create_branch_task(
    plan_result: PlanResult, max_slug_length: int = 50, thread_id: str = ""
) -> str:
    return await asyncio.to_thread(create_branch, plan_result, max_slug_length, thread_id)


# Phase 6b / Phase 42. Runs the implementation agent (Claude Agent SDK in a
# loop) to edit files according to the plan. It is now a GENERIC retry-block
# producer: it emits a plain StepResult (its `detail` is ignored downstream),
# and the commit/PR summary + test_plan are produced separately by
# summarize_task. The old implement()/ImplementationResult and the
# implement/"fix" mode switch are gone — on a retry the failing gate's feedback
# arrives via `feedback`, appended to the user message under a standard heading
# (feedback_section). Implementation is the most expensive task by far (minutes
# of LLM time, real file edits), so the @task wrapper's resume-skip is the
# single biggest cost win the checkpointer gives us.
async def _run_implementation_producer(
    plan_text: str, feedback: str | None, model: str
) -> StepResult:
    """The implementation agent invocation, factored out of implementation_task.

    Keeping it separate lets the @task wrapper stay a pure checkpoint boundary:
    on resume the @task replays its cached StepResult and this expensive agent
    call is skipped. (It is also the seam tests fake when they resume mid-loop,
    so the real @task's replay semantics stay under test — the same role the old
    implement() played before Phase 42.)
    """
    _impl = load_config().workflow.implementation  # Phase 40: [workflow.implementation]
    parts = ["## Plan", "", plan_text]
    if feedback:
        # Phase 42: replaces mode="fix" + qa_failures. The producer formats the
        # raw gate detail via the engine's standard helper.
        parts += ["", feedback_section(feedback)]
    return await run_structured_agent(
        system_prompt=load_prompt("implementation"),
        user_message="\n".join(parts),
        model=model,
        # File-editing tools from [workflow.implementation]. No Git, no commit,
        # no PR tools — the orchestrator owns those entirely.
        allowed_tools=_impl.allowed_tools,
        disallowed_tools=_impl.disallowed_tools,
        # cwd must be the target repo root — the agent edits files there.
        cwd=find_project_root(),
        timeout=_impl.timeout,
        emit_tool_name="emit_step_result",
        emit_tool_description=(
            "Emit the final result of this step. Call exactly once when the work "
            "is complete, with a one-line `summary` of what you changed. After "
            "calling, stop — the orchestrator takes over."
        ),
        emit_tool_fields={"summary": str},
        result_factory=lambda c, u: StepResult(
            step_id="implementation",
            kind="ai_agent",
            ok=True,
            detail=c.get("summary", "") or "",
            usage=u,
        ),
    )


@task
async def implementation_task(
    plan_text: str,
    feedback: str | None,
    model: str,
) -> StepResult:
    # Phase 59: `model` required (resolved by the caller). `feedback` also loses its
    # default — both call sites pass it positionally — so a required `model` can
    # follow it without a "non-default arg after default arg" error.
    return await _run_implementation_producer(plan_text, feedback, model)


# Phase 6c. Read-only LLM task: the QA agent reviews the uncommitted
# diff against the approved plan and emits a PASS/FAIL verdict. No file
# edits, no git operations. The QaResult feeds into Phase 7's retry
# loop — on FAIL the orchestrator will call implementation_task again
# in "fix" mode with the failure text. For now (linear chain, no
# retries yet) we just record the verdict in the workflow result.
@task
async def qa_task(
    plan_result: PlanResult, model: str
) -> QaResult:
    # Phase 59: `model` required (resolved by the caller); see planning_task.
    return await qa(plan_result, model=model)


# Phase 42: the summarizer. Runs ONCE after the impl→QA retry block passes,
# before commit. Reads the plan + `git diff HEAD` and emits the commit/PR
# summary + test_plan — the structured output that used to live on
# ImplementationResult, relocated to a read-only post-loop @task so the
# implementation producer could become generic. Its SummaryResult is
# checkpointed (on the serde allowlist), so a crash before commit replays it.
@task
async def summarize_task(
    plan_text: str, model: str
) -> SummaryResult:
    # Phase 59: `model` required (resolved by the caller); see planning_task.
    return await summarize(plan_text, model)


# Phase 41: documentation agent, a permanent spine task. Runs once after
# summarize, before commit — on the final, QA-passed code — so any doc edits
# land in the same commit. (Phase 49: pre-commit work is now the tail of the
# `work` list, which runs before summarize.) The
# prompt ships in the package (orchestrator/prompts/docs.md, tracked by git)
# and is loaded via load_prompt — the same loader as planning/implementation/qa,
# so it inherits the .orchestrator/prompts/ override path — rather than from
# .orchestrator/agents/ (gitignored), so a spine step never depends on a
# local-only file. Built directly on Phase 39's run_structured_agent.
@task
async def docs_task(
    plan_text: str, model: str
) -> StepResult:
    # Phase 59: `model` required (resolved by the caller); see planning_task.
    """Run the documentation agent against the QA-passed working tree.

    A @task like every other spine step: its StepResult is checkpointed, so a
    crash between docs and commit replays the docs result on resume (no LLM
    re-call). The package prompt is the system prompt; the agent reads
    `git diff HEAD` itself and edits ONLY documentation (.md) — it never edits
    source, including the workflow that orchestrates it. Returns a StepResult
    (already on the serde allowlist)."""
    return await run_structured_agent(
        system_prompt=load_prompt("docs"),
        user_message="\n".join(["## Plan", "", plan_text]),
        model=model,
        allowed_tools=["Read", "Edit", "Write", "Bash", "Grep"],
        disallowed_tools=[],
        cwd=find_project_root(),
        timeout=load_config().workflow.docs.timeout,
        emit_tool_name="emit_step_result",
        emit_tool_description=(
            "Emit the final result of this step. Call exactly once when done, "
            "with a one-line `summary` of what you did. After calling, stop."
        ),
        emit_tool_fields={"summary": str},
        result_factory=lambda c, u: StepResult(
            step_id="docs",
            kind="ai_agent",
            ok=True,
            detail=c.get("summary", "") or "",
            usage=u,
        ),
    )


# Phase 15: the old commit_and_pr_task split into three idempotent
# tasks. Each step's success is checkpointed independently, so a
# failure at push or pr_create can be resumed via the resume_run MCP
# tool without re-committing or re-pushing work that already landed.
#
# push_task and pr_create_task take `sha` as an input even though they
# don't use it directly — including it in the inputs invalidates the
# @task cache key when the commit changes (e.g. if an earlier retry
# produced a different commit), forcing those downstream tasks to run
# fresh instead of returning stale cached results.
@task
async def commit_task(
    branch: str, title: str, summary: str, base_branch: str | None = None
) -> str:
    """Stage + commit any uncommitted changes; return HEAD SHA.
    Idempotent: a clean tree with an existing ahead-of-base commit
    returns that commit's SHA without re-committing."""
    return await asyncio.to_thread(commit, branch, title, summary, base_branch)


@task
async def push_task(branch: str, sha: str, base_branch: str | None = None, auto_rebase: bool = True) -> None:
    """Push branch with upstream tracking. Idempotent (git push is a
    no-op when the remote is already up to date).

    Fetches origin first and rebases onto origin/<base_branch> if it
    moved since branch creation (Phase 22). Rebase conflicts surface as
    a UserActionError; set auto_rebase=False to skip and ask for manual
    rebase instead.
    """
    return await asyncio.to_thread(push, branch, base_branch, auto_rebase)


@task
async def pr_create_task(
    branch: str,
    title: str,
    summary: str,
    test_plan: str,
    sha: str,
    base_branch: str | None = None,
    draft: bool = False,
    reviewers: list[str] | None = None,
    plan_type: str | None = None,
) -> str:
    """Open a PR and return its URL. Idempotent: if a PR already exists
    for this branch, returns its URL instead of opening another.

    Phase 40: `plan_type` (plan_result.type) is passed through to pr_create,
    which auto-derives the PR label from it (replacing the old pr.labels list)."""
    return await asyncio.to_thread(
        pr_create, branch, title, summary, test_plan,
        base_branch, draft, reviewers or [], plan_type,
    )


# ---------------------------------------------------------------------------
# Phase 58: entrypoint-body helpers. The @entrypoint body used to inline every
# phase; these named helpers carve it into readable sections. They are plain
# `async def` (not @task), so the interrupt()s inside _plan_and_approve run in
# the entrypoint frame — the same rule run_seam / _run_build_step already follow.
#
# Refactor invariant: the @task names, their count, and their EXECUTION ORDER are
# unchanged. LangGraph keys a task by name + call position, and calling @tasks
# from module-level helpers is the established pattern (run_seam), so the task
# graph is identical and resume/replay is unaffected — hence no WORKFLOW_VERSION
# bump (see the note above the constant).
# ---------------------------------------------------------------------------


async def _gate_checkpoint_and_manifest() -> WorkflowManifest:
    """Phase 20/33 resume gates. Returns the loaded manifest.

    record_version_task / record_manifest_hash_task return the live values on a
    fresh run (and persist them) and the cached creation-time values on resume; a
    mismatch means the body or the injected-step manifest changed incompatibly
    since the run started. Raised from the entrypoint body (not a @task) so it
    propagates straight out of ainvoke without mutating the checkpoint — the run
    stays resumable once the code is reverted or the run abandoned.
    """
    stored_version = await record_version_task()
    if stored_version != WORKFLOW_VERSION:
        raise IncompatibleCheckpointError(stored_version, WORKFLOW_VERSION)
    manifest = load_manifest()
    current_hash = manifest.manifest_hash()
    stored_hash = await record_manifest_hash_task()
    if stored_hash != current_hash:
        raise IncompatibleManifestError(stored_hash, current_hash)
    return manifest


async def _plan_and_approve(
    request: str,
    config: OrchestratorConfig,
    *,
    thread_id: str,
    audit,
    autonomous: bool,
    check_cancel,
    usage_by_task: dict,
) -> tuple[PlanResult, DecompositionResult]:
    """Plan → decompose → approval loop. Returns the approved (plan, decomposition).

    The loop runs until the user replies "yes"; any other reply is feedback that
    regenerates the plan (and re-decomposes, so the two never drift). The plan is
    decomposed BEFORE the approval interrupt so the task list is shown alongside
    the plan (Phase 55). interrupt() is reachable because this helper runs in the
    entrypoint frame. Planning is auto-approved under human_in_loop=false or
    autonomous mode (Phase 13/37).
    """
    async def _run_planning(req: str) -> PlanResult:
        check_cancel()
        async with audited(audit, thread_id, "planning"):
            pr = await planning_task(req, config.resolved_model(config.workflow.planning))
        _record_usage(usage_by_task, "planning", pr)
        write_plan(thread_id, pr)
        return pr

    async def _run_decompose(pr: PlanResult) -> DecompositionResult:
        check_cancel()
        async with audited(audit, thread_id, "decompose"):
            d = await decompose_task(
                pr.plan_text,
                config.resolved_model(config.workflow.decompose),
                config.workflow.decompose.max_tasks,
            )
        _record_usage(usage_by_task, "decompose", d)
        write_decomposition(thread_id, d)
        return d

    plan_result = await _run_planning(request)
    decomposition = await _run_decompose(plan_result)

    while True:
        if config.workflow.planning.human_in_loop and not autonomous:
            emit_event(audit, thread_id, "interrupt", payload={"kind": "plan_approval"})
            approval = interrupt({
                "kind": "plan_approval",
                "plan": plan_result.model_dump(),
                "tasks": [t.model_dump() for t in decomposition.tasks],
                "ask": "Approve this plan? Reply 'yes' or describe changes.",
            })
        else:
            approval = "yes"
        if approval == "yes":
            break
        plan_result = await _run_planning(f"{request}\n\nFeedback: {approval}")
        decomposition = await _run_decompose(plan_result)

    return plan_result, decomposition


async def _ship(
    plan_result: PlanResult,
    branch_name: str,
    config: OrchestratorConfig,
    *,
    thread_id: str,
    audit,
    check_cancel,
    usage_by_task: dict,
) -> tuple[SummaryResult, str]:
    """summarize → docs → commit → push → pr. Returns (summary_result, pr_url).

    summarize (Phase 42) and docs (Phase 41) run read-only on the QA-passed tree
    before the commit, so doc edits land in the same commit and cancel is still
    safe up to the commit line. The three git @tasks (Phase 15) are idempotent and
    individually checkpointed, so a failure between commit/push/pr is resumable.
    No cancel checks once the commit has landed — aborting then would leave a
    half-shipped branch (use git, not the orchestrator).
    """
    check_cancel()
    async with audited(audit, thread_id, "summarize"):
        summary_result = await summarize_task(
            plan_result.plan_text, config.resolved_model(config.workflow.summarize)
        )
    _record_usage(usage_by_task, "summarize", summary_result)
    write_summary(thread_id, summary_result)

    check_cancel()
    async with audited(audit, thread_id, "docs"):
        docs_result = await docs_task(
            plan_result.plan_text, config.resolved_model(config.workflow.docs)
        )
    _record_usage(usage_by_task, "docs", docs_result)

    check_cancel()
    async with audited(audit, thread_id, "commit"):
        sha = await commit_task(
            branch_name, plan_result.title, summary_result.summary, config.pr.base_branch
        )
    async with audited(audit, thread_id, "push"):
        await push_task(branch_name, sha, config.pr.base_branch, config.git.auto_rebase)
    async with audited(audit, thread_id, "pr_create"):
        pr_url = await pr_create_task(
            branch_name,
            plan_result.title,
            summary_result.summary,
            summary_result.test_plan,
            sha,
            config.pr.base_branch,
            config.pr.draft,
            config.pr.reviewers,
            plan_result.type,
        )
    return summary_result, pr_url


def _finalize(usage_by_task: dict, thread: str, **fields) -> dict:
    """Assemble a workflow result dict: aggregate + persist usage, append it.

    Every workflow exit (succeeded / no_changes / failed / aborted / cancelled)
    ends by aggregating usage, writing it to the run folder, and returning a dict
    with a `usage` key. This collapses that shared tail; `fields` carries the
    per-status keys. `thread` is the run's thread_id used for write_usage (named
    distinctly so a result `thread_id` field can still be passed in `fields`).
    """
    usage = aggregate_usage(usage_by_task)
    write_usage(thread, usage)
    return {**fields, "usage": usage}


# build_workflow is a factory, not a module-level workflow definition.
# Why: AsyncSqliteSaver.from_conn_string returns an async context manager
# that opens the SQLite connection on entry and closes it on exit. The
# @entrypoint decorator captures the checkpointer at definition time, so
# the workflow MUST be defined inside the async-with block — there's no
# clean way to attach a still-opening connection to a module-level decorator.
# The asynccontextmanager wrapper lets callers do `async with build_workflow()`.
@asynccontextmanager
async def build_workflow(
    db_path: str | None = None,
    config: OrchestratorConfig | None = None,
) -> AsyncIterator:
    if config is None:
        config = load_config()
    raw_path = db_path if db_path is not None else config.db_path
    p = Path(raw_path)
    effective_db_path = str(p if p.is_absolute() else find_project_root() / p)

    async with AsyncSqliteSaver.from_conn_string(effective_db_path) as checkpointer:
        # AsyncSqliteSaver.from_conn_string doesn't accept a custom serde,
        # so we swap it in after construction. Both attributes need to
        # change: `serde` is the public one read by BaseCheckpointSaver,
        # `jsonplus_serde` is the internal one AsyncSqliteSaver uses
        # directly for some write paths.
        checkpointer.serde = _CUSTOM_SERDE
        checkpointer.jsonplus_serde = _CUSTOM_SERDE

        @entrypoint(checkpointer=checkpointer)
        async def workflow(request: str) -> dict:
            thread_id = get_config()["configurable"]["thread_id"]

            # Phase 37: one resolved flag for the whole run. Read once here so
            # every gate-suppression check below shares it.
            autonomous = config.fully_autonomous
            # Wall-clock budget is per-invocation (monotonic resets per process).
            # Fine because autonomous runs don't pause mid-flight — a run is one
            # continuous process; a resume after a crash starts a fresh budget.
            _run_started = time.monotonic()

            # Phase 16/37: cancel-check helper closed over thread_id. Called
            # before each task (and threaded into builds as check_cancel, so it
            # fires per producer attempt). Raises WorkflowCancelled if the
            # cancel_run MCP tool marked this thread, OR — in autonomous mode —
            # if the run crossed its time/cost safety ceiling. The except clause
            # at the bottom converts either into a status="cancelled" dict.
            def _check_cancel() -> None:
                raise_if_cancelled(thread_id)
                if not autonomous:
                    return
                max_seconds = config.autonomous_max_seconds
                if max_seconds > 0 and (time.monotonic() - _run_started) > max_seconds:
                    raise AutonomousCeilingExceeded(thread_id, "autonomous_ceiling")
                max_cost = config.autonomous_max_cost_usd
                if max_cost > 0:
                    spent = sum(
                        cost
                        for entries in usage_by_task.values()
                        for u in entries
                        if (cost := u.cost_usd()) is not None
                    )
                    if spent > max_cost:
                        raise AutonomousCeilingExceeded(thread_id, "autonomous_ceiling")

            # Phase 24: build the audit sink once per invocation.
            # Each ainvoke() call (fresh start or resume after interrupt)
            # emits a "resume" event so the log captures every interaction.
            _audit_log = str(find_project_root() / config.audit.log_path)
            _audit: AuditSink = (
                build_sink(_audit_log) if config.audit.enabled else NoopAuditSink()
            )
            emit_event(_audit, thread_id, "resume")

            # Accumulate token usage across all agent calls for the run.
            # Keys map to lists so retries (multiple impl/qa calls) are
            # all summed in the final aggregate. Defined OUTSIDE the
            # try block so the cancel-handler can still report whatever
            # tokens were spent before the cancel signal landed.
            usage_by_task: dict[str, list[TaskUsage]] = {
                "planning": [],
                "decompose": [],
                "implementation": [],
                "qa": [],
                "summarize": [],
                "docs": [],
            }
            # Pre-declared so the BuildFailed handler can reference them in scope.
            # A build only runs inside the `work` list (after branch), so by the
            # time BuildFailed can be raised both are set; these defaults just keep
            # the names bound for the except clause.
            plan_result: PlanResult | None = None
            branch_name: str | None = None

            try:
                # Phase 20/33 resume gates (workflow-version + injected-step
                # manifest hash). Raised from the body, not a @task, so a mismatch
                # leaves the checkpoint untouched and resumable. See the helper.
                manifest = await _gate_checkpoint_and_manifest()

                _check_cancel()
                async with audited(_audit, thread_id, "preflight"):
                    await verify_clean_tree_task()

                # Plan → decompose → approval loop (see _plan_and_approve). Returns
                # the approved plan + its task list. Landmine #4: create_branch_task
                # (the first side effect) stays AFTER this on purpose — interrupt()
                # re-executes the body on resume, and completed @tasks replay from
                # cache, so re-running planning_task(request) costs nothing.
                plan_result, decomposition = await _plan_and_approve(
                    request, config,
                    thread_id=thread_id, audit=_audit, autonomous=autonomous,
                    check_cancel=_check_cancel, usage_by_task=usage_by_task,
                )

                # Phase 13: optional branch-creation approval gate.
                if config.workflow.branch.human_in_loop and not autonomous:
                    emit_event(_audit, thread_id, "interrupt", payload={"kind": "branch_approval"})
                    interrupt({
                        "kind": "branch_approval",
                        "ask": "Proceed with branch creation?",
                    })

                _check_cancel()
                async with audited(_audit, thread_id, "create_branch"):
                    branch_name = await create_branch_task(
                        plan_result, config.workflow.branch.max_slug_length, thread_id
                    )
                rename_with_branch(thread_id, branch_name)

                # Phase 56: the per-task execution station (Option B). The frozen
                # task list (Phase 55) is run one produce⇄gate build per task via the
                # SAME engine the spine used before (_run_build_step / run_retry_block)
                # with the [workflow.task_build] recipe — REPLACING the single
                # hard-baked impl⇄QA build as the implementation mechanism. n=1 (a
                # single-task plan) runs exactly one build → today's behaviour. A task
                # that exhausts its budget raises BuildFailed → the clean
                # status="failed" return below (no commit, no PR), tagging the task.
                # _qa_holder stashes the latest QA verdict for the result dict; the
                # "qa"/write_qa contract is unchanged. Runs in the entrypoint body so
                # the build's interrupt()s (Phase 51/52) are reachable.
                _qa_holder: dict[str, QaResult] = {}
                await _run_task_loop(
                    decomposition, manifest, plan_result, config,
                    _check_cancel, usage_by_task, _qa_holder,
                    thread_id=thread_id, audit=_audit, autonomous=autonomous,
                )

                # Any remaining [[steps.work]] entries (user scripts / gates / builds)
                # still run after the task loop — the seam is no longer the home of the
                # core impl loop, but it stays for additional user steps. The built-in
                # implementation/qa are still exposed so a user-declared work build can
                # reference them. The default orchestrator.toml has no work steps, so
                # this is a no-op there.
                async def _builtin_implementation(
                    step_id: str, feedback: str | None
                ) -> StepResult:
                    async with audited(_audit, thread_id, "implementation"):
                        result = await implementation_task(
                            plan_result.plan_text,
                            feedback,
                            config.resolved_model(config.workflow.implementation),
                        )
                    _record_usage(usage_by_task, "implementation", result)
                    return result

                async def _builtin_qa(step_id: str) -> StepResult:
                    async with audited(_audit, thread_id, "qa"):
                        qa_result = await qa_task(
                            plan_result, config.resolved_model(config.workflow.qa)
                        )
                    _record_usage(usage_by_task, "qa", qa_result)
                    write_qa(thread_id, qa_result)
                    _qa_holder["qa"] = qa_result
                    return StepResult(
                        step_id="qa",
                        kind="ai_agent",
                        ok=True,
                        passed=(qa_result.result == "PASS"),
                        detail=qa_result.failures or "",
                    )

                await run_seam(
                    "work", manifest, plan_result.plan_text,
                    _check_cancel, usage_by_task,
                    builtin_producers={"implementation": _builtin_implementation},
                    builtin_gates={"qa": _builtin_qa},
                    thread_id=thread_id,
                    audit=_audit,
                    autonomous=autonomous,
                )

                # Phase 56: optional final whole-diff QA after all tasks pass
                # (default no-op — QA runs per-task). A FAIL raises BuildFailed.
                await _run_final_qa(
                    config, manifest, plan_result, _check_cancel,
                    usage_by_task, _qa_holder, thread_id=thread_id, audit=_audit,
                )

                # The latest QA verdict (last task's per-task QA, or final_qa).
                # None only if the task build was ungated AND no final_qa ran.
                qa_result = _qa_holder.get("qa")

                # Phase 46d: empty-diff resilience. If the build produced no diff
                # (the producer made no edits and nothing is ahead of base), there
                # is nothing to ship — committing would create an empty commit and
                # a no-op PR. Return a clean status="no_changes" instead, skipping
                # summarize / docs / commit / push / pr. Checked before the
                # pr_approval gate so we never ask "open a PR?" for an empty diff.
                # All of this is pre-commit, so cancel/return is safe.
                _check_cancel()
                if not await asyncio.to_thread(
                    working_tree_has_changes, config.pr.base_branch
                ):
                    return _finalize(
                        usage_by_task, thread_id,
                        status="no_changes",
                        plan=plan_result.model_dump(),
                        branch=branch_name,
                        qa=qa_result.model_dump() if qa_result else None,
                    )

                # Phase 13: optional gate before committing and opening PR.
                if config.workflow.commit.human_in_loop and not autonomous:
                    emit_event(_audit, thread_id, "interrupt", payload={"kind": "pr_approval"})
                    interrupt({"kind": "pr_approval", "ask": "QA passed. Open a PR?"})

                # Phase 42/41/15: summarize → docs → commit → push → pr (see _ship).
                summary_result, pr_url = await _ship(
                    plan_result, branch_name, config,
                    thread_id=thread_id, audit=_audit,
                    check_cancel=_check_cancel, usage_by_task=usage_by_task,
                )
                return _finalize(
                    usage_by_task, thread_id,
                    status="succeeded",
                    plan=plan_result.model_dump(),
                    branch=branch_name,
                    # {summary, test_plan} shape unchanged for MCP/UI/tests.
                    implementation={
                        "summary": summary_result.summary,
                        "test_plan": summary_result.test_plan,
                    },
                    # None when the build was ungated or gated only on a non-qa gate.
                    qa=qa_result.model_dump() if qa_result else None,
                    pr_url=pr_url,
                )

            except BuildFailed as exc:
                # Phase 46: a build step ran its full budget without a passing gate
                # under on_exhausted="abort" (or a human declined to keep retrying).
                # Clean status="failed" with the last gate feedback under
                # `qa_failures`, no commit, no PR — build steps are pre-commit, so
                # nothing is half-shipped. plan_result/branch_name are guarded for a
                # pre-branch user build. failed_task_id is "task:<id>" (per-task
                # station), "final_qa", or a [[steps.work]] build id (Phase 56).
                return _finalize(
                    usage_by_task, thread_id,
                    status="failed",
                    plan=plan_result.model_dump() if plan_result else None,
                    branch=branch_name,
                    failed_task_id=exc.step_id,
                    qa_failures=exc.last_feedback,
                )

            except StepGateAborted as exc:
                # Phase 33: an approval_gate step was resumed with an abort decision.
                # Every gate runs before the commit line, so nothing is half-shipped;
                # branch_name may not exist yet (gates can fire pre-branch).
                return _finalize(
                    usage_by_task, thread_id,
                    status="aborted",
                    thread_id=thread_id,
                    aborted_at=exc.step_id,
                )

            except WorkflowCancelled as exc:
                # Phase 16/37: a between-task check found the cancel flag set, or an
                # autonomous run tripped its safety ceiling — `reason` tells them
                # apart ("autonomous_ceiling" vs. a user cancel_run). Whatever was in
                # progress has completed (the SDK doesn't interrupt mid-task).
                reason = getattr(exc, "reason", "user_cancel")
                emit_event(_audit, thread_id, "cancel", payload={"reason": reason})
                return _finalize(
                    usage_by_task, thread_id,
                    status="cancelled",
                    thread_id=thread_id,
                    reason=reason,
                )

        yield workflow
