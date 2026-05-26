import asyncio
from contextlib import asynccontextmanager
from typing import AsyncIterator

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
from orchestrator.git_ops import (
    commit,
    create_branch,
    pr_create,
    push,
    verify_clean_tree,
)
from orchestrator.run_artifacts import (
    rename_with_branch,
    write_implementation,
    write_plan,
    write_qa,
)


# Future LangGraph versions will refuse to deserialize types that aren't
# on this allowlist (the warning today; a hard error tomorrow). Register
# every Pydantic model that flows through a @task so resume keeps working
# across upgrades. Each entry is (module_path, class_name).
_ALLOWED_MSGPACK_MODULES = [
    ("orchestrator.agents.planning", "PlanResult"),
    ("orchestrator.agents.implementation", "ImplementationResult"),
    ("orchestrator.agents.qa", "QaResult"),
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
@task
async def planning_task(request: str) -> PlanResult:
    return await plan(request)


# Pre-flight check. Runs FIRST in the workflow — before planning — so a
# dirty working tree fails fast with zero LLM cost and no wasted approval
# round. Defence in depth: create_branch_task also calls verify_clean_tree
# internally, since the tree could be dirtied between approval and branch
# creation (the user has time to make edits during plan review).
@task
async def verify_clean_tree_task() -> None:
    await asyncio.to_thread(verify_clean_tree)


# Deterministic git task (Phase 6a). Wraps the synchronous create_branch
# function with asyncio.to_thread so it doesn't block the event loop —
# subprocess.run is blocking, and even fast git commands shouldn't stall
# the loop. The @task wrapper means a successful branch creation is
# checkpointed: on resume, we don't re-run git checkout, we read the
# branch name back from the checkpoint and move on.
@task
async def create_branch_task(plan_result: PlanResult) -> str:
    return await asyncio.to_thread(create_branch, plan_result)


# Phase 4 placeholder. Originally created so crash_demo had a long-running
# step to Ctrl-C during. Phase 6b's implementation_task now provides a
# much longer (5+ min) crash window, so this is vestigial — kept only to
# avoid breaking crash_demo.py's documented flow. Safe to delete.
@task
async def step_two_task(plan_result: PlanResult) -> str:
    await asyncio.sleep(5)
    return f"step_two finished for plan {plan_result.title!r}"


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
) -> ImplementationResult:
    return await implement(plan_result, mode=mode, qa_failures=qa_failures)


# Phase 6c. Read-only LLM task: the QA agent reviews the uncommitted
# diff against the approved plan and emits a PASS/FAIL verdict. No file
# edits, no git operations. The QaResult feeds into Phase 7's retry
# loop — on FAIL the orchestrator will call implementation_task again
# in "fix" mode with the failure text. For now (linear chain, no
# retries yet) we just record the verdict in the workflow result.
@task
async def qa_task(plan_result: PlanResult) -> QaResult:
    return await qa(plan_result)


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
async def commit_task(branch: str, title: str, summary: str) -> str:
    """Stage + commit any uncommitted changes; return HEAD SHA.
    Idempotent: a clean tree with an existing ahead-of-base commit
    returns that commit's SHA without re-committing."""
    return await asyncio.to_thread(commit, branch, title, summary)


@task
async def push_task(branch: str, sha: str) -> None:
    """Push branch with upstream tracking. Idempotent (git push is a
    no-op when the remote is already up to date)."""
    return await asyncio.to_thread(push, branch)


@task
async def pr_create_task(
    branch: str, title: str, summary: str, test_plan: str, sha: str
) -> str:
    """Open a PR and return its URL. Idempotent: if a PR already exists
    for this branch, returns its URL instead of opening another."""
    return await asyncio.to_thread(
        pr_create, branch, title, summary, test_plan
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
    db_path: str = ".orchestrator/checkpoints.db",
) -> AsyncIterator:
    async with AsyncSqliteSaver.from_conn_string(db_path) as checkpointer:
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

            # Fail fast on a dirty tree BEFORE the planning LLM call —
            # otherwise we'd waste tokens (and the user's approval time)
            # only to fail at create_branch_task downstream.
            await verify_clean_tree_task()

            plan_result = await planning_task(request)
            write_plan(thread_id, plan_result)

            # Phase 8: plan approval interrupt. The loop runs until the
            # user replies "yes". Any other reply is treated as feedback:
            # the plan is regenerated with the feedback appended to the
            # original request, then the new plan is surfaced for another
            # round of review.
            #
            # Landmine #4: create_branch_task (the first side effect) is
            # intentionally AFTER this block. interrupt() re-executes the
            # entrypoint body on resume; tasks already completed with the
            # same inputs return their cached result without a new LLM call,
            # so planning_task(request) on re-execution is effectively free.
            while True:
                approval = interrupt({
                    "kind": "plan_approval",
                    "plan": plan_result.model_dump(),
                    "ask": "Approve this plan? Reply 'yes' or describe changes.",
                })
                if approval == "yes":
                    break
                plan_result = await planning_task(
                    f"{request}\n\nFeedback: {approval}"
                )
                write_plan(thread_id, plan_result)

            branch_name = await create_branch_task(plan_result)
            rename_with_branch(thread_id, branch_name)

            # Phase 7: retry loop. Up to 3 attempts: first is always
            # "implement" (fresh execution); subsequent attempts are
            # "fix" mode, passing qa_failures so the agent knows exactly
            # what to correct without re-doing passing work.
            #
            # Python's for/else: the `else` block runs only if the loop
            # exhausted all attempts WITHOUT hitting `break`. A `break`
            # means QA passed — the else block (failure path) is skipped.
            qa_failures: str | None = None
            impl_result = None
            for attempt in range(1, 4):
                mode = "implement" if attempt == 1 else "fix"
                impl_result = await implementation_task(
                    plan_result, mode=mode, qa_failures=qa_failures
                )
                write_implementation(thread_id, impl_result)
                qa_result = await qa_task(plan_result)
                write_qa(thread_id, qa_result)
                if qa_result.result == "PASS":
                    break
                qa_failures = qa_result.failures
            else:
                # All 3 attempts failed QA. Return without opening a PR —
                # a broken PR is worse than no PR. The branch and all the
                # attempted diffs are still in the repo; a human can review
                # and decide what to do with them.
                return {
                    "status": "failed",
                    "plan": plan_result.model_dump(),
                    "branch": branch_name,
                    "qa_failures": qa_failures,
                }

            # Phase 15: three separate @tasks instead of one
            # commit_and_pr_task. A failure between commit and push
            # (or push and PR creation) is resumable via resume_run —
            # completed tasks return cached SHAs/URLs; the failed task
            # re-executes against the now-fixed underlying issue.
            sha = await commit_task(
                branch_name, plan_result.title, impl_result.summary
            )
            await push_task(branch_name, sha)
            pr_url = await pr_create_task(
                branch_name,
                plan_result.title,
                impl_result.summary,
                impl_result.test_plan,
                sha,
            )
            return {
                "status": "succeeded",
                "plan": plan_result.model_dump(),
                "branch": branch_name,
                "implementation": impl_result.model_dump(),
                "qa": qa_result.model_dump(),
                "pr_url": pr_url,
            }

        yield workflow
