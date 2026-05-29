"""Idempotency keys (Phase 18).

Caller-supplied `idempotency_key` on `implement_feature`: a second
call with the same key returns the existing thread's current state
instead of starting a fresh workflow. Useful when:
  - the MCP tool is invoked twice in a row (double-click, double-send)
  - a webhook retries on a flaky network connection
  - a CI job re-runs the same step

Store: a directory `.orchestrator/idempotency/<key>` where each file
contains the thread_id that claimed the key. The atomic primitive is
`os.open(..., O_CREAT|O_EXCL)` — a single syscall that either creates
the file (we win the race) or raises FileExistsError (someone else
won; we read their thread_id and return it).

Why filesystem and not a SQLite table — same reason as the cancel
markers in `cancellation.py`. The LangGraph AsyncSqliteSaver holds a
write lock on the checkpoint db for the workflow's lifetime, and a
synchronous reader from a second module hits `database is locked`.
Filesystem entries have no shared lock.

When the orchestrator moves off a single dev machine onto infra, the
backend ports to a `idempotency_keys` table in the same Postgres
database that replaces `AsyncSqliteSaver`. The interface
(`reserve` / `lookup` / `purge_older_than`) stays; the bodies change.
See PLAN.md "Production port" note in Phase 16 — the same logic
applies here.
"""

import os
import re
import time
from pathlib import Path

from orchestrator.config import load_config
from orchestrator.paths import find_project_root


# Idempotency keys are caller-supplied (CI job ids, webhook delivery
# ids, user-typed strings). We allow a slightly broader character set
# than thread_ids — periods are common in CI job ids (e.g. `build.42`)
# — but still reject slashes, dots-only sequences, and other
# path-traversal characters so a malicious or buggy caller can't
# write outside the idempotency directory.
_KEY_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_KEY_MAX_LEN = 128


def _validate_key(key: str) -> None:
    if not key:
        raise ValueError("idempotency_key must be a non-empty string")
    if len(key) > _KEY_MAX_LEN:
        raise ValueError(
            f"idempotency_key length {len(key)} exceeds max {_KEY_MAX_LEN}"
        )
    if not _KEY_RE.fullmatch(key):
        raise ValueError(
            f"idempotency_key {key!r} contains characters outside "
            "[A-Za-z0-9._-]; refusing to use as a filename."
        )
    # Defence in depth against `.` / `..` / `...` — _KEY_RE allows
    # dots, but a key consisting entirely of dots would collide with
    # the current-/parent-directory specials and is never a sensible
    # caller-supplied value.
    if set(key) == {"."}:
        raise ValueError(f"idempotency_key {key!r} is a directory specifier")


def _idempotency_dir(base_dir: Path | None = None) -> Path:
    """Resolve the directory holding idempotency entries.

    Defaults to `<config.db_path's parent>/idempotency` so the entries
    sit alongside the checkpoint db and the cancellation markers.
    Callers can pass an explicit base_dir for tests.
    """
    if base_dir is not None:
        return base_dir
    config = load_config()
    db_parent = Path(config.db_path).parent
    relative = db_parent / "idempotency"
    return relative if relative.is_absolute() else find_project_root() / relative


def _entry_path(key: str, base_dir: Path | None = None) -> Path:
    _validate_key(key)
    return _idempotency_dir(base_dir) / key


def reserve(
    key: str, thread_id: str, base_dir: Path | None = None
) -> str | None:
    """Atomically claim `key` for `thread_id`.

    Returns None on success (this caller is the first to use the key).
    Returns the existing thread_id (str) if the key was already claimed
    — the caller should use that thread_id instead of starting a new
    workflow.

    Race semantics: O_CREAT|O_EXCL is a single syscall that either
    creates the file or fails atomically. Two concurrent callers will
    see exactly one None and one existing-thread-id result.
    """
    path = _entry_path(key, base_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL)
    except FileExistsError:
        # Race lost (or duplicate retry). Read the existing thread_id.
        # The file is written atomically below, so by the time we read
        # it the winner has already flushed.
        return path.read_text().strip()
    with os.fdopen(fd, "w") as f:
        f.write(thread_id)
    return None


def lookup(key: str, base_dir: Path | None = None) -> str | None:
    """Return the thread_id reserved for `key`, or None if not reserved."""
    path = _entry_path(key, base_dir)
    if not path.exists():
        return None
    return path.read_text().strip()


def purge_older_than(
    days: int, base_dir: Path | None = None
) -> int:
    """Delete idempotency entries older than `days` days (by mtime).

    Returns the count of entries deleted. Intended to be invoked from
    cron or an admin script — not on every reserve(), since the
    table-ish would grow forever otherwise and purging is cheap to run
    out-of-band.
    """
    if days < 0:
        raise ValueError(f"days must be non-negative, got {days}")
    cutoff = time.time() - days * 86400
    directory = _idempotency_dir(base_dir)
    if not directory.exists():
        return 0
    count = 0
    for entry in directory.iterdir():
        if entry.is_file() and entry.stat().st_mtime < cutoff:
            entry.unlink()
            count += 1
    return count
