"""Append-only log of orchestrator runs.

One line per run start, written to `.orchestrator/runs.jsonl`. Lets you
recover a thread_id without scrolling back through terminal scrollback
after you close a window mid-run.

The file is intentionally append-only: no status updates, no rewrites.
Determining the current state of a recorded run is the checkpointer's
job — resume by thread_id to find out where it stands.

Schema (one JSON object per line):
    {
        "thread_id": "cli-f3a9b1c2",
        "request": "add a tooltip showing what LTV means",
        "started_at": "2026-05-26T10:32:15.123456+00:00",
        "source": "cli" | "mcp",
        "idempotency_key": "ci-job-789"        # optional
    }

The `idempotency_key` field is omitted entirely when the caller didn't
supply one, and older log entries won't have it either. Consumers should
treat its absence as "no key."

Querying:
    tail .orchestrator/runs.jsonl                       # recent runs
    grep "tooltip" .orchestrator/runs.jsonl             # find by request text
    grep '"idempotency_key":"ci-job-789"' runs.jsonl    # find by CI job
"""

import json
from datetime import datetime, timezone
from pathlib import Path

from orchestrator.paths import find_project_root

_LOG_PATH = find_project_root() / ".orchestrator" / "runs.jsonl"


def append_run(
    thread_id: str,
    request: str,
    source: str,
    idempotency_key: str | None = None,
) -> None:
    """Append a single run-start record. Best-effort: never raises.

    Log-writing failures shouldn't take down the workflow. The recovery
    file is a convenience, not load-bearing — the checkpointer is the
    real source of truth.

    The `idempotency_key` field is included only when non-None so the
    log shape stays compact for the common case (no key) and so the
    schema remains backwards-compatible with pre-Phase-18 readers.
    """
    try:
        _LOG_PATH.parent.mkdir(exist_ok=True)
        record = {
            "thread_id": thread_id,
            "request": request,
            "started_at": datetime.now(timezone.utc).isoformat(),
            "source": source,
        }
        if idempotency_key is not None:
            record["idempotency_key"] = idempotency_key
        with _LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")
    except OSError:
        pass
