"""Phase 33 pluggable-steps tests.

Three layers, all LLM-free:
- manifest: load/validate/hash + frontmatter stripping (pure).
- execute_script: real tiny scripts (success / non-zero / timeout).
- workflow integration: a approval_gate seam fires mid-run and the workflow
  completes; a mid-run manifest edit refuses the resume.

The ai_agent runner's agent loop needs a live model and is not exercised
here; its non-LLM parts (agent-file resolution, frontmatter strip) are.
"""

import uuid
from pathlib import Path

import pytest
from langgraph.types import Command

from orchestrator.agents.planning import PlanResult
from orchestrator.agents.qa import QaResult
from orchestrator.manifest import (
    ApprovalGateStep,
    AiAgentStep,
    ManifestError,
    ScriptStep,
    StepResult,
    WorkflowManifest,
    load_manifest,
)
from orchestrator.steps import StepError, _strip_frontmatter, execute_script
from orchestrator.workflow import IncompatibleManifestError


# --------------------------- manifest loader ---------------------------


def _write(p: Path, body: str) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body, encoding="utf-8")


def test_load_valid_manifest(tmp_path):
    _write(tmp_path / ".orchestrator/scripts/lint.sh", "#!/bin/sh\nexit 0\n")
    _write(tmp_path / ".orchestrator/agents/docs.md", "You are a doc agent.")
    _write(
        tmp_path / "orchestrator.toml",
        """
[[steps.before_plan]]
id = "lint"
type = "script"
path = ".orchestrator/scripts/lint.sh"

[[steps.before_commit]]
id = "docs"
type = "ai_agent"
agent = "docs.md"
dir = ".orchestrator/agents"

[[steps.before_commit]]
id = "gate"
type = "approval_gate"
ask = "ok?"
""",
    )
    m = load_manifest(project_root=tmp_path)
    assert isinstance(m.for_seam("before_plan")[0], ScriptStep)
    after = m.for_seam("before_commit")
    assert isinstance(after[0], AiAgentStep)
    assert isinstance(after[1], ApprovalGateStep)
    assert after[1].ask == "ok?"


def test_no_steps_table_is_empty(tmp_path):
    _write(tmp_path / "orchestrator.toml", "max_retries = 3\n")
    m = load_manifest(project_root=tmp_path)
    assert m.is_empty()


def test_unknown_seam_raises(tmp_path):
    _write(
        tmp_path / "orchestrator.toml",
        '[[steps.after_everything]]\nid="x"\ntype="approval_gate"\n',
    )
    with pytest.raises(ManifestError, match="unknown seam"):
        load_manifest(project_root=tmp_path)


def test_duplicate_id_raises(tmp_path):
    _write(
        tmp_path / "orchestrator.toml",
        """
[[steps.before_plan]]
id = "dup"
type = "approval_gate"

[[steps.before_commit]]
id = "dup"
type = "approval_gate"
""",
    )
    with pytest.raises(ManifestError, match="duplicate step id"):
        load_manifest(project_root=tmp_path)


def test_missing_script_raises(tmp_path):
    _write(
        tmp_path / "orchestrator.toml",
        '[[steps.before_plan]]\nid="lint"\ntype="script"\npath=".orchestrator/scripts/nope.sh"\n',
    )
    with pytest.raises(ManifestError, match="script not found"):
        load_manifest(project_root=tmp_path)


def test_unknown_agent_raises(tmp_path):
    _write(
        tmp_path / "orchestrator.toml",
        '[[steps.before_commit]]\nid="docs"\ntype="ai_agent"\nagent="ghost.md"\ndir=".orchestrator/agents"\n',
    )
    with pytest.raises(ManifestError, match="agent file not found"):
        load_manifest(project_root=tmp_path)


def test_manifest_hash_changes_with_steps():
    a = WorkflowManifest(steps={"before_commit": [ApprovalGateStep(id="g", ask="a")]})
    b = WorkflowManifest(steps={"before_commit": [ApprovalGateStep(id="g", ask="b")]})
    empty = WorkflowManifest()
    assert a.manifest_hash() != b.manifest_hash()
    assert a.manifest_hash() != empty.manifest_hash()
    # Stable across instances.
    assert a.manifest_hash() == WorkflowManifest(
        steps={"before_commit": [ApprovalGateStep(id="g", ask="a")]}
    ).manifest_hash()


def test_strip_frontmatter():
    md = "---\nname: docs\nmodel: x\n---\nYou are an agent.\n"
    assert _strip_frontmatter(md) == "You are an agent.\n"
    plain = "No frontmatter here."
    assert _strip_frontmatter(plain) == plain


# --------------------------- execute_script ---------------------------


@pytest.mark.asyncio
async def test_execute_script_success(tmp_path):
    script = tmp_path / "ok.sh"
    script.write_text("#!/bin/sh\necho hello\nexit 0\n")
    script.chmod(0o755)
    result = await execute_script(ScriptStep(id="ok", path="ok.sh"), tmp_path)
    assert result.ok
    assert result.kind == "script"
    assert "hello" in result.detail


@pytest.mark.asyncio
async def test_execute_script_nonzero_raises(tmp_path):
    script = tmp_path / "fail.sh"
    script.write_text("#!/bin/sh\necho boom >&2\nexit 3\n")
    script.chmod(0o755)
    with pytest.raises(StepError, match="exit 3"):
        await execute_script(ScriptStep(id="fail", path="fail.sh"), tmp_path)


@pytest.mark.asyncio
async def test_execute_script_timeout_raises(tmp_path):
    script = tmp_path / "slow.sh"
    script.write_text("#!/bin/sh\nsleep 5\n")
    script.chmod(0o755)
    with pytest.raises(StepError, match="timed out"):
        await execute_script(
            ScriptStep(id="slow", path="slow.sh", timeout=1), tmp_path
        )


# --------------------------- workflow integration ---------------------------


class _Stubs:
    async def plan(self, request, model="claude-sonnet-4-6") -> PlanResult:
        return PlanResult(title="t", type="feature", plan_text="p")

    def create_branch(self, plan, max_slug_length=50, thread_id="") -> str:
        return "feature/test"

    async def implementation_task(self, plan_text, feedback=None, model="claude-sonnet-4-6"):
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


def _patch(stubs, monkeypatch):
    monkeypatch.setattr("orchestrator.workflow.verify_clean_tree", stubs.verify_clean_tree)
    monkeypatch.setattr("orchestrator.workflow.ensure_on_main", stubs.ensure_on_main)
    monkeypatch.setattr("orchestrator.workflow.plan", stubs.plan)
    monkeypatch.setattr("orchestrator.workflow.create_branch", stubs.create_branch)
    monkeypatch.setattr("orchestrator.workflow.implementation_task", stubs.implementation_task)
    monkeypatch.setattr("orchestrator.workflow.qa", stubs.qa)
    monkeypatch.setattr("orchestrator.workflow.commit", stubs.commit)
    monkeypatch.setattr("orchestrator.workflow.push", stubs.push)
    monkeypatch.setattr("orchestrator.workflow.pr_create", stubs.pr_create)


@pytest.mark.asyncio
async def test_approval_gate_seam_fires_and_completes(monkeypatch, tmp_path):
    _patch(_Stubs(), monkeypatch)
    manifest = WorkflowManifest(
        steps={"before_commit": [ApprovalGateStep(id="security_gate", ask="approve?")]}
    )
    monkeypatch.setattr("orchestrator.workflow.load_manifest", lambda: manifest)

    from orchestrator.workflow import build_workflow

    config = {"configurable": {"thread_id": f"test-{uuid.uuid4().hex[:8]}"}}
    async with build_workflow(db_path=str(tmp_path / "ckpt.db")) as workflow:
        result = await workflow.ainvoke("req", config=config)
        assert "__interrupt__" in result  # plan approval

        # Approve the plan → runs through QA, then hits the approval_gate seam.
        result = await workflow.ainvoke(Command(resume="yes"), config=config)
        assert "__interrupt__" in result
        assert result["__interrupt__"][0].value["kind"] == "step_approval_gate"
        assert result["__interrupt__"][0].value["step_id"] == "security_gate"

        # Acknowledge the gate → workflow finishes.
        result = await workflow.ainvoke(Command(resume="yes"), config=config)

    assert result["status"] == "succeeded"


@pytest.mark.asyncio
async def test_before_commit_step_fires_once_before_commit_passes(monkeypatch, tmp_path):
    # Phase 46: the per-attempt `after_impl` and pass-only `before_commit` seams were
    # removed (the impl⇄QA loop is now a build step at after_branch). The
    # "run once after QA passes" use case is now a step at before_commit: even
    # when QA fails once then passes (2 build attempts), a before_commit step
    # fires EXACTLY ONCE, on the QA-passed tree, with attempt=0 (seams no longer
    # carry a loop-attempt number).
    calls: list[tuple[str, int]] = []

    def fake_make_script_task(step_id, *, as_gate=False):
        async def run(step_id, path, timeout, repo_root, attempt=0):
            calls.append((step_id, attempt))
            return StepResult(step_id=step_id, kind="script", ok=True)

        return run

    monkeypatch.setattr(
        "orchestrator.workflow._make_script_task", fake_make_script_task
    )

    verdicts = iter([QaResult(result="FAIL", failures="x"), QaResult(result="PASS")])
    stubs = _Stubs()

    async def qa_seq(plan, model="claude-sonnet-4-6"):
        return next(verdicts)

    stubs.qa = qa_seq
    _patch(stubs, monkeypatch)

    manifest = WorkflowManifest(
        steps={"before_commit": [ScriptStep(id="probe", path="x.sh")]}
    )
    monkeypatch.setattr("orchestrator.workflow.load_manifest", lambda: manifest)

    from orchestrator.workflow import build_workflow

    config = {"configurable": {"thread_id": f"test-{uuid.uuid4().hex[:8]}"}}
    async with build_workflow(db_path=str(tmp_path / "ckpt.db")) as workflow:
        result = await workflow.ainvoke("req", config=config)
        result = await workflow.ainvoke(Command(resume="yes"), config=config)

    assert result["status"] == "succeeded"
    # Fired once, after QA passed (the 2nd build attempt) — not per attempt.
    assert calls == [("probe", 0)]


@pytest.mark.asyncio
async def test_approval_gate_abort_stops_run(monkeypatch, tmp_path):
    # Resuming a approval_gate with an abort word stops the run cleanly:
    # status="aborted", the offending step named, and NO commit.
    committed: list[str] = []
    stubs = _Stubs()

    def track_commit(branch, title, summary, base_branch="main"):
        committed.append(branch)
        return "abc123"

    stubs.commit = track_commit
    _patch(stubs, monkeypatch)

    manifest = WorkflowManifest(
        steps={"before_commit": [ApprovalGateStep(id="signoff", ask="proceed?")]}
    )
    monkeypatch.setattr("orchestrator.workflow.load_manifest", lambda: manifest)

    from orchestrator.workflow import build_workflow

    config = {"configurable": {"thread_id": f"test-{uuid.uuid4().hex[:8]}"}}
    async with build_workflow(db_path=str(tmp_path / "ckpt.db")) as workflow:
        result = await workflow.ainvoke("req", config=config)  # plan approval
        result = await workflow.ainvoke(Command(resume="yes"), config=config)
        assert result["__interrupt__"][0].value["kind"] == "step_approval_gate"

        # Abort at the gate.
        result = await workflow.ainvoke(Command(resume="abort"), config=config)

    assert result["status"] == "aborted"
    assert result["aborted_at"] == "signoff"
    assert committed == []  # gate runs before the commit line


def _fake_ai_agent_task(calls: list[tuple[str, int]]):
    """Stub _make_ai_agent_task: record (step_id, attempt), no live model.

    Wraps the runner in task() exactly like the real factory, so the result is
    checkpointed and REPLAYS on resume (rather than re-running) — letting the
    test assert the agent runs once across an interrupt/resume.
    """
    from langgraph.func import task

    def make(step_id, *, as_gate=False):
        async def run(step_id, agent, dir, model, repo_root, plan_text, attempt=0, feedback=None):
            calls.append((step_id, attempt))
            return StepResult(
                step_id=step_id, kind="ai_agent", ok=True, detail="ran agent"
            )

        return task(run, name=f"step:{step_id}")

    return make


@pytest.mark.asyncio
async def test_ai_agent_human_in_loop_pauses_then_proceeds(monkeypatch, tmp_path):
    # An ai_agent step with human_in_loop pauses AFTER it runs, surfacing the
    # agent's detail for review; resuming with a non-abort reply proceeds. The
    # agent runs exactly once — resume replays the checkpointed @task, not re-run.
    calls: list[tuple[str, int]] = []
    _patch(_Stubs(), monkeypatch)
    monkeypatch.setattr(
        "orchestrator.workflow._make_ai_agent_task", _fake_ai_agent_task(calls)
    )

    manifest = WorkflowManifest(
        steps={
            "before_commit": [
                AiAgentStep(id="review", agent="reviewer.md", dir=".orchestrator/agents", human_in_loop=True)
            ]
        }
    )
    monkeypatch.setattr("orchestrator.workflow.load_manifest", lambda: manifest)

    from orchestrator.workflow import build_workflow

    config = {"configurable": {"thread_id": f"test-{uuid.uuid4().hex[:8]}"}}
    async with build_workflow(db_path=str(tmp_path / "ckpt.db")) as workflow:
        result = await workflow.ainvoke("req", config=config)  # plan approval
        result = await workflow.ainvoke(Command(resume="yes"), config=config)
        # After QA → the agent ran, then paused for review with its detail.
        intr = result["__interrupt__"][0].value
        assert intr["kind"] == "step_ai_agent_review"
        assert intr["step_id"] == "review"
        assert intr["detail"] == "ran agent"
        # before_commit fires once on the QA-passed tree (attempt=0; seams no
        # longer carry a loop-attempt number after Phase 46).
        assert calls == [("review", 0)]  # ran once, before the pause

        # Proceed → workflow finishes; the agent is NOT re-run on resume.
        result = await workflow.ainvoke(Command(resume="yes"), config=config)

    assert result["status"] == "succeeded"
    assert calls == [("review", 0)]


@pytest.mark.asyncio
async def test_ai_agent_human_in_loop_abort_stops_run(monkeypatch, tmp_path):
    # Resuming the ai_agent review pause with an abort word stops the run
    # cleanly (status="aborted", step named) with no commit.
    calls: list[tuple[str, int]] = []
    committed: list[str] = []
    stubs = _Stubs()

    def track_commit(branch, title, summary, base_branch="main"):
        committed.append(branch)
        return "abc123"

    stubs.commit = track_commit
    _patch(stubs, monkeypatch)
    monkeypatch.setattr(
        "orchestrator.workflow._make_ai_agent_task", _fake_ai_agent_task(calls)
    )

    manifest = WorkflowManifest(
        steps={
            "before_commit": [
                AiAgentStep(id="review", agent="reviewer.md", dir=".orchestrator/agents", human_in_loop=True)
            ]
        }
    )
    monkeypatch.setattr("orchestrator.workflow.load_manifest", lambda: manifest)

    from orchestrator.workflow import build_workflow

    config = {"configurable": {"thread_id": f"test-{uuid.uuid4().hex[:8]}"}}
    async with build_workflow(db_path=str(tmp_path / "ckpt.db")) as workflow:
        result = await workflow.ainvoke("req", config=config)  # plan approval
        result = await workflow.ainvoke(Command(resume="yes"), config=config)
        assert result["__interrupt__"][0].value["kind"] == "step_ai_agent_review"

        result = await workflow.ainvoke(Command(resume="no"), config=config)

    assert result["status"] == "aborted"
    assert result["aborted_at"] == "review"
    assert committed == []  # review pause runs before the commit line


@pytest.mark.asyncio
async def test_manifest_change_mid_run_refuses_resume(monkeypatch, tmp_path):
    _patch(_Stubs(), monkeypatch)

    manifest_a = WorkflowManifest(
        steps={"before_commit": [ApprovalGateStep(id="g", ask="v1")]}
    )
    manifest_b = WorkflowManifest(
        steps={"before_commit": [ApprovalGateStep(id="g", ask="v2-changed")]}
    )
    state = {"current": manifest_a}
    monkeypatch.setattr(
        "orchestrator.workflow.load_manifest", lambda: state["current"]
    )

    from orchestrator.workflow import build_workflow

    config = {"configurable": {"thread_id": f"test-{uuid.uuid4().hex[:8]}"}}
    async with build_workflow(db_path=str(tmp_path / "ckpt.db")) as workflow:
        result = await workflow.ainvoke("req", config=config)
        assert "__interrupt__" in result  # plan approval; hash A recorded

        # Edit orchestrator.toml's steps while paused → hash changes.
        state["current"] = manifest_b
        with pytest.raises(IncompatibleManifestError) as ei:
            await workflow.ainvoke(Command(resume="yes"), config=config)

    assert ei.value.stored_hash == manifest_a.manifest_hash()
    assert ei.value.current_hash == manifest_b.manifest_hash()
