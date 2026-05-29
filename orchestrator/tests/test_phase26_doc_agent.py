"""Phase 26 documentation-agent tests.

Covers the pure, LLM-free logic of the doc agent:
- _doc_agent_delta: isolating the doc agent's edits from the
  implementation changes already present in the tree (snapshot diff).
- _out_of_scope: the extension allowlist that backs the scope guardrail.
- DocResult shape + config wiring (docs model/gate/extensions).

The agent loop itself (query() against the SDK) is not exercised here —
it needs a live model. These tests pin the guardrail logic that decides
whether a run is aborted with DocScopeError.
"""

from orchestrator.agents.docs import (
    DocResult,
    _doc_agent_delta,
    _out_of_scope,
)
from orchestrator.config import OrchestratorConfig


def test_delta_detects_newly_changed_file():
    before = {"app.js": "h1"}  # impl already changed app.js
    after = {"app.js": "h1", "README.md": "h2"}  # doc agent added README
    assert _doc_agent_delta(before, after) == ["README.md"]


def test_delta_detects_further_edit_to_impl_file():
    # Doc agent edits a file the implementation already touched: the hash
    # changes, so it must register as a doc-agent delta.
    before = {"app.js": "h1"}
    after = {"app.js": "h2"}
    assert _doc_agent_delta(before, after) == ["app.js"]


def test_delta_ignores_untouched_impl_changes():
    # No doc-agent edits at all → empty delta even though impl changed files.
    before = {"app.js": "h1", "calc.js": "h2"}
    after = {"app.js": "h1", "calc.js": "h2"}
    assert _doc_agent_delta(before, after) == []


def test_out_of_scope_flags_code_files():
    allowed = {".md", ".rst", ".txt"}
    changed = ["README.md", "docs/guide.rst", "app.js", "config.py"]
    assert _out_of_scope(changed, allowed) == ["app.js", "config.py"]


def test_out_of_scope_empty_when_all_docs():
    allowed = {".md", ".rst", ".txt"}
    changed = ["README.md", "notes.txt"]
    assert _out_of_scope(changed, allowed) == []


def test_docresult_defaults():
    r = DocResult()
    assert r.updated is False
    assert r.changed_files == []
    assert r.summary == ""


def test_config_exposes_docs_defaults():
    cfg = OrchestratorConfig()
    assert cfg.docs.enabled is True
    assert cfg.docs.allowed_extensions == [".md", ".rst", ".txt"]
    assert cfg.models.docs == "claude-sonnet-4-6"
    assert cfg.human_in_loop.docs is False
