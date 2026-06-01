"""Phase 46c — pluggable producer + the after_branch build seam.

The impl⇄QA loop is no longer inline in the workflow body: it runs through
run_seam("after_branch") as a declarative `build` step. With no
[[steps.after_branch]] build declared, the spine synthesizes the default one
(produce=["implementation"], gate=["qa"]) so zero-config reproduces the old
loop exactly (covered by test_phase7 / test_phase42_spine_gates, which run with
no orchestrator.toml). These tests cover the new degrees of freedom:

1. _ensure_default_build synthesizes the default build only when the project
   declares none.
2. A user-declared after_branch build with SWAPPED producer + gate ids runs
   end-to-end on the generic engine — the built-in implementation/QA agents are
   never touched.
3. Declaring a [steps.defs.*] entry whose id IS a built-in (`qa`) overrides the
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
from orchestrator.workflow import _DEFAULT_BUILD_ID, _ensure_default_build


# --------------------------- _ensure_default_build ---------------------------


def test_default_build_synthesized_when_absent():
    m = WorkflowManifest()
    m2, injected = _ensure_default_build(m, max_retries=5)
    assert injected is True
    builds = [s for s in m2.for_seam("after_branch") if isinstance(s, BuildStep)]
    assert len(builds) == 1
    assert builds[0].id == _DEFAULT_BUILD_ID
    assert builds[0].produce == ["implementation"]
    assert builds[0].gate == ["qa"]
    assert builds[0].retry.max == 5  # taken from [workflow.qa].max_retries
    assert builds[0].retry.on_exhausted == "abort"
    # The original manifest is not mutated.
    assert m.for_seam("after_branch") == []


def test_default_build_not_synthesized_when_user_declares_one():
    user = BuildStep(id="mybuild", produce=["coder"], gate=["check"])
    m = WorkflowManifest(steps={"after_branch": [user]})
    m2, injected = _ensure_default_build(m, max_retries=3)
    assert injected is False
    assert m2 is m  # returned unchanged
    builds = [s for s in m2.for_seam("after_branch") if isinstance(s, BuildStep)]
    assert [b.id for b in builds] == ["mybuild"]


def test_default_build_prepended_before_other_after_branch_steps():
    # A non-build step at after_branch (e.g. a approval_gate) coexists with the
    # synthesized default build, which is ordered FIRST.
    from orchestrator.manifest import ApprovalGateStep

    gate = ApprovalGateStep(id="signoff", ask="ok?")
    m = WorkflowManifest(steps={"after_branch": [gate]})
    m2, injected = _ensure_default_build(m, max_retries=3)
    assert injected is True
    seam = m2.for_seam("after_branch")
    assert isinstance(seam[0], BuildStep)
    assert seam[1] is gate


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


async def _run(monkeypatch, tmp_path, manifest, *, fake_ai=None, fake_script=None):
    stubs = _SpineStubs()
    _patch_spine(stubs, monkeypatch)
    monkeypatch.setattr("orchestrator.workflow.load_manifest", lambda *a, **k: manifest)
    if fake_ai is not None:
        monkeypatch.setattr("orchestrator.workflow.execute_ai_agent", fake_ai)
    if fake_script is not None:
        monkeypatch.setattr("orchestrator.workflow.execute_script", fake_script)

    from orchestrator.workflow import build_workflow

    config = {"configurable": {"thread_id": f"test-{uuid.uuid4().hex[:8]}"}}
    async with build_workflow(db_path=str(tmp_path / "ckpt.db")) as workflow:
        result = await workflow.ainvoke("req", config=config)  # plan approval
        result = await workflow.ainvoke(Command(resume="yes"), config=config)
    return result, stubs


@pytest.mark.asyncio
async def test_swapped_producer_and_gate_run_end_to_end(monkeypatch, tmp_path):
    # A user after_branch build swaps BOTH ids: produce=["my-coder"],
    # gate=["my-qa"], each an ai_agent def. The build runs them on the generic
    # engine; the built-in implementation/QA agents are never called, and the
    # success dict carries qa=None (no built-in QA verdict was produced).
    manifest = WorkflowManifest(
        steps={
            "after_branch": [
                BuildStep(id="build", produce=["my-coder"], gate=["my-qa"])
            ]
        },
        defs={
            "my-coder": AiAgentStep(id="my-coder", agent="coder.md", dir=".orchestrator/agents"),
            "my-qa": AiAgentStep(id="my-qa", agent="qa.md", dir=".orchestrator/agents"),
        },
    )

    agent_calls: list[tuple[str, bool]] = []

    async def fake_ai(step, project_root, plan_text, *, feedback=None, as_gate=False):
        agent_calls.append((step.id, as_gate))
        if as_gate:
            return StepResult(step_id=step.id, kind="ai_agent", ok=True, passed=True, detail="")
        return StepResult(step_id=step.id, kind="ai_agent", ok=True, detail="coded")

    result, stubs = await _run(monkeypatch, tmp_path, manifest, fake_ai=fake_ai)

    assert result["status"] == "succeeded"
    assert ("my-coder", False) in agent_calls  # producer ran
    assert ("my-qa", True) in agent_calls  # gate ran as a gate
    assert stubs.builtin_impl_calls == 0  # built-in producer untouched
    assert stubs.builtin_qa_calls == 0  # built-in QA untouched
    assert result["qa"] is None  # no built-in QA verdict to report


@pytest.mark.asyncio
async def test_steps_defs_qa_overrides_builtin_gate(monkeypatch, tmp_path):
    # A build with gate=["qa"] AND a [steps.defs.qa] entry resolves "qa" to the
    # user's def (in defs wins over the built-in), so the built-in QA agent does
    # not run. The producer stays the built-in implementation.
    manifest = WorkflowManifest(
        steps={
            "after_branch": [
                BuildStep(id="build", produce=["implementation"], gate=["qa"])
            ]
        },
        defs={"qa": ScriptStep(id="qa", path="qa.sh")},
    )

    script_gate_calls = 0

    async def fake_script(step, repo_root, *, as_gate=False):
        nonlocal script_gate_calls
        if as_gate:
            script_gate_calls += 1
            return StepResult(step_id=step.id, kind="script", ok=True, passed=True, detail="")
        return StepResult(step_id=step.id, kind="script", ok=True)

    result, stubs = await _run(monkeypatch, tmp_path, manifest, fake_script=fake_script)

    assert result["status"] == "succeeded"
    assert script_gate_calls == 1  # the user's qa.sh gate ran
    assert stubs.builtin_qa_calls == 0  # built-in QA agent overridden
    assert stubs.builtin_impl_calls == 1  # built-in producer still ran
    assert result["qa"] is None  # the built-in QA verdict holder was never set
