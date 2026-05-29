"""User-facing config file for the orchestrator (Phase 13).

Reads orchestrator.toml from the working directory (project root) and
exposes a typed OrchestratorConfig. Missing file → all defaults.
The file is optional; run with zero config works out of the box.

Usage:
    from orchestrator.config import load_config, OrchestratorConfig

    config = load_config()                    # reads orchestrator.toml if present
    config = load_config(Path("other.toml"))  # explicit path

Sample orchestrator.toml (all fields optional, defaults shown):

    max_retries = 3
    db_path = ".orchestrator/checkpoints.db"

    [models]
    planning       = "claude-sonnet-4-6"
    implementation = "claude-sonnet-4-6"
    qa             = "claude-sonnet-4-6"
    docs           = "claude-sonnet-4-6"

    [human_in_loop]
    approve_plan           = true
    approve_branch         = false
    approve_implementation = false
    approve_qa_failure     = false
    approve_pr             = false
    docs                   = false

    [docs]
    enabled            = true
    allowed_extensions = [".md", ".rst", ".txt"]

    [branch]
    max_slug_length = 50

    [pr]
    base_branch = "main"
    draft       = false
    reviewers   = []
    labels      = []
"""

import os
import tomllib
from pathlib import Path

from pydantic import BaseModel, Field

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


class ModelsConfig(BaseModel):
    planning: str = "claude-sonnet-4-6"
    implementation: str = "claude-sonnet-4-6"
    qa: str = "claude-sonnet-4-6"
    docs: str = "claude-sonnet-4-6"


class HumanInLoopConfig(BaseModel):
    approve_plan: bool = True
    approve_branch: bool = False
    approve_implementation: bool = False
    approve_qa_failure: bool = False
    approve_pr: bool = False
    docs: bool = False


class DocsConfig(BaseModel):
    # Run the documentation agent after QA passes (Phase 26). Disable to
    # skip the doc step entirely.
    enabled: bool = True
    # Extensions the doc agent is allowed to write. Touching anything else
    # raises DocScopeError and aborts the workflow.
    allowed_extensions: list[str] = Field(
        default_factory=lambda: [".md", ".rst", ".txt"]
    )


class BranchConfig(BaseModel):
    max_slug_length: int = 50


class PrConfig(BaseModel):
    base_branch: str = "main"
    draft: bool = False
    reviewers: list[str] = Field(default_factory=list)
    labels: list[str] = Field(default_factory=list)


class OrchestratorConfig(BaseModel):
    max_retries: int = 3
    db_path: str = ".orchestrator/checkpoints.db"
    qa_scripts_dir: str = ".orchestrator/qa"
    qa_scripts_timeout: int = 60
    pre_hooks_dir: str = ".orchestrator/pre-hooks"
    pre_hooks_timeout: int = 30
    models: ModelsConfig = Field(default_factory=ModelsConfig)
    human_in_loop: HumanInLoopConfig = Field(default_factory=HumanInLoopConfig)
    branch: BranchConfig = Field(default_factory=BranchConfig)
    pr: PrConfig = Field(default_factory=PrConfig)
    docs: DocsConfig = Field(default_factory=DocsConfig)


def load_config(path: Path | None = None) -> OrchestratorConfig:
    """Load config from orchestrator.toml; return defaults if file is missing."""
    if path is None:
        path = find_project_root() / "orchestrator.toml"
    if not path.exists():
        return OrchestratorConfig()
    with path.open("rb") as f:
        data = tomllib.load(f)
    return OrchestratorConfig.model_validate(data)


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

    updates: dict = {}
    if approve_plan is not None:
        updates["human_in_loop"] = config.human_in_loop.model_copy(
            update={"approve_plan": approve_plan}
        )
    if max_retries is not None:
        updates["max_retries"] = max_retries
    if base_branch is not None:
        updates["pr"] = config.pr.model_copy(update={"base_branch": base_branch})

    return config.model_copy(update=updates) if updates else config
