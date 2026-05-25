"""Phase 7 retry-loop control-flow tests.

Stub the 5 agent/git functions so the workflow runs against scripted
outcomes — no LLM calls, no git operations, no token cost. Asserts
the for/else flow, mode switching ("implement" -> "fix"), qa_failures
threading on retries, and the final status branch (succeeded vs failed).

Run with:
    pytest tests/test_phase7_retry_loop.py -v
"""

import uuid
from pathlib import Path

import pytest

from orchestrator.agents.planning import PlanResult
from orchestrator.agents.implementation import ImplementationResult
from orchestrator.agents.qa import QaResult


class _Stubs:
    """Recorder + scripted-response object for the 5 patched functions.

    The workflow's @task wrappers resolve `plan`, `implement`, `qa`,
    `create_branch`, `commit_and_pr` from orchestrator.workflow's
    module globals at call time, so monkey-patching those names on
    that module is sufficient — no need to touch the agent modules.
    """

    def __init__(self, qa_verdicts: list[QaResult]) -> None:
        self.qa_verdicts = qa_verdicts
        self.impl_calls: list[tuple[str, str | None]] = []
        self.qa_call_count = 0
        self.commit_called = False

    async def plan(self, request: str) -> PlanResult:
        return PlanResult(title="t", type="feature", plan_text="p")

    def create_branch(self, plan: PlanResult) -> str:
        return "feature/test"

    async def implement(
        self,
        plan: PlanResult,
        mode: str = "implement",
        qa_failures: str | None = None,
    ) -> ImplementationResult:
        self.impl_calls.append((mode, qa_failures))
        n = len(self.impl_calls)
        return ImplementationResult(summary=f"s{n}", test_plan=f"tp{n}")

    async def qa(self, plan: PlanResult) -> QaResult:
        verdict = self.qa_verdicts[self.qa_call_count]
        self.qa_call_count += 1
        return verdict

    def commit_and_pr(
        self, branch: str, title: str, summary: str, test_plan: str
    ) -> str:
        self.commit_called = True
        return "https://github.com/test/pr/1"

    def verify_clean_tree(self) -> None:
        # No-op: tests don't depend on the real working tree state.
        pass


async def _run(stubs: _Stubs, monkeypatch, tmp_path: Path) -> dict:
    monkeypatch.setattr("orchestrator.workflow.plan", stubs.plan)
    monkeypatch.setattr(
        "orchestrator.workflow.create_branch", stubs.create_branch
    )
    monkeypatch.setattr("orchestrator.workflow.implement", stubs.implement)
    monkeypatch.setattr("orchestrator.workflow.qa", stubs.qa)
    monkeypatch.setattr(
        "orchestrator.workflow.commit_and_pr", stubs.commit_and_pr
    )
    monkeypatch.setattr(
        "orchestrator.workflow.verify_clean_tree", stubs.verify_clean_tree
    )

    from orchestrator.workflow import build_workflow
    from langgraph.types import Command

    # Fresh thread_id per test so the checkpointer doesn't replay a
    # prior run's state. Fresh DB per test (tmp_path) for the same reason.
    config = {"configurable": {"thread_id": f"test-{uuid.uuid4().hex[:8]}"}}
    async with build_workflow(db_path=str(tmp_path / "ckpt.db")) as workflow:
        # Phase 8 added a plan-approval interrupt before the retry loop.
        # Auto-approve it so Phase 7 tests stay focused on retry-loop logic.
        result = await workflow.ainvoke("test request", config=config)
        if "__interrupt__" in result:
            result = await workflow.ainvoke(Command(resume="yes"), config=config)
        return result


@pytest.mark.asyncio
async def test_pass_on_first_attempt(monkeypatch, tmp_path):
    stubs = _Stubs([QaResult(result="PASS")])
    result = await _run(stubs, monkeypatch, tmp_path)

    assert result["status"] == "succeeded"
    assert result["pr_url"] == "https://github.com/test/pr/1"
    assert result["branch"] == "feature/test"
    assert stubs.impl_calls == [("implement", None)]
    assert stubs.qa_call_count == 1
    assert stubs.commit_called is True


@pytest.mark.asyncio
async def test_fail_then_pass_on_second_attempt(monkeypatch, tmp_path):
    stubs = _Stubs(
        [
            QaResult(result="FAIL", failures="missing reset wiring"),
            QaResult(result="PASS"),
        ]
    )
    result = await _run(stubs, monkeypatch, tmp_path)

    assert result["status"] == "succeeded"
    assert stubs.impl_calls == [
        ("implement", None),
        ("fix", "missing reset wiring"),
    ]
    assert stubs.qa_call_count == 2
    assert stubs.commit_called is True


@pytest.mark.asyncio
async def test_fail_fail_then_pass_on_third_attempt(monkeypatch, tmp_path):
    stubs = _Stubs(
        [
            QaResult(result="FAIL", failures="fail 1"),
            QaResult(result="FAIL", failures="fail 2"),
            QaResult(result="PASS"),
        ]
    )
    result = await _run(stubs, monkeypatch, tmp_path)

    assert result["status"] == "succeeded"
    assert stubs.impl_calls == [
        ("implement", None),
        ("fix", "fail 1"),
        ("fix", "fail 2"),
    ]
    assert stubs.qa_call_count == 3
    assert stubs.commit_called is True


@pytest.mark.asyncio
async def test_all_three_attempts_fail(monkeypatch, tmp_path):
    stubs = _Stubs(
        [
            QaResult(result="FAIL", failures="fail 1"),
            QaResult(result="FAIL", failures="fail 2"),
            QaResult(result="FAIL", failures="fail 3"),
        ]
    )
    result = await _run(stubs, monkeypatch, tmp_path)

    # for/else: loop exhausted without break -> failed branch returns
    # without ever calling commit_and_pr_task. A broken PR is worse
    # than no PR.
    assert result["status"] == "failed"
    assert result["qa_failures"] == "fail 3"
    assert result["branch"] == "feature/test"
    assert "pr_url" not in result
    assert stubs.impl_calls == [
        ("implement", None),
        ("fix", "fail 1"),
        ("fix", "fail 2"),
    ]
    assert stubs.qa_call_count == 3
    assert stubs.commit_called is False
