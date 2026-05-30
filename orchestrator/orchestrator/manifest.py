"""Pluggable-step manifest (Phase 33).

Lets operators inject steps into the workflow by editing orchestrator.toml,
without touching workflow.py. The core spine
(verify_clean_tree → plan → branch → impl → qa → commit → push → pr) stays
hard-coded; users add steps only at fixed *seams* that all sit before the
commit line (so cancel semantics stay safe).

This is the constrained, lower-risk first increment of the vision in
PLUGGABLE_WORKFLOW.md — fixed seams, not a free-form DAG.

TOML shape (everything optional; no [steps] table = no injected steps):

    [[steps.before_plan]]
    id   = "lint"
    type = "script"
    path = ".orchestrator/scripts/lint.sh"
    timeout = 60

    [[steps.after_qa]]
    id    = "docs"
    type  = "llm_agent"
    agent = "docs"            # → .orchestrator/agents/docs.md
    model = "claude-sonnet-4-6"

    [[steps.after_qa]]
    id   = "security_gate"
    type = "human_gate"
    ask  = "QA passed. Approve security posture before commit?"

The loader validates at load time (before any LLM spend): unknown seam
names, duplicate ids, missing script paths, unknown agent references. A
problem raises ManifestError with a clear message.
"""

from __future__ import annotations

import hashlib
import json
import tomllib
from pathlib import Path
from typing import Annotated, Literal, Union

from pydantic import BaseModel, Field, TypeAdapter, ValidationError

from orchestrator.errors import FatalError
from orchestrator.paths import find_project_root
from orchestrator.usage import TaskUsage


# The only valid insertion points. All sit BEFORE the commit line so an
# injected step can never create a half-shipped state on cancel. Adding
# after-commit seams is intentionally refused (see phase_33 landmine).
SEAMS: tuple[str, ...] = (
    "before_plan",
    "after_plan",
    "after_impl",
    "after_qa",
    "before_commit",
)


class ManifestError(FatalError):
    """Raised at load time for a malformed or invalid step manifest."""


class _BaseStep(BaseModel):
    # `id` is the step's RESUME IDENTITY: a step's @task cache key derives
    # from it, so renaming an id mid-run makes resume re-run that step.
    id: str


class ScriptStep(_BaseStep):
    type: Literal["script"] = "script"
    path: str
    # Seconds before the script is killed. Bounds cancel latency, since
    # cancel is checked between steps, not mid-execution.
    timeout: int = 60


class HumanGateStep(_BaseStep):
    type: Literal["human_gate"] = "human_gate"
    ask: str = "Proceed?"


class LlmAgentStep(_BaseStep):
    type: Literal["llm_agent"] = "llm_agent"
    # Resolves to .orchestrator/agents/<agent>.md (the system prompt).
    agent: str
    model: str = "claude-sonnet-4-6"


Step = Annotated[
    Union[ScriptStep, HumanGateStep, LlmAgentStep],
    Field(discriminator="type"),
]
_STEP_ADAPTER: TypeAdapter = TypeAdapter(Step)


class StepResult(BaseModel):
    """Result of running one injected step.

    A single registered type for ALL injected steps, so the workflow's
    serde allowlist stays closed no matter how many steps users add — they
    never touch _ALLOWED_MSGPACK_MODULES.
    """

    step_id: str
    kind: str
    ok: bool = True
    detail: str = ""
    usage: TaskUsage | None = None


class WorkflowManifest(BaseModel):
    # seam name → ordered steps injected at that seam.
    steps: dict[str, list[Step]] = Field(default_factory=dict)

    def for_seam(self, seam: str) -> list[Step]:
        return self.steps.get(seam, [])

    def is_empty(self) -> bool:
        return not any(self.steps.values())

    def manifest_hash(self) -> str:
        """Stable hash of the resolved manifest.

        Snapshotted into the run's first checkpoint; compared on resume so a
        mid-run orchestrator.toml edit refuses the resume (Phase 33 resume
        safety) the same way an incompatible WORKFLOW_VERSION does (Phase 20).
        """
        canonical = {
            seam: [s.model_dump() for s in self.steps.get(seam, [])]
            for seam in SEAMS
            if self.steps.get(seam)
        }
        blob = json.dumps(canonical, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def _agent_file(
    project_root: Path, agent: str, agents_dir: str = ".orchestrator/agents"
) -> Path:
    return project_root / agents_dir / f"{agent}.md"


def load_manifest(
    config_path: Path | None = None, project_root: Path | None = None
) -> WorkflowManifest:
    """Load and validate the step manifest from orchestrator.toml.

    Returns an empty manifest when the file or its [steps] table is absent.
    Raises ManifestError on any validation problem — unknown seam, duplicate
    id, missing script path, or unknown agent reference.
    """
    if project_root is None:
        project_root = find_project_root()
    if config_path is None:
        config_path = project_root / "orchestrator.toml"

    if not config_path.exists():
        return WorkflowManifest()

    with config_path.open("rb") as f:
        data = tomllib.load(f)

    # Phase 40: agent prompts may live in a configurable dir (config.agents_dir).
    # Read it from the same TOML so load-time validation and runtime loading
    # (steps._load_agent_prompt) resolve agent files identically.
    agents_dir = data.get("agents_dir", ".orchestrator/agents")

    raw = data.get("steps", {})
    if not raw:
        return WorkflowManifest()
    if not isinstance(raw, dict):
        raise ManifestError(
            "[steps] must be a table of seam arrays, e.g. [[steps.after_qa]]"
        )

    steps: dict[str, list[Step]] = {}
    seen_ids: dict[str, str] = {}

    for seam, items in raw.items():
        if seam not in SEAMS:
            raise ManifestError(
                f"unknown seam {seam!r}. Valid seams: {', '.join(SEAMS)}."
            )
        if not isinstance(items, list):
            raise ManifestError(
                f"[steps.{seam}] must be an array of tables ([[steps.{seam}]])."
            )

        parsed: list[Step] = []
        for item in items:
            try:
                step = _STEP_ADAPTER.validate_python(item)
            except ValidationError as exc:
                raise ManifestError(
                    f"invalid step in seam {seam!r}: {exc}"
                ) from exc

            if step.id in seen_ids:
                raise ManifestError(
                    f"duplicate step id {step.id!r} (in seams "
                    f"{seen_ids[step.id]!r} and {seam!r}); ids must be unique."
                )
            seen_ids[step.id] = seam

            if isinstance(step, ScriptStep):
                if not (project_root / step.path).exists():
                    raise ManifestError(
                        f"step {step.id!r}: script not found at {step.path!r}."
                    )
            elif isinstance(step, LlmAgentStep):
                if not _agent_file(project_root, step.agent, agents_dir).exists():
                    raise ManifestError(
                        f"step {step.id!r}: agent file not found at "
                        f"{agents_dir}/{step.agent}.md."
                    )

            parsed.append(step)

        steps[seam] = parsed

    return WorkflowManifest(steps=steps)
