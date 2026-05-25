"""Phase 8 human-in-loop interrupt tests.

Verifies three scenarios:
1. Immediate approval ("yes") — workflow completes normally.
2. Feedback → re-plan → approval — planning runs twice, commit succeeds.
3. Feedback → re-plan → more feedback → approval — planning runs three times.

The workflow is driven via Command(resume=...) calls against the same
thread_id, matching how the MCP server and CLI will use it in production.
No LLM or git calls — same stub pattern as test_phase7_retry_loop.py.

LangGraph functional API interrupt behaviour (observed, not from docs):
ainvoke() does NOT raise GraphInterrupt. Instead it returns a dict:
  {'__interrupt__': [Interrupt(value={...}, id='...')]}
Resume by calling ainvoke(Command(resume=<value>), config=config).
"""

import uuid
from pathlib import Path

import pytest
from langgraph.types import Command, Interrupt

from orchestrator.agents.implementation import ImplementationResult
from orchestrator.agents.planning import PlanResult
from orchestrator.agents.qa import QaResult


class _Stubs:
    def __init__(self) -> None:
        self.plan_calls: list[str] = []
        self.impl_calls: list[tuple[str, str | None]] = []
        self.commit_called = False

    async def plan(self, request: str) -> PlanResult:
        self.plan_calls.append(request)
        # Return a distinct plan_text per call so tests can detect
        # which plan was surfaced at each interrupt.
        n = len(self.plan_calls)
        return PlanResult(title=f"title-{n}", type="feature", plan_text=f"plan-{n}")

    def create_branch(self, plan: PlanResult) -> str:
        return "feature/test"

    async def implement(self, plan, mode="implement", qa_failures=None):
        self.impl_calls.append((mode, qa_failures))
        n = len(self.impl_calls)
        return ImplementationResult(summary=f"s{n}", test_plan=f"tp{n}")

    async def qa(self, plan: PlanResult) -> QaResult:
        return QaResult(result="PASS")

    def commit_and_pr(self, branch, title, summary, test_plan) -> str:
        self.commit_called = True
        return "https://github.com/test/pr/1"

    def verify_clean_tree(self) -> None:
        pass


def _patch(stubs: _Stubs, monkeypatch) -> None:
    monkeypatch.setattr("orchestrator.workflow.plan", stubs.plan)
    monkeypatch.setattr("orchestrator.workflow.create_branch", stubs.create_branch)
    monkeypatch.setattr("orchestrator.workflow.implement", stubs.implement)
    monkeypatch.setattr("orchestrator.workflow.qa", stubs.qa)
    monkeypatch.setattr("orchestrator.workflow.commit_and_pr", stubs.commit_and_pr)
    monkeypatch.setattr(
        "orchestrator.workflow.verify_clean_tree", stubs.verify_clean_tree
    )


def _fresh_config() -> dict:
    return {"configurable": {"thread_id": f"test-{uuid.uuid4().hex[:8]}"}}


def _assert_interrupt(result: dict, expected_plan_text: str | None = None) -> None:
    """Assert result is an interrupt dict and optionally check the plan."""
    assert "__interrupt__" in result, f"Expected interrupt, got: {result}"
    interrupts: list[Interrupt] = result["__interrupt__"]
    assert interrupts[0].value["kind"] == "plan_approval"
    if expected_plan_text is not None:
        assert interrupts[0].value["plan"]["plan_text"] == expected_plan_text


@pytest.mark.asyncio
async def test_immediate_approval(monkeypatch, tmp_path):
    stubs = _Stubs()
    _patch(stubs, monkeypatch)

    from orchestrator.workflow import build_workflow

    config = _fresh_config()
    async with build_workflow(db_path=str(tmp_path / "ckpt.db")) as workflow:
        # First invocation: pauses at plan-approval, returns interrupt dict.
        result = await workflow.ainvoke("add a tooltip", config=config)
        _assert_interrupt(result, expected_plan_text="plan-1")

        # Approve: workflow completes end-to-end.
        result = await workflow.ainvoke(Command(resume="yes"), config=config)

    assert result["status"] == "succeeded"
    assert result["pr_url"] == "https://github.com/test/pr/1"
    assert stubs.plan_calls == ["add a tooltip"]
    assert stubs.impl_calls == [("implement", None)]
    assert stubs.commit_called is True


@pytest.mark.asyncio
async def test_feedback_triggers_replan_then_approval(monkeypatch, tmp_path):
    stubs = _Stubs()
    _patch(stubs, monkeypatch)

    from orchestrator.workflow import build_workflow

    config = _fresh_config()
    async with build_workflow(db_path=str(tmp_path / "ckpt.db")) as workflow:
        # First interrupt: original plan.
        result = await workflow.ainvoke("add a tooltip", config=config)
        _assert_interrupt(result, expected_plan_text="plan-1")

        # Feedback: triggers re-plan and surfaces the updated plan.
        result = await workflow.ainvoke(
            Command(resume="also make it dismissible"), config=config
        )
        _assert_interrupt(result, expected_plan_text="plan-2")

        # Approve the revised plan.
        result = await workflow.ainvoke(Command(resume="yes"), config=config)

    assert result["status"] == "succeeded"
    assert len(stubs.plan_calls) == 2
    assert stubs.plan_calls[0] == "add a tooltip"
    assert "Feedback: also make it dismissible" in stubs.plan_calls[1]
    assert stubs.commit_called is True


@pytest.mark.asyncio
async def test_two_rounds_of_feedback_then_approval(monkeypatch, tmp_path):
    stubs = _Stubs()
    _patch(stubs, monkeypatch)

    from orchestrator.workflow import build_workflow

    config = _fresh_config()
    async with build_workflow(db_path=str(tmp_path / "ckpt.db")) as workflow:
        result = await workflow.ainvoke("add a tooltip", config=config)
        _assert_interrupt(result)

        result = await workflow.ainvoke(
            Command(resume="also make it dismissible"), config=config
        )
        _assert_interrupt(result)

        result = await workflow.ainvoke(
            Command(resume="and animate it on entry"), config=config
        )
        _assert_interrupt(result)

        result = await workflow.ainvoke(Command(resume="yes"), config=config)

    assert result["status"] == "succeeded"
    assert len(stubs.plan_calls) == 3
    assert stubs.commit_called is True
