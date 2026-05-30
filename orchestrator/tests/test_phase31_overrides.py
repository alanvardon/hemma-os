"""Tests for orchestrator.config.apply_overrides — per-invocation overrides (Phase 31).

Covers the resolution order (kwarg > env var > config), env-var parsing for
each knob, and the invariants: the input config isn't mutated, and an
unchanged config is returned by identity when nothing overrides anything.
"""

import pytest

from orchestrator.config import (
    ENV_APPROVE_PLAN,
    ENV_BASE_BRANCH,
    ENV_MAX_RETRIES,
    OrchestratorConfig,
    apply_overrides,
)


def _base() -> OrchestratorConfig:
    return OrchestratorConfig()


# ---------------------------------------------------------------------------
# kwarg path
# ---------------------------------------------------------------------------


def test_kwarg_overrides_approve_plan():
    cfg = apply_overrides(_base(), approve_plan=False)
    assert cfg.workflow.planning.human_in_loop is False


def test_kwarg_overrides_max_retries():
    cfg = apply_overrides(_base(), max_retries=7)
    assert cfg.workflow.qa.max_retries == 7


def test_kwarg_overrides_base_branch():
    cfg = apply_overrides(_base(), base_branch="develop")
    assert cfg.pr.base_branch == "develop"


def test_kwarg_wins_over_env_var(monkeypatch):
    monkeypatch.setenv(ENV_APPROVE_PLAN, "true")
    cfg = apply_overrides(_base(), approve_plan=False)
    assert cfg.workflow.planning.human_in_loop is False


# ---------------------------------------------------------------------------
# env var path
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("value,expected", [
    ("true", True), ("True", True), ("TRUE", True), ("1", True),
    ("yes", True), ("on", True),
    ("false", False), ("False", False), ("0", False),
    ("no", False), ("off", False),
])
def test_env_var_approve_plan_accepted_values(monkeypatch, value, expected):
    monkeypatch.setenv(ENV_APPROVE_PLAN, value)
    cfg = apply_overrides(_base())
    assert cfg.workflow.planning.human_in_loop is expected


def test_env_var_max_retries(monkeypatch):
    monkeypatch.setenv(ENV_MAX_RETRIES, "5")
    cfg = apply_overrides(_base())
    assert cfg.workflow.qa.max_retries == 5


def test_env_var_base_branch(monkeypatch):
    monkeypatch.setenv(ENV_BASE_BRANCH, "develop")
    cfg = apply_overrides(_base())
    assert cfg.pr.base_branch == "develop"


def test_env_var_used_when_kwarg_is_none(monkeypatch):
    # All three env vars set; no kwargs passed; all should apply.
    monkeypatch.setenv(ENV_APPROVE_PLAN, "false")
    monkeypatch.setenv(ENV_MAX_RETRIES, "9")
    monkeypatch.setenv(ENV_BASE_BRANCH, "trunk")
    cfg = apply_overrides(_base())
    assert cfg.workflow.planning.human_in_loop is False
    assert cfg.workflow.qa.max_retries == 9
    assert cfg.pr.base_branch == "trunk"


# ---------------------------------------------------------------------------
# defaults / no-op
# ---------------------------------------------------------------------------


def test_no_kwargs_no_env_returns_config_unchanged(monkeypatch):
    # Defensive: ensure env vars from the test runner aren't leaking in.
    monkeypatch.delenv(ENV_APPROVE_PLAN, raising=False)
    monkeypatch.delenv(ENV_MAX_RETRIES, raising=False)
    monkeypatch.delenv(ENV_BASE_BRANCH, raising=False)
    original = _base()
    result = apply_overrides(original)
    # Same identity — no model_copy was triggered because nothing overrode.
    assert result is original


def test_input_config_not_mutated(monkeypatch):
    original = _base()
    apply_overrides(original, approve_plan=False, max_retries=99, base_branch="x")
    assert original.workflow.planning.human_in_loop is True
    assert original.workflow.qa.max_retries == 3
    assert original.pr.base_branch == "main"


# ---------------------------------------------------------------------------
# invalid env values
# ---------------------------------------------------------------------------


def test_invalid_bool_env_raises(monkeypatch):
    monkeypatch.setenv(ENV_APPROVE_PLAN, "maybe")
    with pytest.raises(ValueError, match=ENV_APPROVE_PLAN):
        apply_overrides(_base())


def test_invalid_int_env_raises(monkeypatch):
    monkeypatch.setenv(ENV_MAX_RETRIES, "two")
    with pytest.raises(ValueError, match=ENV_MAX_RETRIES):
        apply_overrides(_base())


def test_empty_base_branch_env_treated_as_unset(monkeypatch):
    monkeypatch.setenv(ENV_BASE_BRANCH, "   ")
    cfg = apply_overrides(_base())
    assert cfg.pr.base_branch == "main"
