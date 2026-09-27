#!/usr/bin/env bash
# The example on a local Kubernetes cluster (RFC 0024).
#
#   scripts/cluster.sh up      build the example's image from the workspace's packages as `npm pack` writes them, create
#                              a kind cluster, install charts/wilanis-tree with the example's generated values and
#                              values-local.yaml, wait until production is ready, and run the smoke check
#   scripts/cluster.sh smoke   sign in as the demo's operator and GET /customers through the NodePort, for a 200
#   scripts/cluster.sh down    delete the cluster
#
# It is the one thing in the repository that needs docker, kind, kubectl and helm, and it names whichever is missing
# before it starts. It pushes nothing and publishes nothing: the image goes from the local docker into the cluster, and
# the packed tarballs are served to the build from a container that is removed on exit.
set -euo pipefail

readonly CLUSTER=wilanis
readonly CONTEXT="kind-$CLUSTER"
# The tree and the profile its deploy/ files are written for (`npx wilanis-deploy example --profile production`).
readonly TREE=example
readonly PROFILE=production
# localhost:8080 on this machine is port 30080 on the node, the nodePort values-local.yaml gives production.
readonly HOST_PORT=8080
readonly NODE_PORT=30080
# The name the image build reaches the packed tarballs by, and the port they are served on inside their container.
readonly PACKS_HOST=wilanis-packs
readonly PACKS_PORT=8080

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
readonly REPO
STAGE=""
PACKS_SERVER=""
PACKS_ADDRESS=""
LOCKER=""

say() { printf '%s\n' "$*"; }
die() {
  printf 'cluster.sh: %s\n' "$*" >&2
  exit 1
}

usage() {
  sed -n '4,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

# Where each command a verb needs is installed from, for the line that says it is missing.
where_from() {
  case "$1" in
    docker) echo "docker (https://docs.docker.com/get-docker/)" ;;
    kind) echo "kind (https://kind.sigs.k8s.io/docs/user/quick-start/#installation)" ;;
    kubectl) echo "kubectl (https://kubernetes.io/docs/tasks/tools/)" ;;
    helm) echo "helm (https://helm.sh/docs/intro/install/)" ;;
    *) echo "$1" ;;
  esac
}

# Refuses before anything runs when a command the verb needs is not on PATH, naming every one of them; and, where the
# verb needs docker, when its daemon does not answer.
need() {
  local verb=$1 missing="" tool
  shift
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || missing="$missing, $(where_from "$tool")"
  done
  [ -z "$missing" ] || die "$verb needs $*; missing: ${missing#, }"
  case " $* " in
    *" docker "*) docker info >/dev/null 2>&1 || die "$verb needs docker's daemon, which does not answer: start it, then run $verb again" ;;
  esac
}

# Removes the two containers `up` makes and its staging directory, however it ends.
cleanup() {
  if [ -n "$LOCKER" ]; then docker rm -f "$LOCKER" >/dev/null 2>&1 || true; fi
  if [ -n "$PACKS_SERVER" ]; then docker rm -f "$PACKS_SERVER" >/dev/null 2>&1 || true; fi
  if [ -n "$STAGE" ]; then rm -rf "$STAGE"; fi
}

# The directories of the workspace packages the tree depends on, and of the ones those depend on in turn: what
# `npm run release` would publish for it, one per line.
closure() {
  node -e '
    const { readFileSync, readdirSync, existsSync } = require("node:fs");
    const { join } = require("node:path");
    const [root, tree] = process.argv.slice(1);
    const read = file => JSON.parse(readFileSync(join(root, file), "utf8"));
    const dirs = new Map();
    for (const parent of ["packages", "libraries"])
      for (const name of readdirSync(join(root, parent)))
        if (existsSync(join(root, parent, name, "package.json"))) dirs.set(read(join(parent, name, "package.json")).name, join(parent, name));
    const wanted = Object.keys(read(join(tree, "package.json")).dependencies ?? {});
    const taken = new Set();
    while (wanted.length) {
      const name = wanted.pop();
      if (taken.has(name) || !dirs.has(name)) continue;
      taken.add(name);
      const pkg = read(join(dirs.get(name), "package.json"));
      wanted.push(...Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }));
    }
    for (const name of [...taken].sort()) console.log(dirs.get(name));
  ' "$REPO" "$TREE"
}

# Builds the workspace, refuses deploy/ files that have gone stale against the tree, and packs every package the tree
# needs into $STAGE/packs, with what npm answered for each (its name and its tarball) in $STAGE/packs.json.
pack() {
  local dirs=() dir packed
  (cd "$REPO" && npm run build --silent)
  (cd "$REPO" && node_modules/.bin/wilanis-deploy "$TREE" --profile "$PROFILE" --target image,helm --check) ||
    die "$TREE/deploy/ is not what the tree renders: run npx wilanis-deploy $TREE --profile $PROFILE --target image,compose,helm"
  packed=$(closure)
  while IFS= read -r dir; do dirs+=(-w "$dir"); done <<<"$packed"
  mkdir -p "$STAGE/packs"
  (cd "$REPO" && npm pack --silent --json --pack-destination "$STAGE/packs" "${dirs[@]}") >"$STAGE/packs.json"
}

# A copy of the tree as the repository holds it, uncommitted edits included and whatever .gitignore leaves out left
# out (node_modules, .env, .wilanis/, scenarios/), whose package.json names each packed tarball at its URL.
stage_tree() {
  (
    cd "$REPO"
    git ls-files -z --cached --others --exclude-standard -- "$TREE" |
      while IFS= read -r -d '' file; do if [ -e "$file" ]; then printf '%s\0' "$file"; fi; done |
      tar --null -T - -cf -
  ) | (cd "$STAGE" && tar -xf -)
  node -e '
    const { readFileSync, writeFileSync } = require("node:fs");
    const [file, packs, base] = process.argv.slice(1);
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    pkg.dependencies ??= {};
    for (const { name, filename } of JSON.parse(readFileSync(packs, "utf8"))) pkg.dependencies[name] = base + "/" + filename;
    writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  ' "$STAGE/$TREE/package.json" "$STAGE/packs.json" "http://$PACKS_HOST:$PACKS_PORT"
}

# Serves $STAGE/packs from a container on docker's default network, and sets PACKS_ADDRESS to the address a build
# reaches it at. The tarballs are copied in rather than mounted, so this works wherever the daemon runs.
serve_packs() {
  local image=$1
  PACKS_SERVER="wilanis-packs-$$"
  docker create --name "$PACKS_SERVER" "$image" node -e '
    const { createReadStream, existsSync } = require("node:fs");
    const { basename, join } = require("node:path");
    require("node:http").createServer((request, response) => {
      const file = join("/packs", basename(decodeURIComponent(new URL(request.url, "http://packs").pathname)));
      if (!file.endsWith(".tgz") || !existsSync(file)) return response.writeHead(404).end();
      response.writeHead(200, { "content-type": "application/octet-stream" });
      createReadStream(file).pipe(response);
    }).listen(Number(process.argv[1]));
  ' "$PACKS_PORT" >/dev/null
  docker cp "$STAGE/packs/." "$PACKS_SERVER:/packs" >/dev/null
  docker start "$PACKS_SERVER" >/dev/null
  PACKS_ADDRESS=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$PACKS_SERVER")
  [ -n "$PACKS_ADDRESS" ] || die "the tarball server has no address on docker's default network, where the build reaches it"
  for _ in $(seq 1 30); do
    if docker exec "$PACKS_SERVER" node -e \
      "require('node:net').connect($PACKS_PORT).on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"; then
      return
    fi
    sleep 1
  done
  die "the tarball server did not open port $PACKS_PORT"
}

# Writes the staged tree's package-lock.json with the npm of the image the Dockerfile starts from, fetching the
# tarballs where the build will, so `npm ci` in the build installs exactly what the lockfile records.
lock() {
  local image=$1
  LOCKER=$(docker create --add-host "$PACKS_HOST:$PACKS_ADDRESS" -w /app "$image" \
    npm install --package-lock-only --ignore-scripts --no-audit --no-fund --loglevel=error)
  mkdir -p "$STAGE/lock"
  cp "$STAGE/$TREE/package.json" "$STAGE/lock/"
  docker cp "$STAGE/lock/." "$LOCKER:/app" >/dev/null
  docker start -a "$LOCKER" || die "npm could not write the staged tree's lockfile"
  docker cp "$LOCKER:/app/package-lock.json" "$STAGE/$TREE/package-lock.json" >/dev/null
}

# Creates the kind cluster with localhost:$HOST_PORT mapped to the node's $NODE_PORT, or keeps the one already there.
create_cluster() {
  if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
    say "kind: cluster '$CLUSTER' is up already, and is used as it is"
    return
  fi
  kind create cluster --name "$CLUSTER" --wait 120s --config - <<EOF
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    extraPortMappings:
      - containerPort: $NODE_PORT
        hostPort: $HOST_PORT
        listenAddress: 127.0.0.1
        protocol: TCP
EOF
  say "kind: cluster '$CLUSTER' ready (1 node, $HOST_PORT → $NODE_PORT)"
}

# A copy of the chart with its pinned dependencies fetched as Chart.lock records them, into $STAGE/chart. Helm's
# repository list is kept in $STAGE too, so this machine's is not touched.
stage_chart() {
  local n=0 url
  export HELM_REPOSITORY_CONFIG="$STAGE/helm/repositories.yaml" HELM_REPOSITORY_CACHE="$STAGE/helm/cache"
  cp -R "$REPO/charts/wilanis-tree" "$STAGE/chart"
  rm -rf "$STAGE/chart/charts"
  while IFS= read -r url; do
    n=$((n + 1))
    helm repo add "pinned-$n" "$url" >/dev/null
  done < <(grep -o 'https://[^ ]*' "$STAGE/chart/Chart.lock" | sort -u)
  helm dependency build "$STAGE/chart" >/dev/null
}

# One `helm upgrade --install` of the release with the tree's values and the local demo's.
helm_install() {
  helm upgrade --install "$1" "$STAGE/chart" --kube-context "$CONTEXT" --namespace default \
    -f "$REPO/$TREE/deploy/values.yaml" -f "$REPO/charts/wilanis-tree/values-local.yaml" >/dev/null
}

# Installs the chart in the two passes CloudNativePG needs: the first installs the operator and its resource types and
# cannot yet render the Cluster; the second, once the operator is ready, renders it. Then waits for the database and
# for the tree's own Deployment, which waits in turn for the Secret the operator writes.
install_chart() {
  local release=$1 existed=""
  helm status "$release" --kube-context "$CONTEXT" --namespace default >/dev/null 2>&1 && existed=yes
  helm_install "$release"
  kubectl --context "$CONTEXT" rollout status "deployment/$release-cloudnative-pg" --timeout=300s
  for _ in $(seq 1 12); do
    if helm_install "$release" && kubectl --context "$CONTEXT" get "clusters.postgresql.cnpg.io/$release-postgresql" >/dev/null 2>&1; then
      break
    fi
    sleep 10
  done
  kubectl --context "$CONTEXT" get "clusters.postgresql.cnpg.io/$release-postgresql" >/dev/null ||
    die "the second helm pass made no PostgreSQL Cluster: the operator's resource types are still not served"
  say "helm: installed $release (charts/wilanis-tree -f $TREE/deploy/values.yaml -f charts/wilanis-tree/values-local.yaml)"
  kubectl --context "$CONTEXT" wait --for=condition=Ready "clusters.postgresql.cnpg.io/$release-postgresql" --timeout=600s
  if [ -n "$existed" ]; then kubectl --context "$CONTEXT" rollout restart "deployment/$release-$PROFILE"; fi
  kubectl --context "$CONTEXT" rollout status "deployment/$release-$PROFILE" --timeout=600s
  say "ready: deployment/$release-$PROFILE"
}

# What `wilanis-deploy --target plan` answers for one field, read from the plan it prints.
plan_field() {
  (cd "$REPO" && node_modules/.bin/wilanis-deploy "$TREE" --profile "$PROFILE" --target plan 2>/dev/null) |
    node -e 'let text = ""; process.stdin.on("data", chunk => (text += chunk)).on("end", () =>
      console.log(process.argv[1].split(".").reduce((value, key) => value[key], JSON.parse(text))))' "$1"
}

up() {
  local name image node_image count
  need up docker kind kubectl helm node npm git curl
  [ -x "$REPO/node_modules/.bin/wilanis-deploy" ] || die "up needs the workspace installed: run npm install first"
  STAGE=$(mktemp -d "${TMPDIR:-/tmp}/wilanis-cluster.XXXXXX")
  trap cleanup EXIT
  pack
  name=$(plan_field name)
  image=$(plan_field image.reference)
  stage_tree
  node_image=$(sed -n 's/^FROM[[:space:]]\{1,\}\([^[:space:]]*\).*/\1/p' "$STAGE/$TREE/deploy/Dockerfile" | head -n 1)
  serve_packs "$node_image"
  lock "$node_image"
  count=$(grep -c '"filename"' "$STAGE/packs.json")
  say "pack: $count tarballs from packages/ and libraries/, locked into a staging copy of $TREE/"
  docker build --add-host "$PACKS_HOST:$PACKS_ADDRESS" -f "$STAGE/$TREE/deploy/Dockerfile" -t "$image" "$STAGE/$TREE"
  say "docker: built $image from $TREE/deploy/Dockerfile"
  create_cluster
  kind load docker-image "$image" --name "$CLUSTER"
  stage_chart
  install_chart "$name"
  smoke
  say "→ http://localhost:$HOST_PORT/customers (signed in: scripts/cluster.sh smoke signs in as the demo's operator)"
}

# Signs in as the one operator account values-local.yaml writes the hash of, and reads GET /customers with the token,
# through localhost:$HOST_PORT and so through the node's $NODE_PORT: the assertion that the image, built from the packed
# tarballs and installed from the chart, answers a route.
smoke() {
  local url="http://localhost:$HOST_PORT" tokens token answer status
  need smoke curl node
  tokens=$(curl -fsS --retry 20 --retry-delay 3 --retry-all-errors -H 'content-type: application/json' \
    -d '{"username":"operator","password":"operator-pass"}' "$url/api/v1/auth-employees") ||
    die "POST $url/api/v1/auth-employees did not sign the operator in"
  token=$(printf '%s' "$tokens" | node -e 'let text = ""; process.stdin.on("data", chunk => (text += chunk)).on("end", () =>
    process.stdout.write(JSON.parse(text).accessToken))')
  answer=$(curl -sS -w '\n%{http_code}' -H "authorization: Bearer $token" "$url/customers")
  status=${answer##*$'\n'}
  [ "$status" = 200 ] || die "GET $url/customers answered $status, not 200: ${answer%$'\n'*}"
  say "smoke: the operator signed in, and GET /customers answered 200: ${answer%$'\n'*}"
}

down() {
  need down docker kind
  kind delete cluster --name "$CLUSTER"
}

case "${1:-}" in
  up) up ;;
  smoke) smoke ;;
  down) down ;;
  -h | --help | help) usage ;;
  *) usage 1 >&2 ;;
esac
