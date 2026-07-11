#!/usr/bin/env bash
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "BLOCKED by inspect-script hook: jq is required but not installed" >&2
  exit 2
fi

PAYLOAD=$(cat)
COMMAND=$(echo "$PAYLOAD" | jq -r '.tool_input.command // ""')
LOG_FILE=".claude/hooks/inspect-script.log"

# Block execution of script files via any interpreter.
# Covers: python, python3, node, ruby, perl, bash, sh, zsh, ./script
if echo "$COMMAND" | grep -qE \
  '(^|[[:space:]])(python3?|node|ruby|perl|bash|sh|zsh)[[:space:]]+[^-][^[:space:]]*\.(py|js|rb|pl|sh|ts)([[:space:]]|$)' \
  || echo "$COMMAND" | grep -qE '(^|[[:space:]])\./[^[:space:]]+'; then
  echo "BLOCKED by inspect-script hook: script file execution is not permitted" >&2
  echo "Run the logic inline or request the action directly." >&2
  mkdir -p "$(dirname "$LOG_FILE")"
  printf '[%s] BLOCKED script execution | command=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$COMMAND" >> "$LOG_FILE"
  exit 2
fi

exit 0
