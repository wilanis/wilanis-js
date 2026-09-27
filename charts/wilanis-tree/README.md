# wilanis-tree

One wilanis tree on Kubernetes (RFC 0024). The chart is written once, versioned here and reviewed like code; what
differs per tree is its values, and those `wilanis-deploy` derives from the tree's manifest. Nothing in this
directory is generated.

```
npx wilanis-deploy example --profile production --target helm
helm dependency update charts/wilanis-tree
helm install customers charts/wilanis-tree -f example/deploy/values.yaml
```

`--target helm` writes `<root>/deploy/values.yaml`, whose first line says it is generated and whose second says the
command that writes it again; `--check` fails CI when it has gone stale against the tree. The chart's own
`values.yaml` is the same shape with nothing in it, so an install without the tree's values deploys nothing and
says so.

## What it expects

- An image, built from the Dockerfile the `image` target writes beside the values, and tagged as `image`
  names it (`<name>:<version>` from the tree's `package.json`). Push it where the cluster pulls from, or load it
  into a local one.
- A Secret, holding every key in `secret.keys`: the variables the tree's secrets name, by name. The chart
  never holds a value unless it is told to. Name the Secret with `secret.existingSecret`, or leave that empty and
  create the one named after the tree; the Compose target's `.env.example`, filled in and saved as `.env`, is
  already the file it takes:

  ```
  kubectl create secret generic customers --from-env-file=example/deploy/.env
  ```

  `secret.create: true` makes the chart create it from `secret.values` instead, which puts the values in the
  release and in whatever file passed them: a laptop's choice, never production's.
- The values `wilanis-deploy` writes, and a values file of the operator's own for what the cluster decides:
  `service.type`, `service.nodePorts`, `resources`. A file layered with `-f` merges into maps but replaces a list
  whole, so a change to one workload (more replicas, an `httpGet` probe on a route the tree declares) restates
  `workloads`.

## What it makes

For each entry of `workloads`, a Deployment named `<name>-<profile>` that runs the one image with that workload's
command, reads each variable from the Secret, and is ready once its first port accepts a connection. The tree opens
that socket only after every startup step before its listener has succeeded, so the socket is the readiness the
tree already declares, and no route is needed for it. Each workload that listens also gets a Service of the same
name, a port for each port it listens on, named `tcp-<port>`; a worker or a scheduler listens on nothing and gets
none. `replicas` is 1: until RFC 0005 a tree may keep state on the instance's disk.

After an install `NOTES.txt` prints what was made, which Secret the pods wait for, and `requires`: every connection
a workload reaches whose kind declares an endpoint, as the tree said it. No template reads `requires`, and it is a
floor: a connection whose kind declares no `endpoint` is not in it.

## The pod

The pod runs as RFC 0020's deployment half asks: as the image's `node` user by number (1000, so the kubelet can
tell it is not root), with no privilege escalation, no capabilities, the runtime's default seccomp profile, no
service account token, and a read-only root filesystem. One directory is writable, `/tmp`, an `emptyDir`, which is
where the file blob registry keeps the bodies it holds.

Nothing inside the tree is writable, and that is deliberate. A profile that binds `@auth/state.port.json` to
`@auth/files.port.json` keeps sessions and challenges as files under `.wilanis/auth`, inside the tree, and under
this chart its first sign-in is refused the write. Such a profile must bind `@auth/state.port.json` to a store, as
the example's `production` profile does (`@features/state/data/auth-storage.binding.json`, beside the customers in
PostgreSQL). The chart gives `.wilanis` no volume of its own because the only volume it could give without owning
storage is an `emptyDir`, which is one pod's: a session written there is gone at the pod's next restart and unknown
to a second replica, which is a loss nobody would see until a user is signed out. The read-only root turns that
into an error at the first write instead.

## The switches

What the chart may stand up beside the tree, each a dependency in `Chart.yaml` pinned by version, each off, each
chosen for images that pull without a vendor account. They exist so the roadmap's demos stand up on a laptop; none
is provisioned for production, where a connection names a host the operator runs.

| Switch | Chart | Stands up |
|---|---|---|
| `postgresql` | `cloudnative-pg` 0.29.1, the CloudNativePG operator | the operator, and one `Cluster` of `postgresql.instances` on a `postgresql.size` volume (`templates/postgresql.yaml`); RFC 0002's engine, and RFC 0009's broker, a table in the same database |
| `minio` | `minio` 5.4.0, the MinIO project's own | one MinIO server on one volume, the S3 API of RFC 0005 |
| `jaeger` | `jaeger` 4.14.0 | one Jaeger process holding traces in memory and receiving OTLP on 4317 and 4318, RFC 0006's collector |

The operator's own values go under `cloudnative-pg:`; MinIO's under `minio:` and Jaeger's under `jaeger:`, beside
each `enabled`.

`postgresql.variables` names the variables the cluster answers: each is read from the key `uri` of
`<name>-postgresql-app`, the Secret the operator writes for the cluster's application user, instead of from the
tree's Secret, so no database password is in any file. The operator installs the `Cluster` resource type along
with itself, so on a first install there is no such type yet and the chart renders no `Cluster`; NOTES.txt says so,
and the same command run again as `helm upgrade` once the operator is ready creates it. Until then the tree's pods
wait for the Secret the cluster would write.

`Chart.yaml` names each version exactly, so `helm dependency update charts/wilanis-tree` fetches the three
archives `Chart.lock` records into `charts/wilanis-tree/charts/`, where they are not committed. CI runs `helm
dependency build` instead, which reads `Chart.lock` and fails where it has fallen out of step with `Chart.yaml`;
it needs each repository added first. A new pin is a pull request that changes the version and runs `helm
dependency update`.

## The example's cluster

`values-local.yaml` is what the example's demo turns on, layered over the example's generated values:

```
helm install customers charts/wilanis-tree -f example/deploy/values.yaml -f charts/wilanis-tree/values-local.yaml
```

It puts the production listener on NodePort 30080, which a local kind cluster maps a host port to; turns on
`postgresql` and reads `CUSTOMERS_DATABASE_URL` from the cluster it stands up, where the production profile keeps
its customers, its sessions and its removals queue; and has the chart create the Secret for the two variables
left, with values that work on that laptop and nowhere else (the operator account's password is `operator-pass`).
It turns on neither `minio`, since the example reaches no bucket, nor `jaeger`, since the example's traces go to
the collector the `@otel` settings name, `localhost:4318`.
