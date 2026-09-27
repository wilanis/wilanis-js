/**
 * What a profile is, read back (RFC 0013): the bindings it chooses, the connections it stands in, and what the
 * tree reaches there -- the effectful operations and the connections they were reached with, what it holds
 * open, what its place permits (RFC 0016), the startup steps it runs, and the variables it needs. `wilanis
 * describe project.json` prints it and the viewer's project page draws it, both from `profilesOf`, so the two
 * never say different things.
 *
 * The reach is grouped by port: operations of one port reached with the same connections share a line, which
 * reads as the contract a reviewer already knows (`@storage/store.port.json#find, #get, #put`) rather than as a
 * list of connections with every operation behind each repeated.
 */
import { type Reach, type ReachedNative, reachOf } from '@wilanis/compiler';
import { type Loaded, type PortDoc, runsUnder, type Scope, splitRef } from '@wilanis/core';

/** Operations of one port the profile reaches with the same connections: the port, the operations, the connections. */
export interface ReachedGroup {
  port: string;
  operations: string[];
  /** The connections those operations were reached with, stand-ins already in place; empty where they name none. */
  connections: string[];
}

/** One variable the profile needs: the variable, the secret key it answers, and who reads it. */
export interface ProfileNeed {
  /** The variable `project.json → secrets` names; nothing where the key is undeclared (C001). */
  variable: string | undefined;
  key: string;
  readBy: string[];
}

/** One profile read back: its choices, as written, and what it reaches, derived by `reachOf`. */
export interface ProfileReach {
  /** Nothing for the unnamed profile of a project that declares none. */
  name: string | undefined;
  default: boolean;
  description?: string;
  binds: { port: string; binding: string }[];
  /** Each connection the documents name and the stand-in this profile reaches in its place. */
  standsIn: { named: string; standIn: string }[];
  reaches: ReachedGroup[];
  holds: ReachedGroup[];
  /**
   * The profile's `permits` as it writes them (RFC 0016), which the checker holds to `reaches` and `holds` in both
   * directions (C021, C022); absent where it writes none, and so permits everything.
   */
  permits?: string[];
  starts: { run: string; label?: string }[];
  needs: ProfileNeed[];
}

/** Every profile the project declares, in its order; the one unnamed profile where it declares none. */
export function profilesOf(scope: Scope): ProfileReach[] {
  const declared = scope.profiles();
  return declared.length ? declared.map(name => profileOf(scope, name)) : [profileOf(scope, undefined)];
}

/** One profile: what it writes, and the reach `reachOf` derives from it. */
function profileOf(scope: Scope, name: string | undefined): ProfileReach {
  const written = name ? scope.project?.profiles?.[name] : undefined;
  const reach = reachOf(scope, name);
  const pairs = (record: Record<string, string> | undefined) => Object.entries(record ?? {});
  return {
    name,
    default: written?.default === true,
    ...(written?.description ? { description: written.description } : {}),
    binds: pairs(written?.bindings).map(([port, binding]) => ({ port, binding })),
    standsIn: pairs(written?.connections).map(([named, standIn]) => ({ named, standIn })),
    reaches: groupsOf(reach.operations.filter(one => !one.holds)),
    holds: groupsOf(reach.operations.filter(one => one.holds)),
    ...(written?.permits ? { permits: written.permits } : {}),
    starts: (scope.project?.startup ?? [])
      .filter(step => runsUnder(step, name))
      .map(step => ({ run: step.run, ...(step.label ? { label: step.label } : {}) })),
    needs: needsOf(reach),
  };
}

/** The sites reached, one entry per operation with every connection it was reached with, grouped by port. */
function groupsOf(sites: ReachedNative[]): ReachedGroup[] {
  const byOp = new Map<string, string[]>();
  for (const site of sites) {
    const connections = byOp.get(site.key) ?? [];
    if (site.connection && !connections.includes(site.connection)) connections.push(site.connection);
    byOp.set(site.key, connections);
  }
  const groups = new Map<string, ReachedGroup>();
  for (const [key, connections] of [...byOp].sort(([one], [other]) => one.localeCompare(other))) {
    const { path, op } = splitRef(key);
    const id = `${path}|${connections.join(',')}`;
    const group = groups.get(id) ?? { port: path, operations: [], connections };
    group.operations.push(op);
    groups.set(id, group);
  }
  return [...groups.values()];
}

/** The secrets the reach reads, one entry per key, with every reader of it. */
function needsOf(reach: Reach): ProfileNeed[] {
  const byKey = new Map<string, ProfileNeed>();
  for (const secret of reach.secrets) {
    const need = byKey.get(secret.key) ?? { variable: secret.variable, key: secret.key, readBy: [] };
    need.readBy.push(secret.readBy);
    byKey.set(secret.key, need);
  }
  return [...byKey.values()].sort((one, other) => (one.variable ?? one.key).localeCompare(other.variable ?? other.key));
}

/** Where a connection stands in for another, or is stood in for, under each profile that says so. */
export interface StandIn {
  role: 'stands in for' | 'replaced by';
  other: string;
  profile: string;
}

/** Every profile's `connections` entry naming this connection, on either side, in the project's order. */
export function standInsOf(scope: Scope, connection: string): StandIn[] {
  return Object.entries(scope.project?.profiles ?? {}).flatMap(([profile, written]) =>
    Object.entries(written.connections ?? {}).flatMap(([named, standIn]): StandIn[] => [
      ...(scope.canon(standIn) === connection ? [{ role: 'stands in for' as const, other: named, profile }] : []),
      ...(scope.canon(named) === connection ? [{ role: 'replaced by' as const, other: standIn, profile }] : []),
    ]),
  );
}

// ---- said -----------------------------------------------------------------------------------------

/** One labelled row: the label padded to one column, the first value beside it, the rest aligned under it. */
function rows(label: string, values: string[], none: string): string[] {
  const [first, ...rest] = values.length ? values : [none];
  return [`  ${label.padEnd(10)} ${first}`, ...rest.map(value => `  ${''.padEnd(10)} ${value}`)];
}

/** One group of a port's operations, and the connections they were reached with where they name any. */
export function groupSaid(group: ReachedGroup): string {
  const ops = group.operations.map((op, index) => (index ? `#${op}` : `${group.port}#${op}`)).join(', ');
  return group.connections.length ? `${ops}  via ${group.connections.join(', ')}` : ops;
}

/** A count and the noun it counts, plural where the count is not one. */
const counted = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/**
 * What a profile permits, said against the reach printed above it: `the 19 operations and 3 connections above, by
 * 13 entries`. The checker holds the list to that reach in both directions (C021, C022), so the block counts what
 * the entries cover rather than showing a difference, which is `wilanis check`'s to say; a profile that writes no
 * `permits` permits everything.
 */
export function permitsSaid(profile: ProfileReach): string {
  if (!profile.permits) return 'everything (no permits)';
  const reached = [...profile.reaches, ...profile.holds];
  const operations = reached.reduce((sum, group) => sum + group.operations.length, 0);
  const connections = new Set(reached.flatMap(group => group.connections)).size;
  const entries = counted(profile.permits.length, 'entry', 'entries');
  return `the ${counted(operations, 'operation')} and ${counted(connections, 'connection')} above, by ${entries}`;
}

/** One need: the variable, the key it answers and who reads it; a key no variable answers says so. */
export function needSaid(need: ProfileNeed): string {
  const readers = `read by ${need.readBy.join(', ')}`;
  return need.variable
    ? `${need.variable} (${need.key}, ${readers})`
    : `{{secrets.${need.key}}} (undeclared, ${readers})`;
}

/** The first line of one profile's block: its name, `(default)` where it is, and what it says of itself. */
export function profileHeading(profile: ProfileReach): string {
  if (profile.name === undefined) return 'profile  none declared: each port is met by its one binding';
  const marked = profile.default ? '  (default)' : '';
  return `profile ${profile.name}${marked}${profile.description ? `  -- ${profile.description}` : ''}`;
}

/** One profile's block, as `wilanis describe project.json` prints it. */
export function profileBlock(profile: ProfileReach): string[] {
  const starts = profile.starts.map(step => step.label ?? step.run);
  return [
    profileHeading(profile),
    ...rows(
      'binds',
      profile.binds.map(one => `${one.port}  → ${one.binding}`),
      "each port's one binding",
    ),
    ...(profile.standsIn.length
      ? rows(
          'stands in',
          profile.standsIn.map(one => `${one.named}  → ${one.standIn}`),
          '',
        )
      : []),
    ...rows('reaches', profile.reaches.map(groupSaid), 'nothing effectful'),
    ...rows('holds', profile.holds.map(groupSaid), 'nothing open'),
    ...rows('permits', [permitsSaid(profile)], ''),
    ...rows('starts', starts.length ? [starts.join(' · ')] : [], 'nothing'),
    ...rows('needs', profile.needs.map(needSaid), 'no variable'),
  ];
}

/** Every profile's block, a blank line before each. */
export function profilesLines(scope: Scope): string[] {
  return profilesOf(scope).flatMap(profile => ['', ...profileBlock(profile)]);
}

/** A connection's stand-ins, a line each: what it stands in for, or what replaces it, and under which profile. */
export function standInLines(scope: Scope, connection: string): string[] {
  return standInsOf(scope, connection).map(one => `${one.role} ${one.other} under ${one.profile}`);
}

/** Whether a profile's `permits` may name a document at all (C023): a connection, or a native port with an effectful operation. */
function permittable(doc: Loaded): boolean {
  if (doc.kind === 'connection') return true;
  if (doc.kind !== 'port' || !doc.native) return false;
  return Object.values((doc.doc as PortDoc).operations).some(op => op.pure !== true);
}

/** How one profile's entries name a document: the profile, with the operations it names where none names the port whole. */
function permitterSaid(scope: Scope, path: string, profile: string, entries: string[]): string[] {
  const naming = entries.filter(entry => scope.canon(entry.split('#')[0]) === path);
  if (!naming.length) return [];
  const operations = naming.filter(entry => entry.includes('#')).map(entry => `#${splitRef(entry).op}`);
  return [operations.length < naming.length ? profile : `${profile} (${operations.join(', ')})`];
}

/**
 * Who permits a native port or a connection (RFC 0016): `permitted by  production (#ensure)`, every profile whose
 * `permits` names the document or one of its operations, in the project's order. A profile that writes no
 * `permits` permits everything and is not named, since its block in `describe project.json` says so once; so a
 * tree none of whose profiles writes one prints no line, and where one does and none names the document the line
 * says that, which is what a reader about to reach it needs to know.
 */
export function permittedLines(scope: Scope, doc: Loaded): string[] {
  if (!permittable(doc)) return [];
  const writing = Object.entries(scope.project?.profiles ?? {}).filter(([, profile]) => profile.permits);
  if (!writing.length) return [];
  const named = writing.flatMap(([name, profile]) => permitterSaid(scope, doc.path, name, profile.permits ?? []));
  return [`permitted by  ${named.length ? named.join(', ') : 'no profile that writes permits'}`];
}
