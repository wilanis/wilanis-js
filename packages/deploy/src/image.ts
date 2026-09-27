/**
 * The `image` target (RFC 0024): the Dockerfile that builds the one image every workload runs, and the ignore file
 * beside it. A tree's profiles share their documents and their node_modules, so one image serves them all: it starts
 * the first workload's command, and every other workload runs it with its own, which is why the Dockerfile names no
 * profile of its own. This writes the recipe and never builds it, so the package depends on no container runtime.
 *
 * The ignore file is `Dockerfile.dockerignore`, beside the Dockerfile, rather than `.dockerignore`: the build's context
 * is the tree's root, and Docker reads a `.dockerignore` only at the root of the context, or a `<Dockerfile>.dockerignore`
 * beside the Dockerfile. One written into `deploy/` under the plain name would be read by nothing.
 */
import { posix } from 'node:path';
import type { Plan } from './plan.js';
import type { Rendered } from './write.js';

/** The Node major an image is based on where the tree's package.json names no engines.node. */
export const NODE_MAJOR = 22;

/** The major a base image is chosen by: the first version the tree's engines.node names that is no upper bound. */
export function majorOf(node: string | null): number {
  const lowest = node?.match(/(?:^|[^<\d.])(\d+)/);
  return lowest ? Number(lowest[1]) : NODE_MAJOR;
}

/** A command in a Dockerfile's exec form: a JSON array, so no shell stands between the image and the process. */
const execForm = (command: string[]): string => `[${command.map(word => JSON.stringify(word)).join(', ')}]`;

/** Every port any workload listens on, each once, in order. */
const portsOf = (plan: Plan): number[] =>
  [...new Set(plan.workloads.flatMap(workload => workload.listens.map(listen => listen.port)))].sort(
    (one, other) => one - other,
  );

/** The Dockerfile: the tree installed as it ships, run as the unprivileged user, the first workload's command. */
function dockerfileOf(plan: Plan): string {
  const [first] = plan.workloads;
  const lines = [
    `FROM node:${majorOf(plan.node)}-alpine`,
    'WORKDIR /app',
    'COPY package.json package-lock.json ./',
    'RUN npm ci --omit=dev',
    'COPY . .',
    "# the wilanis command, from the tree's own node_modules",
    'ENV PATH=/app/node_modules/.bin:$PATH',
    'USER node',
    ...portsOf(plan).map(port => `EXPOSE ${port}`),
    ...(first
      ? [
          "# the first workload's command; every other workload runs this image with its own",
          `CMD ${execForm(first.command)}`,
        ]
      : []),
  ];
  return `${lines.join('\n')}\n`;
}

/** What the build never copies: modules npm installs afresh, the repository, and every .env, which holds values. */
const IGNORED = ['node_modules', '.git', '**/.env'];

/** The Dockerfile and its ignore file, at the path the plan names for the Dockerfile's own name. */
export function imageFiles(plan: Plan): Rendered[] {
  const dockerfile = posix.basename(plan.image.dockerfile);
  return [
    { path: dockerfile, contents: dockerfileOf(plan) },
    { path: `${dockerfile}.dockerignore`, contents: `${IGNORED.join('\n')}\n` },
  ];
}
