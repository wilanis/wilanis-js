# @wilanis/deploy

Deployment for wilanis trees (RFC 0024). A tool over a tree's manifest, as `@wilanis/view` is a tool over a
loaded tree: it grants nothing to a tree and runs nothing of it.

Between the manifest `wilanis manifest` prints and any file a container runtime or a cluster reads sits one pure
function, `planOf`, whose answer is a **plan**: one workload per profile asked for, with the command that starts
it, the addresses it listens on, what it holds open, the variables it needs by name, one replica and a probe on
its first port; and `requires`, every connection those profiles reach whose kind declares an `endpoint`, which
the environment must provide. A target renders the plan and reads nothing else.

```
npx wilanis-deploy example --profile production
npx wilanis-deploy example --profile production --profile production-worker
npx wilanis-deploy example --profile production --target plan
npx wilanis-deploy example --profile production --check
npx wilanis-deploy example --profile production --target helm
```

`--profile` is required and may be repeated: a deployment is of one place, and the asker knows which. A tree
that declares no profile is deployed with `--profile ''`. The tree is loaded and checked first, as `wilanis
manifest` does, and a tree with refusals prints them and exits 1. The plan goes to stdout and never to a file
inside the tree, since the loader reads every `*.json` under the root; its shape is
[`schemas/plan.schema.json`](schemas/plan.schema.json).

Two things are refused before anything is printed, each with the edit that fixes it: a profile that holds
nothing, which would start, answer and exit in a container; and an address whose port the tree does not fix,
where a secret supplies it or nothing writes it. Neither is a checker rule: a tree that never deploys is not wrong
for either.

## Targets

`--target` takes a comma-separated list, and is `image,compose` where none is named:

| Target | Writes | What it is |
|---|---|---|
| `image` | `Dockerfile`, `Dockerfile.dockerignore` | the one image every workload runs: the tree installed with `npm ci --omit=dev`, run as `node`, one `EXPOSE` per port, the first workload's command |
| `compose` | `compose.yaml`, `.env.example` | one service per workload, on a read-only root with `/tmp` writable, probed by a TCP connect on its first port; `.env.example` names every variable, its key and who reads it, and holds no value |
| `helm` | `values.yaml` | the values of [`charts/wilanis-tree`](https://github.com/wilanis/wilanis-js/tree/main/charts/wilanis-tree), the chart this repository ships: each workload's command, replicas, ports (named `tcp-<port>`), probe and variables, the Secret's keys by name, what the environment must provide, and every switch off |
| `plan` | nothing | the plan as JSON on stdout |

The files go into `<root>/deploy`, or where `-o` says; the image is built from the root either way. None of
them is JSON, so the loader, which reads every `*.json` under the root, never takes one for a document and
`wilanis check` reads the tree exactly as before. The ignore file is `Dockerfile.dockerignore` because Docker
reads a plain `.dockerignore` only at the root of the build's context, which is the tree's root, and reads
`<Dockerfile>.dockerignore` beside the Dockerfile; one named `.dockerignore` inside `deploy/` would be read by
nothing. `compose` and `helm` refuse an address bound to a fixed interface that is no wildcard, such as
`127.0.0.1`: a published port and a Service both arrive on the container's own address, so such a listener would
answer nobody. The plan does not refuse it, and a sidecar sharing the network namespace renders `--target plan` and
writes its own objects.

The chart is not generated: it is written once and reviewed like code, and `helm` writes only what differs per
tree, so a fix to the chart reaches every tree without regenerating anything. Its README says what it expects
beside the values (an image and a Secret) and what each switch stands up.

Every file begins with two lines saying it is generated, from which tree and profiles, and the command that
renders it again. The tree is the source, so regenerate rather than edit. A file whose first line is not that
header is someone's own -- a Dockerfile the tree outgrew -- and is never overwritten without `--force`; nothing
is written while one stands where a target would write. `--check` writes nothing and exits 1 naming every file
a write would change, which is what CI runs over `example/deploy/`. stdout carries the plan and nothing else;
what was written, and what would change, is said on stderr.

## From code

```ts
import { composeFiles, imageFiles, planOf, stamped, writeInto } from '@wilanis/deploy';
import { loadProject, manifestOf } from '@wilanis/runtime';

const manifest = manifestOf(await loadProject('example'), { root: 'example' });
const plan = planOf(manifest, { profiles: ['production'], image: 'customers:0.1.0' });
const origin = { root: 'example', profiles: ['production'], flags: [] };
const files = [...imageFiles(plan), ...composeFiles(plan)].map(file => stamped(file, origin));
writeInto('example/deploy', files, { check: false, force: false });
```

`planOf` never loads a tree and never reads the environment, so a manifest another tool printed plans the same.
Each renderer is a pure function from a plan to the files it writes, `{ path, contents }`; `writeInto` is the one
thing that touches the disk.
