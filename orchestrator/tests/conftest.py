"""Shared pytest fixtures.

Two autouse fixtures keep the workflow tests hermetic:

- _isolate_runs_dir redirects run-artifact writes into
  .orchestrator/runs/developer_tests/ so they don't mix with real runs.
  Without it, tests that drive build_workflow would leak `test-<uuid>/`
  folders alongside the real `run-<uuid>-<slug>/` ones.

- _isolate_manifest makes load_manifest() return a manifest with ONLY the
  spine's impl⇄QA build (no pluggable seam steps), so the suite never depends
  on whatever pluggable steps happen to be configured in the real
  orchestrator.toml. Without it, enabling a live ai_agent step in
  orchestrator.toml would make full-workflow tests spawn a real Claude agent
  (slow, flaky, a network dependency). Phase 47: the build is no longer
  synthesized, so this fixture supplies it explicitly — that's what makes the
  implementation⇄QA loop run in full-workflow tests. Tests that exercise
  specific steps override this with their own monkeypatch (which runs after
  this fixture and wins); use with_standard_build() to keep the build present.
"""

import pytest

from orchestrator.manifest import BuildStep, RetryConfig, WorkflowManifest
from orchestrator.paths import find_project_root


def standard_build(human_in_loop: dict | None = None) -> BuildStep:
    """The spine's impl⇄QA build step (Phase 47: declared, not synthesized).

    The real orchestrator.toml declares this exact block as the first
    [[steps.work]] entry. Tests run with no orchestrator.toml, so the manifest
    fixtures inject it. Pass `human_in_loop` (Phase 51), e.g.
    {"on_gate_fail": True}, to turn on the build's per-step pauses."""
    kwargs: dict = {}
    if human_in_loop is not None:
        kwargs["human_in_loop"] = human_in_loop
    return BuildStep(
        id="build",
        produce=["implementation"],
        gate=["qa"],
        retry=RetryConfig(max=3, on_exhausted="abort"),
        **kwargs,
    )


def with_standard_build(
    manifest: WorkflowManifest | None = None, human_in_loop: dict | None = None
) -> WorkflowManifest:
    """Return `manifest` with the standard impl⇄QA build prepended to the `work` list.

    For tests that override load_manifest with their own work steps but still
    need the spine's build to run (pre-47 they relied on the synthesized default;
    now the build is explicit, so it must be present in the manifest). Pass
    `human_in_loop` to enable the build's per-step pauses (Phase 51)."""
    if manifest is None:
        return WorkflowManifest(steps={"work": [standard_build(human_in_loop)]})
    steps = {k: list(v) for k, v in manifest.steps.items()}
    steps["work"] = [standard_build(human_in_loop), *steps.get("work", [])]
    return WorkflowManifest(steps=steps, defs=manifest.defs)


def task_build_config(
    *,
    human_in_loop: dict | None = None,
    on_exhausted: str | None = None,
    max_retries: int | None = None,
    produce: list[str] | None = None,
    gate: list[str] | None = None,
):
    """Phase 56: an OrchestratorConfig whose per-task station ([workflow.task_build])
    carries the given overrides — pass it to build_workflow(config=...).

    This is the replacement for the pre-56 with_standard_build(human_in_loop=...):
    the impl⇄QA loop is no longer a work-list build, it's the per-task station, so
    its retry/pauses/producer/gate are configured here. `on_exhausted="abort"`
    restores the pre-56 hard-abort-on-exhaustion for tests that assert that path
    (the new default is the Phase 52 pause-and-ask)."""
    from orchestrator.config import OrchestratorConfig
    from orchestrator.manifest import HumanInLoopConfig

    cfg = OrchestratorConfig()
    tb = cfg.workflow.task_build
    retry_updates = {
        k: v
        for k, v in (("on_exhausted", on_exhausted), ("max", max_retries))
        if v is not None
    }
    tb_updates: dict = {"retry": tb.retry.model_copy(update=retry_updates)}
    if human_in_loop is not None:
        tb_updates["human_in_loop"] = HumanInLoopConfig(**human_in_loop)
    if produce is not None:
        tb_updates["produce"] = produce
    if gate is not None:
        tb_updates["gate"] = gate
    new_tb = tb.model_copy(update=tb_updates)
    return cfg.model_copy(
        update={"workflow": cfg.workflow.model_copy(update={"task_build": new_tb})}
    )


@pytest.fixture(autouse=True)
def _isolate_runs_dir(monkeypatch):
    runs = find_project_root() / ".orchestrator" / "runs" / "developer_tests"
    monkeypatch.setattr(
        "orchestrator.run_artifacts._runs_dir",
        lambda: runs,
    )


@pytest.fixture(autouse=True)
def _isolate_manifest(monkeypatch):
    # Phase 56: the impl⇄QA loop is no longer a [[steps.work]] build — it's run
    # per-task by the built-in station (driven by [workflow.task_build] + the
    # stubbed decomposer's task list). So the default test manifest is EMPTY: the
    # station provides the implementation; the work list is only for extra user
    # steps. Tests that exercise user work steps override this with their own
    # monkeypatch (which runs after this fixture and wins).
    monkeypatch.setattr(
        "orchestrator.workflow.load_manifest",
        lambda *a, **k: WorkflowManifest(),
    )


@pytest.fixture(autouse=True)
def _stub_docs_task(monkeypatch):
    """Phase 41: docs_task is now a mandatory spine step that would spawn a real
    Claude agent. Stub it for the whole suite so full-workflow tests never hit a
    live model. Tests that exercise docs specifically override this with their
    own monkeypatch (which runs after this fixture and wins)."""
    from orchestrator.manifest import StepResult

    async def _fake_docs_task(plan_text, model="claude-haiku-4-5-20251001"):
        return StepResult(
            step_id="docs", kind="ai_agent", ok=True,
            detail="(docs stubbed in tests)", usage=None,
        )

    monkeypatch.setattr("orchestrator.workflow.docs_task", _fake_docs_task)


@pytest.fixture(autouse=True)
def _stub_summarize_task(monkeypatch):
    """Phase 42: summarize_task is a mandatory spine step (runs after the retry
    block, before commit) that would spawn a real Claude agent. Stub it for the
    whole suite so full-workflow tests never hit a live model. It supplies the
    commit/PR summary + test_plan; tests that assert on those override this with
    their own monkeypatch (which runs after this fixture and wins)."""
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
    """Phase 55: the decomposer runs after planning on every full-workflow run and
    would spawn a real Claude call. Stub it suite-wide (at the function level, so
    the real decompose_task wiring still exercises) returning a single-task list —
    the n=1 case, which keeps existing full-workflow tests behaving as before.
    Tests that exercise decomposition override this with their own monkeypatch."""
    from orchestrator.agents.decompose import DecompositionResult, Task

    async def _fake_decompose(plan_text, model="claude-sonnet-4-6", max_tasks=0):
        return DecompositionResult(
            tasks=[Task(id="task-1", title="The change", description=plan_text)],
            usage=None,
        )

    monkeypatch.setattr("orchestrator.workflow.decompose", _fake_decompose)
