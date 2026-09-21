#!/usr/bin/env bash
# Redo the reviewer's steps and the page from saved material, without calling a model. The directory holds,
# for each model, the finished tree at <dir>/<model> (a git repository whose first commit is the baseline,
# with node_modules linked to this repository's) and its transcript at <dir>/<model>.jsonl; a meta.json
# beside them says the date and commit the runs were made at, or the footer names today's.
#
#   bash docs/demo/arena/render-from.sh <dir> [out.html]
set -euo pipefail
FROM=$(cd "${1:?dir with <model>/ and <model>.jsonl}" && pwd)
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${2:-$HERE/index.html}
found=0
for m in haiku sonnet opus; do
  [ -d "$FROM/$m" ] && [ -f "$FROM/$m.jsonl" ] || continue
  found=1
  bash "$HERE/review.sh" "$FROM" "$m"
done
[ "$found" -eq 1 ] || { echo "render-from.sh: nothing to render in $FROM" >&2; exit 2; }
python3 "$HERE/render.py" "$FROM" "$OUT"
