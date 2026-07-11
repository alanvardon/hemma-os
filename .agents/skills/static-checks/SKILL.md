---
name: static-checks
description: Mechanical correctness checks for index.html. Run as the first step of QA review, and as a self-gate before implementation emits SUMMARY.
allowed-tools: Bash
---

Run `bash .Codex/skills/static-checks/static-checks.sh`. Exit 0 means all checks passed; non-zero means at least one violation, with details on stderr.

On non-zero exit:
- **If invoked from implementation:** read each violation and fix it in `index.html`. Re-run until the script exits 0. Do not emit `SUMMARY:` until the script passes.
- **If invoked from qa:** record each violation as `✗ FAIL — <violation text>` in your report. Do not fix anything.
