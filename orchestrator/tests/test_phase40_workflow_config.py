"""Phase 40 — [workflow.*] config schema consolidation tests.

Covers the new schema (per-step [workflow.<step>] tables, default_model
inheritance), the fail-loud extra="forbid" guard, the max_retries relocation,
the auto-derived PR label, the runner's wall-clock timeout, and the removal of
tool_profile.py. All LLM-free.
"""

import asyncio
import importlib
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from orchestrator.config import OrchestratorConfig, apply_overrides, load_config


# --------------------------- schema round-trip ---------------------------


def test_workflow_implementation_roundtrip(tmp_path):
    p = tmp_path / "orchestrator.toml"
    p.write_text(
        "[workflow.implementation]\n"
        'model = "claude-opus-4-7"\n'
        # human_in_loop on implementation/qa is rejected at load (Phase 51) —
        # the build's pauses live on the build step. Other fields still round-trip.
        "human_in_loop = false\n"
        'allowed_tools = ["Read", "Bash"]\n'
        'disallowed_tools = ["Write"]\n'
    )
    impl = load_config(p).workflow.implementation
    assert impl.model == "claude-opus-4-7"
    assert impl.human_in_loop is False
    assert impl.allowed_tools == ["Read", "Bash"]
    assert impl.disallowed_tools == ["Write"]


def test_workflow_defaults_when_absent(tmp_path):
    p = tmp_path / "orchestrator.toml"
    p.write_text('db_path = ".x/y.db"\n')  # unrelated valid key; no [workflow]
    cfg = load_config(p)
    assert cfg.workflow.planning.human_in_loop is True
    assert "Edit" in cfg.workflow.implementation.allowed_tools
    assert cfg.workflow.qa.allowed_tools == ["Read", "Grep", "Bash"]
    assert cfg.workflow.qa.max_retries == 3


def test_default_model_inheritance(tmp_path):
    p = tmp_path / "orchestrator.toml"
    p.write_text(
        'default_model = "claude-opus-4-7"\n'
        "[workflow.qa]\n"
        'model = "claude-haiku-4-5"\n'
    )
    cfg = load_config(p)
    # planning has no model → inherits default_model
    assert cfg.resolved_model(cfg.workflow.planning) == "claude-opus-4-7"
    # qa sets its own → overrides
    assert cfg.resolved_model(cfg.workflow.qa) == "claude-haiku-4-5"


def test_agents_dir_key_rejected(tmp_path):
    # The global agents_dir was removed — each ai_agent step now carries its own
    # `dir`. A stray top-level agents_dir must fail loud (extra="forbid").
    p = tmp_path / "orchestrator.toml"
    p.write_text('agents_dir = ".custom/agents"\n')
    with pytest.raises(ValidationError):
        load_config(p)


def test_workflow_docs_defaults_and_roundtrip(tmp_path):
    cfg = OrchestratorConfig()
    assert cfg.workflow.docs.model == "claude-haiku-4-5-20251001"
    assert cfg.workflow.docs.timeout == 120

    p = tmp_path / "orchestrator.toml"
    p.write_text('[workflow.docs]\nmodel = "claude-sonnet-4-6"\ntimeout = 300\n')
    docs = load_config(p).workflow.docs
    assert docs.model == "claude-sonnet-4-6"
    assert docs.timeout == 300


# --------------------------- fail-loud (extra="forbid") ---------------------------


def test_unknown_top_level_key_rejected(tmp_path):
    p = tmp_path / "orchestrator.toml"
    p.write_text('bogus_key = "x"\n')
    with pytest.raises(ValidationError):
        load_config(p)


def test_unknown_workflow_step_key_rejected(tmp_path):
    p = tmp_path / "orchestrator.toml"
    p.write_text("[workflow.implementation]\nnot_a_field = 1\n")
    with pytest.raises(ValidationError):
        load_config(p)


def test_steps_table_does_not_break_config(tmp_path):
    # [steps.*] is the manifest namespace; load_config must drop it before the
    # extra="forbid" check, not reject it.
    p = tmp_path / "orchestrator.toml"
    p.write_text(
        'default_model = "claude-sonnet-4-6"\n'
        "[[steps.work]]\n"
        'id = "x"\n'
        'type = "approval_gate"\n'
    )
    cfg = load_config(p)
    assert cfg.default_model == "claude-sonnet-4-6"


# --------------------------- max_retries relocation ---------------------------


def test_top_level_max_retries_rejected(tmp_path):
    # Relocated to [workflow.qa]; a stray top-level key must fail loud so two
    # sources can't silently coexist.
    p = tmp_path / "orchestrator.toml"
    p.write_text("max_retries = 5\n")
    with pytest.raises(ValidationError):
        load_config(p)


def test_workflow_qa_max_retries_roundtrip(tmp_path):
    p = tmp_path / "orchestrator.toml"
    p.write_text("[workflow.qa]\nmax_retries = 7\n")
    assert load_config(p).workflow.qa.max_retries == 7


def test_env_override_targets_nested_max_retries(monkeypatch):
    # ORCHESTRATOR_MAX_RETRIES still resolves, now onto config.workflow.qa.
    monkeypatch.setenv("ORCHESTRATOR_MAX_RETRIES", "9")
    cfg = apply_overrides(OrchestratorConfig())
    assert cfg.workflow.qa.max_retries == 9


# --------------------------- auto-derived PR label ---------------------------


def _fake_gh_run(branch, captured):
    """Fake git_ops._run: rev-parse → branch; gh pr view → no PR; else → URL."""
    def run(args):
        captured.append(args)
        if args[:3] == ["git", "rev-parse", "--abbrev-ref"]:
            return SimpleNamespace(stdout=f"{branch}\n", stderr="")
        if args[:3] == ["gh", "pr", "view"]:
            raise subprocess.CalledProcessError(1, args)  # no existing PR
        return SimpleNamespace(stdout="https://github.com/o/r/pull/1\n", stderr="")
    return run


def test_pr_create_derives_label_from_plan_type(monkeypatch):
    from orchestrator import git_ops

    cmds: list[list[str]] = []
    monkeypatch.setattr(git_ops, "_run", _fake_gh_run("feature/x", cmds))
    url = git_ops.pr_create(
        "feature/x", "t", "s", "tp", base_branch="main", plan_type="fix"
    )
    assert url == "https://github.com/o/r/pull/1"
    create = next(c for c in cmds if c[:3] == ["gh", "pr", "create"])
    assert "--label" in create
    assert create[create.index("--label") + 1] == "bug"  # fix → bug


def test_pr_create_unknown_type_no_label(monkeypatch):
    from orchestrator import git_ops

    cmds: list[list[str]] = []
    monkeypatch.setattr(git_ops, "_run", _fake_gh_run("feature/x", cmds))
    git_ops.pr_create(
        "feature/x", "t", "s", "tp", base_branch="main", plan_type="mystery"
    )
    create = next(c for c in cmds if c[:3] == ["gh", "pr", "create"])
    assert "--label" not in create


# --------------------------- runner wall-clock timeout ---------------------------


class _DummyServer:
    pass


@pytest.mark.asyncio
async def test_runner_timeout_raises_fatal(monkeypatch):
    from orchestrator.agents import runner as runner_mod
    from orchestrator.errors import FatalError

    async def slow_query(prompt, options):
        await asyncio.sleep(5)
        yield None  # never reached — wait_for cancels first

    monkeypatch.setattr(
        runner_mod, "create_sdk_mcp_server", lambda **k: _DummyServer()
    )
    monkeypatch.setattr(runner_mod, "query", slow_query)

    with pytest.raises(FatalError, match="timed out"):
        await runner_mod.run_structured_agent(
            system_prompt="s",
            user_message="m",
            model="claude-sonnet-4-6",
            allowed_tools=[],
            disallowed_tools=[],
            cwd=Path("."),
            timeout=0.05,
            emit_tool_name="emit_x",
            emit_tool_description="d",
            emit_tool_fields={"summary": str},
            result_factory=lambda c, u: c,
        )


# --------------------------- tool_profile.py removed ---------------------------


def test_tool_profile_module_removed():
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("orchestrator.tool_profile")
