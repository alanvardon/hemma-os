"""Phase 46c / 47 / 49 — pluggable producer + the build step in the work list.

The impl⇄QA loop is no longer inline in the workflow body: it runs through
run_seam("work") as a declarative `build` step, declared explicitly in
orchestrator.toml (Phase 47 dropped the synthesized default; Phase 49 collapsed
the seams into the one `work` list). The standard impl/qa build running with no
extra config is covered by test_phase7 / test_phase42_spine_gates (the conftest
fixture supplies it). These tests cover the new degrees of freedom:

1. A user-declared work build with SWAPPED producer + gate ids runs
   end-to-end on the generic engine — the built-in implementation/QA agents are
   never touched.
2. Declaring a [steps.defs.*] entry whose id IS a built-in (`qa`) overrides the
   built-in: the build runs the user's def, not the spine's QA agent.
"""

import uuid

import pytest
from langgraph.types import Command

from orchestrator.agents.planning import PlanResult
from orchestrator.agents.qa import QaResult
from orchestrator.manifest import (
    AiAgentStep,
    BuildStep,
    ScriptStep,
    StepResult,
    WorkflowManifest,
)

from tests.conftest import task_build_config
# --------------------------- end-to-end: swapped ids -------------------------


class _SpineStubs:
    """Happy-path spine stubs. implementation_task / qa raise if called, so a
    test can prove a swapped build never touches the built-in agents."""

    def __init__(self) -> None:
        self.builtin_impl_calls = 0
        self.builtin_qa_calls = 0

    async def plan(self, request, model="claude-sonnet-4-6") -> PlanResult:
        return PlanResult(title="t", type="feature", plan_text="p")

    def create_branch(self, plan, max_slug_length=50, thread_id="") -> str:
        return "feature/test"

    async def implementation_task(self, plan_text, feedback=None, model="claude-sonnet-4-6"):
        self.builtin_impl_calls += 1
        return StepResult(step_id="implementation", kind="ai_agent", ok=True)

    async def qa(self, plan, model="claude-sonnet-4-6") -> QaResult:
        self.builtin_qa_calls += 1
        return QaResult(result="PASS")

    def commit(self, branch, title, summary, base_branch="main") -> str:
        return "abc123"

    def push(self, branch, base_branch="main", auto_rebase=True) -> None:
        pass

    def pr_create(self, branch, title, summary, test_plan, base_branch="main", draft=False, reviewers=None, labels=None) -> str:
        return "https://github.com/test/pr/1"

    def verify_clean_tree(self) -> None:
        pass

    def ensure_on_main(self, base_branch: str = "main") -> None:
        pass


def _patch_spine(stubs, monkeypatch):
    monkeypatch.setattr("orchestrator.workflow.plan", stubs.plan)
    monkeypatch.setattr("orchestrator.workflow.create_branch", stubs.create_branch)
    monkeypatch.setattr("orchestrator.workflow.implementation_task", stubs.implementation_task)
    monkeypatch.setattr("orchestrator.workflow.qa", stubs.qa)
    monkeypatch.setattr("orchestrator.workflow.commit", stubs.commit)
    monkeypatch.setattr("orchestrator.workflow.push", stubs.push)
    monkeypatch.setattr("orchestrator.workflow.pr_create", stubs.pr_create)
    monkeypatch.setattr("orchestrator.workflow.verify_clean_tree", stubs.verify_clean_tree)
    monkeypatch.setattr("orchestrator.workflow.ensure_on_main", stubs.ensure_on_main)


async def _run(monkeypatch, tmp_path, manifest, *, oc, fake_ai=None, fake_script=None):
    stubs = _SpineStubs()
    _patch_spine(stubs, monkeypatch)
    monkeypatch.setattr("orchestrator.workflow.load_manifest", lambda *a, **k: manifest)
    if fake_ai is not None:
        monkeypatch.setattr("orchestrator.workflow.execute_ai_agent", fake_ai)
    if fake_script is not None:
        monkeypatch.setattr("orchestrator.workflow.execute_script", fake_script)

    from orchestrator.workflow import build_workflow

    config = {"configurable": {"thread_id": f"test-{uuid.uuid4().hex[:8]}"}}
    async with build_workflow(db_path=str(tmp_path / "ckpt.db"), config=oc) as workflow:
        result = await workflow.ainvoke("req", config=config)  # plan approval
        result = await workflow.ainvoke(Command(resume="yes"), config=config)
    return result, stubs


@pytest.mark.asyncio
async def test_swapped_producer_and_gate_run_end_to_end(monkeypatch, tmp_path):
    # Phase 56: the per-task station swaps BOTH ids via [workflow.task_build]:
    # produce=["my-coder"], gate=["my-qa"], each an ai_agent def. The station runs
    # them on the generic engine; the built-in implementation/QA agents are never
    # called, and the success dict carries qa=None (no built-in QA verdict).
    manifest = WorkflowManifest(
        defs={
            "my-coder": AiAgentStep(id="my-coder", agent=".orchestrator/agents/coder.md"),
            "my-qa": AiAgentStep(id="my-qa", agent=".orchestrator/agents/qa.md"),
        },
    )

    agent_calls: list[tuple[str, bool]] = []

    async def fake_ai(step, project_root, plan_text, *, feedback=None, as_gate=False):
        agent_calls.append((step.id, as_gate))
        if as_gate:
            return StepResult(step_id=step.id, kind="ai_agent", ok=True, passed=True, detail="")
        return StepResult(step_id=step.id, kind="ai_agent", ok=True, detail="coded")

    result, stubs = await _run(
        monkeypatch, tmp_path, manifest, fake_ai=fake_ai,
        oc=task_build_config(produce=["my-coder"], gate=["my-qa"]),
    )

    assert result["status"] == "succeeded"
    assert ("my-coder", False) in agent_calls  # producer ran
    assert ("my-qa", True) in agent_calls  # gate ran as a gate
    assert stubs.builtin_impl_calls == 0  # built-in producer untouched
    assert stubs.builtin_qa_calls == 0  # built-in QA untouched
    assert result["qa"] is None  # no built-in QA verdict to report


@pytest.mark.asyncio
async def test_steps_defs_qa_overrides_builtin_gate(monkeypatch, tmp_path):
    # Phase 56: the station's gate=["qa"] AND a [steps.defs.qa] entry resolves "qa"
    # to the user's def (in defs wins over the built-in), so the built-in QA agent
    # does not run. The producer stays the built-in implementation.
    manifest = WorkflowManifest(
        defs={"qa": ScriptStep(id="qa", path="qa.sh")},
    )

    script_gate_calls = 0

    async def fake_script(step, repo_root, *, as_gate=False):
        nonlocal script_gate_calls
        if as_gate:
            script_gate_calls += 1
            return StepResult(step_id=step.id, kind="script", ok=True, passed=True, detail="")
        return StepResult(step_id=step.id, kind="script", ok=True)

    result, stubs = await _run(
        monkeypatch, tmp_path, manifest, fake_script=fake_script,
        oc=task_build_config(produce=["implementation"], gate=["qa"]),
    )

    assert result["status"] == "succeeded"
    assert script_gate_calls == 1  # the user's qa.sh gate ran
    assert stubs.builtin_qa_calls == 0  # built-in QA agent overridden
    assert stubs.builtin_impl_calls == 1  # built-in producer still ran
    assert result["qa"] is None  # the built-in QA verdict holder was never set
