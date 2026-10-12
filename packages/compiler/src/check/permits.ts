/**
 * What a place permits (RFC 0016): a profile's `permits` held to what the profile reaches (`reachOf`, RFC 0013),
 * in both directions. An operation or a connection the profile reaches and no entry permits is C021; an entry
 * that permits nothing the profile reaches is C022; an entry that is no permit at all -- a domain port or one of
 * its operations, a pure operation, a port with nothing effectful, a connection the profile replaces -- is C023;
 * and an entry that names nothing is R001. A profile without `permits` permits everything and is not judged.
 *
 * A profile is judged as resolved (RFC 0043): a child that writes no `permits` is held to its parent's list. An
 * inherited entry naming what the parent reaches for a connection the child stands in for permits the stand-in,
 * and its own connection where the child still reaches it. Whether an entry names anything (R001) or is a permit
 * at all (C023) is a fact about the entry, refused once at the parent's line; under the child such an entry
 * permits nothing and is refused nothing. A refusal about an inherited list points at the child's `extends`.
 */
import { type Loaded, type PortDoc, type ResolvedProfile, splitRef } from '@wilanis/core';
import { type Reach, type ReachedNative, type Root, reachOf } from '../reach.js';
import type { Judge } from './judge.js';

/** One entry of `permits` that permits something: an operation, every operation of a port, or a connection. */
interface Permit {
  kind: 'operation' | 'port' | 'connection';
  /** The canonical `path#operation`, or the canonical path of the port or connection. */
  path: string;
  /**
   * For an inherited entry naming what the parent reaches for a connection the child stands in for: the child's
   * stand-ins (canonical), which it permits always. Empty for every other entry.
   */
  standIns: string[];
  /** The entry as the profile writes it, and where. */
  entry: string;
  index: number;
}

/** Where one profile's permits are judged: the profile as resolved, its name, and the parent it inherits its list from. */
interface Judging {
  judge: Judge;
  name: string;
  profile: ResolvedProfile;
  /** The profile whose list this is, where the profile writes none and inherits it whole; else nothing. */
  parent: string | undefined;
}

const MISUSED =
  'permits lists effectful native operations and connections; a domain port is met by a binding, a pure operation needs no permit, a replaced connection is named by its stand-in';

/** C021, C022, C023, R001: what one resolved profile permits against what it reaches, where it has a `permits` list. */
export function checkPermits(judge: Judge, name: string, profile: ResolvedProfile): void {
  if (!profile.permits) return;
  const parent = profile.inherited.permits ? profile.extends : undefined;
  const judging: Judging = { judge, name, profile, parent };
  const permits = profile.permits.flatMap((entry, index) => readPermit(judging, entry, index) ?? []);
  const reach = reachOf(judge.scope, name);
  checkReached(judging, reach, permits);
  checkDead(judging, reach, permits);
}

/** What an entry names, read: what it permits, or the refusal it earns and why. */
type Read = Pick<Permit, 'kind' | 'path'> | { code: 'R001' | 'C023'; why: string; hint: string };

/** An entry that names nothing the tree has (R001). */
const unknown = (why: string, hint: string): Read => ({ code: 'R001', why, hint });

/** An entry that names something no permit may name (C023). */
const misused = (why: string): Read => ({ code: 'C023', why, hint: MISUSED });

/**
 * What one entry permits, or nothing where it names nothing (R001) or nothing a permit may name (C023). An
 * inherited entry that is no permit is refused under the parent, at its line, and not again here.
 */
function readPermit(judging: Judging, entry: string, index: number): Permit | undefined {
  const { judge, name, profile, parent } = judging;
  const read = entry.includes('#') ? operationPermit(judging, entry) : pathPermit(judging, entry);
  if ('path' in read) return { ...read, standIns: profile.alsoPermits[entry] ?? [], entry, index };
  if (parent !== undefined) return undefined;
  const at = `profiles/${name}/permits/${index}`;
  judge.refuser(judge.project.path)(read.code, `profile '${name}' permits '${entry}', ${read.why}`, at, read.hint);
  return undefined;
}

/** An entry `path#operation`: an effectful operation of a native port. */
function operationPermit({ judge }: Judging, entry: string): Read {
  const hit = judge.scope.op(entry);
  if (typeof hit === 'string') return unknown(`which names nothing: ${hit}`, 'wilanis ls port');
  if (!hit.port.native) return misused(`which is an operation of ${domainPort(hit.port)}`);
  if (hit.op.pure === true) return misused('which is pure: running it reaches nothing outside the run');
  return { kind: 'operation', path: `${hit.path}#${hit.opName}` };
}

/**
 * An entry `path`: a native port with an effectful operation, or a connection the profile does not replace. An
 * inherited entry is read as the parent reads it, so it is refused, or not, once.
 */
function pathPermit({ judge, profile, parent }: Judging, entry: string): Read {
  const port = judge.scope.get('port', entry);
  if (port) {
    if (!port.native) return misused(`which is ${domainPort(port)}`);
    const effectful = Object.values(port.doc.operations).some(op => op.pure !== true);
    return effectful ? { kind: 'port', path: port.path } : misused('which is a port with no effectful operation');
  }
  const connection = judge.scope.get('connection', entry);
  if (!connection) return unknown('which names no port and no connection', 'wilanis ls port; wilanis ls connection');
  const replacedBy = (parent === undefined ? profile : judge.scope.profile(parent))?.connections[connection.path];
  if (replacedBy)
    return misused(`which this profile replaces with '${replacedBy}': the tree reaches the stand-in, not it`);
  return { kind: 'connection', path: connection.path };
}

/** How a message says a port is a domain port: a binding meets it, whether the tree's or one a plugin requires. */
function domainPort(port: Loaded<PortDoc>): string {
  const required = port.requiredBy ? ` ${port.requiredBy} requires` : '';
  return `a domain port${required}: a binding meets it, and what the binding reaches is what needs a permit`;
}

/** C021: every operation and every connection the profile reaches is one some entry permits. */
function checkReached(judging: Judging, reach: Reach, permits: Permit[]): void {
  const sitesOf = new Map<string, ReachedNative[]>();
  for (const site of reach.operations) sitesOf.set(site.key, [...(sitesOf.get(site.key) ?? []), site]);
  for (const [key, sites] of sitesOf) if (!permitsOperation(permits, key)) refuseReached(judging, key, sites);
  for (const connection of reach.connections) {
    if (permits.some(permit => permit.kind === 'connection' && permitted(permit).includes(connection))) continue;
    refuseReached(
      judging,
      connection,
      reach.operations.filter(site => site.connection === connection),
    );
  }
}

/** The connections a connection entry permits where the profile reaches them: its own, and the stand-ins it carries. */
const permitted = (permit: Permit): string[] => [permit.path, ...permit.standIns];

/** Whether an entry permits an operation: the operation itself, or its port whole. */
function permitsOperation(permits: Permit[], key: string): boolean {
  const port = splitRef(key).path;
  return permits.some(
    permit => (permit.kind === 'operation' && permit.path === key) || (permit.kind === 'port' && permit.path === port),
  );
}

/** One C021: what is reached, from the first root found (and how many more), through which binding, in which feature. */
function refuseReached({ judge, name, parent }: Judging, reached: string, sites: ReachedNative[]): void {
  const [first] = sites;
  if (!first) return;
  const roots = new Set(sites.map(site => rootKey(site.root)));
  const more = roots.size > 1 ? ` (and ${roots.size - 1} more)` : '';
  const through = first.binding ? ` through ${first.binding}` : '';
  const home = rootHome(judge, first.root);
  const included = home?.included ? `, included from ${home.included}` : '';
  const feature = home?.feature ? ` (feature ${home.feature}${included})` : '';
  const inherited = parent === undefined ? '' : ` (permits inherited from '${parent}')`;
  const message = `profile '${name}' does not permit '${reached}', reached from ${rootSaid(first.root)}${more}${through}${feature}${inherited}`;
  const remove = home?.included ? 'remove the feature from includes[].features' : 'remove the node that reaches it';
  const add = parent === undefined ? `add "${reached}" to profiles/${name}/permits` : replaceWhole(name, parent);
  const hint = `${remove}, or bind the port to a binding that does not; else, if ${name} may, ${add}`;
  const at = parent === undefined ? `profiles/${name}/permits` : `profiles/${name}/extends`;
  judge.refuser(judge.project.path)('C021', message, at, hint);
}

/** What a refusal about an inherited list says to write: a list of the child's own, which replaces the parent's. */
const replaceWhole = (name: string, parent: string) =>
  `write profiles/${name}/permits: a list it writes replaces ${parent}'s whole`;

/** A root, told apart from every other: its kind, its document and what it runs. */
const rootKey = (root: Root) => `${root.kind} ${root.file} ${root.run}`;

/** How a message names a root: the trigger or policy, the startup step by what it runs, or the requiring plugin. */
function rootSaid(root: Root): string {
  if (root.kind === 'trigger') return root.file;
  if (root.kind === 'policy') return `policy ${root.file}`;
  if (root.kind === 'startup') return `the startup step running ${root.run}`;
  return `${root.run}, which ${root.file.replace(/\/plugin\.json$/, '')} requires`;
}

/** The document a trigger or policy root is written in, for the feature it sits in and the package it came from. */
function rootHome(judge: Judge, root: Root): Loaded | undefined {
  if (root.kind !== 'trigger' && root.kind !== 'policy') return undefined;
  return judge.scope.registry.any(root.file);
}

/**
 * C022: every entry permits something the profile reaches, so the list is never wider than the tree. An entry
 * carrying stand-ins is refused only where the profile reaches neither its own connection nor any of them.
 */
function checkDead(judging: Judging, reach: Reach, permits: Permit[]): void {
  const keys = new Set(reach.operations.map(site => site.key));
  const ports = new Set([...keys].map(key => splitRef(key).path));
  const unreached: Record<Permit['kind'], (permit: Permit) => string | undefined> = {
    operation: ({ path }) => (keys.has(path) ? undefined : 'nothing it reaches runs it'),
    port: ({ path }) => (ports.has(path) ? undefined : 'nothing it reaches runs an operation of that port'),
    connection: permit =>
      permitted(permit).some(one => reach.connections.includes(one)) ? undefined : unnamed(permit),
  };
  for (const permit of permits) {
    const why = unreached[permit.kind](permit);
    if (why) refuseDead(judging, permit, why);
  }
}

/** Why a connection entry permits nothing: no reached operation names it, nor a stand-in it carries. */
function unnamed({ standIns }: Permit): string {
  const also = standIns.map(one => `'${one}'`).join(', ');
  return `no operation it reaches names that connection${also && `, nor ${also}, which this profile reaches in its place`}`;
}

/** One C022: at the entry's line, or, for an inherited list, at the child's `extends`, saying where the entry came from. */
function refuseDead({ judge, name, parent }: Judging, permit: Permit, why: string): void {
  const refuse = judge.refuser(judge.project.path);
  if (parent === undefined) {
    const at = `profiles/${name}/permits/${permit.index}`;
    refuse(
      'C022',
      `profile '${name}' permits '${permit.entry}', but ${why}`,
      at,
      `remove it from profiles/${name}/permits`,
    );
    return;
  }
  const message = `profile '${name}' inherits '${permit.entry}' from '${parent}', but ${why}`;
  refuse('C022', message, `profiles/${name}/extends`, replaceWhole(name, parent));
}
