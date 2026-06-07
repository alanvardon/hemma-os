#!/usr/bin/env bash
# tests.sh — deterministic unit-test gate for the orchestrator's task-build.
#
# Runs the project's pure-calc unit tests. Exit 0 = green (gate passes),
# non-zero = red (gate fails → the implement loop retries with the failing
# output as feedback).
#
# The scripted gate invokes this with cwd = this script's own directory, so we
# resolve the repo root from the script location before running the suite.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

node --test calc.test.js
