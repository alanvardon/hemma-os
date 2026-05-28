"""Shared pytest fixtures.

Autouse fixture redirects run-artifact writes from the orchestrator's
unit-test suite into .orchestrator/runs/developer_tests/ so they're
cleanly namespaced and don't mix with real production runs.

Without this, tests that drive build_workflow without isolating CWD
would leak `test-<uuid>/` folders directly into .orchestrator/runs/,
sitting alongside the real `run-<uuid>-<slug>/` folders.
"""

import pytest

from orchestrator.paths import find_project_root


@pytest.fixture(autouse=True)
def _isolate_runs_dir(monkeypatch):
    runs = find_project_root() / ".orchestrator" / "runs" / "developer_tests"
    monkeypatch.setattr(
        "orchestrator.run_artifacts._runs_dir",
        lambda: runs,
    )
