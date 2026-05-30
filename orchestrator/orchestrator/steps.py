"""Runtime execution of injected steps (Phase 33).

Plain async functions, one per executable step type. workflow.py wraps each
in a @task so they inherit checkpointing, tracing, and cancel/usage handling
at the @task boundary — the user's step never touches that plumbing.

- execute_script: run an executable; non-zero exit raises StepError.
- execute_llm_agent: run a markdown-defined agent (.orchestrator/agents/
  <agent>.md as the system prompt) via the Claude Agent SDK, same loop shape
  as the planning/implementation/qa agents.

human_gate steps have no runner here — they're a pause (interrupt()) handled
inline in workflow.run_seam, since interrupt() must run in the entrypoint
body, not inside a @task.
"""

from __future__ import annotations

import asyncio
import logging
import subprocess
from pathlib import Path

from orchestrator.agents.runner import run_structured_agent
from orchestrator.errors import FatalError
from orchestrator.manifest import LlmAgentStep, ScriptStep, StepResult


class StepError(RuntimeError):
    """Raised when an injected step fails (non-zero script exit, timeout, or
    a missing agent file). Propagates out of the workflow and aborts it."""


def _logger(step_id: str) -> logging.Logger:
    # Child logger per step so injected-step output is attributable without
    # the user adding any logging of their own.
    return logging.getLogger(f"orchestrator.steps.{step_id}")


def _run_script_sync(step: ScriptStep, repo_root: Path) -> StepResult:
    log = _logger(step.id)
    script = repo_root / step.path
    log.info("running script step %r: %s", step.id, step.path)
    try:
        proc = subprocess.run(
            [str(script)],
            cwd=str(repo_root),
            capture_output=True,
            text=True,
            timeout=step.timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise StepError(
            f"script step {step.id!r} timed out after {step.timeout}s"
        ) from exc
    except OSError as exc:
        raise StepError(
            f"script step {step.id!r} could not be executed ({step.path}): {exc}"
        ) from exc

    out = (proc.stdout or "").strip()
    err = (proc.stderr or "").strip()
    if proc.stdout:
        log.info("[%s] stdout:\n%s", step.id, out)
    if proc.stderr:
        log.info("[%s] stderr:\n%s", step.id, err)

    if proc.returncode != 0:
        # The script's own output is the abort reason (like pre-hooks).
        report = err or out or "(no output)"
        raise StepError(
            f"script step {step.id!r} failed (exit {proc.returncode}):\n{report}"
        )

    # Keep a short tail of stdout as the human-readable detail.
    detail = out[-500:] if out else "ok"
    return StepResult(step_id=step.id, kind="script", ok=True, detail=detail)


async def execute_script(step: ScriptStep, repo_root: Path) -> StepResult:
    """Run a script step off the event loop (subprocess.run is blocking)."""
    return await asyncio.to_thread(_run_script_sync, step, repo_root)


def _load_agent_prompt(project_root: Path, agent: str) -> str:
    """Read the agent's markdown file, stripping any YAML frontmatter.

    The body is the system prompt. Frontmatter (a leading `---` block) is
    optional and ignored for v1 — the step config already carries the model,
    and the agent reads the diff itself via Bash, so reads/writes injection
    isn't needed yet.
    """
    path = project_root / ".orchestrator" / "agents" / f"{agent}.md"
    if not path.exists():
        raise StepError(
            f"agent file not found at .orchestrator/agents/{agent}.md"
        )
    text = path.read_text(encoding="utf-8")
    return _strip_frontmatter(text)


def _strip_frontmatter(text: str) -> str:
    if text.startswith("---"):
        # Split on the closing fence: lines[0] == "---", find the next "---".
        parts = text.split("\n")
        for i in range(1, len(parts)):
            if parts[i].strip() == "---":
                return "\n".join(parts[i + 1 :]).lstrip("\n")
    return text


async def execute_llm_agent(
    step: LlmAgentStep, project_root: Path, plan_text: str
) -> StepResult:
    """Run a markdown-defined agent against the current working tree.

    The agent loop lives in run_structured_agent (Phase 39); this function
    resolves the agent's markdown prompt, runs the loop, and shapes the result
    into a StepResult. The agent gets the plan in the user message and runs
    `git diff HEAD` itself to see the changes (like the qa agent).
    """
    log = _logger(step.id)
    system_prompt = _load_agent_prompt(project_root, step.agent)

    log.info("running llm_agent step %r (agent=%s)", step.id, step.agent)
    # The shared runner raises FatalError on a missing emit; re-wrap it as
    # StepError so this module keeps its single failure type. (Either error
    # aborts the workflow, but StepError is the documented step contract.)
    try:
        return await run_structured_agent(
            system_prompt=system_prompt,
            user_message="\n".join(["## Plan", "", plan_text]),
            model=step.model,
            allowed_tools=["Read", "Edit", "Write", "Bash", "Grep"],
            disallowed_tools=[],
            cwd=project_root,
            emit_tool_name="emit_step_result",
            emit_tool_description=(
                "Emit the final result of this step. Call exactly once when "
                "done, with a one-line `summary` of what you did. After "
                "calling, stop."
            ),
            emit_tool_fields={"summary": str},
            result_factory=lambda captured, usage: StepResult(
                step_id=step.id,
                kind="llm_agent",
                ok=True,
                detail=captured.get("summary", "") or "",
                usage=usage,
            ),
        )
    except FatalError as exc:
        raise StepError(
            f"llm_agent step {step.id!r} did not call emit_step_result"
        ) from exc
