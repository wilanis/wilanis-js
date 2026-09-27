#!/usr/bin/env bash
# The subcharts a chart's Chart.lock pins, in the chart's charts/ directory (RFC 0024).
#
#   scripts/subcharts.sh [chart]    the chart's directory, charts/wilanis-tree unless given
#
# Helm saves each pinned subchart as <name>-<version>.tgz. When charts/ holds every one the lock pins, nothing is
# fetched: CI restores that directory with actions/cache under a key over Chart.lock and Chart.yaml, and a checkout
# never holds it, so what is there is what the cache kept for this lock. Otherwise the repositories the lock names are
# added and `helm dependency build` fetches the subcharts as the lock pins them, refusing a lock out of step with
# Chart.yaml. A failed attempt is tried again after 10 s, then after 20 s, and the third failure ends the script with
# an error naming the host that did not answer. The repositories go wherever HELM_REPOSITORY_CONFIG says, as
# scripts/cluster.sh sets it for its staged copy of the chart.
set -euo pipefail

chart=${1:-charts/wilanis-tree}
[ -f "$chart/Chart.lock" ] || {
  echo "subcharts.sh: $chart/Chart.lock does not exist: run helm dependency update $chart to write it" >&2
  exit 1
}
log=$(mktemp "${TMPDIR:-/tmp}/subcharts.XXXXXX")
trap 'rm -f "$log"' EXIT

pinned=$(awk '/^- name: /{name=$3} /^  version: /{print name "-" $2 ".tgz"}' "$chart/Chart.lock")
missing=$(printf '%s\n' "$pinned" | while read -r tgz; do [ -f "$chart/charts/$tgz" ] || echo "$tgz"; done)

# One attempt: add each repository the lock names, then build; either failing fails the attempt.
fetch() {
  grep -o 'https://[^ ]*' "$chart/Chart.lock" | sort -u | nl -w1 -s' ' |
    while read -r n url; do helm repo add "pinned-$n" "$url" || exit; done &&
    helm dependency build "$chart"
}

if [ -n "$pinned" ] && [ -z "$missing" ]; then
  echo "skips helm dependency build: $chart/charts holds every subchart Chart.lock pins"
  printf '%s\n' "$pinned" | sed 's/^/  /'
  exit 0
fi
echo "fetches the subcharts Chart.lock pins: $chart/charts does not hold all of them"
command -v helm >/dev/null 2>&1 || {
  echo "subcharts.sh: fetching them needs helm (https://helm.sh/docs/intro/install/), which is not on PATH" >&2
  exit 1
}
for attempt in 1 2 3; do
  fetch 2>&1 | tee "$log" && exit 0
  if [ "$attempt" = 3 ]; then
    hosts=$(grep -i error "$log" | grep -o 'https://[^/ :"]*' | sed 's|^https://||' | sort -u |
      paste -sd, - | sed 's/,/, /g') || true
    echo "::error::the subcharts Chart.lock pins could not be fetched in 3 attempts, from ${hosts:-the repositories it names}; re-run the job once that host is back"
    exit 1
  fi
  echo "attempt $attempt of 3 failed; trying again in $((attempt * 10))s"
  sleep $((attempt * 10))
done
