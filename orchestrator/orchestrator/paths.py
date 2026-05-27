"""Project root discovery.

Walk up from CWD to find the nearest .git directory. This works for any
git repo regardless of where the orchestrator package is installed,
making it safe for both the drop-in case (orchestrator/ folder lives
inside the target repo) and the extracted case (orchestrator installed
globally, target repo lives elsewhere). __file__-based resolution would
break the extracted case once the package lives in site-packages.
"""

from pathlib import Path


def find_project_root() -> Path:
    """Return the nearest ancestor directory containing a .git folder.

    Falls back to CWD if no .git is found (e.g. running outside a git repo
    in tests). Never raises.
    """
    current = Path.cwd().resolve()
    for path in [current, *current.parents]:
        if (path / ".git").exists():
            return path
    return current
