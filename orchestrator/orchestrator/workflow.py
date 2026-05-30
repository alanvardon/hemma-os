import asyncio
import logging
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
# the per-step tasks built by _make_script_task / _make_llm_agent_task). That's
# a body change, so the bump makes any checkpoint created before Phase 33
# refuse to resume (clean version error) rather than resume into a changed
# task graph. (Phase 33's later refinements — per-id step task names, after_qa
# firing only on PASS, human_gate abort — all landed before 1.1.0 shipped, so
# they fold into this same version.)
# 1.1.0 → 1.2.0 (Phase 41): docs_task is now a permanent spine task, inserted
# after the before_commit seam and before commit_task. A new required task in
# the body is a control-flow change, so the bump refuses resume of any run
# created before Phase 41 (clean version error) rather than resuming into a
# task graph that lacks the docs step.
WORKFLOW_VERSION = "1.2.0"


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

from orchestrator.agents.planning import plan, PlanResult
from orchestrator.agents.implementation import implement, ImplementationResult
from orchestrator.agents.qa import qa, QaResult
from orchestrator.agents.runner import run_structured_agent
from orchestrator.audit import AuditSink, NoopAuditSink, audited, build_sink, emit_event
from orchestrator.cancellation import WorkflowCancelled, raise_if_cancelled
from orchestrator.config import OrchestratorConfig, load_config
from orchestrator.manifest import (
    HumanGateStep,
    LlmAgentStep,
    ScriptStep,
    StepResult,
    WorkflowManifest,
    load_manifest,
)
from orchestrator.steps import execute_llm_agent, execute_script, _strip_frontmatter
from orchestrator.usage import TaskUsage, aggregate_usage
from orchestrator.git_ops import (
    commit,
    create_branch,
    ensure_on_main,
    pr_create,
    push,
    verify_clean_tree,
    PreHookError,
)
from orchestrator.paths import find_project_root
from orchestrator.pre_hooks import run_pre_hooks
from orchestrator.run_artifacts import (
    rename_with_branch,
    write_implementation,
    write_plan,
    write_qa,
    write_usage,
)


# Future LangGraph versions will refuse to deserialize types that aren't
# on this allowlist (the warning today; a hard error tomorrow). Register
# every Pydantic model that flows through a @task so resume keeps working
# across upgrades. Each entry is (module_path, class_name).
_ALLOWED_MSGPACK_MODULES = [
    ("orchestrator.agents.planning", "PlanResult"),
    ("orchestrator.agents.implementation", "ImplementationResult"),
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
# script (or every llm_agent) step collapsing onto one shared task name.
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
# human_gate payload); per-attempt distinctness comes from call position, not
# from this value.
def _make_script_task(step_id: str):
    async def run_script_step(
        step_id: str, path: str, timeout: int, repo_root: str, attempt: int = 0
    ) -> StepResult:
        return await execute_script(
            ScriptStep(id=step_id, path=path, timeout=timeout), Path(repo_root)
        )

    return task(run_script_step, name=f"step:{step_id}")


def _make_llm_agent_task(step_id: str):
    async def run_llm_agent_step(
        step_id: str,
        agent: str,
        model: str,
        repo_root: str,
        plan_text: str,
        attempt: int = 0,
    ) -> StepResult:
        return await execute_llm_agent(
            LlmAgentStep(id=step_id, agent=agent, model=model),
            Path(repo_root),
            plan_text,
        )

    return task(run_llm_agent_step, name=f"step:{step_id}")


class StepGateAborted(RuntimeError):
    """Phase 33: raised when a human_gate step is resumed with an abort
    decision ('abort'/'no'/'stop'). Propagates out of run_seam to the
    entrypoint body, which converts it into a clean status="aborted" return.
    All seams run before the commit line, so an abort never leaves a
    half-shipped state.
    """

    def __init__(self, step_id: str) -> None:
        self.step_id = step_id
        super().__init__(f"workflow aborted at human_gate step {step_id!r}")


# Resume values (case-insensitive) that mean "stop the run" at a human_gate.
# Anything else proceeds — replying to a gate is how you resume past it.
_GATE_ABORT_WORDS = frozenset({"abort", "no", "stop"})


async def run_seam(
    seam: str,
    manifest: WorkflowManifest,
    plan_text: str,
    check_cancel,
    usage_by_task: dict,
    attempt: int = 0,
) -> None:
    """Run every injected step at `seam`, in declared order.

    A plain async helper (not a @task) so human_gate steps can call
    interrupt(), which must run in the entrypoint body. Script and llm_agent
    steps dispatch to their @tasks (checkpointed). Cancel is checked before
    each step (between-step semantics, inherited from the spine). Each
    llm_agent step's usage is accumulated under its own `id`.

    `attempt` distinguishes per-attempt checkpoint entries for seams that run
    inside the impl/QA retry loop (after_impl, after_qa); it is 0 for seams
    that run once outside the loop.
    """
    steps = manifest.for_seam(seam)
    if not steps:
        return
    repo_root = str(find_project_root())
    for step in steps:
        check_cancel()
        if isinstance(step, HumanGateStep):
            # A human checkpoint. The resume value decides: an abort word
            # ('abort'/'no'/'stop') stops the run cleanly via StepGateAborted;
            # anything else (including 'yes' or empty) proceeds — replying is
            # how you resume past the gate.
            decision = interrupt({
                "kind": "step_human_gate",
                "step_id": step.id,
                "ask": step.ask,
                "attempt": attempt,
            })
            if isinstance(decision, str) and decision.strip().lower() in _GATE_ABORT_WORDS:
                raise StepGateAborted(step.id)
            continue
        if isinstance(step, ScriptStep):
            step_task = _make_script_task(step.id)
            await step_task(step.id, step.path, step.timeout, repo_root, attempt)
        elif isinstance(step, LlmAgentStep):
            step_task = _make_llm_agent_task(step.id)
            result = await step_task(
                step.id, step.agent, step.model, repo_root, plan_text, attempt
            )
            if result.usage:
                usage_by_task.setdefault(step.id, []).append(result.usage)


@task
async def planning_task(request: str, model: str = "claude-sonnet-4-6") -> PlanResult:
    return await plan(request, model=model)


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


# Phase 6b. Runs the implementation agent (Claude Agent SDK in a loop)
# to edit files according to the plan. The function body is short
# because all the heavy lifting is inside implement() — the @task
# wrapper exists so LangGraph can checkpoint the ImplementationResult
# and skip re-running on resume. Implementation is the most expensive
# task by far (minutes of LLM time, real file edits), so resume-skip
# is the single biggest cost win the checkpointer gives us.
@task
async def implementation_task(
    plan_result: PlanResult,
    mode: str = "implement",
    qa_failures: str | None = None,
    model: str = "claude-sonnet-4-6",
) -> ImplementationResult:
    return await implement(plan_result, mode=mode, qa_failures=qa_failures, model=model)


# Phase 6c. Read-only LLM task: the QA agent reviews the uncommitted
# diff against the approved plan and emits a PASS/FAIL verdict. No file
# edits, no git operations. The QaResult feeds into Phase 7's retry
# loop — on FAIL the orchestrator will call implementation_task again
# in "fix" mode with the failure text. For now (linear chain, no
# retries yet) we just record the verdict in the workflow result.
@task
async def qa_task(
    plan_result: PlanResult, model: str = "claude-sonnet-4-6"
) -> QaResult:
    return await qa(plan_result, model=model)


# Phase 41: documentation agent, now a permanent spine task (was a pluggable
# before_commit step). Runs once after the before_commit seam, before commit —
# on the final, QA-passed code — so any doc edits land in the same commit. The
# prompt ships in the package (orchestrator/agents/docs.md, tracked by git)
# rather than .orchestrator/agents/ (gitignored), so a spine step never depends
# on a local-only file. Built directly on Phase 39's run_structured_agent.
_DOCS_PROMPT_PATH = Path(__file__).parent / "agents" / "docs.md"


def _load_docs_prompt() -> str:
    """Read the package-shipped docs agent prompt, stripping YAML frontmatter.

    Loaded by path relative to this module — works for source / editable
    installs, which is how the orchestrator runs."""
    return _strip_frontmatter(_DOCS_PROMPT_PATH.read_text(encoding="utf-8"))


@task
async def docs_task(
    plan_text: str, model: str = "claude-haiku-4-5-20251001"
) -> StepResult:
    """Run the documentation agent against the QA-passed working tree.

    A @task like every other spine step: its StepResult is checkpointed, so a
    crash between docs and commit replays the docs result on resume (no LLM
    re-call). The package prompt is the system prompt; the agent reads
    `git diff HEAD` itself and edits ONLY documentation (.md) — it never edits
    source, including the workflow that orchestrates it. Returns a StepResult
    (already on the serde allowlist)."""
    return await run_structured_agent(
        system_prompt=_load_docs_prompt(),
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
            kind="llm_agent",
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

            # Phase 16: cancel-check helper closed over thread_id.
            # Called before each task; raises WorkflowCancelled if the
            # cancel_run MCP tool has marked this thread. The except
            # clause at the bottom of the body converts the exception
            # into a status="cancelled" return dict.
            def _check_cancel() -> None:
                raise_if_cancelled(thread_id)

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
                "implementation": [],
                "qa": [],
                "docs": [],
            }

            try:
                # Phase 20: workflow-version gate. Runs first on every
                # invocation. On a fresh run this records and returns the
                # live WORKFLOW_VERSION; on a resume it returns the cached
                # version that created the run. A mismatch means the body
                # changed incompatibly since this run started — refuse
                # rather than resume into a shifted task graph. Raised here
                # (not inside a @task) so it propagates straight out of
                # ainvoke without mutating the checkpoint, leaving the run
                # resumable once the code is reverted or the run abandoned.
                stored_version = await record_version_task()
                if stored_version != WORKFLOW_VERSION:
                    raise IncompatibleCheckpointError(stored_version, WORKFLOW_VERSION)

                # Phase 33: load + validate the injected-step manifest (raises
                # ManifestError on a bad config, before any LLM spend), then
                # gate on its hash the same way as the version above — a
                # mid-run orchestrator.toml edit refuses the resume.
                manifest = load_manifest()
                current_manifest_hash = manifest.manifest_hash()
                stored_manifest_hash = await record_manifest_hash_task()
                if stored_manifest_hash != current_manifest_hash:
                    raise IncompatibleManifestError(
                        stored_manifest_hash, current_manifest_hash
                    )

                _check_cancel()
                async with audited(_audit, thread_id, "preflight"):
                    await verify_clean_tree_task()

                # Phase 33 seam: before_plan (no plan context yet).
                await run_seam(
                    "before_plan", manifest, "", _check_cancel, usage_by_task
                )

                _check_cancel()
                async with audited(_audit, thread_id, "planning"):
                    plan_result = await planning_task(request, config.resolved_model(config.workflow.planning))
                if plan_result.usage:
                    usage_by_task["planning"].append(plan_result.usage)
                write_plan(thread_id, plan_result)

                # Phase 8: plan approval interrupt. The loop runs until the
                # user replies "yes". Any other reply is treated as feedback:
                # the plan is regenerated with the feedback appended to the
                # original request, then the new plan is surfaced for another
                # round of review.
                #
                # Phase 13: gated by config.workflow.planning.human_in_loop.
                # false = auto-approve (fully autonomous mode).
                #
                # Landmine #4: create_branch_task (the first side effect) is
                # intentionally AFTER this block. interrupt() re-executes the
                # entrypoint body on resume; tasks already completed with the
                # same inputs return their cached result without a new LLM call,
                # so planning_task(request) on re-execution is effectively free.
                while True:
                    if config.workflow.planning.human_in_loop:
                        emit_event(_audit, thread_id, "interrupt", payload={"kind": "plan_approval"})
                        approval = interrupt({
                            "kind": "plan_approval",
                            "plan": plan_result.model_dump(),
                            "ask": "Approve this plan? Reply 'yes' or describe changes.",
                        })
                    else:
                        approval = "yes"
                    if approval == "yes":
                        break
                    _check_cancel()
                    async with audited(_audit, thread_id, "planning"):
                        plan_result = await planning_task(
                            f"{request}\n\nFeedback: {approval}",
                            config.resolved_model(config.workflow.planning),
                        )
                    if plan_result.usage:
                        usage_by_task["planning"].append(plan_result.usage)
                    write_plan(thread_id, plan_result)

                # Phase 33 seam: after_plan (plan is finalised/approved).
                await run_seam(
                    "after_plan", manifest, plan_result.plan_text,
                    _check_cancel, usage_by_task,
                )

                # Phase 13: optional branch-creation approval gate.
                if config.workflow.branch.human_in_loop:
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

                # Phase 7: retry loop. Up to config.workflow.qa.max_retries attempts: first
                # is always "implement" (fresh execution); subsequent attempts
                # are "fix" mode, passing qa_failures so the agent knows exactly
                # what to correct without re-doing passing work.
                #
                # Python's for/else: the `else` block runs only if the loop
                # exhausted all attempts WITHOUT hitting `break`. A `break`
                # means QA passed — the else block (failure path) is skipped.
                qa_failures: str | None = None
                impl_result = None
                for attempt in range(1, config.workflow.qa.max_retries + 1):
                    _check_cancel()
                    mode = "implement" if attempt == 1 else "fix"
                    async with audited(_audit, thread_id, "implementation"):
                        impl_result = await implementation_task(
                            plan_result,
                            mode=mode,
                            qa_failures=qa_failures,
                            model=config.resolved_model(config.workflow.implementation),
                        )
                    if impl_result.usage:
                        usage_by_task["implementation"].append(impl_result.usage)
                    write_implementation(thread_id, impl_result)

                    # Phase 33 seam: after_impl — fires on EVERY attempt, since
                    # each attempt produces freshly changed code. `attempt`
                    # keeps each run a distinct checkpoint entry.
                    await run_seam(
                        "after_impl", manifest, plan_result.plan_text,
                        _check_cancel, usage_by_task, attempt,
                    )

                    if config.workflow.implementation.human_in_loop:
                        emit_event(_audit, thread_id, "interrupt", payload={"kind": "implementation_approval"})
                        interrupt({
                            "kind": "implementation_approval",
                            "ask": "Implementation complete. Proceed to QA?",
                        })

                    _check_cancel()
                    async with audited(_audit, thread_id, "qa"):
                        qa_result = await qa_task(
                            plan_result, config.resolved_model(config.workflow.qa)
                        )
                    if qa_result.usage:
                        usage_by_task["qa"].append(qa_result.usage)
                    write_qa(thread_id, qa_result)

                    if qa_result.result == "PASS":
                        # Phase 33 seam: after_qa — fires ONCE, only after QA
                        # has passed and is finished (not on failed attempts).
                        # `attempt` is the passing attempt number.
                        await run_seam(
                            "after_qa", manifest, plan_result.plan_text,
                            _check_cancel, usage_by_task, attempt,
                        )
                        break

                    # Log QA failure at ERROR level so scripted-gate failures
                    # (Phase 28) and LLM failures are both visible in the log.
                    logger.error(
                        "QA FAIL (attempt %d/%d):\n%s",
                        attempt,
                        config.workflow.qa.max_retries,
                        qa_result.failures or "(no failure details)",
                    )

                    # Phase 13: optional gate on QA failure — user can abort
                    # rather than burning another retry attempt.
                    if config.workflow.qa.human_in_loop:
                        emit_event(_audit, thread_id, "interrupt", payload={"kind": "qa_failure"})
                        decision = interrupt({
                            "kind": "qa_failure",
                            "failures": qa_result.failures,
                            "ask": (
                                f"QA FAIL (attempt {attempt}/{config.workflow.qa.max_retries}). "
                                "Retry? Reply 'yes' or 'abort'."
                            ),
                        })
                        if decision == "abort":
                            _usage = aggregate_usage(usage_by_task)
                            write_usage(thread_id, _usage)
                            return {
                                "status": "failed",
                                "plan": plan_result.model_dump(),
                                "branch": branch_name,
                                "qa_failures": qa_result.failures,
                                "usage": _usage,
                            }

                    qa_failures = qa_result.failures
                else:
                    _usage = aggregate_usage(usage_by_task)
                    write_usage(thread_id, _usage)
                    return {
                        "status": "failed",
                        "plan": plan_result.model_dump(),
                        "branch": branch_name,
                        "qa_failures": qa_failures,
                        "usage": _usage,
                    }

                # Phase 13: optional gate before committing and opening PR.
                if config.workflow.commit.human_in_loop:
                    emit_event(_audit, thread_id, "interrupt", payload={"kind": "pr_approval"})
                    interrupt({
                        "kind": "pr_approval",
                        "ask": "QA passed. Open a PR?",
                    })

                # Phase 33 seam: before_commit (last chance before the spine
                # commits — still before the commit line, so cancel-safe).
                await run_seam(
                    "before_commit", manifest, plan_result.plan_text,
                    _check_cancel, usage_by_task,
                )

                # Phase 41: documentation agent — permanent spine task. Runs
                # once on the final, QA-passed code, after any before_commit
                # pluggable steps and before the commit, so doc edits land in
                # the same commit. cwd is the target repo; cancel is still safe
                # here (nothing committed yet).
                _check_cancel()
                async with audited(_audit, thread_id, "docs"):
                    docs_result = await docs_task(
                        plan_result.plan_text,
                        config.resolved_model(config.workflow.docs),
                    )
                if docs_result.usage:
                    usage_by_task["docs"].append(docs_result.usage)

                # Phase 15: three separate @tasks instead of one
                # commit_and_pr_task. A failure between commit and push
                # (or push and PR creation) is resumable via resume_run —
                # completed tasks return cached SHAs/URLs; the failed task
                # re-executes against the now-fixed underlying issue.
                #
                # No cancel checks between commit/push/pr_create: by the time
                # the commit has landed, "cancelling" would leave the branch
                # in a confusing half-shipped state. If you need to abort
                # after commit, do it with git, not the orchestrator.
                _check_cancel()
                async with audited(_audit, thread_id, "commit"):
                    sha = await commit_task(
                        branch_name, plan_result.title, impl_result.summary,
                        config.pr.base_branch,
                    )
                async with audited(_audit, thread_id, "push"):
                    await push_task(branch_name, sha, config.pr.base_branch, config.git.auto_rebase)
                async with audited(_audit, thread_id, "pr_create"):
                    pr_url = await pr_create_task(
                        branch_name,
                        plan_result.title,
                        impl_result.summary,
                        impl_result.test_plan,
                        sha,
                        config.pr.base_branch,
                        config.pr.draft,
                        config.pr.reviewers,
                        plan_result.type,
                    )
                _usage = aggregate_usage(usage_by_task)
                write_usage(thread_id, _usage)
                return {
                    "status": "succeeded",
                    "plan": plan_result.model_dump(),
                    "branch": branch_name,
                    "implementation": impl_result.model_dump(),
                    "qa": qa_result.model_dump(),
                    "pr_url": pr_url,
                    "usage": _usage,
                }

            except StepGateAborted as exc:
                # Phase 33: a human_gate step was resumed with an abort
                # decision. Every seam runs before the commit line, so there's
                # nothing half-shipped to unwind — return a clean status and
                # whatever usage was spent up to the gate. branch_name may not
                # exist yet (gates can fire pre-branch), so it isn't referenced.
                _usage = aggregate_usage(usage_by_task)
                write_usage(thread_id, _usage)
                return {
                    "status": "aborted",
                    "thread_id": thread_id,
                    "aborted_at": exc.step_id,
                    "usage": _usage,
                }

            except WorkflowCancelled:
                # Phase 16: a between-task check found the cancel flag set.
                # Whatever was in progress has completed (the SDK doesn't
                # interrupt mid-task); we still owe the caller a final
                # status and the usage accumulated so far.
                emit_event(_audit, thread_id, "cancel")
                _usage = aggregate_usage(usage_by_task)
                write_usage(thread_id, _usage)
                return {
                    "status": "cancelled",
                    "thread_id": thread_id,
                    "usage": _usage,
                }

        yield workflow
