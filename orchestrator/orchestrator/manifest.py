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
    type  = "ai_agent"
    agent = "docs"            # file stem
    dir   = "team/agents"     # → team/agents/docs.md (per-step, required)
    model = "claude-sonnet-4-6"

    [[steps.after_qa]]
    id   = "security_gate"
    type = "approval_gate"
    ask  = "QA passed. Approve security posture before commit?"

Phase 42 — a `retry` block: re-run producer(s) until gate(s) pass (or the
budget is exhausted), with the failing gate's feedback injected into the next
producer attempt. produce/gate reference definitions under [steps.defs.*]:

    [[steps.after_impl]]
    id           = "lint-loop"
    type         = "retry"
    produce      = ["lint-fix"]      # ids defined in [steps.defs.*]
    gate         = ["lint-check"]    # gate verdict = script exit / agent `passed`
    max_retries  = 3
    on_exhausted = "abort"           # abort | approval_gate | proceed

    [steps.defs.lint-fix]
    type  = "ai_agent"
    agent = "lint-fixer"
    dir   = "team/agents"

    [steps.defs.lint-check]
    type = "script"
    path = ".orchestrator/scripts/lint.sh"

The loader validates at load time (before any LLM spend): unknown seam
names, duplicate ids, missing script paths, unknown agent references, and —
for retry blocks — that produce/gate reference defined ids, that no id is both
a producer and a gate, and that both lists are non-empty. A problem raises
ManifestError with a clear message.
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


class ApprovalGateStep(_BaseStep):
    type: Literal["approval_gate"] = "approval_gate"
    ask: str = "Proceed?"


class AiAgentStep(_BaseStep):
    type: Literal["ai_agent"] = "ai_agent"
    # The system prompt is <dir>/<agent>.md, relative to the project root.
    # `dir` is required and per-step — each ai_agent points at wherever its
    # prompt lives, so agents can be stored anywhere (there is no global
    # agents_dir). `agent` is the file stem (also used in logs / errors).
    agent: str
    dir: str
    model: str = "claude-sonnet-4-6"
    # When true, pause AFTER the agent runs (before the workflow continues) so a
    # human can inspect what it produced. Same reply contract as approval_gate: an
    # abort word ('abort'/'no'/'stop') stops the run; anything else proceeds.
    # For an agent placed directly at a seam the pause fires right after it runs.
    # For a [steps.defs.*] agent used as a retry-block PRODUCER it fires once,
    # after the block succeeds (the gate passed) — not on intermediate failed
    # attempts, and not if the block exhausts its budget. Ignored on a retry-block
    # gate (a read-only judge run every attempt).
    human_in_loop: bool = False


class RetryBlockStep(_BaseStep):
    """Phase 42: a declarative retry block injected at a seam.

    `produce` and `gate` hold ids that reference [steps.defs.*] definitions. The
    generic engine (retry_block.run_retry_block) re-runs the producers — with the
    failing gate's feedback injected — until a gate passes or the retry budget is
    exhausted. Gates run in declared order; the first to fail short-circuits the
    rest and triggers a retry. `on_exhausted` decides what happens when the
    budget runs out: abort the run, ask a human, or proceed anyway.
    """

    type: Literal["retry"] = "retry"
    produce: list[str]
    gate: list[str]
    max_retries: int = Field(default=3, ge=1)
    on_exhausted: Literal["abort", "approval_gate", "proceed"] = "abort"


# Steps that can be INJECTED at a seam (a retry block is one of them).
Step = Annotated[
    Union[ScriptStep, ApprovalGateStep, AiAgentStep, RetryBlockStep],
    Field(discriminator="type"),
]
_STEP_ADAPTER: TypeAdapter = TypeAdapter(Step)

# Steps that can be DEFINED under [steps.defs.*] and referenced by a retry block
# as a producer or gate. Only executable mutator/checker steps qualify — a
# approval_gate is a pause, not a producer or gate, so it's excluded; and a retry
# block can't reference another block. Both variants are gate-capable: a script
# gate's verdict is its exit code, and an ai_agent gate is run with a
# `passed`-emitting tool at execution time (see steps.execute_ai_agent).
StepDef = Annotated[
    Union[ScriptStep, AiAgentStep],
    Field(discriminator="type"),
]
_STEPDEF_ADAPTER: TypeAdapter = TypeAdapter(StepDef)


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
    # Phase 42: gate verdict. None = this step is not a gate; True/False = a
    # gate's pass/fail. The retry engine fails closed on a None in a gate slot.
    passed: bool | None = None
    usage: TaskUsage | None = None


class WorkflowManifest(BaseModel):
    # seam name → ordered steps injected at that seam.
    steps: dict[str, list[Step]] = Field(default_factory=dict)
    # Phase 42: id → step definition, referenced by retry blocks' produce/gate.
    defs: dict[str, StepDef] = Field(default_factory=dict)

    def for_seam(self, seam: str) -> list[Step]:
        return self.steps.get(seam, [])

    def is_empty(self) -> bool:
        # defs alone (with no seam steps referencing them) execute nothing.
        return not any(self.steps.values())

    def _hashable_step(self, step: Step) -> dict:
        d = step.model_dump()
        if isinstance(step, RetryBlockStep):
            # Phase 42 resume safety: fold the referenced defs into the block's
            # hashed form so editing a def *body* (not just the block) also
            # refuses the resume. The block dump alone only names def ids, so
            # without this a changed lint.sh / agent would resume silently.
            d["_resolved_defs"] = {
                rid: self.defs[rid].model_dump()
                for rid in (step.produce + step.gate)
                if rid in self.defs
            }
        return d

    def manifest_hash(self) -> str:
        """Stable hash of the resolved manifest.

        Snapshotted into the run's first checkpoint; compared on resume so a
        mid-run orchestrator.toml edit refuses the resume (Phase 33 resume
        safety) the same way an incompatible WORKFLOW_VERSION does (Phase 20).
        """
        canonical = {
            seam: [self._hashable_step(s) for s in self.steps.get(seam, [])]
            for seam in SEAMS
            if self.steps.get(seam)
        }
        blob = json.dumps(canonical, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def _agent_file(project_root: Path, step: AiAgentStep) -> Path:
    return project_root / step.dir / f"{step.agent}.md"


def _validate_retry_block(step: RetryBlockStep, defs: dict[str, StepDef]) -> None:
    """Validate a retry block's references against [steps.defs.*] (Phase 42).

    max_retries (>= 1) and on_exhausted (the abort/approval_gate/proceed enum) are
    already enforced by the Pydantic model; this covers the cross-references.
    """
    if not step.produce:
        raise ManifestError(
            f"retry block {step.id!r}: `produce` must list at least one "
            f"[steps.defs.*] id."
        )
    if not step.gate:
        raise ManifestError(
            f"retry block {step.id!r}: `gate` must list at least one "
            f"[steps.defs.*] id."
        )
    both = sorted(set(step.produce) & set(step.gate))
    if both:
        raise ManifestError(
            f"retry block {step.id!r}: {both} listed as both producer and gate; "
            f"a step is one or the other."
        )
    for rid in step.produce + step.gate:
        if rid not in defs:
            raise ManifestError(
                f"retry block {step.id!r}: references unknown step def {rid!r}. "
                f"Define it under [steps.defs.{rid}]."
            )
    # Gate-capability: defs are restricted to script | ai_agent (StepDef
    # excludes approval_gate), and both are gate-capable — a script gate's verdict
    # is its exit code; an ai_agent gate is run with a `passed`-emitting tool.
    # So a referenced gate id is always gate-capable; no further check needed.


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

    raw = data.get("steps", {})
    if not raw:
        return WorkflowManifest()
    if not isinstance(raw, dict):
        raise ManifestError(
            "[steps] must be a table of seam arrays, e.g. [[steps.after_qa]]"
        )

    # All step ids (seam steps AND [steps.defs.*]) share one namespace so a
    # retry block can reference a def unambiguously by id.
    seen_ids: dict[str, str] = {}

    # Phase 42: [steps.defs.*] — the producer/gate step definitions referenced
    # by retry blocks. A table keyed by id (NOT a seam array), so pull it out
    # before the seam loop and parse it first, so retry blocks can be validated
    # against it.
    defs_raw = raw.pop("defs", {})
    defs: dict[str, StepDef] = {}
    if defs_raw:
        if not isinstance(defs_raw, dict):
            raise ManifestError(
                "[steps.defs] must be a table of named step definitions, "
                "e.g. [steps.defs.my-gate]."
            )
        for def_id, body in defs_raw.items():
            if not isinstance(body, dict):
                raise ManifestError(
                    f"[steps.defs.{def_id}] must be a table with a `type`."
                )
            try:
                # The id is the table key; inject it so the model is complete.
                definition = _STEPDEF_ADAPTER.validate_python({**body, "id": def_id})
            except ValidationError as exc:
                raise ManifestError(
                    f"invalid step def {def_id!r}: {exc}"
                ) from exc
            if def_id in seen_ids:
                raise ManifestError(
                    f"duplicate step id {def_id!r}; ids must be unique."
                )
            seen_ids[def_id] = "steps.defs"
            if isinstance(definition, ScriptStep):
                if not (project_root / definition.path).exists():
                    raise ManifestError(
                        f"step def {def_id!r}: script not found at "
                        f"{definition.path!r}."
                    )
            elif isinstance(definition, AiAgentStep):
                if not _agent_file(project_root, definition).exists():
                    raise ManifestError(
                        f"step def {def_id!r}: agent file not found at "
                        f"{definition.dir}/{definition.agent}.md."
                    )
            defs[def_id] = definition

    steps: dict[str, list[Step]] = {}

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
                    f"duplicate step id {step.id!r} (in {seen_ids[step.id]!r} "
                    f"and {seam!r}); ids must be unique."
                )
            seen_ids[step.id] = seam

            if isinstance(step, ScriptStep):
                if not (project_root / step.path).exists():
                    raise ManifestError(
                        f"step {step.id!r}: script not found at {step.path!r}."
                    )
            elif isinstance(step, AiAgentStep):
                if not _agent_file(project_root, step).exists():
                    raise ManifestError(
                        f"step {step.id!r}: agent file not found at "
                        f"{step.dir}/{step.agent}.md."
                    )
            elif isinstance(step, RetryBlockStep):
                _validate_retry_block(step, defs)

            parsed.append(step)

        steps[seam] = parsed

    return WorkflowManifest(steps=steps, defs=defs)
