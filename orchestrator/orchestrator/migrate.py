"""Phase 68: v1 → v2 config migration.

`migrate_v1_to_v2` converts a parsed v1 `orchestrator.toml` dict (the
`[workflow.*]` + `[[steps.work]]` + `[steps.defs.*]` shape) into the v2 shape
(`flow` + `[stage.*]` + `[builtin.*]` + `[defs.*]`), preserving pipeline
SEMANTICS (stage order and per-task recipe). It returns `(v2_dict, notes)`;
`notes` lists anything that has no clean v2 home yet (e.g. an `approval_gate`
work step) so nothing is dropped silently.

`render_toml` serialises a v2 dict to TOML text (stdlib has no writer). It is
scoped to the shapes this migrator produces and is round-trip tested against
tomllib + pipeline.build_pipeline.
"""

from __future__ import annotations

# v1 produce/gate ids that are spine built-ins (resolve without a [steps.defs.*]
# entry). Everything else is a user [steps.defs.*] id → a defs: reference.
_V1_BUILTIN_PARTS = frozenset({"implementation", "qa"})


def _ref(v1_id: str) -> str:
    """Map a v1 produce/gate id to a v2 prefixed reference."""
    return f"builtin:{v1_id}" if v1_id in _V1_BUILTIN_PARTS else f"defs:{v1_id}"


def _carry(dst: dict, src: dict, keys: tuple[str, ...]) -> None:
    """Copy keys from src to dst when present and not an empty/None default."""
    for k in keys:
        if k in src and src[k] not in (None, []):
            dst[k] = src[k]


def migrate_v1_to_v2(v1: dict) -> tuple[dict, list[str]]:
    notes: list[str] = []
    wf = v1.get("workflow", {})
    steps = v1.get("steps", {})
    defs = steps.get("defs", {})
    work = steps.get("work", [])

    v2: dict = {}
    _carry(
        v2, v1,
        ("default_model", "db_path", "fully_autonomous",
         "autonomous_max_seconds", "autonomous_max_cost_usd"),
    )

    stage_builtin: dict = {}
    stage_user: dict = {}
    builtin_parts: dict = {}
    v2_defs: dict = {}

    # plan — v1 planning.human_in_loop defaults to True; preserve that if unset.
    plan = {"type": "ai_agent"}
    p = wf.get("planning", {})
    _carry(plan, p, ("model", "timeout", "allowed_tools", "disallowed_tools"))
    plan["human_in_loop"] = p.get("human_in_loop", True)
    stage_builtin["plan"] = plan

    # decompose
    dec = {"type": "ai_agent"}
    _carry(dec, wf.get("decompose", {}), ("model", "max_tasks"))
    stage_builtin["decompose"] = dec

    # task-build (the per-task recipe)
    tb_src = wf.get("task_build", {})
    tb: dict = {
        "produce": [_ref(x) for x in tb_src.get("produce", ["implementation"])],
        "gate": [_ref(x) for x in tb_src.get("gate", ["qa"])],
    }
    if "retry" in tb_src:
        tb["retry"] = dict(tb_src["retry"])
    if "human_in_loop" in tb_src:
        tb["human_in_loop"] = dict(tb_src["human_in_loop"])
    stage_builtin["task-build"] = tb

    # docs + summarize
    docs = {"type": "ai_agent"}
    _carry(docs, wf.get("docs", {}), ("model", "timeout", "allowed_tools", "disallowed_tools"))
    stage_builtin["docs"] = docs
    summ = {"type": "ai_agent"}
    _carry(summ, wf.get("summarize", {}), ("model", "timeout", "allowed_tools", "disallowed_tools"))
    stage_builtin["summarize"] = summ

    # built-in parts: implementation (producer) + qa (gate) tool config
    impl: dict = {}
    _carry(impl, wf.get("implementation", {}), ("model", "allowed_tools", "disallowed_tools", "timeout"))
    builtin_parts["implementation"] = impl
    qa_part: dict = {}
    _carry(qa_part, wf.get("qa", {}), ("model", "allowed_tools", "disallowed_tools", "timeout"))
    builtin_parts["qa"] = qa_part

    # [steps.defs.*] → [defs.*]; ai_agent `agent` key → `path`
    for did, body in defs.items():
        nb = dict(body)
        if nb.get("type") == "ai_agent" and "agent" in nb:
            nb["path"] = nb.pop("agent")
        v2_defs[did] = nb

    # [[steps.work]] → ordered user stages
    work_ids: list[str] = []
    for w in work:
        wid, wtype = w["id"], w.get("type")
        if wtype == "script":
            su = {"type": "script", "path": w["path"]}
            _carry(su, w, ("timeout",))
            stage_user[wid] = su
            work_ids.append(wid)
        elif wtype == "ai_agent":
            su = {"type": "ai_agent", "path": w["agent"]}
            _carry(su, w, ("model", "allowed_tools", "disallowed_tools", "timeout"))
            stage_user[wid] = su
            work_ids.append(wid)
        elif wtype == "build":
            su = {
                "type": "build",
                "produce": [_ref(x) for x in w.get("produce", [])],
                "gate": [_ref(x) for x in w.get("gate", [])],
            }
            if w.get("ungated"):
                su["ungated"] = True
            if "retry" in w:
                su["retry"] = dict(w["retry"])
            stage_user[wid] = su
            work_ids.append(wid)
        elif wtype == "approval_gate":
            notes.append(
                f"work step {wid!r} was an approval_gate — the v2 foundation has "
                "no approval_gate stage type; re-add it as a human gate after the cutover."
            )
        else:
            notes.append(f"work step {wid!r} (type {wtype!r}) was not converted.")

    # final_qa gates → trailing stages (preserving v1 order: work → final_qa)
    final_qa_ids: list[str] = []
    for g in wf.get("final_qa", {}).get("gate", []):
        bare = g.split(":", 1)[1] if ":" in g else g
        if bare == "qa":
            stage_builtin["qa"] = {"type": "ai_agent"}
            final_qa_ids.append("qa")
        else:
            stage_user[bare] = {"uses": _ref(bare)}
            final_qa_ids.append(bare)

    # assemble flow, preserving v1 execution order:
    #   plan → decompose → task-build → work → final_qa → summarize → docs
    order = ["plan", "decompose", "task-build", *work_ids, *final_qa_ids,
             "summarize", "docs"]
    v2["flow"] = " >> ".join(order)
    v2["stage"] = {"builtin": stage_builtin}
    if stage_user:
        v2["stage"]["user"] = stage_user
    v2["builtin"] = builtin_parts
    if v2_defs:
        v2["defs"] = v2_defs

    # rails + infra carry across unchanged (branch slug moves out of [workflow])
    if "max_slug_length" in wf.get("branch", {}):
        v2["branch"] = {"max_slug_length": wf["branch"]["max_slug_length"]}
    for table in ("git", "pr", "pre_hooks", "audit"):
        if table in v1:
            v2[table] = dict(v1[table])
    # rail-level commit pause has no v2 home yet (rails are locked, no pause config)
    if wf.get("commit", {}).get("human_in_loop"):
        notes.append(
            "[workflow.commit].human_in_loop (the pre-PR pause) has no v2 home "
            "yet — rails are locked. Re-add a pre-ship pause after the cutover."
        )

    return v2, notes


# ── minimal TOML emitter (scoped to the shapes above) ────────────────────────

def render_toml(d: dict) -> str:
    lines: list[str] = []
    scalars = {k: v for k, v in d.items() if not isinstance(v, dict)}
    for k, v in scalars.items():
        lines.append(f"{k} = {_fmt(v)}")
    if scalars:
        lines.append("")
    _emit_tables(d, [], lines)
    return "\n".join(lines).rstrip() + "\n"


def _emit_tables(node: dict, path: list[str], lines: list[str]) -> None:
    scalar_keys = [(k, v) for k, v in node.items() if not isinstance(v, dict)]
    dict_keys = [(k, v) for k, v in node.items() if isinstance(v, dict)]
    if path and scalar_keys:
        lines.append(f"[{'.'.join(path)}]")
        for k, v in scalar_keys:
            lines.append(f"{k} = {_fmt(v)}")
        lines.append("")
    for k, v in dict_keys:
        _emit_tables(v, path + [k], lines)


def _fmt(v) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, str):
        return '"' + v.replace("\\", "\\\\").replace('"', '\\"') + '"'
    if isinstance(v, list):
        return "[" + ", ".join(_fmt(x) for x in v) + "]"
    raise TypeError(f"cannot render {type(v).__name__} to TOML: {v!r}")
