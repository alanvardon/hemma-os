"""User-facing config file for the orchestrator.

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
    max_tasks = 0                         # 0 = uncapped; >0 = advisory task cap

    [workflow.branch]
    max_slug_length = 50

    [workflow.implementation]
    allowed_tools = ["Read", "Edit", "Write", "Bash"]
    # A built-in's model/tools may instead come from its prompt frontmatter
    # (.orchestrator/prompts/<step>.md); a key set here overrides it.

    [workflow.qa]
    allowed_tools = ["Read", "Grep", "Bash"]
    # The impl↔QA retry budget lives on [workflow.task_build].retry.max

    [workflow.docs]
    model = "claude-haiku-4-5-20251001"    # baked-in docs agent

    [workflow.summarize]
    model = "claude-haiku-4-5-20251001"    # baked-in summarizer agent

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


# Env var names for the per-invocation overrides. Kept here (not in the override
# function) so they're easy to find and
# document in one place — and so docs/tests can import the constants
# instead of re-typing the strings.
ENV_APPROVE_PLAN = "ORCHESTRATOR_APPROVE_PLAN"
ENV_BASE_BRANCH = "ORCHESTRATOR_BASE_BRANCH"
# Fully-autonomous mode + its safety rails.
ENV_FULLY_AUTONOMOUS = "ORCHESTRATOR_FULLY_AUTONOMOUS"
ENV_AUTONOMOUS_MAX_SECONDS = "ORCHESTRATOR_AUTONOMOUS_MAX_SECONDS"
ENV_AUTONOMOUS_MAX_COST_USD = "ORCHESTRATOR_AUTONOMOUS_MAX_COST_USD"


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


def _parse_float_env(name: str, value: str) -> float:
    try:
        return float(value.strip())
    except ValueError as exc:
        raise ValueError(
            f"{name}={value!r} is not a valid number."
        ) from exc


# Default model used by any workflow step whose `model` is left unset.
_DEFAULT_MODEL = "claude-sonnet-4-6"
# The docs spine task defaults to haiku — a read-diff / edit-md task, not a
# reasoning task.
_DEFAULT_DOCS_MODEL = "claude-haiku-4-5-20251001"
# The summarizer reads the plan + `git diff HEAD` and emits the
# commit/PR summary + test_plan. Like docs it's a cheap, read-only agent → haiku.
_DEFAULT_SUMMARIZE_MODEL = "claude-haiku-4-5-20251001"


class WorkflowStepConfig(BaseModel):
    """Per-step config for one built-in spine step.

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


class WorkflowDecomposeConfig(WorkflowStepConfig):
    # Advisory cap on how many tasks the decomposer may emit. 0 = uncapped. > 0 is
    # passed to the decomposer as soft guidance, not a hard validation error — an
    # over-split run should surface for review rather than abort.
    max_tasks: int = 0


class WorkflowTaskBuildConfig(BaseModel):
    """The recipe applied to EACH decomposed task by the per-task station.

    The plan owns *what* the tasks are (the decomposer's list); this owns *how*
    each task is built and checked. `produce`/`gate` reference [steps.defs.*] ids
    or the built-in `implementation` producer / `qa` gate. Mirrors a BuildStep's
    fields so the station can reuse the existing build engine per task.

    Defaults: implementation produces, QA gates *each* task (so the implement⇄QA
    auto-fix retry loop runs per task), and gate exhaustion pauses-and-asks rather
    than hard-aborting. Point `gate` at a cheap script for the cost-shaped pattern
    (cheap per-task check + one final whole-diff QA — see [workflow.final_qa])."""

    model_config = ConfigDict(extra="forbid")
    produce: list[str] = Field(default_factory=lambda: ["implementation"])
    gate: list[str] = Field(default_factory=lambda: ["qa"])
    retry: RetryConfig = Field(
        default_factory=lambda: RetryConfig(max=3, on_exhausted="approval_gate")
    )
    human_in_loop: HumanInLoopConfig = Field(default_factory=HumanInLoopConfig)


class WorkflowFinalQaConfig(BaseModel):
    """An optional single whole-diff acceptance check after ALL tasks pass.

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
    # Turns the approved plan into an ordered task list. Runs after planning, before
    # branch. Model inherits default_model unless its prompt frontmatter or
    # [workflow.decompose] sets one.
    decompose: WorkflowDecomposeConfig = Field(default_factory=WorkflowDecomposeConfig)
    # The per-task execution loop. task_build is the recipe run for each decomposed
    # task; final_qa is an optional once-after-the-loop whole-diff check.
    task_build: WorkflowTaskBuildConfig = Field(default_factory=WorkflowTaskBuildConfig)
    final_qa: WorkflowFinalQaConfig = Field(default_factory=WorkflowFinalQaConfig)
    branch: WorkflowBranchConfig = Field(default_factory=WorkflowBranchConfig)
    implementation: WorkflowStepConfig = Field(
        default_factory=lambda: WorkflowStepConfig(
            allowed_tools=["Read", "Edit", "Write", "Bash"]
        )
    )
    qa: WorkflowStepConfig = Field(
        default_factory=lambda: WorkflowStepConfig(allowed_tools=["Read", "Grep", "Bash"])
    )
    docs: WorkflowStepConfig = Field(
        default_factory=lambda: WorkflowStepConfig(
            model=_DEFAULT_DOCS_MODEL, timeout=120
        )
    )
    # Derives the commit/PR summary + test_plan from the plan + diff, after the
    # impl→QA retry block passes. Read-only tools (Bash for git diff).
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
    """Scripted QA gate: the executable checks under scripts_dir that run before
    the QA agent. Distinct from [workflow.qa] (the QA agent step)."""

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
    # The PR label is auto-derived from plan.type in git_ops.pr_create.


class AuditConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = True
    log_path: str = ".orchestrator/audit.log"
    include_content: bool = False


class OrchestratorConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    default_model: str = _DEFAULT_MODEL
    db_path: str = ".orchestrator/checkpoints.db"
    # Never pause for a human. Suppresses every human_in_loop gate, auto-approves
    # approval_gate steps, and makes build retries unbounded (the produce⇄gate loop
    # runs until a gate passes — no exhaustion). For CI / unattended runs. Per-step
    # gate settings are bypassed at runtime, not erased.
    fully_autonomous: bool = False
    # Safety rails for the unbounded loop above; enforced ONLY when
    # fully_autonomous is true. Both <= 0 mean "no ceiling" (loop until solved).
    # A trip stops the run via the same cancel path → status="cancelled",
    # reason="autonomous_ceiling".
    autonomous_max_seconds: int = 0      # wall-clock budget per invocation
    autonomous_max_cost_usd: float = 0.0  # USD spend budget for the run
    workflow: WorkflowConfig = Field(default_factory=WorkflowConfig)
    pre_hooks: PreHooksConfig = Field(default_factory=PreHooksConfig)
    qa: QaConfig = Field(default_factory=QaConfig)
    git: GitConfig = Field(default_factory=GitConfig)
    pr: PrConfig = Field(default_factory=PrConfig)
    audit: AuditConfig = Field(default_factory=AuditConfig)

    def resolved_model(self, step: WorkflowStepConfig) -> str:
        """Return the step's model, falling back to default_model when unset."""
        return step.model if step.model is not None else self.default_model


# Built-in spine steps whose model/tools may be driven by their prompt file's
# frontmatter. branch/commit run no agent (deterministic git ops), so they have no
# prompt and are absent here.
_BUILTIN_PROMPT_STEPS: tuple[str, ...] = (
    "planning", "decompose", "implementation", "qa", "docs", "summarize",
)
# Only the operational dials cross over from frontmatter. human_in_loop is
# deliberately excluded: planning/branch/commit own that flag, and the build's
# implementation/qa pauses live on the build step (guarded above).
_BUILTIN_FRONTMATTER_FIELDS: tuple[str, ...] = (
    "model", "allowed_tools", "disallowed_tools", "timeout",
)


def _merge_builtin_frontmatter(
    config: OrchestratorConfig, raw_workflow: dict
) -> OrchestratorConfig:
    """Let a built-in agent's prompt frontmatter supply its model/tools.

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


_MAX_RETRIES_MIGRATION = (
    "`max_retries` has been removed. The impl⇄QA retry budget now lives on the "
    "per-task station: set [workflow.task_build].retry.max instead "
    "(ORCHESTRATOR_MAX_RETRIES is gone too)."
)


def _reject_removed_max_retries(data: dict) -> None:
    """Fail loud if a config still sets the removed `max_retries` knob.

    Covers both historical homes: the top-level key and [workflow.qa].
    """
    if "max_retries" in data:
        raise ValueError(_MAX_RETRIES_MIGRATION)
    qa = (data.get("workflow") or {}).get("qa")
    if isinstance(qa, dict) and "max_retries" in qa:
        raise ValueError(_MAX_RETRIES_MIGRATION)


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
        # The old impl⇄QA retry budget (`max_retries`) was superseded by the build
        # step's retry.max and removed. Fail loud with a migration message rather
        # than letting extra="forbid" emit a generic "unexpected key" — the single
        # source of truth is now [workflow.task_build].retry.max.
        _reject_removed_max_retries(data)
        config = OrchestratorConfig.model_validate(data)
        raw_workflow = data.get("workflow") or {}
    # The build's human pauses live on the build step's own
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
    # A built-in agent's prompt frontmatter (model/tools) drives that step, with
    # [workflow.<step>] overriding. No-op when prompts have no frontmatter (the
    # default).
    return _merge_builtin_frontmatter(config, raw_workflow)


def apply_overrides(
    config: OrchestratorConfig,
    *,
    approve_plan: bool | None = None,
    base_branch: str | None = None,
    fully_autonomous: bool | None = None,
    autonomous_max_seconds: int | None = None,
    autonomous_max_cost_usd: float | None = None,
) -> OrchestratorConfig:
    """Overlay per-invocation overrides on a loaded config.

    Resolution order per knob: explicit kwarg → env var → unchanged.
    Returns a NEW OrchestratorConfig — never mutates the input.

    The env-var fallback is read here (not by the caller) so CLI flags
    and MCP tool params share one resolution path. Invalid env values
    raise ValueError so misconfiguration fails loud instead of being
    silently ignored.
    """
    if approve_plan is None and (raw := os.environ.get(ENV_APPROVE_PLAN)) is not None:
        approve_plan = _parse_bool_env(ENV_APPROVE_PLAN, raw)
    if base_branch is None and (raw := os.environ.get(ENV_BASE_BRANCH)) is not None:
        base_branch = raw.strip() or None
    if fully_autonomous is None and (raw := os.environ.get(ENV_FULLY_AUTONOMOUS)) is not None:
        fully_autonomous = _parse_bool_env(ENV_FULLY_AUTONOMOUS, raw)
    if autonomous_max_seconds is None and (raw := os.environ.get(ENV_AUTONOMOUS_MAX_SECONDS)) is not None:
        autonomous_max_seconds = _parse_int_env(ENV_AUTONOMOUS_MAX_SECONDS, raw)
    if autonomous_max_cost_usd is None and (raw := os.environ.get(ENV_AUTONOMOUS_MAX_COST_USD)) is not None:
        autonomous_max_cost_usd = _parse_float_env(ENV_AUTONOMOUS_MAX_COST_USD, raw)

    # approve_plan lives under config.workflow now
    # (workflow.planning.human_in_loop), so collect its nested update and apply
    # it to a workflow copy.
    workflow_updates: dict = {}
    if approve_plan is not None:
        workflow_updates["planning"] = config.workflow.planning.model_copy(
            update={"human_in_loop": approve_plan}
        )

    updates: dict = {}
    if workflow_updates:
        updates["workflow"] = config.workflow.model_copy(update=workflow_updates)
    if base_branch is not None:
        updates["pr"] = config.pr.model_copy(update={"base_branch": base_branch})
    # Top-level autonomous knobs (no nested workflow rewrite — the flag is read at
    # the interrupt sites, which apply_overrides can't reach anyway).
    if fully_autonomous is not None:
        updates["fully_autonomous"] = fully_autonomous
    if autonomous_max_seconds is not None:
        updates["autonomous_max_seconds"] = autonomous_max_seconds
    if autonomous_max_cost_usd is not None:
        updates["autonomous_max_cost_usd"] = autonomous_max_cost_usd

    return config.model_copy(update=updates) if updates else config
