"""Shared pytest fixtures.

Autouse fixtures keep the workflow tests hermetic and off the live models:

- _isolate_runs_dir redirects run-artifact writes into
  .orchestrator/runs/developer_tests/ so they don't mix with real runs.
  Without it, tests that drive build_workflow would leak `test-<uuid>/`
  folders alongside the real `run-<uuid>-<slug>/` ones.

- _stub_decompose / _stub_docs_task / _stub_summarize_task replace the three
  spine agents that would otherwise spawn a real Claude call on every
  full-workflow run. Tests that exercise one of them override it with their own
  monkeypatch (which runs after the autouse fixture and wins).

There is no manifest fixture in v2: the impl⇄QA loop is the built-in `task-build`
station (driven by the pipeline's task-build stage + the stubbed decomposer's task
list), not a [[steps.work]] build. task_build_config() builds an OrchestratorConfig
whose task-build stage carries per-test overrides — the v2 replacement for the old
with_standard_build(...) helper, with the same signature.
"""

import pytest

from orchestrator.paths import find_project_root


def task_build_config(
    *,
    human_in_loop: dict | None = None,
    on_exhausted: str | None = None,
    max_retries: int | None = None,
    produce: list[str] | None = None,
    gate: list[str] | None = None,
):
    """An OrchestratorConfig whose per-task `task-build` stage carries the given
    overrides — pass it to build_workflow(config=...).

    The v2 replacement for the old with_standard_build(human_in_loop=...): the
    impl⇄QA loop is the per-task station, so its retry/pauses/producer/gate are
    configured on the task-build stage. `on_exhausted="abort"` restores the
    hard-abort-on-exhaustion path (the default is pause-and-ask). produce/gate, if
    given, are v2-prefixed refs (e.g. ["builtin:implementation"], ["defs:lint"]).
    """
    from orchestrator.config import OrchestratorConfig
    from orchestrator.manifest import HumanInLoopConfig
    from orchestrator.pipeline import Pipeline

    cfg = OrchestratorConfig()  # the default pipeline
    tb = cfg.stage("task-build")
    retry_updates = {
        k: v
        for k, v in (("on_exhausted", on_exhausted), ("max", max_retries))
        if v is not None
    }
    updates: dict = {"retry": tb.retry.model_copy(update=retry_updates)}
    if human_in_loop is not None:
        updates["human_in_loop"] = HumanInLoopConfig(**human_in_loop)
    if produce is not None:
        updates["produce"] = produce
    if gate is not None:
        updates["gate"] = gate
    new_tb = tb.model_copy(update=updates)
    new_stages = tuple(new_tb if s.id == "task-build" else s for s in cfg.pipeline.stages)
    new_pipeline = Pipeline(
        flow=cfg.pipeline.flow, stages=new_stages, parts=cfg.pipeline.parts
    )
    return cfg.model_copy(update={"pipeline": new_pipeline})


@pytest.fixture(autouse=True)
def _isolate_runs_dir(monkeypatch):
    runs = find_project_root() / ".orchestrator" / "runs" / "developer_tests"
    monkeypatch.setattr(
        "orchestrator.run_artifacts._runs_dir",
        lambda: runs,
    )


@pytest.fixture(autouse=True)
def _stub_docs_task(monkeypatch):
    """docs is a mandatory spine stage that would spawn a real Claude agent. Stub
    it for the whole suite so full-workflow tests never hit a live model. Tests
    that exercise docs specifically override this with their own monkeypatch."""
    from orchestrator.manifest import StepResult

    async def _fake_docs_task(plan_text, model="claude-haiku-4-5-20251001"):
        return StepResult(
            step_id="docs", kind="ai_agent", ok=True,
            detail="(docs stubbed in tests)", usage=None,
        )

    monkeypatch.setattr("orchestrator.workflow.docs_task", _fake_docs_task)


@pytest.fixture(autouse=True)
def _stub_summarize_task(monkeypatch):
    """summarize is a mandatory spine stage (runs before the ship rails) that would
    spawn a real Claude agent. Stub it for the whole suite so full-workflow tests
    never hit a live model. It supplies the commit/PR summary + test_plan; tests
    that assert on those override this with their own monkeypatch."""
    from orchestrator.agents.summarize import SummaryResult

    async def _fake_summarize_task(plan_text, model="claude-haiku-4-5-20251001"):
        return SummaryResult(
            summary="(summary stubbed in tests)",
            test_plan="(test plan stubbed in tests)",
            usage=None,
        )

    monkeypatch.setattr("orchestrator.workflow.summarize_task", _fake_summarize_task)


@pytest.fixture(autouse=True)
def _stub_decompose(monkeypatch):
    """The decomposer runs after planning on every full-workflow run and would
    spawn a real Claude call. Stub it suite-wide (at the function level, so the
    real decompose_task wiring still exercises) returning a single-task list — the
    n=1 case, which keeps existing full-workflow tests behaving as before. Tests
    that exercise decomposition override this with their own monkeypatch."""
    from orchestrator.agents.decompose import DecompositionResult, Task

    async def _fake_decompose(plan_text, model="claude-sonnet-4-6", max_tasks=0, tdd=False):
        return DecompositionResult(
            tasks=[Task(id="task-1", title="The change", description=plan_text,
                        acceptance_criteria="the change is implemented")],
            usage=None,
        )

    monkeypatch.setattr("orchestrator.workflow.decompose", _fake_decompose)
