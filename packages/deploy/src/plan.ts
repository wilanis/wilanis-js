/**
 * The plan (RFC 0024): what one deployment of one tree is, derived from the tree's manifest (RFC 0026) and from
 * nothing else. `planOf` is pure over a manifest object: it never loads a tree and never reads the environment or
 * the clock, so a manifest another tool printed plans as one `manifestOf` answered. Every array it answers is sorted
 * by its own keys, so a manifest plans to the same bytes whatever order its arrays were written in. A target is a
 * renderer from a plan, and asks the tree for nothing more.
 */
import type { Manifest } from '@wilanis/runtime';
import { byUnits, sorted } from './order.js';
import { refusalsOf } from './refusals.js';

/** One profile's block of a manifest. */
type ProfileBlock = Manifest['profiles'][string];

/** Where the plan's JSON Schema is published, beside the package that prints it. */
export const PLAN_SCHEMA =
  'https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/deploy/schemas/plan.schema.json';

/** Where the image is built from and the file that builds it, relative to the tree's root. */
const BUILT = { context: '.', dockerfile: 'deploy/Dockerfile' };

/** The one image every workload runs: where it is built from, and the reference it is tagged with. */
export interface PlanImage {
  context: string;
  dockerfile: string;
  reference: string;
}
/** One address a workload listens on. The port is always a number: a plan refuses an address whose port is not. */
export interface PlanListen {
  operation: string;
  host: string | null;
  port: number;
}
/** One variable a workload needs, by name: the secret key it answers, and who reads it. */
export interface PlanNeed {
  variable: string;
  key: string;
  readBy: string[];
}
/** How a workload is known to be up: its first listened port accepting a connection. */
export interface PlanProbe {
  tcp: number;
}
/** One profile's process: how it starts, what it listens on and holds open, what it needs, and how it is probed. */
export interface Workload {
  profile: string;
  description: string | null;
  command: string[];
  listens: PlanListen[];
  holds: string[];
  needs: PlanNeed[];
  replicas: 1;
  probe: PlanProbe | null;
}
/** One thing the environment must provide: a connection an asked profile reaches whose kind names an endpoint. */
export interface Requirement {
  connection: string;
  kind: string;
  endpoint: string;
  reachedBy: string[];
}
/** What one deployment of one tree is: the image, one workload per profile, and what the environment provides. */
export interface Plan {
  format: 1;
  name: string;
  node: string | null;
  image: PlanImage;
  workloads: Workload[];
  requires: Requirement[];
}
/** What the command supplies, as `manifestOf` is given its root: the profiles asked for, and the image's reference. */
export interface PlanOptions {
  profiles: string[];
  image: string;
}

/** The command a profile's process starts with; the unnamed profile, keyed `""`, is started naming none. */
export const commandOf = (profile: string): string[] =>
  profile === '' ? ['wilanis', 'start', '.'] : ['wilanis', 'start', '.', '--profile', profile];

/** Which of two addresses comes first: by operation, then port, then host, the unwritten host first. */
function byAddress(one: PlanListen, other: PlanListen): number {
  return byUnits(one.operation, other.operation) || one.port - other.port || byUnits(one.host ?? '', other.host ?? '');
}

/** A block's addresses, each with its port; `refusalsOf` has already refused one whose port is not fixed. */
function listensOf(block: ProfileBlock): PlanListen[] {
  const fixed = block.listens.flatMap(({ operation, host, port }) =>
    port === null ? [] : [{ operation, host, port }],
  );
  return fixed.sort(byAddress);
}

/** A block's variables, by variable and then key, each with its readers sorted. */
function needsOf(block: ProfileBlock): PlanNeed[] {
  const needs = block.needs.map(({ variable, key, readBy }) => ({ variable, key, readBy: sorted(readBy) }));
  return needs.sort((one, other) => byUnits(one.variable, other.variable) || byUnits(one.key, other.key));
}

/** One profile's workload: one replica, and a probe on the first port it listens on, where it listens on one. */
function workloadOf(profile: string, block: ProfileBlock): Workload {
  const listens = listensOf(block);
  const first = listens[0];
  return {
    profile,
    description: block.description,
    command: commandOf(profile),
    listens,
    holds: sorted(block.holds),
    needs: needsOf(block),
    replicas: 1,
    probe: first ? { tcp: first.port } : null,
  };
}

/** Every connection reached under the profiles whose kind names an endpoint, by path, with who reaches it. */
function requiresOf(manifest: Manifest, blocks: [string, ProfileBlock][]): Requirement[] {
  const reachers = new Map<string, string[]>();
  for (const [profile, block] of blocks) {
    for (const connection of sorted(block.reaches.flatMap(reach => reach.via))) {
      reachers.set(connection, [...(reachers.get(connection) ?? []), profile]);
    }
  }
  const required = manifest.connections.flatMap(({ path, kind, endpoint }) => {
    const reachedBy = reachers.get(path);
    return endpoint === null || !reachedBy ? [] : [{ connection: path, kind, endpoint, reachedBy: sorted(reachedBy) }];
  });
  return required.sort((one, other) => byUnits(one.connection, other.connection));
}

/**
 * The plan of the profiles asked for, from a manifest alone: one workload per profile, by name, and every connection
 * they reach whose kind names an endpoint. Throws every refusal at once, each a message and its hint, where a profile
 * is not in the manifest, holds nothing, or listens on a port the tree does not fix.
 */
export function planOf(manifest: Manifest, options: PlanOptions): Plan {
  const profiles = sorted(options.profiles);
  const refusals = refusalsOf(manifest, profiles);
  if (refusals.length) throw new Error(refusals.join('\n\n'));
  const blocks = profiles.map(profile => [profile, manifest.profiles[profile]] as [string, ProfileBlock]);
  return {
    format: 1,
    name: manifest.name,
    node: manifest.node,
    image: { ...BUILT, reference: options.image },
    workloads: blocks.map(([profile, block]) => workloadOf(profile, block)),
    requires: requiresOf(manifest, blocks),
  };
}

/** The plan as `--target plan` prints it: two-space JSON and a newline, as the manifest is printed. */
export const planText = (plan: Plan): string => `${JSON.stringify(plan, null, 2)}\n`;
