/**
 * The `compose` target (RFC 0024): a Compose file with one service per workload, and the `.env.example` that names
 * every variable they read and holds no value. The YAML is emitted by the `yaml` package from an object, never built
 * as a string, so it parses by construction; every string is double-quoted, so `8080:8080` is never read as a
 * sexagesimal number by a YAML 1.1 reader. The file sits beside the Dockerfile, and each service builds the one image
 * from the tree's root. A service is probed by a TCP connect on its first port, with the node the image already has.
 * The project is named after the tree, not after the directory the file sits in, which is `deploy` for every tree.
 */
import { posix } from 'node:path';
import { Document, visit, type YAMLSeq } from 'yaml';
import { byUnits, sorted } from './order.js';
import type { Plan, Workload } from './plan.js';
import { unreachableOf } from './reachable.js';
import type { Rendered } from './write.js';

/** Where compose reads the variables from, beside the Compose file: `.env.example` filled in and saved. */
const ENV_FILE = '.env';

/** A service's name: the tree's, and the profile's where the workload has one. */
const serviceOf = (plan: Plan, workload: Workload): string =>
  workload.profile === '' ? plan.name : `${plan.name}-${workload.profile}`;

/** How the image is built, as compose reads it from the file's own directory: the tree's root, and the Dockerfile. */
function buildOf(plan: Plan): { context: string; dockerfile: string } {
  const { context, dockerfile } = plan.image;
  return {
    context: posix.relative(posix.dirname(dockerfile), context) || '.',
    dockerfile: posix.relative(context, dockerfile),
  };
}

/** The script a healthcheck runs: a TCP connect on the port, exiting 0 once it connects and 1 when it cannot. */
const connects = (port: number): string =>
  `require('node:net').connect(${port}).on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))`;

/** A workload's healthcheck, where it has a probe: a TCP connect on the port every ten seconds, six tries. */
const healthcheckOf = ({ probe }: Workload) =>
  probe
    ? { healthcheck: { test: ['CMD', 'node', '-e', connects(probe.tcp)], interval: '10s', timeout: '2s', retries: 6 } }
    : {};

/** One workload's service: the image, its command, its ports, its variables, a read-only root, and its probe. */
function serviceBody(plan: Plan, workload: Workload): Record<string, unknown> {
  const numbers = [...new Set(workload.listens.map(listen => listen.port))].sort((one, other) => one - other);
  const ports = numbers.map(port => `${port}:${port}`);
  return {
    build: buildOf(plan),
    image: plan.image.reference,
    command: workload.command,
    ...(ports.length ? { ports } : {}),
    ...(workload.needs.length ? { env_file: [ENV_FILE] } : {}),
    restart: 'unless-stopped',
    read_only: true,
    tmpfs: ['/tmp'],
    ...healthcheckOf(workload),
  };
}

/** The Compose file's text: every list on one line and every string quoted, as the Guide writes it. */
function composeOf(plan: Plan): string {
  const services = Object.fromEntries(
    plan.workloads.map(workload => [serviceOf(plan, workload), serviceBody(plan, workload)]),
  );
  const doc = new Document({ name: plan.name, services });
  const flow = (_: unknown, node: YAMLSeq) => {
    node.flow = true;
  };
  visit(doc, { Seq: flow });
  return doc.toString({
    lineWidth: 0,
    flowCollectionPadding: false,
    defaultStringType: 'QUOTE_DOUBLE',
    defaultKeyType: 'PLAIN',
  });
}

/** One variable as `.env.example` names it: the secret keys it answers, and who reads it. */
interface Variable {
  keys: string[];
  readBy: string[];
}

/** Every variable any workload needs, by name, its keys and readers gathered across the workloads. */
function variablesOf(plan: Plan): [string, Variable][] {
  const variables = new Map<string, Variable>();
  for (const need of plan.workloads.flatMap(workload => workload.needs)) {
    const was = variables.get(need.variable) ?? { keys: [], readBy: [] };
    variables.set(need.variable, {
      keys: sorted([...was.keys, need.key]),
      readBy: sorted([...was.readBy, ...need.readBy]),
    });
  }
  return [...variables].sort(([one], [other]) => byUnits(one, other));
}

/** Who `.env.example` is for, with the verb that agrees: `profile 'production' needs`, `profiles 'a', 'b' need`. */
function needSaid(plan: Plan): string {
  const named = plan.workloads.map(workload =>
    workload.profile === '' ? 'the unnamed profile' : `'${workload.profile}'`,
  );
  return named.length === 1 ? `profile ${named[0]} needs` : `profiles ${named.join(', ')} need`;
}

/** `.env.example`: each variable a comment naming its keys and readers, then its name and an `=`, and never a value. */
function envExampleOf(plan: Plan): string {
  const variables = variablesOf(plan);
  if (!variables.length) return `# ${needSaid(plan)} no variable\n`;
  const lines = variables.flatMap(([variable, { keys, readBy }]) => [
    `# ${keys.map(key => `secrets.${key}`).join(', ')}, read by ${readBy.join(', ')}`,
    `${variable}=`,
  ]);
  return [`# every variable ${needSaid(plan)}; fill these in and save as ${ENV_FILE}`, ...lines, ''].join('\n');
}

/**
 * The Compose file and `.env.example` of a plan. Throws every address a published port would not reach, as one
 * refusal each, since compose publishes every port it lists.
 */
export function composeFiles(plan: Plan): Rendered[] {
  const refusals = unreachableOf(plan);
  if (refusals.length) throw new Error(refusals.join('\n\n'));
  return [
    { path: 'compose.yaml', contents: composeOf(plan) },
    { path: '.env.example', contents: envExampleOf(plan) },
  ];
}
