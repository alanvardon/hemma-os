"""Runtime execution of injected steps (Phase 33).

Plain async functions, one per executable step type. workflow.py wraps each
in a @task so they inherit checkpointing, tracing, and cancel/usage handling
at the @task boundary — the user's step never touches that plumbing.

- execute_script: run an executable; non-zero exit raises StepError.
- execute_ai_agent: run a markdown-defined agent (<step.dir>/<agent>.md as the
  system prompt) via the Claude Agent SDK, same loop shape as the
  planning/implementation/qa agents.

approval_gate steps have no runner here — they're a pause (interrupt()) handled
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
from orchestrator.manifest import AiAgentStep, ScriptStep, StepResult
from orchestrator.retry_block import feedback_section


class StepError(RuntimeError):
    """Raised when an injected step fails (non-zero script exit, timeout, or
    a missing agent file). Propagates out of the workflow and aborts it."""


def _logger(step_id: str) -> logging.Logger:
    # Child logger per step so injected-step output is attributable without
    # the user adding any logging of their own.
    return logging.getLogger(f"orchestrator.steps.{step_id}")


def _run_script_sync(
    step: ScriptStep, repo_root: Path, *, as_gate: bool = False
) -> StepResult:
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
        report = err or out or "(no output)"
        if as_gate:
            # Phase 42: as a retry-block gate, a non-zero exit is a FAIL verdict
            # (not an abort). Its output becomes the feedback the engine injects
            # into the next producer attempt.
            return StepResult(
                step_id=step.id, kind="script", ok=True, passed=False, detail=report
            )
        # As a plain step, the script's own output is the abort reason (pre-hooks
        # behaviour): a non-zero exit fails the whole workflow.
        raise StepError(
            f"script step {step.id!r} failed (exit {proc.returncode}):\n{report}"
        )

    # Keep a short tail of stdout as the human-readable detail. A gate that
    # exits 0 is a PASS verdict; a plain step leaves `passed` unset (None).
    detail = out[-500:] if out else "ok"
    return StepResult(
        step_id=step.id,
        kind="script",
        ok=True,
        passed=True if as_gate else None,
        detail=detail,
    )


async def execute_script(
    step: ScriptStep, repo_root: Path, *, as_gate: bool = False
) -> StepResult:
    """Run a script step off the event loop (subprocess.run is blocking).

    `as_gate` (Phase 42): when True the step is a retry-block gate — a non-zero
    exit returns `passed=False` with the output as feedback instead of raising.
    """
    return await asyncio.to_thread(_run_script_sync, step, repo_root, as_gate=as_gate)


def _load_agent_prompt(project_root: Path, agent: str, dir: str) -> str:
    """Read the agent's markdown file, stripping any YAML frontmatter.

    The body is the system prompt. Frontmatter (a leading `---` block) is
    optional and ignored for v1 — the step config already carries the model,
    and the agent reads the diff itself via Bash, so reads/writes injection
    isn't needed yet.

    `dir` is the per-step directory (AiAgentStep.dir), relative to the project
    root; the prompt file is <dir>/<agent>.md. Mirrors manifest._agent_file so
    load-time validation and runtime loading resolve the same path.
    """
    path = project_root / dir / f"{agent}.md"
    if not path.exists():
        raise StepError(f"agent file not found at {dir}/{agent}.md")
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


def _coerce_passed(raw: object) -> bool:
    """Interpret the gate agent's emitted `passed` as a bool.

    The SDK normally delivers a JSON boolean as a Python bool; coerce common
    string spellings defensively (anything else is treated as a FAIL — the
    fail-closed posture carried from Phase 39)."""
    if isinstance(raw, bool):
        return raw
    return str(raw).strip().lower() in ("true", "1", "yes")


async def execute_ai_agent(
    step: AiAgentStep,
    project_root: Path,
    plan_text: str,
    *,
    feedback: str | None = None,
    as_gate: bool = False,
) -> StepResult:
    """Run a markdown-defined agent against the current working tree.

    The agent loop lives in run_structured_agent (Phase 39); this function
    resolves the agent's markdown prompt, runs the loop, and shapes the result
    into a StepResult. The agent gets the plan in the user message and runs
    `git diff HEAD` itself to see the changes (like the qa agent).

    Phase 42 (retry-block roles):
    - `feedback` (producer): on a retry, the failing gate's detail is appended
      to the user message under a standard heading, so the producer can target
      its fixes — the same feedback-injection the built-in implementation
      producer uses.
    - `as_gate`: the agent is a gate. Its emit tool gains a required `passed`
      bool (the verdict) plus `detail` (the feedback), and it runs read-only.
    """
    log = _logger(step.id)
    system_prompt = _load_agent_prompt(project_root, step.agent, step.dir)

    parts = ["## Plan", "", plan_text]
    if feedback:
        parts += ["", feedback_section(feedback)]
    user_message = "\n".join(parts)

    if as_gate:
        # A gate judges and reports; it must not mutate the tree (read-only).
        allowed_tools = ["Read", "Bash", "Grep"]
        emit_tool_description = (
            "Emit the gate verdict. Call exactly once when the check is "
            "complete: `passed` is true if the check passes, false otherwise; "
            "`detail` is the failure report / feedback (used to guide a retry "
            "on failure, empty on pass). After calling, stop."
        )
        emit_tool_fields = {"passed": bool, "detail": str}
        result_factory = lambda captured, usage: StepResult(
            step_id=step.id,
            kind="ai_agent",
            ok=True,
            passed=_coerce_passed(captured.get("passed")),
            detail=captured.get("detail", "") or "",
            usage=usage,
        )
    else:
        allowed_tools = ["Read", "Edit", "Write", "Bash", "Grep"]
        emit_tool_description = (
            "Emit the final result of this step. Call exactly once when "
            "done, with a one-line `summary` of what you did. After "
            "calling, stop."
        )
        emit_tool_fields = {"summary": str}
        result_factory = lambda captured, usage: StepResult(
            step_id=step.id,
            kind="ai_agent",
            ok=True,
            detail=captured.get("summary", "") or "",
            usage=usage,
        )

    log.info(
        "running ai_agent step %r (agent=%s, as_gate=%s)", step.id, step.agent, as_gate
    )
    # The shared runner raises FatalError on a missing emit; re-wrap it as
    # StepError so this module keeps its single failure type. (Either error
    # aborts the workflow, but StepError is the documented step contract.) The
    # fail-closed guard means a gate that never emits aborts — it never silently
    # passes.
    try:
        return await run_structured_agent(
            system_prompt=system_prompt,
            user_message=user_message,
            model=step.model,
            allowed_tools=allowed_tools,
            disallowed_tools=[],
            cwd=project_root,
            emit_tool_name="emit_step_result",
            emit_tool_description=emit_tool_description,
            emit_tool_fields=emit_tool_fields,
            result_factory=result_factory,
        )
    except FatalError as exc:
        raise StepError(
            f"ai_agent step {step.id!r} did not call emit_step_result"
        ) from exc
