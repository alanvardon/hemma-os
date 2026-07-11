#!/usr/bin/env bash
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "BLOCKED by block-secrets-pretool hook: jq is required but not installed" >&2
  exit 2
fi

PAYLOAD=$(cat)
TOOL=$(echo "$PAYLOAD" | jq -r '.tool_name')

case "$TOOL" in
  Write) CONTENT=$(echo "$PAYLOAD" | jq -r '.tool_input.content') ;;
  Edit)  CONTENT=$(echo "$PAYLOAD" | jq -r '.tool_input.new_string') ;;
  *)     exit 0 ;;
esac

PATTERNS=(
  'sk-ant-'
  'sk-live-'
  'sk_live_'
  'ghp_'
  'gho_'
  'AKIA'
  'xox[bpors]-'
  'SG\.'
  'eyJ'
  'BEGIN.*PRIVATE KEY'
)
for p in "${PATTERNS[@]}"; do
  if echo "$CONTENT" | grep -qE "$p"; then
    echo "BLOCKED: write would introduce potential secret matching '$p'" >&2
    exit 2
  fi
done
exit 0
