#!/bin/sh
# Make the golden-capture copy of the v41 artifact:
#   - storage keys renamed (vindsplanen- → vgold-) so it never touches a real plan,
#   - gold-hook.js inserted before the module's closing </script>.
# Usage: sh make-copy.sh [path/to/vindsplanen-v41.html]
# Output: out/vindsplanen-gold.html (gitignored).
set -eu
DIR=$(cd "$(dirname "$0")" && pwd)
SRC=${1:-"$DIR/../../../planning/140-vindsplanen-ref/vindsplanen-v41.html"}
OUT="$DIR/out"
mkdir -p "$OUT"
sed "s/vindsplanen-/vgold-/g" "$SRC" > "$OUT/renamed.html"
LAST=$(grep -n '</script>' "$OUT/renamed.html" | tail -1 | cut -d: -f1)
{
  # the artifact host wraps the page in a skeleton with a charset; without it
  # the × in '78×118' etc. would be decoded as windows-1252
  printf '<!doctype html><meta charset="utf-8">\n'
  head -n $((LAST - 1)) "$OUT/renamed.html"
  cat "$DIR/gold-hook.js"
  tail -n +"$LAST" "$OUT/renamed.html"
} > "$OUT/vindsplanen-gold.html"
rm "$OUT/renamed.html"
echo "wrote $OUT/vindsplanen-gold.html"
