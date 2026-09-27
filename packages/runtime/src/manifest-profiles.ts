/**
 * The per-profile half of the manifest (RFC 0026): one block per profile the tree is judged under, each what the
 * profile writes (its bindings and stand-ins, canonical on both sides) beside what `reachOf` derives from it (the
 * effects reached and the connections they were reached with, what is held open, the startup steps that run there
 * and the variables read), what `listensOf` reads off the steps that run there (the addresses listened on), and
 * what RFC 0016 has the profile permit. It reads the Scope and never the environment: which profile a process would
 * pick is `activeProfile`'s question, and the manifest describes the tree, not the process.
 */
import { profilesOf, type Reach, reachOf } from '@wilanis/compiler';
import { runsUnder, type Scope } from '@wilanis/core';
import { type ListenRow, listensOf } from './manifest-listens.js';
import { sorted, sortedBy } from './manifest-rows.js';
import { declaredProfile } from './profile.js';

/** One effectful native operation a profile reaches, and every connection it was reached with. */
export interface ReachRow {
  operation: string;
  via: string[];
}
/** One variable a profile needs: the secret key it answers, and everyone who reads it. */
export interface NeedRow {
  variable: string;
  key: string;
  readBy: string[];
}
/** One profile: what it chooses and permits, and what the tree reaches, holds, listens on, starts and needs under it. */
export interface ProfileBlock {
  default: boolean;
  description: string | null;
  bindings: Record<string, string>;
  connections: Record<string, string>;
  reaches: ReachRow[];
  holds: string[];
  listens: ListenRow[];
  starts: (string | null)[];
  needs: NeedRow[];
  /** What the profile permits (RFC 0016), canonical and sorted; null where it writes no `permits`, so everything. */
  permits: string[] | null;
}

/** The key the unnamed profile of a tree that declares none is written under: JSON has no key for nothing. */
export const UNNAMED = '';

/** A profile's map as written, canonical on both sides and by key. */
function canonMap(scope: Scope, written: Record<string, string> | undefined): Record<string, string> {
  const pairs = Object.entries(written ?? {}).map(([from, to]) => [scope.canon(from), scope.canon(to)] as const);
  return Object.fromEntries(sortedBy([...pairs], ([from]) => from));
}

/**
 * What a profile's `permits` names, each entry canonical, by entry: an operation as path#operation, a whole port or a
 * connection as its path. Null where the profile writes none, which permits everything (RFC 0016); the checker holds
 * a list that is written to what the profile reaches, in both directions (C021, C022).
 */
function permitsOf(scope: Scope, written: string[] | undefined): string[] | null {
  return written ? sorted(written.map(entry => scope.canon(entry))) : null;
}

/** Every effectful operation reached, once, by operation, with the connections its sites named, sorted. */
function reachRows(reach: Reach): ReachRow[] {
  const byOp = new Map<string, string[]>();
  for (const site of reach.operations) {
    const via = byOp.get(site.key) ?? [];
    if (site.connection) via.push(site.connection);
    byOp.set(site.key, via);
  }
  return sorted(byOp.keys()).map(operation => ({ operation, via: sorted(byOp.get(operation) ?? []) }));
}

/**
 * Every variable the reach reads, once per secret key, by variable and then key, with its readers sorted. A key no
 * variable answers is left out: the checker refuses it (C001, B007), and the manifest is only ever of a tree the
 * checker accepted.
 */
function needRows(reach: Reach): NeedRow[] {
  const byKey = new Map<string, NeedRow>();
  for (const { key, variable, readBy } of reach.secrets) {
    if (variable === undefined) continue;
    const need = byKey.get(key) ?? { variable, key, readBy: [] };
    need.readBy.push(readBy);
    byKey.set(key, need);
  }
  const rows = [...byKey.values()].map(need => ({ ...need, readBy: sorted(need.readBy) }));
  return sortedBy(
    sortedBy(rows, need => need.key),
    need => need.variable,
  );
}

/** One profile's block; the unnamed one is the default, since a start that names no profile runs it. */
function profileBlock(scope: Scope, name: string | undefined): ProfileBlock {
  const written = name === undefined ? undefined : scope.project?.profiles?.[name];
  const reach = reachOf(scope, name);
  return {
    default: name === undefined || written?.default === true,
    description: written?.description ?? null,
    bindings: canonMap(scope, written?.bindings),
    connections: canonMap(scope, written?.connections),
    reaches: reachRows(reach),
    holds: sorted(reach.holds),
    listens: listensOf(scope, name),
    starts: (scope.project?.startup ?? []).filter(step => runsUnder(step, name)).map(step => step.label ?? null),
    needs: needRows(reach),
    permits: permitsOf(scope, written?.permits),
  };
}

/**
 * Every profile the tree is judged under, by name, the unnamed one under `""`; or the one `only` names, which
 * throws RFC 0013's message where the project declares no such profile.
 */
export function profileBlocks(scope: Scope, only?: string): Record<string, ProfileBlock> {
  const names = only === undefined ? profilesOf(scope) : [declaredProfile(scope.project, only)];
  const keyed = names.map(name => [name ?? UNNAMED, name] as const);
  return Object.fromEntries(
    sortedBy([...keyed], ([key]) => key).map(([key, name]) => [key, profileBlock(scope, name)]),
  );
}
