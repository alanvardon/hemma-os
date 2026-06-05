"""Phase 68 — v1 → v2 migration tests.

Proves migrate_v1_to_v2 produces a v2 dict that pipeline.build_pipeline accepts,
that key mappings are correct, that render_toml round-trips through tomllib, and
that the REAL in-repo orchestrator.toml migrates to a valid v2 pipeline.
"""

import tomllib

import pytest

from orchestrator.migrate import migrate_v1_to_v2, render_toml
from orchestrator.paths import find_project_root
from orchestrator.pipeline import build_pipeline


def _v1_default() -> dict:
    return {
        "default_model": "claude-sonnet-4-6",
        "workflow": {
            "planning": {"human_in_loop": True},
            "decompose": {"max_tasks": 0},
            "task_build": {
                "produce": ["implementation"],
                "gate": ["qa"],
                "retry": {"max": 3, "on_exhausted": "approval_gate"},
            },
            "final_qa": {"gate": []},
            "branch": {"max_slug_length": 50},
            "implementation": {"allowed_tools": ["Read", "Edit", "Write", "Bash"]},
            "qa": {"allowed_tools": ["Read", "Grep", "Bash"]},
            "docs": {"model": "claude-haiku-4-5-20251001", "timeout": 120},
            "summarize": {"model": "claude-haiku-4-5-20251001", "timeout": 120},
        },
        "git": {"auto_rebase": True},
        "pr": {"base_branch": "main", "draft": False, "reviewers": []},
        "audit": {"enabled": True, "log_path": ".orchestrator/audit.log"},
    }


def test_default_v1_migrates_to_valid_v2():
    v2, notes = migrate_v1_to_v2(_v1_default())
    p = build_pipeline(v2)  # must not raise
    assert [s.id for s in p.stages] == [
        "plan", "decompose", "task-build", "summarize", "docs",
    ]
    assert notes == []


def test_produce_gate_ids_get_namespaced():
    v2, _ = migrate_v1_to_v2(_v1_default())
    tb = v2["stage"]["builtin"]["task-build"]
    assert tb["produce"] == ["builtin:implementation"]
    assert tb["gate"] == ["builtin:qa"]


def test_planning_human_in_loop_default_preserved_when_unset():
    v1 = _v1_default()
    del v1["workflow"]["planning"]["human_in_loop"]
    v2, _ = migrate_v1_to_v2(v1)
    assert v2["stage"]["builtin"]["plan"]["human_in_loop"] is True


def test_planning_human_in_loop_respected_when_false():
    v1 = _v1_default()
    v1["workflow"]["planning"]["human_in_loop"] = False
    v2, _ = migrate_v1_to_v2(v1)
    assert v2["stage"]["builtin"]["plan"]["human_in_loop"] is False


def test_branch_slug_moves_out_of_workflow():
    v2, _ = migrate_v1_to_v2(_v1_default())
    assert v2["branch"]["max_slug_length"] == 50


def test_infra_tables_carry_across():
    v2, _ = migrate_v1_to_v2(_v1_default())
    assert v2["git"]["auto_rebase"] is True
    assert v2["pr"]["base_branch"] == "main"
    assert v2["audit"]["enabled"] is True


def _v1_with_work() -> dict:
    v1 = _v1_default()
    v1["workflow"]["final_qa"] = {"gate": ["qa"]}
    v1["steps"] = {
        "defs": {
            "lint": {"type": "script", "path": ".orchestrator/checks/lint.sh"},
            "reviewer": {
                "type": "ai_agent",
                "agent": ".orchestrator/agents/rev.md",
                "model": "claude-sonnet-4-6",
            },
        },
        "work": [
            {"id": "sec", "type": "script", "path": ".orchestrator/checks/sec.sh"},
            {"id": "approve", "type": "approval_gate", "ask": "ok?"},
            {
                "id": "lint-loop",
                "type": "build",
                "produce": ["reviewer"],
                "gate": ["lint"],
                "retry": {"max": 2, "on_exhausted": "abort"},
            },
        ],
    }
    return v1


def test_work_steps_become_ordered_user_stages():
    v2, notes = migrate_v1_to_v2(_v1_with_work())
    p = build_pipeline(v2)  # must not raise
    ids = [s.id for s in p.stages]
    # preserves v1 order: task-build → work → final_qa → summarize → docs
    assert ids == [
        "plan", "decompose", "task-build", "sec", "lint-loop", "qa",
        "summarize", "docs",
    ]
    assert p.stage("sec").namespace == "user"
    assert p.stage("lint-loop").effective_type == "build"


def test_defs_agent_key_becomes_path():
    v2, _ = migrate_v1_to_v2(_v1_with_work())
    assert v2["defs"]["reviewer"]["path"] == ".orchestrator/agents/rev.md"
    assert "agent" not in v2["defs"]["reviewer"]


def test_user_build_refs_namespaced_to_defs():
    v2, _ = migrate_v1_to_v2(_v1_with_work())
    loop = v2["stage"]["user"]["lint-loop"]
    assert loop["produce"] == ["defs:reviewer"]
    assert loop["gate"] == ["defs:lint"]


def test_approval_gate_work_step_is_noted_not_dropped_silently():
    v2, notes = migrate_v1_to_v2(_v1_with_work())
    assert any("approve" in n and "approval_gate" in n for n in notes)
    assert "approve" not in v2["stage"].get("user", {})


def test_final_qa_qa_becomes_a_stage():
    v2, _ = migrate_v1_to_v2(_v1_with_work())
    assert v2["stage"]["builtin"]["qa"] == {"type": "ai_agent"}


# ── render_toml round-trip ───────────────────────────────────────────────────

def test_render_toml_round_trips_through_tomllib():
    v2, _ = migrate_v1_to_v2(_v1_with_work())
    text = render_toml(v2)
    reloaded = tomllib.loads(text)
    # the re-parsed text must still build a valid pipeline
    p = build_pipeline(reloaded)
    assert [s.id for s in p.stages] == [
        "plan", "decompose", "task-build", "sec", "lint-loop", "qa",
        "summarize", "docs",
    ]
    # spot-check a few values survived serialisation
    assert reloaded["stage"]["user"]["lint-loop"]["produce"] == ["defs:reviewer"]
    assert reloaded["defs"]["reviewer"]["path"] == ".orchestrator/agents/rev.md"
    assert reloaded["stage"]["builtin"]["task-build"]["retry"]["on_exhausted"] == "approval_gate"


def test_real_in_repo_orchestrator_toml_migrates_to_valid_v2():
    path = find_project_root() / "orchestrator.toml"
    if not path.exists():
        pytest.skip("no in-repo orchestrator.toml")
    with path.open("rb") as f:
        v1 = tomllib.load(f)
    v2, notes = migrate_v1_to_v2(v1)
    build_pipeline(v2)            # must not raise
    # and the rendered form must re-parse + re-validate
    build_pipeline(tomllib.loads(render_toml(v2)))
