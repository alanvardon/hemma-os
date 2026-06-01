"""Phase 42 Part C / Phase 46 — declarative build steps in orchestrator.toml.

Three slices:
1. Parsing — a `[[steps.*]] type="build"` step + `[steps.defs.*]` round-trips
   through load_manifest into a BuildStep and a defs table.
2. Validation — references, producer/gate overlap, empty lists, gate-capability
   (approval_gate can't be a def), budget/policy bounds, id uniqueness, and missing
   support files are all caught at load time (before any LLM spend).
3. Resume safety — manifest_hash folds a block's referenced defs in, so editing
   a def *body* (not just the block) refuses the resume; an unreferenced def
   doesn't affect the hash.
4. End-to-end — a declared block at a seam runs on the generic engine: producers
   re-run until the gate passes (or aborts the run when it never does).
"""

import uuid
from pathlib import Path

import pytest
from langgraph.types import Command

from orchestrator.agents.planning import PlanResult
from orchestrator.agents.qa import QaResult
from orchestrator.manifest import (
    AiAgentStep,
    BuildStep,
    ManifestError,
    RetryConfig,
    ScriptStep,
    WorkflowManifest,
    load_manifest,
)
# --------------------------- parsing / validation ---------------------------


def _project(tmp_path: Path, toml_body: str, *, scripts=(), agents=()) -> Path:
    """Write a tmp orchestrator.toml plus any referenced support files."""
    (tmp_path / "orchestrator.toml").write_text(toml_body, encoding="utf-8")
    sd = tmp_path / ".orchestrator" / "scripts"
    ad = tmp_path / ".orchestrator" / "agents"
    sd.mkdir(parents=True, exist_ok=True)
    ad.mkdir(parents=True, exist_ok=True)
    for s in scripts:
        p = sd / s
        p.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        p.chmod(0o755)
    for a in agents:
        (ad / f"{a}.md").write_text("agent prompt", encoding="utf-8")
    return tmp_path


def _load(tmp_path: Path, toml_body: str, **files) -> WorkflowManifest:
    root = _project(tmp_path, toml_body, **files)
    return load_manifest(config_path=root / "orchestrator.toml", project_root=root)


_VALID = """
[[steps.after_branch]]
id           = "lint-loop"
type         = "build"
produce      = ["lint-fix"]
gate         = ["lint-check"]
retry        = { max = 2, on_exhausted = "abort" }

[steps.defs.lint-fix]
type  = "ai_agent"
agent = "lint-fixer.md"
dir   = ".orchestrator/agents"

[steps.defs.lint-check]
type = "script"
path = ".orchestrator/scripts/lint.sh"
"""


def test_valid_retry_block_round_trips(tmp_path):
    m = _load(tmp_path, _VALID, scripts=["lint.sh"], agents=["lint-fixer"])
    block = m.for_seam("after_branch")[0]
    assert isinstance(block, BuildStep)
    assert block.id == "lint-loop"
    assert block.produce == ["lint-fix"]
    assert block.gate == ["lint-check"]
    assert block.retry.max == 2
    assert block.retry.on_exhausted == "abort"
    # defs parsed into their own table, keyed by id.
    assert set(m.defs) == {"lint-fix", "lint-check"}
    assert isinstance(m.defs["lint-fix"], AiAgentStep)
    assert isinstance(m.defs["lint-check"], ScriptStep)


def test_unknown_referenced_def_raises(tmp_path):
    toml = """
[[steps.after_branch]]
id      = "loop"
type    = "build"
produce = ["lint-fix"]
gate    = ["does-not-exist"]

[steps.defs.lint-fix]
type  = "ai_agent"
agent = "lint-fixer.md"
dir   = ".orchestrator/agents"
"""
    with pytest.raises(ManifestError, match="unknown gate 'does-not-exist'"):
        _load(tmp_path, toml, agents=["lint-fixer"])


def test_producer_and_gate_overlap_raises(tmp_path):
    toml = """
[[steps.after_branch]]
id      = "loop"
type    = "build"
produce = ["both"]
gate    = ["both"]

[steps.defs.both]
type = "script"
path = ".orchestrator/scripts/lint.sh"
"""
    with pytest.raises(ManifestError, match="both producer and gate"):
        _load(tmp_path, toml, scripts=["lint.sh"])


def test_empty_produce_raises(tmp_path):
    toml = """
[[steps.after_branch]]
id      = "loop"
type    = "build"
produce = []
gate    = ["lint-check"]

[steps.defs.lint-check]
type = "script"
path = ".orchestrator/scripts/lint.sh"
"""
    with pytest.raises(ManifestError, match="`produce` must list at least one"):
        _load(tmp_path, toml, scripts=["lint.sh"])


def test_empty_gate_raises(tmp_path):
    toml = """
[[steps.after_branch]]
id      = "loop"
type    = "build"
produce = ["lint-fix"]
gate    = []

[steps.defs.lint-fix]
type  = "ai_agent"
agent = "lint-fixer.md"
dir   = ".orchestrator/agents"
"""
    with pytest.raises(ManifestError, match="`gate` must list at least one"):
        _load(tmp_path, toml, agents=["lint-fixer"])


def test_approval_gate_def_rejected(tmp_path):
    # A approval_gate is a pause, not a producer/gate — it can't be a def.
    toml = """
[[steps.after_branch]]
id      = "loop"
type    = "build"
produce = ["x"]
gate    = ["y"]

[steps.defs.x]
type = "script"
path = ".orchestrator/scripts/lint.sh"

[steps.defs.y]
type = "approval_gate"
ask  = "ok?"
"""
    with pytest.raises(ManifestError, match="invalid step def 'y'"):
        _load(tmp_path, toml, scripts=["lint.sh"])


def test_max_retries_zero_rejected(tmp_path):
    toml = """
[[steps.after_branch]]
id          = "loop"
type        = "build"
produce     = ["x"]
gate        = ["y"]
retry       = { max = 0 }

[steps.defs.x]
type = "script"
path = ".orchestrator/scripts/lint.sh"
[steps.defs.y]
type = "script"
path = ".orchestrator/scripts/lint.sh"
"""
    with pytest.raises(ManifestError, match="invalid step in seam"):
        _load(tmp_path, toml, scripts=["lint.sh"])


def test_bad_on_exhausted_rejected(tmp_path):
    toml = """
[[steps.after_branch]]
id           = "loop"
type         = "build"
produce      = ["x"]
gate         = ["y"]
retry        = { on_exhausted = "explode" }

[steps.defs.x]
type = "script"
path = ".orchestrator/scripts/lint.sh"
[steps.defs.y]
type = "script"
path = ".orchestrator/scripts/lint.sh"
"""
    with pytest.raises(ManifestError, match="invalid step in seam"):
        _load(tmp_path, toml, scripts=["lint.sh"])


def test_def_id_collides_with_seam_step_id(tmp_path):
    # A def and a seam step share an id — one global namespace, so this is a dup.
    toml = """
[[steps.before_plan]]
id   = "shared"
type = "script"
path = ".orchestrator/scripts/lint.sh"

[[steps.after_branch]]
id      = "loop"
type    = "build"
produce = ["shared"]
gate    = ["g"]

[steps.defs.shared]
type = "script"
path = ".orchestrator/scripts/lint.sh"
[steps.defs.g]
type = "script"
path = ".orchestrator/scripts/lint.sh"
"""
    with pytest.raises(ManifestError, match="duplicate step id 'shared'"):
        _load(tmp_path, toml, scripts=["lint.sh"])


def test_missing_def_script_raises(tmp_path):
    # lint.sh is referenced by a def but not created.
    with pytest.raises(ManifestError, match="script not found"):
        _load(tmp_path, _VALID, agents=["lint-fixer"])  # note: no scripts=


def test_missing_def_agent_raises(tmp_path):
    # lint-fixer.md is referenced by a def but not created.
    with pytest.raises(ManifestError, match="agent file not found"):
        _load(tmp_path, _VALID, scripts=["lint.sh"])  # note: no agents=


# --------------------------- resume safety (hash) ---------------------------


def test_hash_changes_when_referenced_def_changes():
    defs = {
        "fix": AiAgentStep(id="fix", agent="a.md", dir="d"),
        "check": ScriptStep(id="check", path="x.sh"),
    }
    block = BuildStep(id="b", produce=["fix"], gate=["check"])
    m1 = WorkflowManifest(steps={"after_branch": [block]}, defs=defs)
    # Edit a referenced def's BODY (not the block) → hash must change so a
    # mid-run edit refuses the resume.
    m2 = WorkflowManifest(
        steps={"after_branch": [block]},
        defs={**defs, "check": ScriptStep(id="check", path="DIFFERENT.sh")},
    )
    assert m1.manifest_hash() != m2.manifest_hash()


def test_hash_ignores_unreferenced_def():
    defs = {
        "fix": AiAgentStep(id="fix", agent="a.md", dir="d"),
        "check": ScriptStep(id="check", path="x.sh"),
    }
    block = BuildStep(id="b", produce=["fix"], gate=["check"])
    m1 = WorkflowManifest(steps={"after_branch": [block]}, defs=defs)
    # Adding a def the block does NOT reference changes nothing it depends on.
    m3 = WorkflowManifest(
        steps={"after_branch": [block]},
        defs={**defs, "unused": ScriptStep(id="unused", path="z.sh")},
    )
    assert m1.manifest_hash() == m3.manifest_hash()


# --------------------------- end-to-end execution ---------------------------


class _Stubs:
    """Happy-path spine stubs (plan → impl → qa PASS → commit/push/pr)."""

    async def plan(self, request, model="claude-sonnet-4-6") -> PlanResult:
        return PlanResult(title="t", type="feature", plan_text="p")

    def create_branch(self, plan, max_slug_length=50, thread_id="") -> str:
        return "feature/test"

    async def implementation_task(self, plan_text, feedback=None, model="claude-sonnet-4-6"):
        from orchestrator.manifest import StepResult
        return StepResult(step_id="implementation", kind="ai_agent", ok=True)

    async def qa(self, plan, model="claude-sonnet-4-6") -> QaResult:
        return QaResult(result="PASS")

    def commit(self, branch, title, summary, base_branch="main") -> str:
        return "abc123"

    def push(self, branch, base_branch="main", auto_rebase=True) -> None:
        pass

    def pr_create(self, branch, title, summary, test_plan, base_branch="main", draft=False, reviewers=None, labels=None) -> str:
        return "https://github.com/test/pr/1"

    def verify_clean_tree(self) -> None:
        pass

    def ensure_on_main(self, base_branch: str = "main") -> None:
        pass


def _patch_spine(stubs, monkeypatch):
    monkeypatch.setattr("orchestrator.workflow.plan", stubs.plan)
    monkeypatch.setattr("orchestrator.workflow.create_branch", stubs.create_branch)
    monkeypatch.setattr("orchestrator.workflow.implementation_task", stubs.implementation_task)
    monkeypatch.setattr("orchestrator.workflow.qa", stubs.qa)
    monkeypatch.setattr("orchestrator.workflow.commit", stubs.commit)
    monkeypatch.setattr("orchestrator.workflow.push", stubs.push)
    monkeypatch.setattr("orchestrator.workflow.pr_create", stubs.pr_create)
    monkeypatch.setattr("orchestrator.workflow.verify_clean_tree", stubs.verify_clean_tree)
    monkeypatch.setattr("orchestrator.workflow.ensure_on_main", stubs.ensure_on_main)


def _block_manifest(on_exhausted="abort", max_retries=3) -> WorkflowManifest:
    """A retry block at after_plan: a script producer + a script gate."""
    return WorkflowManifest(
        steps={
            "after_plan": [
                BuildStep(
                    id="loop",
                    produce=["fix"],
                    gate=["check"],
                    retry=RetryConfig(max=max_retries, on_exhausted=on_exhausted),
                )
            ]
        },
        defs={
            "fix": ScriptStep(id="fix", path="fix.sh"),
            "check": ScriptStep(id="check", path="check.sh"),
        },
    )


def _fake_execute_script_factory(gate_passes_on_attempt: int | None):
    """Build a fake workflow.execute_script that records calls. The gate
    ('check') passes on `gate_passes_on_attempt` (1-based); None = never."""
    from orchestrator.manifest import StepResult

    calls: list[tuple[str, bool]] = []

    async def fake(step, repo_root, *, as_gate=False):
        calls.append((step.id, as_gate))
        if as_gate:  # the "check" gate
            gate_runs = sum(1 for c in calls if c == (step.id, True))
            passed = gate_passes_on_attempt is not None and gate_runs >= gate_passes_on_attempt
            return StepResult(
                step_id=step.id, kind="script", ok=True, passed=passed,
                detail="" if passed else "lint failed",
            )
        return StepResult(step_id=step.id, kind="script", ok=True)  # producer

    return fake, calls


async def _drive(monkeypatch, tmp_path, manifest, fake_execute_script):
    stubs = _Stubs()
    _patch_spine(stubs, monkeypatch)
    monkeypatch.setattr("orchestrator.workflow.load_manifest", lambda *a, **k: manifest)
    monkeypatch.setattr("orchestrator.workflow.execute_script", fake_execute_script)

    from orchestrator.workflow import build_workflow

    config = {"configurable": {"thread_id": f"test-{uuid.uuid4().hex[:8]}"}}
    async with build_workflow(db_path=str(tmp_path / "ckpt.db")) as workflow:
        result = await workflow.ainvoke("req", config=config)  # plan_approval
        result = await workflow.ainvoke(Command(resume="yes"), config=config)
    return result


@pytest.mark.asyncio
async def test_declared_block_retries_until_gate_passes(monkeypatch, tmp_path):
    fake, calls = _fake_execute_script_factory(gate_passes_on_attempt=2)
    result = await _drive(monkeypatch, tmp_path, _block_manifest(), fake)

    assert result["status"] == "succeeded"
    # Producer ran twice (fail → retry → pass), gate ran twice.
    assert [c for c in calls if c == ("fix", False)] == [("fix", False)] * 2
    assert [c for c in calls if c == ("check", True)] == [("check", True)] * 2


@pytest.mark.asyncio
async def test_declared_block_abort_when_gate_never_passes(monkeypatch, tmp_path):
    fake, calls = _fake_execute_script_factory(gate_passes_on_attempt=None)
    # Phase 46: on_exhausted="abort" → the build raises BuildFailed, which the
    # entrypoint turns into a clean status="failed" (no commit/PR), with the
    # failing gate's last feedback under qa_failures — the same contract the
    # default QA-gated build uses.
    result = await _drive(
        monkeypatch, tmp_path, _block_manifest(on_exhausted="abort", max_retries=2), fake
    )
    assert result["status"] == "failed"
    assert result["qa_failures"] == "lint failed"
    assert "pr_url" not in result
    # Producer + gate each ran the full budget (2 attempts).
    assert sum(1 for c in calls if c == ("fix", False)) == 2
    assert sum(1 for c in calls if c == ("check", True)) == 2


@pytest.mark.asyncio
async def test_declared_block_proceed_when_gate_never_passes(monkeypatch, tmp_path):
    fake, calls = _fake_execute_script_factory(gate_passes_on_attempt=None)
    # on_exhausted="proceed" → exhausting the budget continues the run anyway.
    result = await _drive(
        monkeypatch, tmp_path, _block_manifest(on_exhausted="proceed", max_retries=2), fake
    )
    assert result["status"] == "succeeded"
    assert sum(1 for c in calls if c == ("check", True)) == 2


# ------------------ Phase 44: producer human_in_loop review ------------------


def _hil_block_manifest(on_exhausted="abort", max_retries=3) -> WorkflowManifest:
    """A retry block whose PRODUCER is an ai_agent with human_in_loop=true,
    gated by a script. After the block succeeds, the producer's output is
    reviewed once."""
    return WorkflowManifest(
        steps={
            "after_plan": [
                BuildStep(
                    id="loop",
                    produce=["fix"],
                    gate=["check"],
                    retry=RetryConfig(max=max_retries, on_exhausted=on_exhausted),
                )
            ]
        },
        defs={
            "fix": AiAgentStep(id="fix", agent="fixer.md", dir=".orchestrator/agents", human_in_loop=True),
            "check": ScriptStep(id="check", path="check.sh"),
        },
    )


def _fake_agent_producer():
    """A fake workflow.execute_ai_agent recording (step_id, feedback) calls."""
    from orchestrator.manifest import StepResult

    agent_calls: list[tuple[str, str | None]] = []

    async def fake(step, project_root, plan_text, *, feedback=None, as_gate=False):
        agent_calls.append((step.id, feedback))
        return StepResult(
            step_id=step.id, kind="ai_agent", ok=True, detail="rewrote foo.js"
        )

    return fake, agent_calls


@pytest.mark.asyncio
async def test_producer_human_in_loop_reviews_after_block_succeeds(monkeypatch, tmp_path):
    # gate passes on attempt 2 → producer runs twice (fail → retry → pass). The
    # block then pauses ONCE for review of the producer's final output; a
    # non-abort reply proceeds. The producer is NOT re-run on resume.
    fake_script, script_calls = _fake_execute_script_factory(gate_passes_on_attempt=2)
    fake_agent, agent_calls = _fake_agent_producer()

    stubs = _Stubs()
    _patch_spine(stubs, monkeypatch)
    monkeypatch.setattr("orchestrator.workflow.load_manifest", lambda *a, **k: _hil_block_manifest())
    monkeypatch.setattr("orchestrator.workflow.execute_script", fake_script)
    monkeypatch.setattr("orchestrator.workflow.execute_ai_agent", fake_agent)

    from orchestrator.workflow import build_workflow

    config = {"configurable": {"thread_id": f"test-{uuid.uuid4().hex[:8]}"}}
    async with build_workflow(db_path=str(tmp_path / "ckpt.db")) as workflow:
        result = await workflow.ainvoke("req", config=config)  # plan approval
        result = await workflow.ainvoke(Command(resume="yes"), config=config)
        # Block succeeded (gate passed on attempt 2) → review pause with detail.
        intr = result["__interrupt__"][0].value
        assert intr["kind"] == "step_retry_review"
        assert intr["step_id"] == "loop"
        assert intr["producers"] == ["fix"]
        assert "rewrote foo.js" in intr["detail"]
        assert intr["attempts"] == 2
        # Producer ran exactly once per attempt (twice); gate ran twice.
        assert len(agent_calls) == 2
        assert sum(1 for c in script_calls if c == ("check", True)) == 2

        # Proceed → run finishes; producer NOT re-run on resume.
        result = await workflow.ainvoke(Command(resume="yes"), config=config)

    assert result["status"] == "succeeded"
    assert len(agent_calls) == 2


@pytest.mark.asyncio
async def test_producer_human_in_loop_no_pause_on_first_try(monkeypatch, tmp_path):
    # gate passes on attempt 1 → no retries. The review still fires once (the
    # block succeeded "without requiring retries").
    fake_script, _ = _fake_execute_script_factory(gate_passes_on_attempt=1)
    fake_agent, agent_calls = _fake_agent_producer()

    stubs = _Stubs()
    _patch_spine(stubs, monkeypatch)
    monkeypatch.setattr("orchestrator.workflow.load_manifest", lambda *a, **k: _hil_block_manifest())
    monkeypatch.setattr("orchestrator.workflow.execute_script", fake_script)
    monkeypatch.setattr("orchestrator.workflow.execute_ai_agent", fake_agent)

    from orchestrator.workflow import build_workflow

    config = {"configurable": {"thread_id": f"test-{uuid.uuid4().hex[:8]}"}}
    async with build_workflow(db_path=str(tmp_path / "ckpt.db")) as workflow:
        result = await workflow.ainvoke("req", config=config)  # plan approval
        result = await workflow.ainvoke(Command(resume="yes"), config=config)
        assert result["__interrupt__"][0].value["kind"] == "step_retry_review"
        assert result["__interrupt__"][0].value["attempts"] == 1
        assert len(agent_calls) == 1  # ran once, no retry
        result = await workflow.ainvoke(Command(resume="yes"), config=config)

    assert result["status"] == "succeeded"


@pytest.mark.asyncio
async def test_producer_human_in_loop_abort_stops_run(monkeypatch, tmp_path):
    # Aborting the post-success review stops the run cleanly, with no commit.
    fake_script, _ = _fake_execute_script_factory(gate_passes_on_attempt=1)
    fake_agent, _ = _fake_agent_producer()

    committed: list[str] = []
    stubs = _Stubs()

    def track_commit(branch, title, summary, base_branch="main"):
        committed.append(branch)
        return "abc123"

    stubs.commit = track_commit
    _patch_spine(stubs, monkeypatch)
    monkeypatch.setattr("orchestrator.workflow.load_manifest", lambda *a, **k: _hil_block_manifest())
    monkeypatch.setattr("orchestrator.workflow.execute_script", fake_script)
    monkeypatch.setattr("orchestrator.workflow.execute_ai_agent", fake_agent)

    from orchestrator.workflow import build_workflow

    config = {"configurable": {"thread_id": f"test-{uuid.uuid4().hex[:8]}"}}
    async with build_workflow(db_path=str(tmp_path / "ckpt.db")) as workflow:
        result = await workflow.ainvoke("req", config=config)  # plan approval
        result = await workflow.ainvoke(Command(resume="yes"), config=config)
        assert result["__interrupt__"][0].value["kind"] == "step_retry_review"
        result = await workflow.ainvoke(Command(resume="abort"), config=config)

    assert result["status"] == "aborted"
    assert result["aborted_at"] == "loop"
    assert committed == []


@pytest.mark.asyncio
async def test_producer_human_in_loop_no_review_when_exhausted_proceed(monkeypatch, tmp_path):
    # on_exhausted="proceed" with a gate that never passes → the block proceeds
    # but did NOT succeed (result.ok is False), so the human_in_loop review must
    # NOT fire. The run finishes straight through after the single plan resume.
    fake_script, _ = _fake_execute_script_factory(gate_passes_on_attempt=None)
    fake_agent, agent_calls = _fake_agent_producer()

    stubs = _Stubs()
    _patch_spine(stubs, monkeypatch)
    monkeypatch.setattr(
        "orchestrator.workflow.load_manifest",
        lambda *a, **k: _hil_block_manifest(on_exhausted="proceed", max_retries=2),
    )
    monkeypatch.setattr("orchestrator.workflow.execute_script", fake_script)
    monkeypatch.setattr("orchestrator.workflow.execute_ai_agent", fake_agent)

    from orchestrator.workflow import build_workflow

    config = {"configurable": {"thread_id": f"test-{uuid.uuid4().hex[:8]}"}}
    async with build_workflow(db_path=str(tmp_path / "ckpt.db")) as workflow:
        result = await workflow.ainvoke("req", config=config)  # plan approval
        result = await workflow.ainvoke(Command(resume="yes"), config=config)

    # No second interrupt — the run completed without a review pause.
    assert result["status"] == "succeeded"
    assert len(agent_calls) == 2  # ran the full budget, never reviewed


# ------------------ Phase 46: build type, retry config, ungated -------------


def test_retry_inline_table_roundtrips(tmp_path):
    toml = """
[[steps.after_branch]]
id      = "loop"
type    = "build"
produce = ["fix"]
gate    = ["check"]
retry   = { max = 5, on_exhausted = "proceed" }

[steps.defs.fix]
type  = "ai_agent"
agent = "lint-fixer.md"
dir   = ".orchestrator/agents"
[steps.defs.check]
type = "script"
path = ".orchestrator/scripts/lint.sh"
"""
    m = _load(tmp_path, toml, scripts=["lint.sh"], agents=["lint-fixer"])
    block = m.for_seam("after_branch")[0]
    assert isinstance(block, BuildStep)
    assert block.retry.max == 5
    assert block.retry.on_exhausted == "proceed"


def test_ungated_build_step_allowed(tmp_path):
    # ungated=true permits an empty gate list (producer runs once, no gate).
    toml = """
[[steps.after_branch]]
id      = "make"
type    = "build"
produce = ["fix"]
ungated = true

[steps.defs.fix]
type = "script"
path = ".orchestrator/scripts/lint.sh"
"""
    m = _load(tmp_path, toml, scripts=["lint.sh"])
    block = m.for_seam("after_branch")[0]
    assert isinstance(block, BuildStep)
    assert block.ungated is True
    assert block.gate == []


def test_retry_unknown_key_rejected(tmp_path):
    # RetryConfig is extra="forbid" — a typo'd key fails loud at load.
    toml = """
[[steps.after_branch]]
id      = "loop"
type    = "build"
produce = ["x"]
gate    = ["y"]
retry   = { maximum = 3 }

[steps.defs.x]
type = "script"
path = ".orchestrator/scripts/lint.sh"
[steps.defs.y]
type = "script"
path = ".orchestrator/scripts/lint.sh"
"""
    with pytest.raises(ManifestError, match="invalid step in seam"):
        _load(tmp_path, toml, scripts=["lint.sh"])


def _ungated_manifest() -> WorkflowManifest:
    return WorkflowManifest(
        steps={
            "after_plan": [BuildStep(id="loop", produce=["fix"], gate=[], ungated=True)]
        },
        defs={"fix": ScriptStep(id="fix", path="fix.sh")},
    )


@pytest.mark.asyncio
async def test_ungated_build_runs_producer_once(monkeypatch, tmp_path):
    # A gateless (ungated) build runs the producer exactly once, no gate, and
    # the run proceeds to success.
    fake, calls = _fake_execute_script_factory(gate_passes_on_attempt=None)
    result = await _drive(monkeypatch, tmp_path, _ungated_manifest(), fake)
    assert result["status"] == "succeeded"
    assert calls == [("fix", False)]  # producer once; no gate call
