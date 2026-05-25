"""Pre-flight verify_clean_tree_task tests.

Verifies that a dirty working tree fails the workflow BEFORE any
planning LLM call is made — the whole point of the pre-flight check.
"""

import uuid
from pathlib import Path

import pytest
from langgraph.types import Command

from orchestrator.agents.implementation import ImplementationResult
from orchestrator.agents.planning import PlanResult
from orchestrator.agents.qa import QaResult
from orchestrator.git_ops import BranchCreationError


class _Stubs:
    def __init__(self, dirty: bool) -> None:
        self.dirty = dirty
        self.plan_called = False
        self.commit_called = False

    def verify_clean_tree(self) -> None:
        if self.dirty:
            raise BranchCreationError("working tree is dirty. [test fixture]")

    async def plan(self, request: str) -> PlanResult:
        self.plan_called = True
        return PlanResult(title="t", type="feature", plan_text="p")

    def create_branch(self, plan: PlanResult) -> str:
        return "feature/test"

    async def implement(self, plan, mode="implement", qa_failures=None):
        return ImplementationResult(summary="s", test_plan="tp")

    async def qa(self, plan) -> QaResult:
        return QaResult(result="PASS")

    def commit_and_pr(self, branch, title, summary, test_plan) -> str:
        self.commit_called = True
        return "https://github.com/test/pr/1"


def _patch(stubs: _Stubs, monkeypatch) -> None:
    monkeypatch.setattr(
        "orchestrator.workflow.verify_clean_tree", stubs.verify_clean_tree
    )
    monkeypatch.setattr("orchestrator.workflow.plan", stubs.plan)
    monkeypatch.setattr("orchestrator.workflow.create_branch", stubs.create_branch)
    monkeypatch.setattr("orchestrator.workflow.implement", stubs.implement)
    monkeypatch.setattr("orchestrator.workflow.qa", stubs.qa)
    monkeypatch.setattr("orchestrator.workflow.commit_and_pr", stubs.commit_and_pr)


@pytest.mark.asyncio
async def test_dirty_tree_fails_before_planning(monkeypatch, tmp_path):
    stubs = _Stubs(dirty=True)
    _patch(stubs, monkeypatch)

    from orchestrator.workflow import build_workflow

    config = {"configurable": {"thread_id": f"test-{uuid.uuid4().hex[:8]}"}}
    async with build_workflow(db_path=str(tmp_path / "ckpt.db")) as workflow:
        # The pre-flight check raises BranchCreationError. LangGraph
        # wraps it in its own task-failure machinery, so we just assert
        # the original is in the chain.
        with pytest.raises(BranchCreationError):
            await workflow.ainvoke("test request", config=config)

    # The single most important assertion: planning was NEVER called.
    # That's the entire point of the pre-flight check — fail fast,
    # before paying for any LLM tokens.
    assert stubs.plan_called is False
    assert stubs.commit_called is False


@pytest.mark.asyncio
async def test_clean_tree_proceeds_to_planning(monkeypatch, tmp_path):
    stubs = _Stubs(dirty=False)
    _patch(stubs, monkeypatch)

    from orchestrator.workflow import build_workflow

    config = {"configurable": {"thread_id": f"test-{uuid.uuid4().hex[:8]}"}}
    async with build_workflow(db_path=str(tmp_path / "ckpt.db")) as workflow:
        result = await workflow.ainvoke("test request", config=config)
        # Hits the plan-approval interrupt — auto-approve.
        if "__interrupt__" in result:
            result = await workflow.ainvoke(Command(resume="yes"), config=config)

    assert result["status"] == "succeeded"
    assert stubs.plan_called is True
    assert stubs.commit_called is True
