# Bostadskalkyl Orchestrator — Build Plan

A pedagogical, phased plan to port the existing Claude Code coordinator
workflow into a Python LangGraph orchestrator integrated with Claude Code
via an MCP server.

## Goal

By the end you will have:

- A Python package at `orchestrator/` that replaces `.claude/agents/coordinator.md`.
- **Structured Pydantic outputs** replacing sentinel strings (`PLAN COMPLETE:`, `SUMMARY:`, `QA RESULT:`).
- A **SQLite checkpointer** replacing `state.json` + `progress.log`.
- **LangSmith tracing** replacing post-hoc log inspection.
- An **MCP server** exposing `implement_feature` and `approve_plan` tools to Claude Code.
- A **conversational human-in-loop** flow — plan, review, approve (or revise) entirely inside the Claude Code chat.

## Architecture at a glance

```
You (in Claude Code)
   │ "/implement add a help tooltip"
   ▼
Claude Code (frontend / chat UI)
   │ tool call → implement_feature(request)
   ▼
MCP server (orchestrator/mcp_server.py)
   │ workflow.ainvoke({...}, thread_id=...)
   ▼
LangGraph workflow (orchestrator/workflow.py)
   ├─ planning_task         ← LLM (Anthropic SDK + structured output)
   ├─ interrupt() ──────────→ returns to Claude Code for approval
   ├─ create_branch_task    ← deterministic (subprocess + git)
   ├─ implementation_task   ← LLM (Claude Agent SDK for file edits)
   ├─ qa_task               ← LLM (Anthropic SDK + structured output)
   └─ commit_and_pr_task    ← deterministic (subprocess + gh)
        │
        ▼
   AsyncSqliteSaver (checkpoints.db)   ← durable state
   LangSmith                            ← observability traces
```

The split that matters:
- **Orchestration** (control flow, retries, state) → Python code, deterministic.
- **Cognition** (planning, implementation, QA review) → LLM calls, probabilistic.
- **Frontend** (chat UI, slash commands) → Claude Code.
- **Backend** (durable workflow + state) → LangGraph + SQLite.

## Pedagogical structure

16 phases (0–15). Each phase introduces **one** concept and ends with a
"run this and see X" verification step. Don't move on until the current
phase runs cleanly — debugging gets exponentially harder with each
layer of indirection added on top.

Estimated total: ~12–18 focused hours spread over multiple sessions.

---

## Phase 0 — Setup (30 min)

**Build:** an empty Python project that can call Claude.
**Learn:** the Python toolchain choices and where API keys live.

### Prerequisites check

```bash
pyenv --version                                # pyenv installed
pyenv virtualenvs                              # pyenv-virtualenv plugin installed
grep -E 'pyenv init|virtualenv-init' ~/.zshrc  # both init lines present
```

If `pyenv-virtualenv` is missing: `brew install pyenv-virtualenv`.

Both of these must be in `~/.zshrc`:
```bash
eval "$(pyenv init -)"
eval "$(pyenv virtualenv-init -)"
```

### Steps

```bash
# 1. Install Python 3.12 if you don't have it
pyenv install 3.12.7

# 2. Create the orchestrator dir and dedicated virtualenv
cd ~/Programming/bostadskalkyl/orchestrator
pyenv virtualenv 3.12.7 bostadskalkyl-orchestrator
pyenv local bostadskalkyl-orchestrator

# 3. Verify auto-activation
cd ~ && cd ~/Programming/bostadskalkyl/orchestrator
which python   # → ~/.pyenv/versions/bostadskalkyl-orchestrator/bin/python
python --version
```

### Why a dedicated env (not the parent bostadskalkyl env)

One env per deployable artefact. The orchestrator has its own dependency
surface (anthropic, langgraph, mcp), its own Python version trajectory, and
its own lifecycle. Conflating it with whatever the parent env contains will
bite later.

### Project scaffolding

```bash
mkdir orchestrator                              # the actual Python package
touch orchestrator/__init__.py
```

Create `pyproject.toml`:

```toml
[project]
name = "bostadskalkyl-orchestrator"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
    "anthropic>=0.40",
    "langgraph>=0.2",
    "langgraph-checkpoint-sqlite",
    "langsmith",
    "pydantic>=2",
    "python-dotenv",
    "aiosqlite",
    "mcp",
    "claude-agent-sdk",
]

[project.optional-dependencies]
dev = ["pytest", "pytest-asyncio", "ipython"]

[project.scripts]
implement-feature = "orchestrator.cli:main"

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"
```

Install:
```bash
pip install -e ".[dev]"
which pip   # confirm it's the env-scoped pip, not global
```

Create `.env` (do NOT commit). Use the real key prefixes from your provider
dashboards — Anthropic keys begin with `sk-ant`, LangSmith keys with `lsv2`:
```
ANTHROPIC_API_KEY=<your Anthropic key>
LANGCHAIN_API_KEY=<your LangSmith key>
LANGCHAIN_TRACING_V2=true
LANGCHAIN_PROJECT=bostadskalkyl-orchestrator
```

Create `.gitignore`:
```
.env
__pycache__/
*.pyc
*.db
.orchestrator/
```

Commit `.python-version` (it's how teammates and future-you pick up the env automatically).

### Hello-Claude sanity check

`orchestrator/hello.py`:
```python
import os
from dotenv import load_dotenv
from anthropic import Anthropic

load_dotenv()
client = Anthropic()
response = client.messages.create(
    model="claude-haiku-4-5",
    max_tokens=100,
    messages=[{"role": "user", "content": "Say hi in one sentence."}],
)
print(response.content[0].text)
```

**Run this and see X:** `python -m orchestrator.hello` prints a sentence from Claude.
*Do not proceed if this fails — debugging auth later is harder than now.*

---

## Phase 1 — One LLM call with structured output (45 min)

**Build:** a standalone `plan()` function — no LangGraph yet.
**Learn:** **structured outputs are how you kill sentinels.** This is the single biggest robustness win and you should feel it before adding any framework.

### Steps

1. Create `orchestrator/agents/planning.py`.
2. Define the response shape with Pydantic:
   ```python
   from pydantic import BaseModel
   from typing import Literal

   class PlanResult(BaseModel):
       title: str
       type: Literal["feature", "fix", "refactor"]
       plan_text: str
   ```
3. Copy the body of `.claude/agents/planning.md` (everything below the
   frontmatter) into a `PLANNING_SYSTEM_PROMPT` string constant. Strip out
   the `PLAN COMPLETE:` sentinel section — it's gone.
4. Write `async def plan(request: str) -> PlanResult` using Anthropic's
   tool-use-as-structured-output pattern: define a tool whose input schema
   matches `PlanResult`, force `tool_choice={"type": "tool", "name": "..."}`,
   parse the tool input back into the Pydantic model.

**Run this and see X:**
`python -m orchestrator.agents.planning "add a stress test for variable rates"`
prints a validated `PlanResult`. No string matching, no sentinel, no parse
failures possible.

**Teaching moment:** compare these ~20 lines to your current contract
("emit `PLAN COMPLETE: title=X, type=Y` exactly, coordinator parses it,
halts if missing"). The robustness gain is permanent and free.

---

## Phase 2 — Wrap `planning` as a LangGraph task (30 min)

**Build:** the smallest possible LangGraph workflow — one entrypoint, one task.
**Learn:** `@task` and `@entrypoint` are mostly just decorators.

### Steps

`orchestrator/workflow.py`:
```python
from langgraph.func import entrypoint, task
from langgraph.checkpoint.memory import MemorySaver
from orchestrator.agents.planning import plan, PlanResult

@task
async def planning_task(request: str) -> PlanResult:
    return await plan(request)

@entrypoint(checkpointer=MemorySaver())
async def workflow(request: str) -> dict:
    result = await planning_task(request)
    return result.model_dump()
```

A `main.py` script that calls
`await workflow.ainvoke("add dark mode", config={"configurable": {"thread_id": "demo-1"}})`.

**Run this and see X:** same output as Phase 1, but now wrapped in LangGraph.
Functionally identical. *That's the point.* LangGraph hasn't changed the
cognitive work — it's wrapped it in a durable harness.

**Teaching moment:** you had to pass `thread_id` even with `MemorySaver`.
Threads are the unit of "one workflow run" — the equivalent of your
`.workflow/<branch>/` directory.

---

## Phase 3 — Persistent checkpointer + state inspection (30 min)

**Build:** swap `MemorySaver` for `AsyncSqliteSaver`, then inspect the database.
**Learn:** what the checkpointer actually stores, and how to query it.

### Steps

1. In `workflow.py`, replace `MemorySaver()` with
   `AsyncSqliteSaver.from_conn_string(".orchestrator/checkpoints.db")`.
   Wrap the workflow definition in `async with`.
2. Run the workflow twice with the same `thread_id`. The second run
   *doesn't re-call Claude* — `planning_task` is memoised per checkpoint.
3. Inspect the DB:
   ```bash
   sqlite3 .orchestrator/checkpoints.db ".tables"
   sqlite3 .orchestrator/checkpoints.db "SELECT * FROM checkpoints LIMIT 5;"
   ```
4. Use `workflow.aget_state_history(config)` in Python to see the same data
   as Python objects.

**Run this and see X:** the second invocation with the same `thread_id`
returns the cached result instantly without an API call. Your `state.json`
and `progress.log` are now this database file.

---

## Phase 4 — Resume from interruption (20 min)

**Build:** deliberately crash a workflow mid-flight, then resume it.
**Learn:** durability is one line of code, not an abstract promise.

### Steps

1. Add a fake `step_two_task` that does `await asyncio.sleep(5)` then returns "done".
2. Run the workflow with `thread_id="crash-demo"`. Hit `Ctrl-C` during the sleep.
3. Re-run with
   `await workflow.ainvoke(None, config={"configurable": {"thread_id": "crash-demo"}})`
   (note the `None` input).
4. Notice `planning_task` does not re-run; `step_two_task` does.

**Run this and see X:** crash, restart, see only the unfinished task resume.
Your current coordinator can't do this; this is the production-grade win.

---

## Phase 5 — LangSmith tracing (15 min)

**Build:** nothing — observability comes from the env vars set in Phase 0.
**Learn:** the trace UI, and what it shows that file logs don't.

### Steps

1. Re-run the workflow.
2. Open smith.langchain.com → your project → click the latest run.
3. Explore: nested spans per task, exact prompt sent to Claude, exact response,
   token counts, latency per step.

**Run this and see X:** the trace tree of your last run.
**Teaching moment:** ask yourself which past debugging sessions on your
current workflow would have been faster with this view.

---

## Phase 6 — Add the rest of the workflow steps (2–3 hours)

**Build:** the remaining four tasks. Do them one at a time, running between each.
**Learn:** the difference between LLM-driven and deterministic tasks.

Order matters:

### 6a. `create_branch_task(plan: PlanResult) -> str` — deterministic

No LLM. Wraps `git checkout -b` via `subprocess.run`. Returns the branch name.
Port `.claude/skills/create-feature-branch.md` line-by-line; it becomes ~30
lines of Python. **Shows you that not every task needs an LLM.**

### 6b. `implementation_task(plan, mode, failures) -> ImplementationResult` — LLM with file edits

This is the one that needs the **Claude Agent SDK** (not raw `messages.create`)
because the model must iteratively edit files.

```python
from claude_agent_sdk import query, ClaudeAgentOptions

async def implementation_task(...) -> ImplementationResult:
    async for message in query(
        prompt=build_prompt(plan, mode, failures),
        options=ClaudeAgentOptions(
            system_prompt=IMPLEMENTATION_SYSTEM_PROMPT,  # body of .claude/agents/implementation.md
            allowed_tools=["Read", "Edit", "Write", "Bash"],
            cwd="..",  # bostadskalkyl repo root
        ),
    ):
        ...
    # parse final result into ImplementationResult { summary, test_plan }
```

Structured output `ImplementationResult { summary: str, test_plan: str }`
replaces your `SUMMARY:` sentinel.

### 6c. `qa_task(plan) -> QaResult` — LLM, read-only

Same pattern but with read-only tools (`Read`, `Bash` for `git diff`).
Structured output `QaResult { result: Literal["PASS", "FAIL"], failures: str | None }`
replaces `QA RESULT: PASS/FAIL`.

### 6d. `commit_and_pr_task(branch, title, summary, test_plan) -> str` — deterministic

Wraps `git commit`, `git push`, `gh pr create`. Returns the PR URL.

**Run this and see X:** after each new task, invoke it standalone first
(outside the workflow), then plug it into the entrypoint and run end-to-end
on a tiny feature. **Don't add the next task until the current one runs cleanly.**

**Teaching moment:** the LLM-vs-deterministic split is the cleanest you'll
ever see it. Half your tasks have no model in them at all.

---

## Phase 7 — The retry loop (45 min)

**Build:** the `for attempt in range(1, 4)` loop your current workflow has.
**Learn:** control flow that was previously prose-described becomes ordinary Python.

```python
@entrypoint(checkpointer=...)
async def workflow(request: str) -> dict:
    plan = await planning_task(request)
    branch = await create_branch_task(plan)
    summary, test_plan, qa_failures = None, None, None
    for attempt in range(1, 4):
        mode = "implement" if attempt == 1 else "fix"
        impl = await implementation_task(plan, mode, qa_failures)
        summary, test_plan = impl.summary, impl.test_plan
        qa = await qa_task(plan)
        if qa.result == "PASS":
            break
        qa_failures = qa.failures
    else:
        return {"status": "failed", "qa_failures": qa_failures}
    pr_url = await commit_and_pr_task(branch, plan.title, summary, test_plan)
    return {"status": "succeeded", "pr_url": pr_url}
```

**Run this and see X:** trigger a fail-then-pass scenario (introduce a
deliberately incomplete plan) and watch the loop in the LangSmith trace tree.

**Teaching moment:** compare these 12 lines to the ~80 lines of fix-loop prose
in `.claude/agents/coordinator.md` lines 233–262. Same logic. One is testable.

---

## Phase 8 — Human-in-loop interrupt (45 min)

**Build:** the "does this plan look correct?" pause your current workflow has.
**Learn:** `interrupt()` is the LangGraph primitive for human approval.

```python
from langgraph.types import interrupt

plan = await planning_task(request)
approval = interrupt({
    "kind": "plan_approval",
    "plan": plan.model_dump(),
    "ask": "Approve this plan? Reply 'yes' or describe changes.",
})
if approval != "yes":
    plan = await planning_task(f"{request}\n\nFeedback: {approval}")
    # (loop until approved — left as exercise)
```

**Critical rule for production:** `interrupt()` causes the calling task
to re-run from the top when resumed, with the resume value injected.
**Side effects must come AFTER `interrupt()`, never before** — otherwise
they happen twice.

For now you'll test this programmatically. The actual user-facing
approval happens through the MCP layer in Phase 10.

**Note on the interrupt return shape (verified empirically — the older
docs and many third-party examples are stale on this point):** in the
*functional* API, `ainvoke()` does NOT raise `GraphInterrupt` when it
hits `interrupt()`. It returns a dict shaped like
`{"__interrupt__": [Interrupt(value=<your dict>, id="...")]}`. Resume by
calling `ainvoke(Command(resume=<value>), config=config)` against the
same `thread_id`. (`GraphInterrupt` *does* exist and IS raised in some
internal code paths and in the state-graph API, but its own docstring
says "never raised directly, or surfaced to the user" — trust the dict.)

**Run this and see X:** workflow pauses at the interrupt; `ainvoke`
returns a dict containing `__interrupt__`. Resume with
`Command(resume="yes")` and it continues to completion.

---

## Phase 9 — Progress logging (decision phase, 30 min)

**Build:** either nothing (recommended), or a thin file-log adapter.
**Learn:** when adding "extra" persistence is a code smell.

Two paths:

- **Recommended:** skip a custom `progress.log` entirely. LangSmith has the
  trace; the checkpointer has the state. Anything beyond that duplicates and
  will drift.
- **If you need it:** subscribe to `workflow.astream(...)` events and append
  lines to a file. ~20 lines.

**Teaching moment:** the instinct to keep `progress.log` "just in case" is
the same instinct that built three overlapping state systems in your current
coordinator. Resist it unless you have a concrete consumer.

---

## Phase 10 — CLI debug interface (1 hour)

**Build:** a terminal CLI for `implement-feature`. Not the production
interface — a *debug surface* you'll keep around.
**Learn:** how to wire the orchestrator as a runnable tool.

`orchestrator/cli.py`:
```python
import asyncio, sys, uuid
from langgraph.types import Command
from orchestrator.workflow import build_workflow

async def run():
    request = " ".join(sys.argv[1:])
    config = {"configurable": {"thread_id": f"cli-{uuid.uuid4().hex[:8]}"}}
    async with build_workflow() as workflow:
        result = await workflow.ainvoke(request, config=config)
        # interrupt() in the functional API does NOT raise — it returns
        # a dict containing "__interrupt__". Loop until the workflow
        # completes normally (no __interrupt__ in the return value).
        # A feedback reply triggers a re-plan and another interrupt, so
        # the loop is required, not optional.
        while "__interrupt__" in result:
            interrupt_val = result["__interrupt__"][0].value
            print(interrupt_val["plan"]["plan_text"])
            response = input("Approve? ")
            result = await workflow.ainvoke(Command(resume=response), config=config)
        print(result)

def main():
    asyncio.run(run())
```

Use it on a tiny feature: `implement-feature "add a console.log to App.recalc"`.

**Run this and see X:** the same end-to-end flow as today's coordinator,
started from one shell command, with a LangSmith trace and a SQLite
checkpoint you can inspect.

**Why keep this around after Phase 11:** it's your "is the orchestrator
itself broken?" sanity check when Claude Code + MCP add indirection layers.

### Known gaps in the snippet above (address as you build)

The snippet is the minimum that compiles. Two of the gaps below are
*functional* — the CLI is unusable without them. The rest are polish you
can defer until they annoy you. Tackle in this order.

**Functional (must fix):**

1. **Multi-turn approval loop.** The snippet above already handles this
   via `while "__interrupt__" in result:`. If you simplify the snippet
   later (e.g. for a one-shot demo), keep the loop — a feedback reply
   triggers a re-plan and another interrupt; without the loop, the
   second `__interrupt__` would be silently ignored and you'd act on
   the original plan.

2. **Progress signal during long tasks.** `implementation_task` runs for
   5+ minutes (Claude Agent SDK editing files). `await workflow.ainvoke`
   shows nothing during that time — you'll think it hung. Switch from
   `ainvoke` to `astream(...)` and print one line per event, OR run a
   background coroutine that prints `Implementing… (2m 15s)` every
   ~15 seconds. Either is fine for a debug surface.

**Polish (defer until annoying):**

3. **Don't `print(dict)` for the plan.** The plan has a `plan_text` field
   that's already markdown. `print(plan["plan_text"])` reads cleanly;
   the full dict dump doesn't.
4. **Highlight the PR URL.** Final result is `{"status": "succeeded",
   "pr_url": "..."}`. Extract and print on its own line so you can click it.
5. **Surface the `thread_id`.** Print it at the top of the run so if
   something goes wrong you can `inspect_state <thread_id>` or resume
   manually with `ainvoke(None, ...)`.
6. **Colour / formatting.** `rich` makes the plan and the diff readable
   in the terminal. Adds a dependency; weigh that against the fact that
   the production surface is Claude Code, not this CLI.

**What still doesn't belong here:**
Don't add token-cost reporting, run history listing, multi-run dashboards,
or interactive scenario selection. Those belong in a future admin tool
(or just `inspect_state`). The CLI's job is "run one workflow end-to-end,
prove the orchestrator works." Resist scope creep — every feature you
add here is one you'll also have to keep working through Phases 11–12.

---

## Phase 11 — MCP server with two tools (1.5 hours)

**Build:** an MCP server exposing `implement_feature` and `approve_plan`.
**Learn:** how external services integrate with Claude Code natively.

### The conversational flow you're building toward

```
You    → /implement add a help tooltip to the LTV display
Claude → [calls implement_feature("...")]
       MCP server runs workflow until interrupt(), returns:
         { status: "awaiting_approval", thread_id: "run-7f3a", plan: {...} }
Claude → Here's the plan: [...] Approve, or describe changes?
You    → yes, but also make it dismissible
Claude → [calls approve_plan("run-7f3a", "yes, but also make it dismissible")]
       MCP server resumes workflow. Re-plans, hits interrupt() again.
Claude → Here's the revised plan: [...] Approve?
You    → yes
Claude → [calls approve_plan("run-7f3a", "yes")]
       Workflow proceeds: branch → impl → qa → pr.
Claude → Done. PR: https://github.com/.../pull/8
```

### Server skeleton

`orchestrator/mcp_server.py`:
```python
from uuid import uuid4
from mcp.server.fastmcp import FastMCP
from langgraph.types import Command
from orchestrator.workflow import build_workflow

mcp = FastMCP("bostadskalkyl-orchestrator")

# Reminder (see Phase 8 note): in the functional API, `ainvoke()` does
# NOT raise on interrupt — it returns a dict containing "__interrupt__".

def _awaiting_approval(thread_id: str, result: dict, hint: str) -> dict:
    interrupt_val = result["__interrupt__"][0].value
    return {
        "status": "awaiting_approval",
        "thread_id": thread_id,
        "plan": interrupt_val["plan"],
        "next": hint,
    }

@mcp.tool()
async def implement_feature(request: str) -> dict:
    """Start a new feature/fix/refactor workflow. Returns the plan for
    user approval. The user MUST approve or revise via approve_plan
    before any code is written."""
    thread_id = f"run-{uuid4().hex[:8]}"
    config = {"configurable": {"thread_id": thread_id}}
    async with build_workflow() as workflow:
        result = await workflow.ainvoke(request, config=config)
    if "__interrupt__" in result:
        return _awaiting_approval(
            thread_id, result,
            "Call approve_plan with thread_id and the user's response.",
        )
    raise RuntimeError("Workflow completed without hitting plan approval interrupt")

@mcp.tool()
async def approve_plan(thread_id: str, response: str) -> dict:
    """Resume a workflow at the plan-approval step. Response is either
    'yes' to proceed, or feedback describing required changes."""
    config = {"configurable": {"thread_id": thread_id}}
    async with build_workflow() as workflow:
        result = await workflow.ainvoke(Command(resume=response), config=config)
    if "__interrupt__" in result:
        return _awaiting_approval(
            thread_id, result,
            "Plan was revised. Show to user and call approve_plan again.",
        )
    return {"status": "complete", **result}

if __name__ == "__main__":
    mcp.run()
```

### Testing before wiring to Claude Code

Use the official MCP inspector first:
```bash
npx @modelcontextprotocol/inspector \
  ~/.pyenv/versions/bostadskalkyl-orchestrator/bin/python \
  -m orchestrator.mcp_server
```
This gives you a browser UI to invoke tools manually and see their responses.
Catches most bugs before Claude Code is in the loop.

**Critical:** invoke the server via the **full env-scoped Python path**, not
just `python`. MCP servers are subprocesses; pyenv auto-activation doesn't
apply. This is one of the few times pyenv's behaviour can confuse you.

**Run this and see X:** in the MCP inspector, call `implement_feature` →
get back a plan + thread_id. Call `approve_plan(thread_id, "yes")` →
get back a PR URL. If both work, the server is ready for Claude Code.

---

## Phase 12 — Register with Claude Code (30 min)

**Build:** `.mcp.json` config + optional `/implement` slash command.
**Learn:** the Claude Code MCP integration surface.

`.mcp.json` at the project root:
```json
{
  "mcpServers": {
    "orchestrator": {
      "command": "/Users/avardon/.pyenv/versions/bostadskalkyl-orchestrator/bin/python",
      "args": ["-m", "orchestrator.mcp_server"],
      "cwd": "/Users/avardon/Programming/bostadskalkyl/orchestrator"
    }
  }
}
```

Restart Claude Code. Confirm the tools appear (e.g., via `/mcp` or in the
tool list).

Optional ergonomics — `.claude/commands/implement.md`:
```markdown
---
description: Run the LangGraph orchestrator on a feature request
---

Use the `implement_feature` MCP tool with the user's request: $ARGUMENTS

After receiving the plan, show it to the user clearly and ask whether they
approve or want changes. Then call `approve_plan` with their response.
Continue this approval loop until the workflow returns a status of
"complete" with a PR URL.
```

**Run this and see X:** in Claude Code, type
`/implement add a tooltip showing what LTV means` → see the plan in chat →
approve → see the PR URL.

**Once you trust it:** archive `.claude/agents/coordinator.md` (move to
`.claude/agents/_archive/`). Keep for reference. Do not delete.

---

## Phase 13 — User-facing config file (1 hour)

**Build:** an optional `orchestrator.toml` at the project root that exposes
the tuning knobs without forcing users to edit Python.
**Learn:** how to keep the config surface tight — every knob is a new
failure mode and a new doc obligation.

Add `orchestrator/config.py` with a single Pydantic `OrchestratorConfig`
model, loaded once at `build_workflow()` time via `tomllib` (stdlib).
If `orchestrator.toml` is missing, fall back to defaults — the file is
optional.

Exposed fields (start minimal — resist growing this):

```toml
# orchestrator.toml — all fields optional, defaults shown
max_retries = 3                    # implementation+qa loop attempts
db_path = ".orchestrator/checkpoints.db"

[models]
planning       = "claude-sonnet-4-6"
implementation = "claude-sonnet-4-6"
qa             = "claude-sonnet-4-6"

[human_in_loop]
# Each toggle gates an `interrupt()` at that stage boundary.
# false = fully autonomous (current Phase 7 behaviour).
approve_plan           = true   # before any code is written (Phase 8 default)
approve_branch         = false  # before create_branch_task runs
approve_implementation = false  # after each impl attempt, before QA
approve_qa_failure     = false  # on QA FAIL, ask before retrying vs. abandoning
approve_pr             = false  # before commit_and_pr opens the PR

[branch]
max_slug_length = 50            # truncation cap in _slugify

[pr]
base_branch = "main"            # some repos use "develop" or "trunk"
draft       = false             # open as draft vs ready-for-review
reviewers   = []                # GitHub usernames to request review from
labels      = []                # labels to attach to the PR
```

**What is deliberately NOT in the config:**

- **System prompts.** Tightly coupled to structured-output schemas; a typo
  here breaks the agent loop in ways that are painful to debug. Keep in code.
- **Allowed-tools lists per agent.** Security-sensitive (QA must stay
  read-only). Keep in code.
- **Per-attempt mode logic** (`implement` vs `fix`). Workflow behaviour,
  not user preference.

**Wiring:**

1. `config.py` exports `load_config(path: Path | None = None) -> OrchestratorConfig`.
2. `build_workflow()` accepts an optional `config: OrchestratorConfig`
   argument; if omitted, calls `load_config()` itself.
3. The Phase 7 retry loop reads `config.max_retries` instead of the
   hardcoded `range(1, 4)`.
4. Each agent's `ClaudeAgentOptions(model=...)` reads from `config.models.*`.
5. Each `interrupt()` call in the workflow is gated by the relevant
   `config.human_in_loop.*` flag — `if config.human_in_loop.approve_plan: interrupt(...)`.
6. `git_ops._slugify` reads `config.branch.max_slug_length` instead of the
   hardcoded `50`.
7. `git_ops.commit_and_pr` reads `config.pr.*` and passes the values to
   `gh pr create` — `--base`, `--draft`, repeated `--reviewer`,
   repeated `--label`. Empty lists mean "omit the flag entirely".

**Granular human-in-loop — why per-stage flags work:**

LangGraph's `interrupt()` is a workflow primitive, not a global mode. It
pauses execution at the call site, persists state to the checkpointer, and
returns whatever value the user supplies on resume. That means you can
stack as many or as few as you want; each one is just an `if` around a
function call. The five stages above are the natural boundaries — adding
more (e.g., post-planning-revision) is straightforward later.

**Pedagogical landmine carried forward:** `interrupt()` re-runs its
calling task on resume (see landmine #4). Every gated interrupt MUST have
its side effects after the interrupt, not before. The Phase 8 work
already proves this pattern; Phase 13 just multiplies the call sites.

**Run this and see X:** drop an `orchestrator.toml` with
`max_retries = 1` and `approve_pr = true` → run a feature request → on QA
PASS, see the workflow pause for PR approval. Delete the file → run again
→ workflow uses defaults and runs end-to-end without prompts.

---

## Phase 14 — Token and cost tracking (1.5 hours)

**Build:** per-task token counts and a USD cost estimate surfaced as a
summary banner in the CLI, and in the MCP server's terminal response.
**Learn:** how structured outputs let you carry side-data (usage) along
with the agent's primary result, and how checkpointer history makes
aggregating across retries trivial.

The orchestrator makes three LLM calls per attempt (planning,
implementation, qa), and retries multiply that. Without per-task numbers
you can't tell whether an expensive run was driven by long planning, a
file-thrashy implementation, or a chatty QA — or whether retries are
the real cost driver.

LangSmith already captures all of this in the trace, so the pure
*observability* need is solved. Phase 14 is for **offline visibility** —
seeing the cost number in the CLI without opening a browser, and
returning it to Claude Code so the chat can show it.

### Steps

1. Add `orchestrator/usage.py` with a `TaskUsage` Pydantic model and a
   small `PRICES_USD_PER_MTOKEN` table sourced from anthropic.com/pricing:

   ```python
   class TaskUsage(BaseModel):
       model: str
       input_tokens: int
       output_tokens: int
       cache_read_tokens: int = 0
       cache_creation_tokens: int = 0

       def cost_usd(self) -> float | None: ...  # None for unknown models
   ```

2. Capture usage in each agent function. **The two SDKs report
   differently — test each independently:**
   - Raw Anthropic SDK (planning, qa): `response.usage.input_tokens`,
     `response.usage.output_tokens`, plus `cache_read_input_tokens` /
     `cache_creation_input_tokens` if prompt caching kicked in.
   - Claude Agent SDK (implementation): the final `ResultMessage`
     yielded from `query(...)` carries `usage` and `total_cost_usd`.
     Use the SDK's reported cost when available; fall back to the
     price table otherwise.

3. Extend each `*Result` model with an optional `usage: TaskUsage | None`
   field. Optional so old checkpoints stay deserialisable.

4. After the workflow's final return, walk the checkpointer's task
   history (`workflow.aget_state_history(config)`) and sum every
   `usage` field across ALL recorded task results — including failed
   retry attempts. The retry loop produces 1–3 implementation entries;
   aggregate all of them. Attach the summary to the final result dict
   under `"usage"`.

5. In `cli.py`, print the summary after the success/failure banner:

   ```
   ============================================================
   Token usage
   ============================================================
     planning:        4,213 in   /     521 out  ($0.014)
     implementation:  82,440 in  /   3,917 out  ($0.31)
     qa:             10,553 in   /     294 out  ($0.034)
   ------------------------------------------------------------
     TOTAL:          97,206 in   /   4,732 out  ($0.36)
   ============================================================
   ```

6. The MCP server already passes the workflow result through; the
   `usage` block surfaces in `approve_plan`'s final response
   automatically. Claude Code can decide whether to mention it in chat.

### What is deliberately NOT in Phase 14

- **Per-task budgets / cost caps.** Tracking is observation; capping is
  enforcement. Caps require a kill switch wired through every LLM call
  — that's a Phase 15+ project, not a small extension of Phase 14.
- **Charts or run-history dashboards.** LangSmith already does this.
- **Per-attempt itemisation in the CLI banner.** Aggregate across the
  retry loop; if you need per-attempt detail, look at the LangSmith
  trace tree.
- **Live token meters during long tasks.** The heartbeat shows elapsed
  time; that's enough. Adding live token counts means hooking the SDK
  stream events — disproportionate to the value.

### Pedagogical landmines

1. **Two SDKs, two usage shapes.** Don't assume `response.usage` looks
   the same everywhere. Write one parser per SDK and test each.

2. **Prompt caching makes the naïve cost calc wrong.** Cache reads are
   ~10× cheaper than fresh reads, cache creation is ~25% more
   expensive. Track all four token categories (input, output,
   cache_read, cache_creation) or your numbers will drift on cached
   runs.

3. **The retry loop multiplies usage.** Failed attempts cost just as
   much as successful ones — sometimes more, because fix-mode prompts
   carry extra context. Make sure the aggregator iterates the full
   task history from the checkpointer, not just the final state.

4. **Prices change.** Hardcode them in `PRICES_USD_PER_MTOKEN`, source
   from the public pricing page, and update when prices change (rare,
   quarterly at most). Don't try to fetch live — that's a new API
   dependency and a new failure mode for a value that changes slowly.

**Run this and see X:** run any small feature end-to-end → see the
"Token usage" banner with per-task and total breakdowns → cross-check
the total against the same run's LangSmith trace; the two should agree
to within a few percent (rounding + cache attribution differences).

---

## Phase 15 — Resumable commit/push/PR + thread_id surfacing (1.5 hours)

**Build:** split `commit_and_pr_task` into three independently
checkpointed `@task`s (commit, push, pr_create), each idempotent. Add
a `resume_run(thread_id)` MCP tool so a partial failure can be picked
up from where it stopped. Surface `thread_id` in every CLI banner and
every MCP response so the user can recover without spelunking.
**Learn:** how `@task`'s "checkpoint successful results only" contract
turns partial failures into resumable state — but only if your tasks
are sized to the resume granularity you want.

### The failure mode this fixes

A real dogfood run (2026-05-25) failed after `commit_and_pr_task` had
already committed locally but before `git push` succeeded. The commit
left the working tree clean. The orchestrator's retry then re-entered
`commit_and_pr_task` from scratch, hit `git status --porcelain` (step 2:
"guard against empty diff"), and raised "no changes to commit". The
work was done but the orchestrator couldn't get it across the line.
Manual `git push` + `gh pr create` recovered the run.

Root cause: `commit_and_pr_task` is **atomic from LangGraph's view but
non-atomic in reality** — it performs commit + push + gh pr create as
one function, but those three operations have independent failure modes
and independent persistence. The task either succeeds (cached) or
raises (no cache), so any partial-success state is unrecoverable.

### Steps

1. **Refactor `git_ops.py`** — split into three idempotent functions
   replacing today's `commit_and_pr`:

   ```python
   def commit(branch: str, title: str, summary: str) -> str:
       """Return commit SHA. Idempotent: if HEAD already has the
       expected diff vs main and a commit subject we'd have generated,
       return HEAD's SHA without re-committing."""

   def push(branch: str) -> None:
       """Push branch to origin. Idempotent: re-running after a
       successful push is a no-op (git's own behaviour)."""

   def pr_create(branch: str, title: str, body: str) -> str:
       """Return PR URL. Idempotent: if a PR already exists for this
       branch (via `gh pr view <branch> --json url`), return that URL
       instead of opening a new one."""
   ```

   The idempotency checks are the load-bearing piece — without them,
   a re-run double-writes. Pattern: "look at git state first; only act
   if the desired state isn't already there."

2. **Refactor `workflow.py`** — replace the single `commit_and_pr_task`
   with three `@task`s called in sequence. Each task name appears in
   the LangSmith trace and the CLI `done:` markers, so you'll see the
   failure point at a glance:

   ```python
   commit_sha = await commit_task(branch_name, plan.title, impl.summary)
   await push_task(branch_name)
   pr_url = await pr_create_task(branch_name, plan.title, body)
   ```

3. **Add MCP tool `resume_run(thread_id) -> dict`.** Resumes a stalled
   workflow without starting a new one:

   ```python
   @mcp.tool()
   async def resume_run(thread_id: str) -> dict:
       """Resume a workflow that failed mid-task. The completed tasks
       are cached in the checkpointer, so only the failed task and any
       downstream tasks re-run. Use this AFTER fixing the underlying
       issue (e.g. authenticating gh, restoring network, fixing a
       merge conflict on the branch)."""
       config = {"configurable": {"thread_id": thread_id}}
       async with build_workflow() as workflow:
           result = await workflow.ainvoke(None, config=config)
       result["thread_id"] = thread_id
       return result
   ```

   The `None` input is the LangGraph signal to resume rather than
   start fresh. Tasks that ran successfully on the prior attempt
   return their cached result instantly; only the failed task (and
   anything downstream) executes fresh.

4. **Surface `thread_id` in every MCP response.** Today's success path
   returns the workflow's dict as-is, which doesn't include thread_id.
   Add it explicitly at the MCP-server layer so Claude Code always
   sees it in chat:

   ```python
   result["thread_id"] = thread_id  # in implement_feature, approve_plan
   ```

5. **Update the slash command** (`.claude/commands/implement.md`) to
   explicitly require Claude Code to show the thread_id on every
   message, not just on the first approval cycle. Without this
   instruction, Claude tends to elide the id after the first turn —
   which is exactly when the user needs it most.

6. **Surface `thread_id` in CLI banners** (`cli.py`):
   - Already shown at run start.
   - Add to the plan-approval prompt header.
   - Add to the success banner (alongside Branch and PR).
   - Add to the QA-exhausted failure banner.
   - **Don't** add to per-task `done:` lines or heartbeat lines —
     that's noise. The transitions are enough.

### Pedagogical landmines

1. **`@task`'s checkpoint granularity == your resume granularity.** A
   single `@task` is atomic from LangGraph's view: either the whole
   function succeeds (cached) or it raises (no cache, full re-run on
   retry). If you need partial-state resumability, you must split the
   task. This is the lesson Phase 15 teaches by counter-example.

2. **Idempotency is YOUR responsibility, not LangGraph's.** A re-run
   re-invokes your function with the same inputs. If the function
   writes side effects (git commit, git push, PR creation), it must
   detect "already done" state and skip — otherwise you get duplicate
   commits, double-pushed branches, or a "PR already exists" error
   from gh.

3. **`ainvoke(None, config)` is the resume incantation in the
   functional API.** Not `ainvoke({}, ...)` or `ainvoke(Command(...))`
   — those start a new run or resume from an interrupt respectively.
   `None` specifically means "resume the workflow associated with
   this thread_id from its last checkpoint."

4. **The user has to know the thread_id to recover.** This is why the
   surfacing work matters — if a partial failure happens at hour 3 of
   a multi-step run and the thread_id was only printed at the top,
   the user has to scroll through chat history (or hunt
   `.orchestrator/checkpoints.db`) to find it. Always-on visibility
   is the whole point.

### What is deliberately NOT in Phase 15

- **Per-task retries.** A push that fails because of a network blip
  should be the user's choice to retry, not silent magic. The
  `resume_run` tool makes that one user action; that's the right
  cadence for a workflow whose tasks have side effects.
- **Auto-recovery on tool failure.** Same reasoning. The MCP server
  could detect a failure and call `resume_run` itself, but that hides
  the failure from Claude Code (which means hidden from the user).
  Keep the loop explicit.
- **Branch cleanup on abandoned runs.** A workflow that crashed and
  was never resumed leaves a feature branch + maybe a commit lying
  around. Detecting and cleaning these up is a separate
  garbage-collection project — out of scope here.

**Run this and see X:** force a `push` failure (kill network, or
temporarily `git remote set-url origin /nonsense`) → see the workflow
error with thread_id in the response → restore network → `resume_run`
from Claude Code chat → workflow completes from the push step without
re-running commit or anything upstream → PR URL appears.

---

## What to skip on the first pass

Defer until the basic version runs end-to-end:

- **Parallel feature implementation.** Major topic on its own; needs git
  worktrees, concurrency caps, partial-failure semantics.
- **Cost caps / token budgets.** Per-run *tracking* lands in Phase 14;
  *capping* (a hard kill switch when a budget is hit) is a separate
  enforcement layer and stays off the roadmap for now.
- **Custom retry logic on Anthropic API errors.** The SDK handles transients;
  add only when you see a real need.
- **Tests beyond a smoke test on each task.**
- **Migrating old `.workflow/` runs.** Start fresh.
- **QA failures as interrupts.** Today's behaviour (auto-retry 3x) is fine.
  A user-judgement step is configurable in Phase 13 via
  `human_in_loop.approve_qa_failure`.

## Pedagogical landmines

Things that will trip you up that nobody warns you about:

1. **MCP tool descriptions are part of the prompt.** Whatever you put in the
   docstring is what Claude sees when deciding to use the tool. Bad description
   → Claude calls it wrong or not at all. Treat as a prompt, not a comment.
2. **MCP servers need explicit cwd and full python paths.** pyenv
   auto-activation doesn't apply to subprocesses. Always use the absolute
   env-scoped python binary.
3. **Restart Claude Code after every `.mcp.json` change.** Easy to forget.
4. **`interrupt()` re-runs its calling task on resume.** Side effects MUST
   come after the interrupt, never before. Classic production bug.
5. **`pip install -e .` requires the venv to be active.** Always check
   `which pip` first.
6. **`pyenv local` writes `.python-version` in the current directory.** Run
   it in the wrong place and you'll get a confusing auto-activation outside
   the project.

## Open design questions to revisit

These don't change the plan but you'll want to decide as you go:

- **How do you want the planning prompt to handle revisions?** Today's
  coordinator appends user feedback to the original request. Surfaces in Phase 8.
- **Should QA failures be interruptible** (surface to user for judgement)
  or always auto-retry (current behaviour)? Surfaces in Phase 7; made
  configurable in Phase 13.
- **Implementation tasks take 5+ min; what does Claude Code show during that?**
  MCP supports progress notifications. Surfaces in Phase 11.
- **Worktree-per-feature** for future parallelism — design now or retrofit
  later? Surfaces if/when you tackle parallel work.

## Order-of-magnitude time estimate

| Phase | Time |
|---|---|
| 0. Setup | 30 min |
| 1. Structured output | 45 min |
| 2. First @task + @entrypoint | 30 min |
| 3. SQLite checkpointer | 30 min |
| 4. Resume from crash | 20 min |
| 5. LangSmith tracing | 15 min |
| 6. Remaining four tasks | 2–3 hours |
| 7. Retry loop | 45 min |
| 8. Interrupt | 45 min |
| 9. Progress logging decision | 30 min |
| 10. CLI debug interface | 1 hour |
| 11. MCP server | 1.5 hours |
| 12. Register with Claude Code | 30 min |
| 13. User-facing config file | 1 hour |
| 14. Token and cost tracking | 1.5 hours |
| 15. Resumable commit/push/PR + thread_id surfacing | 1.5 hours |
| **Total** | **~13–18 focused hours** |

**Spread across multiple sessions.** The pedagogical value comes from
running each phase and letting the model click before adding the next
layer. One-sitting attempts defeat the purpose.

## How to know each phase is done

A phase is done only when:
1. The "run this and see X" verification has happened successfully.
2. You can articulate in one sentence what you learned that you didn't
   know before.
3. You haven't moved on to the next phase yet.

If you can't satisfy all three, the phase isn't done.
