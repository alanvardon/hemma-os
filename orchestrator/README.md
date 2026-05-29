# Orchestrator

A proof-of-concept that automates code changes end-to-end — from a plain
English request to an open PR. You describe what you want, review the plan,
and the orchestrator writes the code, checks it, commits, and opens the PR.

The key idea: everything deterministic (git operations, branching, commits,
PRs) is handled by Python. Everything that requires judgment (writing the
plan, editing files, reviewing the diff) is handled by Claude. The two never
mix.

Originally built for the [Bostadskalkyl](../) project, but works on any git
repo via per-project prompt and config overrides.

---

## Why split it this way

AI is non-deterministic — the same prompt can produce different output on
different runs. That's fine for judgment calls, but it's a problem for
deterministic operations that have one right answer.

An LLM handling git operations introduces real risk: wrong base branch,
accidental force-pushes, malformed commits, credentials ending up in diffs.
These aren't edge cases — they're known failure modes. Keeping those steps
in plain Python means the failure surface is small and auditable.

The orchestrator draws that line deliberately:

- **Deterministic Python owns:** branch creation, commit, push, PR open,
  state persistence, scripted checks
- **Claude owns:** planning, writing code, reviewing whether the diff
  matches the plan

---

## How it's built

Six concerns make up a production-ready agent workflow. The orchestrator
covers all six.

### 1. Workflow design — what runs, in what order, who decides

The full sequence is:
`check clean tree → plan → branch → implement → QA → commit → push → open PR`

Each step is checkpointed ([workflow.py](orchestrator/workflow.py)). If the
process crashes mid-run, it picks up from the last completed step — no
re-running expensive LLM calls from scratch.

Five human approval gates are configurable in
[orchestrator.toml](orchestrator.toml): plan approval, branch creation,
after implementation, on QA failure, and before the PR opens. Each toggle
is independent — you can run fully supervised, fully autonomous, or anything
in between.

### 2. Data access — what the agent can read

The implementation agent runs inside your project's directory and
automatically picks up your `CLAUDE.md` and `.claude/settings.json`
([agents/implementation.py:131](orchestrator/agents/implementation.py#L131-L152)).
Any guardrails you've already set — "never read `.env`", "don't touch
migrations" — apply automatically without extra config.

### 3. Authority — what the agent is allowed to do

Each agent has its own tool list ([tool_profile.py](orchestrator/tool_profile.py)):
- Implementation gets read and write access to files
- QA gets read-only access
- No agent ever touches git — the orchestrator owns that entirely

Configurable per-agent in [orchestrator.toml](orchestrator.toml) under
`[tools.*]`.

### 4. Evals — checking the work before it proceeds

Two layers of review ([qa_scripts.py](orchestrator/qa_scripts.py),
[agents/qa.py](orchestrator/agents/qa.py)):

1. Any scripts in `.orchestrator/qa/` run first. They're deterministic —
   a non-zero exit aborts immediately. Use these for linting, type checks,
   or any rule you can express as a script.
2. A read-only Claude agent then reviews the diff against the approved plan
   and gives a PASS or FAIL verdict.

On FAIL, the workflow retries implementation (up to `max_retries` times),
passing the failure notes so the agent knows exactly what to fix.

### 5. Audit trails — what happened and why

Three independent records, each suited to a different question:

- **Run artifacts** ([run_artifacts.py](orchestrator/run_artifacts.py)) —
  each run gets a folder under `.orchestrator/runs/` with the plan,
  implementation summary, QA verdict, and token usage. Readable without any
  external service.
- **Checkpoint database** ([workflow.py:207](orchestrator/workflow.py#L207)) —
  every step's inputs and outputs are saved to `.orchestrator/checkpoints.db`.
  This is what makes resume possible; it's also a full replay record.
- **LangSmith traces** — every step and every LLM call appears as a span in
  LangSmith with timing, token usage, prompts, and responses. The best view
  for drilling into a specific run. Enable by setting `LANGSMITH_TRACING=true`
  and `LANGSMITH_API_KEY` in `.env` — no code changes needed, LangGraph and
  the Anthropic SDK pick it up automatically.

### 6. Recovery — what happens when something goes wrong

Commit, push, and PR creation are three separate checkpointed steps
([workflow.py:152](orchestrator/workflow.py#L152-L186)). If push fails
(say, auth expired), the commit is preserved. Fix the auth issue, call
`resume_run`, and it continues from the push — no re-committing, no lost
work.

`cancel_run` signals a graceful stop at the next step boundary.
`resume_run --force` clears a cancel and picks back up.

---

## Try it on your repo

The default prompts reference Bostadskalkyl-specific conventions and are
meant as a reference set, not something you use directly. Drop your own
prompts in `.orchestrator/prompts/` and they take over:

```
<your-repo>/
├── .git/
├── CLAUDE.md                          # your project rules
└── .orchestrator/
    ├── prompts/
    │   ├── planning.md                # your planning prompt
    │   ├── implementation.md          # your implementation prompt
    │   └── qa.md                      # your QA prompt
    ├── qa/                            # optional scripted QA checks
    │   ├── 01-lint.sh
    │   └── 02-typecheck.sh
    └── pre-hooks/                     # optional pre-flight checks
        └── 01-verify-env.sh
```

The orchestrator finds your project root by walking up to the nearest `.git`
directory — no path configuration needed.

---

## Run it

```bash
# Install
cd orchestrator
pip install -e .

# Standalone CLI (useful for testing)
implement-feature "add a tooltip explaining LTV"

# Or register as an MCP server in Claude Code (preferred path)
# See the docstring in orchestrator/mcp_server.py for the MCP config.
```

Four MCP tools are available in Claude Code:

| Tool | What it does |
|---|---|
| `implement_feature(request, approve_plan?, max_retries?, base_branch?)` | Start a run; pauses at plan approval. Optional per-invocation overrides for the approval gate, retry count, and PR base branch. |
| `approve_plan(thread_id, response)` | `"yes"` to proceed, or feedback text to revise the plan and loop again |
| `resume_run(thread_id, force?)` | Continue a failed run after fixing the underlying issue. Pass `force=True` to clear a prior `cancel_run` and resume anyway. |
| `cancel_run(thread_id)` | Signal a graceful stop at the next task boundary; resume later with `resume_run(..., force=True)` |

---

## Scope

**This is:**
- A working example of what an agent implementation layer looks like in
  practice, for one specific workflow (PR creation).
- A learning project — built solo over a few weeks, mostly with Claude Code.
- Something you can run on your own repos or borrow patterns from.

**This isn't:**
- A general-purpose framework. The workflow shape is fixed; what changes
  per project is the prompts, scripts, and config.
- Enterprise-ready. No multi-tenancy, no governance dashboard.
- A product.

**Known limits:**
- The QA judge uses the same model family as the implementation agent, so
  they can share blind spots. The scripted gates run first and are the
  stronger check.
- One plan per request — no fan-out to multiple agents working in parallel.
- The workflow shape is hard-coded in Python; a config-driven design is
  planned but not built ([PLUGGABLE_WORKFLOW.md](PLUGGABLE_WORKFLOW.md)).

---

## The interesting bit

The code isn't the point — the boundary is. Where you draw the line between
"Python handles this" and "Claude handles this" is a design decision with
real consequences for reliability and recovery.

If you're building something similar, the three patterns most worth borrowing:

1. **Split commit/push/PR into separate checkpointed steps.** Resume after
   a push failure is genuinely useful.
2. **Run scripted checks before the LLM judge.** Deterministic gates are
   cheaper, faster, and don't share the model's blind spots.
3. **Give each agent only the tools it needs.** QA has no reason to write
   files; implementation has no reason to touch git.

The rest is shaped around this specific project. Replace it with yours.
