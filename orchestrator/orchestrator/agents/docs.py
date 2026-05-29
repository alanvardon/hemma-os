"""Documentation agent — runs Claude Agent SDK to keep docs in sync (Phase 26).

Runs after QA passes and before commit, on the uncommitted implementation
changes. It reads the plan and the diff, decides whether documentation needs
updating, and edits the affected markdown docs. If nothing user-facing
changed, it makes no edits and reports that.

Shape: an *agent loop* like implementation.py and qa.py — it reads CLAUDE.md,
runs `git diff HEAD`, inspects docs, and edits them. The structured-output
tool `emit_doc_result` captures a human-readable summary via the same
closure-capture pattern as the other agents.

What's distinctive — the scope guardrail:
  The doc agent must touch ONLY documentation files. Because it runs on a
  tree that already holds the implementation's uncommitted edits, we can't
  tell its edits apart by a plain `git diff`. So we snapshot the content of
  every changed/untracked file BEFORE the agent runs and again AFTER; the
  delta is exactly what the doc agent touched. Any delta file whose extension
  is not on the allowlist raises DocScopeError and aborts the workflow — the
  hard gate behind the prompt's soft "only docs" instruction.

NOTE: Phase 26's WORKFLOW_VERSION ownership is intentionally NOT implemented
here — that constant is introduced by Phase 20 (schema/workflow versioning),
which is not yet built. Wire it in once Phase 20 lands.
"""

from dotenv import load_dotenv

load_dotenv()

import asyncio
import hashlib
import subprocess
import sys
from pathlib import Path

from claude_agent_sdk import (
    ClaudeAgentOptions,
    ResultMessage,
    create_sdk_mcp_server,
    query,
    tool,
)
from pydantic import BaseModel, Field

from orchestrator.usage import TaskUsage
from orchestrator.prompt_loader import load_prompt

from orchestrator.agents.planning import PlanResult
from orchestrator.config import load_config
from orchestrator.git_ops import REPO_ROOT
from orchestrator.tool_profile import load_tool_profile


_DOCS_SYSTEM_PROMPT = load_prompt("docs")


class DocResult(BaseModel):
    updated: bool = False
    summary: str = ""
    changed_files: list[str] = Field(default_factory=list)
    usage: TaskUsage | None = None


class DocScopeError(RuntimeError):
    """Raised when the doc agent edited a file outside the extension allowlist.

    Surfaces as a fatal abort: the doc agent strayed beyond documentation and
    its edits are mixed into the working tree, so we refuse to proceed rather
    than commit out-of-scope changes.
    """


def _build_user_message(plan: PlanResult) -> str:
    """Compose the per-run user message for the doc agent.

    Like QA, the agent gets only the plan — it runs `git diff HEAD` itself to
    see the actual changes.
    """
    return "\n".join(["## Plan", "", plan.plan_text])


def _changed_file_hashes(repo_root: Path) -> dict[str, str]:
    """Map every modified/untracked file (vs HEAD) to a content hash.

    Used to snapshot the working tree before and after the agent runs so we
    can isolate exactly which files the doc agent touched, independent of the
    implementation changes already present.
    """
    out = subprocess.run(
        ["git", "status", "--porcelain", "-z"],
        cwd=str(repo_root),
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    hashes: dict[str, str] = {}
    for entry in out.split("\0"):
        if not entry:
            continue
        # Porcelain format: 2 status chars, a space, then the path.
        path = entry[3:]
        full = repo_root / path
        try:
            hashes[path] = hashlib.sha256(full.read_bytes()).hexdigest()
        except (OSError, IsADirectoryError):
            # Deleted file or directory entry — record a sentinel so a
            # later reappearance/change still registers as a delta.
            hashes[path] = "<absent>"
    return hashes


def _doc_agent_delta(
    before: dict[str, str], after: dict[str, str]
) -> list[str]:
    """Paths whose content changed (or appeared) between the two snapshots."""
    changed = []
    for path, h in after.items():
        if before.get(path) != h:
            changed.append(path)
    return sorted(changed)


def _out_of_scope(changed_files: list[str], allowed_ext: set[str]) -> list[str]:
    """Files the doc agent touched whose extension is not on the allowlist."""
    return [p for p in changed_files if Path(p).suffix not in allowed_ext]


async def document(
    plan: PlanResult, model: str = "claude-sonnet-4-6"
) -> DocResult:
    """Run the documentation agent and return its structured result.

    Snapshots the working tree before/after to isolate the doc agent's edits,
    then enforces the extension allowlist. Raises DocScopeError if the agent
    touched a non-documentation file.
    """
    config = load_config()
    allowed_ext = set(config.docs.allowed_extensions)

    before = _changed_file_hashes(REPO_ROOT)

    # Closure-captured holder for the agent's final structured output.
    captured: dict[str, str] = {}

    @tool(
        "emit_doc_result",
        "Emit the final documentation result. Call this exactly once when "
        "you are done. `summary` is a one-line description of the doc changes "
        "you made, or a short reason why no documentation update was needed. "
        "After calling, stop — the orchestrator takes over.",
        {"summary": str},
    )
    async def emit_doc_result(args: dict) -> dict:
        captured["summary"] = args.get("summary", "") or ""
        return {
            "content": [
                {"type": "text", "text": "Result captured. You may stop now."}
            ]
        }

    orchestrator_mcp = create_sdk_mcp_server(
        name="orchestrator",
        version="1.0.0",
        tools=[emit_doc_result],
    )

    # Doc agent needs to read the diff and edit docs: Read/Edit/Write/Bash/Grep.
    # The extension guardrail below — not the tool allowlist — is what keeps it
    # to documentation files.
    _profile = load_tool_profile("docs")
    _allowed_tools = _profile.allowed_tools + ["mcp__orchestrator__emit_doc_result"]

    options = ClaudeAgentOptions(
        system_prompt=_DOCS_SYSTEM_PROMPT,
        allowed_tools=_allowed_tools,
        disallowed_tools=_profile.disallowed_tools,
        mcp_servers={"orchestrator": orchestrator_mcp},
        cwd=str(REPO_ROOT),
        permission_mode="acceptEdits",
        model=model,
        setting_sources=["project"],
    )

    user_message = _build_user_message(plan)

    result_msg: ResultMessage | None = None
    async for msg in query(prompt=user_message, options=options):
        if isinstance(msg, ResultMessage):
            result_msg = msg

    if "summary" not in captured:
        raise RuntimeError("docs agent did not call emit_doc_result")

    # Authoritative change set: diff the snapshots rather than trust the
    # agent's self-report. Enforce the extension allowlist on it.
    after = _changed_file_hashes(REPO_ROOT)
    changed_files = _doc_agent_delta(before, after)
    out_of_scope = _out_of_scope(changed_files, allowed_ext)
    if out_of_scope:
        raise DocScopeError(
            "Documentation agent modified non-documentation files: "
            + ", ".join(out_of_scope)
            + f". Allowed extensions: {sorted(allowed_ext)}."
        )

    usage: TaskUsage | None = None
    if result_msg is not None and result_msg.usage:
        u = result_msg.usage
        usage = TaskUsage(
            model=model,
            input_tokens=u.get("input_tokens", 0),
            output_tokens=u.get("output_tokens", 0),
            cache_read_tokens=u.get("cache_read_input_tokens", 0),
            cache_creation_tokens=u.get("cache_creation_input_tokens", 0),
            reported_cost_usd=result_msg.total_cost_usd,
        )

    return DocResult(
        updated=bool(changed_files),
        summary=captured["summary"],
        changed_files=changed_files,
        usage=usage,
    )


# Standalone test:
#   python -m orchestrator.agents.docs "tiny test"
# Builds a fake plan, runs the doc agent against whatever uncommitted changes
# are in the target repo right now, prints the result. Will edit doc files, so
# run on a branch you don't mind modifying.
if __name__ == "__main__":
    request = " ".join(sys.argv[1:]) or "document whatever changed"

    async def _main() -> None:
        fake_plan = PlanResult(
            title="standalone docs test",
            type="feature",
            plan_text=request,
        )
        result = await document(fake_plan)
        print(result.model_dump_json(indent=2))

    asyncio.run(_main())
