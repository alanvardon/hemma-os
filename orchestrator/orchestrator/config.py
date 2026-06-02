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

    [workflow.branch]
    max_slug_length = 50

    [workflow.implementation]
    allowed_tools = ["Read", "Edit", "Write", "Bash"]

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


class WorkflowConfig(BaseModel):
    """The built-in spine, one table per step. Counterpart to [steps.*] —
    user-injected pluggable steps owned by manifest.py."""

    model_config = ConfigDict(extra="forbid")
    planning: WorkflowStepConfig = Field(
        default_factory=lambda: WorkflowStepConfig(human_in_loop=True)
    )
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


def load_config(path: Path | None = None) -> OrchestratorConfig:
    """Load config from orchestrator.toml; return defaults if file is missing."""
    if path is None:
        path = find_project_root() / "orchestrator.toml"
    if not path.exists():
        return OrchestratorConfig()
    with path.open("rb") as f:
        data = tomllib.load(f)
    # [steps.*] is the pluggable-step manifest namespace (owned by manifest.py),
    # not orchestrator config. Drop it before validation so extra="forbid" can
    # guard the config keys without rejecting the manifest table that shares
    # this file.
    data.pop("steps", None)
    config = OrchestratorConfig.model_validate(data)
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
    return config


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
