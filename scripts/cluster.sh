#!/usr/bin/env bash
# The example on a local Kubernetes cluster, and under docker compose (RFC 0024).
#
#   scripts/cluster.sh up       build the example's image from the workspace's packages as `npm pack` writes them, create
#                               a kind cluster, install charts/wilanis-tree with the example's generated values and
#                               values-local.yaml, wait until production is ready, and run the smoke check
#   scripts/cluster.sh smoke    sign in as the demo's operator and GET /customers through the NodePort, for a 200
#   scripts/cluster.sh down     delete the cluster
#   scripts/cluster.sh compose  build the same image through the example's deploy/compose.yaml, bring up what it
#                               declares beside a PostgreSQL with deploy/.env holding the demo's values, run the smoke
#                               check on the port it publishes, and take it all down with its volumes
#
# It is the one thing in the repository that needs docker, kind, kubectl and helm, and it names whichever is missing
# before it starts. It pushes nothing and publishes nothing: the image goes from the local docker into the cluster or
# into compose, and the packed tarballs are served to the build from a container that is removed on exit.
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
# The PostgreSQL `compose` stands up for production's database, pinned by version and digest, and the database on it.
# The password is the demo's, as values-local.yaml's values are. Its port is published nowhere: the tree reaches it by
# its service name on the project's own network.
readonly PG_IMAGE=postgres:18.6-alpine3.24@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873
readonly PG_SERVICE=postgresql
readonly PG_USER=customers
readonly PG_PASSWORD=local-only-not-a-secret
readonly PG_DATABASE=customers

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
readonly REPO
STAGE=""
PACKS_SERVER=""
PACKS_ADDRESS=""
LOCKER=""
TREE_NAME=""
IMAGE=""
COMPOSED=""

say() { printf '%s\n' "$*"; }
die() {
  printf 'cluster.sh: %s\n' "$*" >&2
  exit 1
}

usage() {
  sed -n '4,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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

# Removes the two containers `up` and `compose` make and their staging directory, however they end, and takes down what
# `compose` brought up if it is still up, with its logs first where the verb failed.
cleanup() {
  local status=$?
  if [ -n "$COMPOSED" ]; then
    if [ "$status" -ne 0 ]; then compose_files logs --no-color --tail=200 >&2 || true; fi
    compose_down || true
  fi
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

# Builds the workspace, refuses the deploy/ files of the targets it is given (`image,helm`) where they have gone stale
# against the tree, and packs every package the tree needs into $STAGE/packs, with what npm answered for each (its name
# and its tarball) in $STAGE/packs.json.
pack() {
  local targets=$1 dirs=() dir packed
  (cd "$REPO" && npm run build --silent)
  (cd "$REPO" && node_modules/.bin/wilanis-deploy "$TREE" --profile "$PROFILE" --target "$targets" --check) ||
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

# What `up` and `compose` build the image from: the workspace packed, a staging copy of the tree locked to the tarballs,
# and the tarballs served where the build reaches them. It is given the verb it runs for and the deploy/ targets that
# verb reads, and sets TREE_NAME and IMAGE from the plan.
stage() {
  local verb=$1 targets=$2 node_image count
  [ -x "$REPO/node_modules/.bin/wilanis-deploy" ] || die "$verb needs the workspace installed: run npm install first"
  STAGE=$(mktemp -d "${TMPDIR:-/tmp}/wilanis-cluster.XXXXXX")
  trap cleanup EXIT
  pack "$targets"
  TREE_NAME=$(plan_field name)
  IMAGE=$(plan_field image.reference)
  stage_tree
  node_image=$(sed -n 's/^FROM[[:space:]]\{1,\}\([^[:space:]]*\).*/\1/p' "$STAGE/$TREE/deploy/Dockerfile" | head -n 1)
  serve_packs "$node_image"
  lock "$node_image"
  count=$(grep -c '"filename"' "$STAGE/packs.json")
  say "pack: $count tarballs from packages/ and libraries/, locked into a staging copy of $TREE/"
}

up() {
  need up docker kind kubectl helm node npm git curl
  stage up image,helm
  docker build --add-host "$PACKS_HOST:$PACKS_ADDRESS" -f "$STAGE/$TREE/deploy/Dockerfile" -t "$IMAGE" "$STAGE/$TREE"
  say "docker: built $IMAGE from $TREE/deploy/Dockerfile"
  create_cluster
  kind load docker-image "$IMAGE" --name "$CLUSTER"
  stage_chart
  install_chart "$TREE_NAME"
  smoke
  say "→ http://localhost:$HOST_PORT/customers (signed in: scripts/cluster.sh smoke signs in as the demo's operator)"
}

# docker compose over the staged tree's compose.yaml, as wilanis-deploy wrote it, and the demo's override, which sits
# outside the tree so the build context never holds it. The project is the one compose.yaml names.
compose_files() {
  docker compose -f "$STAGE/$TREE/deploy/compose.yaml" -f "$STAGE/compose.override.yaml" "$@"
}

# Writes the staged tree's deploy/.env from its .env.example, as the chart fills the same variables on the cluster: one
# the Secret holds in values-local.yaml takes that value, and one values-local.yaml says the PostgreSQL switch answers
# takes the URL of the override's database. A variable neither answers is refused rather than started empty.
# Dockerfile.dockerignore leaves the .env out of the image.
compose_env() {
  local database="postgres://$PG_USER:$PG_PASSWORD@$PG_SERVICE:5432/$PG_DATABASE" unanswered
  unanswered=$(node -e '
    const { readFileSync, writeFileSync } = require("node:fs");
    const [example, valuesFile, yamlFrom, database, out] = process.argv.slice(1);
    const { parse } = require(require.resolve("yaml", { paths: [yamlFrom] }));
    const values = parse(readFileSync(valuesFile, "utf8"));
    const answers = new Map(Object.entries(values.secret?.values ?? {}));
    for (const name of values.postgresql?.variables ?? []) answers.set(name, database);
    const unanswered = [];
    const lines = readFileSync(example, "utf8").split("\n").map(line => {
      const name = /^([A-Za-z_][A-Za-z0-9_]*)=$/.exec(line)?.[1];
      if (name === undefined) return line;
      if (!answers.has(name)) unanswered.push(name);
      return name + "=" + (answers.get(name) ?? "");
    });
    if (unanswered.length) {
      console.log(unanswered.join(", "));
      process.exit(1);
    }
    writeFileSync(out, lines.join("\n"));
  ' "$STAGE/$TREE/deploy/.env.example" "$REPO/charts/wilanis-tree/values-local.yaml" "$REPO/packages/deploy" \
    "$database" "$STAGE/$TREE/deploy/.env") ||
    die "charts/wilanis-tree/values-local.yaml has no value for $unanswered, which $TREE/deploy/.env.example names: add each under secret.values"
}

# Writes the override `compose` lays over compose.yaml: the address the build fetches the packed tarballs from, and the
# PostgreSQL production keeps its customers in, which the tree's service waits on until it answers.
compose_override() {
  local service=$1
  cat >"$STAGE/compose.override.yaml" <<EOF
services:
  $service:
    build:
      extra_hosts: ["$PACKS_HOST:$PACKS_ADDRESS"]
    depends_on:
      $PG_SERVICE:
        condition: service_healthy
  $PG_SERVICE:
    image: "$PG_IMAGE"
    environment:
      POSTGRES_USER: "$PG_USER"
      POSTGRES_PASSWORD: "$PG_PASSWORD"
      POSTGRES_DB: "$PG_DATABASE"
    healthcheck:
      test: ["CMD", "pg_isready", "-h", "127.0.0.1", "-U", "$PG_USER", "-d", "$PG_DATABASE"]
      interval: "2s"
      timeout: "2s"
      retries: 30
EOF
}

# Takes down what `compose` brought up, the database's volume with it, so the next run starts from an empty database.
compose_down() {
  COMPOSED=""
  compose_files down -v --remove-orphans
  say "compose: down, with its volumes"
}

# Builds the image the way `up` does, but through compose.yaml's own build, brings up what compose.yaml declares with
# the override, waits for both services' healthchecks, and runs the smoke check on the port compose.yaml publishes.
compose() {
  local service port
  need compose docker node npm git curl
  docker compose version >/dev/null 2>&1 ||
    die "compose needs docker's compose plugin (https://docs.docker.com/compose/install/)"
  stage compose image,compose
  service="$TREE_NAME-$PROFILE"
  port=$(plan_field workloads.0.listens.0.port)
  compose_env
  compose_override "$service"
  compose_files build "$service"
  say "docker: built $IMAGE through $TREE/deploy/compose.yaml"
  COMPOSED=yes
  compose_files up --detach --wait --wait-timeout 300
  say "compose: $service up on localhost:$port, beside $PG_SERVICE"
  smoke "$port"
  compose_down
}

# Signs in as the one operator account values-local.yaml writes the hash of, and reads GET /customers with the token,
# through localhost:$HOST_PORT and so through the node's $NODE_PORT, or through the port it is given, where `compose`
# publishes the tree: the assertion that the image, built from the packed tarballs and run from the chart or from
# compose.yaml, answers a route.
smoke() {
  local url="http://localhost:${1:-$HOST_PORT}" tokens token answer status
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
  compose) compose ;;
  -h | --help | help) usage ;;
  *) usage 1 >&2 ;;
esac
