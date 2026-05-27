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

    [human_in_loop]
    approve_plan           = true
    approve_branch         = false
    approve_implementation = false
    approve_qa_failure     = false
    approve_pr             = false

    [branch]
    max_slug_length = 50

    [pr]
    base_branch = "main"
    draft       = false
    reviewers   = []
    labels      = []
"""

import tomllib
from pathlib import Path

from pydantic import BaseModel, Field

from orchestrator.paths import find_project_root


class ModelsConfig(BaseModel):
    planning: str = "claude-sonnet-4-6"
    implementation: str = "claude-sonnet-4-6"
    qa: str = "claude-sonnet-4-6"


class HumanInLoopConfig(BaseModel):
    approve_plan: bool = True
    approve_branch: bool = False
    approve_implementation: bool = False
    approve_qa_failure: bool = False
    approve_pr: bool = False


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


def load_config(path: Path | None = None) -> OrchestratorConfig:
    """Load config from orchestrator.toml; return defaults if file is missing."""
    if path is None:
        path = find_project_root() / "orchestrator.toml"
    if not path.exists():
        return OrchestratorConfig()
    with path.open("rb") as f:
        data = tomllib.load(f)
    return OrchestratorConfig.model_validate(data)
