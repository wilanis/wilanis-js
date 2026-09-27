# @wilanis/deploy

Deployment for wilanis trees (RFC 0024). A tool over a tree's manifest, as `@wilanis/view` is a tool over a
loaded tree: it grants nothing to a tree and runs nothing of it.

Between the manifest `wilanis manifest` prints and any file a container runtime or a cluster reads sits one pure
function, `planOf`, whose answer is a **plan**: one workload per profile asked for, with the command that starts
it, the addresses it listens on, what it holds open, the variables it needs by name, one replica and a probe on
its first port; and `requires`, every connection those profiles reach whose kind declares an `endpoint`, which
the environment must provide. A target renders the plan and reads nothing else.

```
npx wilanis-deploy example --profile production --target plan
npx wilanis-deploy example --profile production --profile production-worker
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

`plan` is the one target so far. The `image`, `compose` and `helm` targets are the next steps of RFC 0024.

## From code

```ts
import { planOf } from '@wilanis/deploy';
import { loadProject, manifestOf } from '@wilanis/runtime';

const manifest = manifestOf(await loadProject('example'), { root: 'example' });
const plan = planOf(manifest, { profiles: ['production'], image: 'customers:0.1.0' });
```

`planOf` never loads a tree and never reads the environment, so a manifest another tool printed plans the same.
