# load_dotenv reads the .env file in the current working directory and sets
# environment variables. AsyncAnthropic() (inside run_structured_completion) with
# no args picks up ANTHROPIC_API_KEY from os.environ; load it before the first call.
from dotenv import load_dotenv
load_dotenv()

import asyncio
import sys

from pydantic import BaseModel, Field

from orchestrator.usage import TaskUsage
from orchestrator.agents.runner import run_structured_completion
from orchestrator.prompt_loader import load_prompt


_DECOMPOSE_SYSTEM_PROMPT = load_prompt("decompose")


# Phase 55: the unit of a decomposed plan. This model is the contract Phase 56's
# per-task loop depends on, so its fields are deliberately limited to (a) what a
# fresh-context producer / a gate / a human reviewer actually need, and (b) what a
# plan-only decomposer can produce reliably. That rules out `files` (a guess
# without repo access — misleading if wrong) and any `depends_on`/DAG (order is
# list order; later tasks see earlier tasks' edits via the working tree).
class Task(BaseModel):
    id: str = Field(
        description="stable, unique kebab-case slug for this task, e.g. 'add-toggle-markup'"
    )
    title: str = Field(description="short, human-scannable name")
    description: str = Field(
        description="what THIS task changes — its slice of the plan, not a "
                    "restatement of the whole plan"
    )
    acceptance_criteria: str | None = Field(
        default=None,
        description="optional, advisory: how a reviewer or test confirms this "
                    "task is done",
    )


# Schema used as the emit_decomposition tool's input_schema. Excludes
# schema_version/usage so the model is never asked to fill those in — mirrors the
# _PlanSchema / PlanResult split in planning.py.
class _DecompositionSchema(BaseModel):
    tasks: list[Task] = Field(
        description="ordered list of tasks; a later task may build on earlier "
                    "ones. Emit a SINGLE task when the change is atomic."
    )


class DecompositionResult(_DecompositionSchema):
    # Phase 20-style schema version. Bump on incompatible shape changes; pure
    # additions of optional fields don't need a bump. Not part of the tool schema.
    schema_version: int = 1
    # Populated after the API call returns; not part of the LLM tool schema.
    usage: TaskUsage | None = None


def _build_user_message(plan_text: str, max_tasks: int) -> str:
    """The decomposer's user message: the plan, plus optional `max_tasks` guidance.

    Pure (no I/O) so the cap behaviour is unit-testable without the SDK. The
    prompt already asks for the fewest tasks; this is the soft cap. There is no
    hard validation error — Phase 55 is execution-inert, so an over-split run
    should surface for review, not abort."""
    guidance = (
        f"\n\nProduce at most {max_tasks} task(s); prefer the fewest tasks that "
        "are each independently checkable."
        if max_tasks and max_tasks > 0
        else ""
    )
    return f"## Plan\n\n{plan_text}{guidance}"


async def decompose(
    plan_text: str, model: str, max_tasks: int = 0
) -> DecompositionResult:
    """Turn an approved plan into an ordered task list (Phase 55).

    Same forced-tool-use structured-output path as planning.plan(), via the shared
    run_structured_completion (Phase 60). Reads ONLY `plan_text` — no repo access
    (repo-aware decomposition is a later phase).
    """
    return await run_structured_completion(
        system_prompt=_DECOMPOSE_SYSTEM_PROMPT,
        user_message=_build_user_message(plan_text, max_tasks),
        model=model,
        tool_name="emit_decomposition",
        tool_description="Emit the ordered task breakdown of the approved plan.",
        schema=_DecompositionSchema,
        result_model=DecompositionResult,
    )


# Allow `python -m orchestrator.agents.decompose "the plan text"` from the terminal.
if __name__ == "__main__":
    from orchestrator.config import OrchestratorConfig

    text = " ".join(sys.argv[1:]) or (
        "Add a dark mode toggle to the header and persist the choice in localStorage."
    )
    result = asyncio.run(decompose(text, OrchestratorConfig().default_model))
    print(result.model_dump_json(indent=2))
