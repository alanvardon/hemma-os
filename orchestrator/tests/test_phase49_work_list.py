"""Phase 49 — the four positional seams collapse into one `[[steps.work]]` list.

before_plan / after_plan / after_branch / before_commit (and the pre-46
after_impl / after_qa) are no longer valid seam names; the loader raises a
migration-guiding error. Steps are declared in one ordered `work` list.
"""

import pytest

from orchestrator.manifest import (
    ApprovalGateStep,
    ManifestError,
    ScriptStep,
    SEAMS,
    load_manifest,
)


def _write(p, body):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body, encoding="utf-8")


def test_work_is_the_only_seam():
    assert SEAMS == ("work",)


@pytest.mark.parametrize(
    "seam,hint",
    [
        ("before_plan", "pre_hooks"),
        ("after_plan", "workflow.planning"),
        ("after_branch", "steps.work"),
        ("before_commit", "steps.work"),
        ("after_impl", "build"),
        ("after_qa", "steps.work"),
    ],
)
def test_old_seam_raises_migration_error(tmp_path, seam, hint):
    _write(
        tmp_path / "orchestrator.toml",
        f'[[steps.{seam}]]\nid = "x"\ntype = "approval_gate"\nask = "?"\n',
    )
    with pytest.raises(ManifestError) as exc:
        load_manifest(project_root=tmp_path)
    msg = str(exc.value)
    assert seam in msg
    assert hint in msg  # points at the replacement mechanism


def test_work_list_loads_in_declared_order(tmp_path):
    _write(tmp_path / ".orchestrator/scripts/a.sh", "#!/bin/sh\nexit 0\n")
    _write(
        tmp_path / "orchestrator.toml",
        """
[[steps.work]]
id = "first"
type = "script"
path = ".orchestrator/scripts/a.sh"

[[steps.work]]
id = "second"
type = "approval_gate"
ask = "ok?"
""",
    )
    work = load_manifest(project_root=tmp_path).for_seam("work")
    assert [s.id for s in work] == ["first", "second"]
    assert isinstance(work[0], ScriptStep)
    assert isinstance(work[1], ApprovalGateStep)
