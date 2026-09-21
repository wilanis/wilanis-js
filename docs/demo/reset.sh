#!/usr/bin/env bash
# Copy the example to a scratch directory and print what to export, so the demo
# in docs/demo.md starts from a clean tree every time. Idempotent: run it again
# and the copy is replaced.
#
#   bash docs/demo/reset.sh            # copies to $TMPDIR/wilanis-demo
#   bash docs/demo/reset.sh ~/demo     # or wherever you say
#
# Needs coreutils and openssl, nothing else. The repository must be built
# (npm install && npm run build), since the copy links its node_modules.
set -euo pipefail

here="$(cd "$(dirname "$0")/../.." && pwd)"
tmp="${TMPDIR:-/tmp}"
target="${1:-${tmp%/}/wilanis-demo}"
target="${target%/}"

rm -rf "$target"
mkdir -p "$target"
cp -R "$here/example/." "$target/"
rm -rf "$target/node_modules" "$target/.wilanis"
ln -s "$here/node_modules" "$target/node_modules"

echo "# the example, copied to $target; its node_modules link to $here"
echo "cd $target"
echo "export DEMO=$here/docs/demo"
echo "export MONITOR_JWT_SECRET=$(openssl rand -base64 32)"
echo "# until #304 lands, start reads every profile's secrets although local never reaches PostgreSQL"
echo "export MONITOR_DATABASE_URL=postgres://unused"
