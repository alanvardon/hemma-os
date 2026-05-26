# load_dotenv reads the .env file in the current working directory and sets
# environment variables. AsyncAnthropic() with no args picks up ANTHROPIC_API_KEY
# from os.environ, so this is how the key reaches the SDK.
from dotenv import load_dotenv
load_dotenv()

import asyncio
import sys

# AsyncAnthropic is the async-IO variant of the Anthropic client. We use it
# because LangGraph (later phases) runs tasks concurrently in an asyncio loop;
# committing to async now means no rewrites when the framework arrives.
from anthropic import AsyncAnthropic



# Pydantic is a data-validation library. BaseModel gives us automatic
# type coercion and a clean __repr__ — no need to write __init__ or validate
# fields manually. The model acts as a typed contract between the planning
# agent and anything that consumes its output.
from pydantic import BaseModel, Field

from orchestrator.usage import TaskUsage
from orchestrator.prompt_loader import load_prompt


_PLANNING_SYSTEM_PROMPT = load_prompt("planning")


# PlanResult is the structured output the planning agent returns.
# Wrapping the agent's response in a model means callers never have to
# inspect raw strings or dicts — they work with validated, typed attributes.
# Schema used as the emit_plan tool's input_schema. Excludes `usage` so
# the model is never asked to fill in token-count data.
class _PlanSchema(BaseModel):
    title: str
    type: str = Field(
        description="short kebab-case category like 'feature', 'fix', "
                    "'migration', 'config' — used as the branch prefix"
    )
    plan_text: str


class PlanResult(_PlanSchema):
    # Populated after the API call returns; not part of the LLM tool schema.
    usage: TaskUsage | None = None


async def plan(request: str, model: str = "claude-sonnet-4-6") -> PlanResult:
    """Ask Claude to produce a plan, return it as a validated PlanResult.

    Uses Anthropic's tool-use-as-structured-output pattern:
      1. We declare a fake tool ("emit_plan") whose input schema matches
         PlanResult exactly.
      2. We force tool_choice to that tool, so the model MUST respond by
         "calling" it with arguments matching the schema.
      3. The tool's input is the validated structured output. No string
         parsing, no sentinel matching, no chance of malformed responses
         surviving past this function.

    This is the single biggest robustness win over the old coordinator,
    which relied on the model emitting `PLAN COMPLETE: title=X, type=Y` as
    free text and hoping the regex matched.
    """
    client = AsyncAnthropic()
    response = await client.messages.create(
        model=model,
        max_tokens=4096,
        system=_PLANNING_SYSTEM_PROMPT,
        tools=[
            {
                "name": "emit_plan",
                "description": "Emit the structured implementation plan for the requested change.",
                "input_schema": _PlanSchema.model_json_schema(),
            }
        ],
        # tool_choice forces the model to call emit_plan rather than reply
        # with free text. This guarantees the response shape.
        tool_choice={"type": "tool", "name": "emit_plan"},
        messages=[{"role": "user", "content": request}],
    )
    tool_use = next(block for block in response.content if block.type == "tool_use")
    result = PlanResult.model_validate(tool_use.input)
    u = response.usage
    result.usage = TaskUsage(
        model=model,
        input_tokens=u.input_tokens,
        output_tokens=u.output_tokens,
        cache_read_tokens=getattr(u, "cache_read_input_tokens", 0) or 0,
        cache_creation_tokens=getattr(u, "cache_creation_input_tokens", 0) or 0,
    )
    return result


# Allow `python -m orchestrator.agents.planning "add dark mode"` to run the
# function from the terminal. asyncio.run drives the async function from
# synchronous entry-point code.
if __name__ == "__main__":
    user_request = " ".join(sys.argv[1:]) or "add a dark mode toggle"
    result = asyncio.run(plan(user_request))
    print(result.model_dump_json(indent=2))
