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


@pytest.fixture(autouse=True)
def _isolate_runs_dir(monkeypatch):
    runs = find_project_root() / ".orchestrator" / "runs" / "developer_tests"
    monkeypatch.setattr(
        "orchestrator.run_artifacts._runs_dir",
        lambda: runs,
    )


@pytest.fixture(autouse=True)
def _isolate_manifest(monkeypatch):
    monkeypatch.setattr(
        "orchestrator.workflow.load_manifest",
        lambda *a, **k: with_standard_build(),
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
