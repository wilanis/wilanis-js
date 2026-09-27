/**
 * The `helm` target (RFC 0024): the values of the one chart this repository ships, `charts/wilanis-tree`. The chart
 * is written once and reviewed like code; what differs per tree is its values, so they are the half this derives,
 * and a fix to the chart reaches every tree without regenerating anything. The YAML is emitted by the `yaml` package
 * from an object, never built as a string, and every string is double-quoted, as the Compose file's are.
 *
 * A port is named `tcp-<port>`: the plan says an operation opens a TCP socket there and nothing about what speaks on
 * it, so a name such as `http` would be the tool knowing a plugin. Every variable is read from the one Secret the
 * operator creates, under its own name; the values name it and never hold a value. Every switch for what the chart
 * may stand up beside the tree is off: a production connection names a host the operator runs.
 */
import { Document, isCollection, isMap, isNode, isScalar, isSeq, type Node } from 'yaml';
import { byUnits, sorted } from './order.js';
import type { Plan, Workload } from './plan.js';
import { unreachableOf } from './reachable.js';
import type { Rendered } from './write.js';

/** Where the chart these values are for sits, from the root of this repository. */
export const CHART = 'charts/wilanis-tree';

/** What the chart may stand up beside the tree, each a switch the values turn off. */
export const SWITCHES = ['postgresql', 'minio', 'jaeger'] as const;

/** An image reference as the chart takes it: the repository, and the tag after the name's last colon, if any. */
function imageOf(reference: string): { repository: string; tag: string } {
  const colon = reference.lastIndexOf(':');
  if (reference.includes('@') || colon <= reference.lastIndexOf('/')) return { repository: reference, tag: '' };
  return { repository: reference.slice(0, colon), tag: reference.slice(colon + 1) };
}

/** Every variable a workload reads, each once, by name. */
const variablesOf = (workload: Workload): string[] => sorted(workload.needs.map(need => need.variable));

/** One workload as the chart takes it: a Deployment's command and replicas, its ports, its probe, its variables. */
function workloadValues(workload: Workload): Record<string, unknown> {
  const ports = [...new Set(workload.listens.map(listen => listen.port))].sort((one, other) => one - other);
  return {
    profile: workload.profile,
    command: workload.command,
    replicas: workload.replicas,
    ports: ports.map(port => ({ name: `tcp-${port}`, port })),
    ...(workload.probe ? { probe: { tcpSocket: { port: workload.probe.tcp } } } : {}),
    env: variablesOf(workload).map(name => ({ name, secretKey: name })),
  };
}

/** The values of a plan, as an object: the tree, its image, its workloads, its Secret's keys, and what it requires. */
function valuesOf(plan: Plan): Record<string, unknown> {
  const keys = [...new Set(plan.workloads.flatMap(variablesOf))].sort(byUnits);
  return {
    name: plan.name,
    image: { ...imageOf(plan.image.reference), pullPolicy: 'IfNotPresent' },
    workloads: plan.workloads.map(workloadValues),
    secret: { existingSecret: '', keys },
    requires: plan.requires.map(({ connection, kind, endpoint }) => ({ connection, kind, endpoint })),
    ...Object.fromEntries(SWITCHES.map(name => [name, { enabled: false }])),
  };
}

/** Why a workload runs one replica, said beside the number. */
const REPLICAS = ' RFC 0005 is what makes a second safe: until then this tree may hold state on disk';
/** Whose the Secret is, said beside its name. */
const SECRET =
  ' the Secret the operator creates, named after the tree where this is empty; these values never hold one';
/** What `requires` is for, said above it. */
const REQUIRES =
  ' What the environment must provide: every connection a workload reaches whose kind declares an endpoint.\n' +
  ' No template reads it. NOTES.txt prints it after an install, and says it is a floor.';
/** What the switches are for, said above the first. */
const STANDS_UP =
  ' What the chart may stand up beside the tree, each off: the switches exist so a demo stands up on a laptop,\n' +
  ` and a production connection names a host the operator runs (${CHART}/README.md).`;

/** The node at a path of the document; throws where there is none, which a path this module wrote never is. */
function nodeAt(doc: Document, path: (string | number)[]): Node {
  const node = doc.getIn(path, true);
  if (!isNode(node)) throw new Error(`no node at ${path.join('.')}`);
  return node;
}

/** A list or map written on one line, as the Guide writes the short ones. */
function flowAt(doc: Document, path: (string | number)[]): void {
  const node = nodeAt(doc, path);
  if (isCollection(node)) node.flow = true;
}

/** A comment on the line before a top-level key. */
function introduce(doc: Document, key: string, comment: string): void {
  if (!isMap(doc.contents)) return;
  const pair = doc.contents.items.find(item => isScalar(item.key) && item.key.value === key);
  if (pair && isScalar(pair.key)) pair.key.commentBefore = comment;
}

/** One workload's command, ports, probe and each variable on one line, and its replicas explained. */
function styleWorkload(doc: Document, at: number, workload: Workload): void {
  for (const key of ['command', 'ports', ...(workload.probe ? ['probe'] : [])]) flowAt(doc, ['workloads', at, key]);
  const env = nodeAt(doc, ['workloads', at, 'env']);
  if (isSeq(env)) for (const [index] of env.items.entries()) flowAt(doc, ['workloads', at, 'env', index]);
  nodeAt(doc, ['workloads', at, 'replicas']).comment = REPLICAS;
}

/** The values file's text: short lists and maps on one line, every string quoted, the reasons beside the values. */
function valuesText(plan: Plan): string {
  const doc = new Document(valuesOf(plan));
  for (const [at, workload] of plan.workloads.entries()) styleWorkload(doc, at, workload);
  flowAt(doc, ['secret', 'keys']);
  nodeAt(doc, ['secret', 'existingSecret']).comment = SECRET;
  for (const name of SWITCHES) flowAt(doc, [name]);
  introduce(doc, 'requires', REQUIRES);
  introduce(doc, SWITCHES[0], STANDS_UP);
  return doc.toString({
    lineWidth: 0,
    flowCollectionPadding: false,
    defaultStringType: 'QUOTE_DOUBLE',
    defaultKeyType: 'PLAIN',
  });
}

/**
 * The values of `charts/wilanis-tree` for a plan. Throws every address a Service would not reach, as `compose` does,
 * since the chart puts a Service in front of every port it lists.
 */
export function helmFiles(plan: Plan): Rendered[] {
  const refusals = unreachableOf(plan);
  if (refusals.length) throw new Error(refusals.join('\n\n'));
  return [{ path: 'values.yaml', contents: valuesText(plan) }];
}
