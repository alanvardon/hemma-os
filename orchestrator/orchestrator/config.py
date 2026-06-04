"""User-facing config file for the orchestrator (Phase 13).

Reads orchestrator.toml from the working directory (project root) and
exposes a typed OrchestratorConfig. Missing file → all defaults.
The file is optional; run with zero config works out of the box.

Usage:
    from orchestrator.config import load_config, OrchestratorConfig

    config = load_config()                    # reads orchestrator.toml if present
    config = load_config(Path("other.toml"))  # explicit path

Sample orchestrator.toml (all fields optional, defaults shown):

    default_model = "claude-sonnet-4-6"   # any [workflow.*] step with model unset inherits this
    db_path       = ".orchestrator/checkpoints.db"

    [pre_hooks]
    dir     = ".orchestrator/pre-hooks"
    timeout = 30

    [qa]
    scripts_dir     = ".orchestrator/qa"
    scripts_timeout = 60

    [workflow.planning]
    human_in_loop = true                  # pause for plan review before any code

    [workflow.decompose]
    max_tasks = 0                         # 0 = uncapped; >0 = advisory task cap (Phase 55)

    [workflow.branch]
    max_slug_length = 50

    [workflow.implementation]
    allowed_tools = ["Read", "Edit", "Write", "Bash"]
    # A built-in's model/tools may instead come from its prompt frontmatter
    # (.orchestrator/prompts/<step>.md); a key set here overrides it (Phase 54).

    [workflow.qa]
    allowed_tools = ["Read", "Grep", "Bash"]
    max_retries   = 3                      # impl↔QA loop budget

    [workflow.docs]
    model = "claude-haiku-4-5-20251001"    # baked-in docs agent (Phase 41)

    [workflow.summarize]
    model = "claude-haiku-4-5-20251001"    # baked-in summarizer agent (Phase 42)

    [git]
    auto_rebase = true   # rebase onto origin/<base_branch> if it moved before push

    [pr]
    base_branch = "main"
    draft       = false
    reviewers   = []                       # labels auto-applied from plan.type

    [audit]
    enabled         = true
    log_path        = ".orchestrator/audit.log"
    include_content = false
"""

import os
import tomllib
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from orchestrator.manifest import HumanInLoopConfig, RetryConfig
from orchestrator.paths import find_project_root


# Env var names for the per-invocation overrides exposed in Phase 31.
# Kept here (not in the override function) so they're easy to find and
# document in one place — and so docs/tests can import the constants
# instead of re-typing the strings.
ENV_APPROVE_PLAN = "ORCHESTRATOR_APPROVE_PLAN"
ENV_MAX_RETRIES = "ORCHESTRATOR_MAX_RETRIES"
ENV_BASE_BRANCH = "ORCHESTRATOR_BASE_BRANCH"


_TRUE_LITERALS = {"true", "1", "yes", "on"}
_FALSE_LITERALS = {"false", "0", "no", "off"}


def _parse_bool_env(name: str, value: str) -> bool:
    lowered = value.strip().lower()
    if lowered in _TRUE_LITERALS:
        return True
    if lowered in _FALSE_LITERALS:
        return False
    raise ValueError(
        f"{name}={value!r} is not a valid boolean. Use one of "
        f"{sorted(_TRUE_LITERALS | _FALSE_LITERALS)}."
    )


def _parse_int_env(name: str, value: str) -> int:
    try:
        return int(value.strip())
    except ValueError as exc:
        raise ValueError(
            f"{name}={value!r} is not a valid integer."
        ) from exc


# Default model used by any workflow step whose `model` is left unset.
_DEFAULT_MODEL = "claude-sonnet-4-6"
# The docs spine task (Phase 41) defaults to haiku — a read-diff / edit-md task,
# not a reasoning task. Provisioned here so Phase 41 lands straight into it.
_DEFAULT_DOCS_MODEL = "claude-haiku-4-5-20251001"
# The summarizer (Phase 42) reads the plan + `git diff HEAD` and emits the
# commit/PR summary + test_plan. Like docs it's a cheap, read-only agent → haiku.
_DEFAULT_SUMMARIZE_MODEL = "claude-haiku-4-5-20251001"


class WorkflowStepConfig(BaseModel):
    """Per-step config for one built-in spine step (Phase 40).

    One [workflow.<step>] table carries everything for that step: which model
    it uses, whether it pauses for a human, its tool permissions, and an
    optional wall-clock timeout. `model = None` inherits `default_model`.
    """

    model_config = ConfigDict(extra="forbid")
    model: str | None = None
    human_in_loop: bool = False
    allowed_tools: list[str] = Field(default_factory=list)
    disallowed_tools: list[str] = Field(default_factory=list)
    timeout: int | None = None  # wall-clock seconds for the agent loop; None = no limit


class WorkflowBranchConfig(WorkflowStepConfig):
    max_slug_length: int = 50  # moved from the old [branch] section


class WorkflowQaConfig(WorkflowStepConfig):
    max_retries: int = 3  # impl↔QA loop budget; moved from the old top-level key


class WorkflowDecomposeConfig(WorkflowStepConfig):
    # Phase 55: advisory cap on how many tasks the decomposer may emit. 0 =
    # uncapped. > 0 is passed to the decomposer as soft guidance (not a hard
    # validation error — this phase is execution-inert, so an over-split run
    # should surface for review rather than abort).
    max_tasks: int = 0


class WorkflowTaskBuildConfig(BaseModel):
    """Phase 56: the recipe applied to EACH decomposed task by the per-task station.

    The plan owns *what* the tasks are (the decomposer's list); this owns *how*
    each task is built and checked. `produce`/`gate` reference [steps.defs.*] ids
    or the built-in `implementation` producer / `qa` gate. Mirrors a BuildStep's
    fields so the station can reuse the existing build engine per task.

    Defaults preserve today's behaviour: implementation produces, QA gates *each*
    task (so the implement⇄QA auto-fix retry loop runs per task), and gate
    exhaustion pauses-and-asks (Phase 52) rather than hard-aborting. Point `gate`
    at a cheap script for the cost-shaped pattern (cheap per-task check + one
    final whole-diff QA — see [workflow.final_qa])."""

    model_config = ConfigDict(extra="forbid")
    produce: list[str] = Field(default_factory=lambda: ["implementation"])
    gate: list[str] = Field(default_factory=lambda: ["qa"])
    retry: RetryConfig = Field(
        default_factory=lambda: RetryConfig(max=3, on_exhausted="approval_gate")
    )
    human_in_loop: HumanInLoopConfig = Field(default_factory=HumanInLoopConfig)


class WorkflowFinalQaConfig(BaseModel):
    """Phase 56: an optional single whole-diff acceptance check after ALL tasks pass.

    Default empty — QA runs per-task (see [workflow.task_build].gate), so a final
    pass is off by default. Set gate = ["qa"] (or your own script/agent ids) to
    also run one whole-diff check that catches cross-task interactions the
    per-task gates can't see. A final-gate FAIL aborts the run (no PR)."""

    model_config = ConfigDict(extra="forbid")
    gate: list[str] = Field(default_factory=list)


class WorkflowConfig(BaseModel):
    """The built-in spine, one table per step. Counterpart to [steps.*] —
    user-injected pluggable steps owned by manifest.py."""

    model_config = ConfigDict(extra="forbid")
    planning: WorkflowStepConfig = Field(
        default_factory=lambda: WorkflowStepConfig(human_in_loop=True)
    )
    # Phase 55: turns the approved plan into an ordered task list. Runs after
    # planning, before branch. Model inherits default_model unless its prompt
    # frontmatter or [workflow.decompose] sets one. Execution-inert in Phase 55 —
    # the list is reviewed + checkpointed but nothing consumes it yet (Phase 56).
    decompose: WorkflowDecomposeConfig = Field(default_factory=WorkflowDecomposeConfig)
    # Phase 56: the per-task execution loop. task_build is the recipe run for each
    # decomposed task (the station that replaced the single impl⇄QA build);
    # final_qa is an optional once-after-the-loop whole-diff check.
    task_build: WorkflowTaskBuildConfig = Field(default_factory=WorkflowTaskBuildConfig)
    final_qa: WorkflowFinalQaConfig = Field(default_factory=WorkflowFinalQaConfig)
    branch: WorkflowBranchConfig = Field(default_factory=WorkflowBranchConfig)
    implementation: WorkflowStepConfig = Field(
        default_factory=lambda: WorkflowStepConfig(
            allowed_tools=["Read", "Edit", "Write", "Bash"]
        )
    )
    qa: WorkflowQaConfig = Field(
        default_factory=lambda: WorkflowQaConfig(allowed_tools=["Read", "Grep", "Bash"])
    )
    docs: WorkflowStepConfig = Field(
        default_factory=lambda: WorkflowStepConfig(
            model=_DEFAULT_DOCS_MODEL, timeout=120
        )
    )
    # Phase 42: derives the commit/PR summary + test_plan from the plan + diff,
    # after the impl→QA retry block passes. Read-only tools (Bash for git diff).
    summarize: WorkflowStepConfig = Field(
        default_factory=lambda: WorkflowStepConfig(
            model=_DEFAULT_SUMMARIZE_MODEL,
            allowed_tools=["Read", "Bash", "Grep"],
            timeout=120,
        )
    )
    commit: WorkflowStepConfig = Field(default_factory=WorkflowStepConfig)


class PreHooksConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    dir: str = ".orchestrator/pre-hooks"
    timeout: int = 30


class QaConfig(BaseModel):
    """Scripted QA gate (Phase 28): the executable checks under scripts_dir that
    run before the QA agent. Distinct from [workflow.qa] (the QA agent step)."""

    model_config = ConfigDict(extra="forbid")
    scripts_dir: str = ".orchestrator/qa"
    scripts_timeout: int = 60


class GitConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    auto_rebase: bool = True


class PrConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    base_branch: str = "main"
    draft: bool = False
    reviewers: list[str] = Field(default_factory=list)
    # `labels` removed in Phase 40 — the PR label is auto-derived from plan.type
    # in git_ops.pr_create.


class AuditConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = True
    log_path: str = ".orchestrator/audit.log"
    include_content: bool = False


class OrchestratorConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    default_model: str = _DEFAULT_MODEL
    db_path: str = ".orchestrator/checkpoints.db"
    workflow: WorkflowConfig = Field(default_factory=WorkflowConfig)
    pre_hooks: PreHooksConfig = Field(default_factory=PreHooksConfig)
    qa: QaConfig = Field(default_factory=QaConfig)
    git: GitConfig = Field(default_factory=GitConfig)
    pr: PrConfig = Field(default_factory=PrConfig)
    audit: AuditConfig = Field(default_factory=AuditConfig)

    def resolved_model(self, step: WorkflowStepConfig) -> str:
        """Return the step's model, falling back to default_model when unset."""
        return step.model if step.model is not None else self.default_model


# Phase 54: built-in spine steps whose model/tools may be driven by their prompt
# file's frontmatter. branch/commit run no agent (deterministic git ops), so
# they have no prompt and are absent here.
_BUILTIN_PROMPT_STEPS: tuple[str, ...] = (
    "planning", "decompose", "implementation", "qa", "docs", "summarize",
)
# Only the operational dials cross over from frontmatter. human_in_loop is
# deliberately excluded: planning/branch/commit own that flag, and the build's
# implementation/qa pauses moved to the build step in Phase 51 (guarded above).
_BUILTIN_FRONTMATTER_FIELDS: tuple[str, ...] = (
    "model", "allowed_tools", "disallowed_tools", "timeout",
)


def _merge_builtin_frontmatter(
    config: OrchestratorConfig, raw_workflow: dict
) -> OrchestratorConfig:
    """Let a built-in agent's prompt frontmatter supply its model/tools (Phase 54).

    A prompt downloaded into .orchestrator/prompts/<step>.md drives that built-in
    the same way frontmatter drives a [steps.defs.*] agent: frontmatter is the
    default, an explicit key under [workflow.<step>] overrides it. `raw_workflow`
    is the un-validated [workflow] table, so its keys tell us exactly what the
    user set (a code default set via default_factory must NOT count as user-set)."""
    from orchestrator.prompt_loader import load_prompt_frontmatter

    step_updates: dict[str, WorkflowStepConfig] = {}
    for step_name in _BUILTIN_PROMPT_STEPS:
        fm = load_prompt_frontmatter(step_name)
        user_keys = set((raw_workflow.get(step_name) or {}).keys())
        step_cfg = getattr(config.workflow, step_name)
        updates = {}
        for field in _BUILTIN_FRONTMATTER_FIELDS:
            if field in user_keys:
                continue  # an explicit [workflow.<step>] value wins
            value = getattr(fm, field)
            if value is not None:
                updates[field] = value
        if updates:
            step_updates[step_name] = step_cfg.model_copy(update=updates)

    if not step_updates:
        return config
    new_workflow = config.workflow.model_copy(update=step_updates)
    return config.model_copy(update={"workflow": new_workflow})


def load_config(path: Path | None = None) -> OrchestratorConfig:
    """Load config from orchestrator.toml; return defaults if file is missing."""
    if path is None:
        path = find_project_root() / "orchestrator.toml"
    if not path.exists():
        config, raw_workflow = OrchestratorConfig(), {}
    else:
        with path.open("rb") as f:
            data = tomllib.load(f)
        # [steps.*] is the pluggable-step manifest namespace (owned by
        # manifest.py), not orchestrator config. Drop it before validation so
        # extra="forbid" can guard the config keys without rejecting the manifest
        # table that shares this file.
        data.pop("steps", None)
        config = OrchestratorConfig.model_validate(data)
        raw_workflow = data.get("workflow") or {}
    # Phase 51: the build's human pauses moved onto the build step's own
    # human_in_loop = { after_producer, on_gate_fail }. The global
    # [workflow.implementation]/[workflow.qa] human_in_loop flags no longer drive
    # anything — fail loud rather than silently ignoring a stale `true`.
    if config.workflow.implementation.human_in_loop or config.workflow.qa.human_in_loop:
        raise ValueError(
            "[workflow.implementation].human_in_loop and [workflow.qa].human_in_loop "
            "no longer control the build's pauses (Phase 51). Configure them on the "
            "build step instead, e.g. in its [[steps.work]] entry:\n"
            "    human_in_loop = { after_producer = true, on_gate_fail = true }"
        )
    # Phase 54: a built-in agent's prompt frontmatter (model/tools) drives that
    # step, with [workflow.<step>] overriding. No-op when prompts have no
    # frontmatter (today's default).
    return _merge_builtin_frontmatter(config, raw_workflow)


def apply_overrides(
    config: OrchestratorConfig,
    *,
    approve_plan: bool | None = None,
    max_retries: int | None = None,
    base_branch: str | None = None,
) -> OrchestratorConfig:
    """Overlay per-invocation overrides on a loaded config (Phase 31).

    Resolution order per knob: explicit kwarg → env var → unchanged.
    Returns a NEW OrchestratorConfig — never mutates the input.

    The env-var fallback is read here (not by the caller) so CLI flags
    and MCP tool params share one resolution path. Invalid env values
    raise ValueError so misconfiguration fails loud instead of being
    silently ignored.
    """
    if approve_plan is None and (raw := os.environ.get(ENV_APPROVE_PLAN)) is not None:
        approve_plan = _parse_bool_env(ENV_APPROVE_PLAN, raw)
    if max_retries is None and (raw := os.environ.get(ENV_MAX_RETRIES)) is not None:
        max_retries = _parse_int_env(ENV_MAX_RETRIES, raw)
    if base_branch is None and (raw := os.environ.get(ENV_BASE_BRANCH)) is not None:
        base_branch = raw.strip() or None

    # approve_plan and max_retries both live under config.workflow now
    # (workflow.planning.human_in_loop and workflow.qa.max_retries), so collect
    # their nested updates and apply them to ONE workflow copy.
    workflow_updates: dict = {}
    if approve_plan is not None:
        workflow_updates["planning"] = config.workflow.planning.model_copy(
            update={"human_in_loop": approve_plan}
        )
    if max_retries is not None:
        workflow_updates["qa"] = config.workflow.qa.model_copy(
            update={"max_retries": max_retries}
        )

    updates: dict = {}
    if workflow_updates:
        updates["workflow"] = config.workflow.model_copy(update=workflow_updates)
    if base_branch is not None:
        updates["pr"] = config.pr.model_copy(update={"base_branch": base_branch})

    return config.model_copy(update=updates) if updates else config
