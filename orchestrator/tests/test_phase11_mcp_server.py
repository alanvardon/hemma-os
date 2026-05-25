"""Phase 11 MCP server tool tests.

Verifies the two tool functions against stubbed workflow internals:
- implement_feature returns awaiting_approval with the plan + thread_id
- approve_plan("yes") completes the workflow and returns the PR URL
- approve_plan(feedback) triggers a re-plan and returns awaiting_approval again

The @mcp.tool() decorator returns the original function, so we can call
implement_feature / approve_plan directly in tests without spinning up
the MCP transport layer.
"""

from pathlib import Path

import pytest

from orchestrator.agents.implementation import ImplementationResult
from orchestrator.agents.planning import PlanResult
from orchestrator.agents.qa import QaResult


class _Stubs:
    def __init__(self) -> None:
        self.plan_calls: list[str] = []
        self.commit_called = False

    def verify_clean_tree(self) -> None:
        pass

    async def plan(self, request: str) -> PlanResult:
        self.plan_calls.append(request)
        n = len(self.plan_calls)
        return PlanResult(title=f"title-{n}", type="feature", plan_text=f"plan-{n}")

    def create_branch(self, plan: PlanResult) -> str:
        return "feature/test"

    async def implement(self, plan, mode="implement", qa_failures=None):
        return ImplementationResult(summary="s", test_plan="tp")

    async def qa(self, plan) -> QaResult:
        return QaResult(result="PASS")

    def commit_and_pr(self, branch, title, summary, test_plan) -> str:
        self.commit_called = True
        return "https://github.com/test/pr/1"


def _patch(stubs: _Stubs, monkeypatch, tmp_path: Path) -> None:
    # Stub the agents/git layer.
    monkeypatch.setattr("orchestrator.workflow.verify_clean_tree", stubs.verify_clean_tree)
    monkeypatch.setattr("orchestrator.workflow.plan", stubs.plan)
    monkeypatch.setattr("orchestrator.workflow.create_branch", stubs.create_branch)
    monkeypatch.setattr("orchestrator.workflow.implement", stubs.implement)
    monkeypatch.setattr("orchestrator.workflow.qa", stubs.qa)
    monkeypatch.setattr("orchestrator.workflow.commit_and_pr", stubs.commit_and_pr)

    # The MCP tools call build_workflow() with no args, so it uses the
    # default db_path ".orchestrator/checkpoints.db" — relative to cwd.
    # Redirect cwd to tmp_path so the DB lands there and each test starts
    # with a fresh checkpoint store.
    monkeypatch.chdir(tmp_path)
    Path(".orchestrator").mkdir(exist_ok=True)


@pytest.mark.asyncio
async def test_implement_feature_returns_awaiting_approval(monkeypatch, tmp_path):
    stubs = _Stubs()
    _patch(stubs, monkeypatch, tmp_path)

    from orchestrator.mcp_server import implement_feature

    result = await implement_feature("add a tooltip")

    assert result["status"] == "awaiting_approval"
    assert result["thread_id"].startswith("run-")
    assert result["plan"]["plan_text"] == "plan-1"
    assert result["plan"]["title"] == "title-1"
    assert "next" in result
    # The workflow ran planning but should NOT have committed anything
    # before approval.
    assert stubs.commit_called is False


@pytest.mark.asyncio
async def test_approve_plan_yes_completes_workflow(monkeypatch, tmp_path):
    stubs = _Stubs()
    _patch(stubs, monkeypatch, tmp_path)

    from orchestrator.mcp_server import approve_plan, implement_feature

    pending = await implement_feature("add a tooltip")
    thread_id = pending["thread_id"]

    final = await approve_plan(thread_id, "yes")

    assert final["status"] == "succeeded"
    assert final["pr_url"] == "https://github.com/test/pr/1"
    assert final["branch"] == "feature/test"
    assert stubs.commit_called is True


@pytest.mark.asyncio
async def test_approve_plan_feedback_triggers_replan(monkeypatch, tmp_path):
    stubs = _Stubs()
    _patch(stubs, monkeypatch, tmp_path)

    from orchestrator.mcp_server import approve_plan, implement_feature

    pending = await implement_feature("add a tooltip")
    thread_id = pending["thread_id"]
    assert pending["plan"]["plan_text"] == "plan-1"

    # Feedback reply: should re-plan and surface the revised plan.
    revised = await approve_plan(thread_id, "also make it dismissible")

    assert revised["status"] == "awaiting_approval"
    assert revised["thread_id"] == thread_id
    assert revised["plan"]["plan_text"] == "plan-2"
    assert "Feedback: also make it dismissible" in stubs.plan_calls[1]
    assert stubs.commit_called is False

    # Approve the revised plan: should now complete.
    final = await approve_plan(thread_id, "yes")
    assert final["status"] == "succeeded"
    assert stubs.commit_called is True
