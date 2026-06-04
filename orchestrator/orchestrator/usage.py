"""Token and cost tracking.

TaskUsage carries the raw token counts for one agent call. cost_usd()
resolves prices in priority order:
  1. reported_cost_usd — the SDK's own figure when available
  2. litellm.model_cost — stays current automatically if litellm is installed
  3. PRICES_USD_PER_MTOKEN — hardcoded fallback; update when Anthropic changes rates
"""

from __future__ import annotations

from pydantic import BaseModel

try:
    import litellm as _litellm
    _LITELLM_AVAILABLE = True
except ImportError:
    _LITELLM_AVAILABLE = False

# USD per million tokens. Keys are the exact model IDs passed to the API.
# cache_read / cache_write are prompt-caching tier prices.
PRICES_USD_PER_MTOKEN: dict[str, dict[str, float]] = {
    "claude-opus-4-7": {
        "input": 15.0,
        "output": 75.0,
        "cache_read": 1.50,
        "cache_write": 18.75,
    },
    "claude-sonnet-4-6": {
        "input": 3.0,
        "output": 15.0,
        "cache_read": 0.30,
        "cache_write": 3.75,
    },
    "claude-haiku-4-5-20251001": {
        "input": 0.80,
        "output": 4.0,
        "cache_read": 0.08,
        "cache_write": 1.0,
    },
    "claude-haiku-4-5": {
        "input": 0.80,
        "output": 4.0,
        "cache_read": 0.08,
        "cache_write": 1.0,
    },
}


class TaskUsage(BaseModel):
    model: str
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0
    # Populated from the SDK's reported cost when available. Takes
    # precedence over the price-table calculation in cost_usd().
    reported_cost_usd: float | None = None

    def cost_usd(self) -> float | None:
        if self.reported_cost_usd is not None:
            return self.reported_cost_usd

        # LiteLLM stores cost per token (not per million); keys use the
        # "cache_read_input_token_cost" / "cache_creation_input_token_cost"
        # convention. .get() with 0 default so unknown cache keys degrade
        # gracefully rather than raising.
        if _LITELLM_AVAILABLE:
            model_data = _litellm.model_cost.get(self.model)
            if model_data:
                return (
                    self.input_tokens * model_data.get("input_cost_per_token", 0)
                    + self.output_tokens * model_data.get("output_cost_per_token", 0)
                    + self.cache_read_tokens * model_data.get("cache_read_input_token_cost", 0)
                    + self.cache_creation_tokens * model_data.get("cache_creation_input_token_cost", 0)
                )

        prices = PRICES_USD_PER_MTOKEN.get(self.model)
        if prices is None:
            return None
        return (
            self.input_tokens * prices["input"] / 1_000_000
            + self.output_tokens * prices["output"] / 1_000_000
            + self.cache_read_tokens * prices["cache_read"] / 1_000_000
            + self.cache_creation_tokens * prices["cache_write"] / 1_000_000
        )


def aggregate_usage(by_task: dict[str, list[TaskUsage]]) -> dict:
    """Summarise per-task usage lists into a result-dict-ready structure.

    Returns {} when no usage was captured (e.g. in tests where agent
    stubs return results without usage). Callers should check for an
    empty dict before rendering a banner.
    """
    task_summaries: dict[str, dict] = {}
    total_in = total_out = 0
    total_cost: float | None = 0.0

    for task_name, usages in by_task.items():
        if not usages:
            continue
        task_in = sum(u.input_tokens for u in usages)
        task_out = sum(u.output_tokens for u in usages)
        costs = [c for u in usages if (c := u.cost_usd()) is not None]
        task_cost: float | None = sum(costs) if costs else None

        task_summaries[task_name] = {
            "input_tokens": task_in,
            "output_tokens": task_out,
            "cost_usd": round(task_cost, 6) if task_cost is not None else None,
        }
        total_in += task_in
        total_out += task_out
        if task_cost is not None and total_cost is not None:
            total_cost += task_cost
        else:
            total_cost = None  # any unknown cost makes the total unknown

    if not task_summaries:
        return {}

    return {
        "by_task": task_summaries,
        "total": {
            "input_tokens": total_in,
            "output_tokens": total_out,
            "cost_usd": round(total_cost, 6) if total_cost is not None else None,
        },
    }
