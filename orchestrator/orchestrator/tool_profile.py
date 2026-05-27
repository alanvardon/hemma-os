"""Tool permission profiles for orchestrator agents (Phase 29).

Loads [tools.*] sections from orchestrator.toml and exposes typed
ToolProfile objects. Used by implementation.py and qa.py to replace
their hardcoded allowed_tools lists with operator-configurable values.

Usage:
    from orchestrator.tool_profile import load_tool_profile

    profile = load_tool_profile("implementation")
    # profile.allowed_tools  → list[str]  (from config or defaults)
    # profile.disallowed_tools → list[str]

NOTE: key names are case-sensitive. A typo like "allowed_tool" (singular)
will silently fall back to bundled defaults. The warning logs help surface
this, but no strict schema validation is performed.

Pinned MCP server tools (e.g. mcp__orchestrator__emit_implementation_result)
are NOT listed in orchestrator.toml — the agent code injects them after
loading the profile.
"""

import logging
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

# Bundled defaults — used when orchestrator.toml has no [tools] section
# or when individual keys are missing.
DEFAULTS: dict[str, dict[str, list[str]]] = {
    "implementation": {
        "allowed_tools": ["Read", "Edit", "Write", "Bash"],
        "disallowed_tools": [],
    },
    "qa": {
        "allowed_tools": ["Read", "Grep", "Bash"],
        "disallowed_tools": [],
    },
    # Informational only — planning uses the raw Anthropic SDK and
    # ignores ClaudeAgentOptions entirely. Never actually consumed.
    "planning": {
        "allowed_tools": ["Read", "Grep", "Glob"],
        "disallowed_tools": [],
    },
}


@dataclass
class ToolProfile:
    """Resolved tool permissions for a single orchestrator agent."""

    agent: str
    allowed_tools: list[str] = field(default_factory=list)
    disallowed_tools: list[str] = field(default_factory=list)


def _resolve_config_path() -> Path:
    """Resolve orchestrator.toml to an absolute path via git-root discovery."""
    from orchestrator.paths import find_project_root
    return find_project_root() / "orchestrator.toml"


def load_tool_profile(
    agent: str, config_path: Path | None = None
) -> ToolProfile:
    """Load tool profile for *agent* from orchestrator.toml.

    Resolution order:
    1. File values (if file exists and section is present)
    2. Bundled defaults for known agents
    3. Empty lists for unknown agents

    All failure paths produce a usable profile rather than raising:
      - Missing file → silent fallback to defaults
      - Invalid TOML syntax → warning logged, fallback to defaults
      - Missing [tools.<agent>] section → per-field default
      - Missing key inside section → per-field default

    The planning-section warning and QA write-tool warning are
    emitted after resolution, not as errors.
    """
    if config_path is None:
        config_path = _resolve_config_path()

    agent_defaults = DEFAULTS.get(agent, {"allowed_tools": [], "disallowed_tools": []})

    # --- Load the TOML file ------------------------------------------------
    try:
        with config_path.open("rb") as f:
            data = tomllib.load(f)
    except FileNotFoundError:
        return ToolProfile(
            agent=agent,
            allowed_tools=list(agent_defaults["allowed_tools"]),
            disallowed_tools=list(agent_defaults["disallowed_tools"]),
        )
    except tomllib.TOMLDecodeError as exc:
        logger.warning(
            "Failed to parse %s (%s); falling back to defaults for agent %r.",
            config_path,
            exc,
            agent,
        )
        return ToolProfile(
            agent=agent,
            allowed_tools=list(agent_defaults["allowed_tools"]),
            disallowed_tools=list(agent_defaults["disallowed_tools"]),
        )

    # --- Inspect [tools] section -------------------------------------------
    tools_section: dict = data.get("tools", {})

    # Warn if operator added [tools.planning] — it has no effect.
    if "planning" in tools_section:
        logger.warning(
            "[tools.planning] in orchestrator.toml has no effect — "
            "the planning agent does not use ClaudeAgentOptions"
        )

    agent_section: dict = tools_section.get(agent, {})

    allowed_tools: list[str] = agent_section.get(
        "allowed_tools", agent_defaults["allowed_tools"]
    )
    disallowed_tools: list[str] = agent_section.get(
        "disallowed_tools", agent_defaults["disallowed_tools"]
    )

    profile = ToolProfile(
        agent=agent,
        allowed_tools=list(allowed_tools),
        disallowed_tools=list(disallowed_tools),
    )

    # --- QA write-tool warning ---------------------------------------------
    if agent == "qa":
        write_tools = {"Edit", "Write"} & set(profile.allowed_tools)
        if write_tools:
            logger.warning(
                "QA tool profile contains write-capable tools (%s). "
                "This is permitted but grants the QA agent write access.",
                ", ".join(sorted(write_tools)),
            )

    return profile
