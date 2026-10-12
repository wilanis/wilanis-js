/**
 * What a profile means (RFC 0043): the profile as written, or, for a child that names a parent under `extends`, the
 * parent's choices with the child's own written over them. Every reader of a profile's choices reads it here,
 * through `Scope.profile`, so no two readers can differ about what a child inherits.
 */

import type { ProfileDoc } from './model.js';

/** What a resolved profile took from its parent, so a reader can say where each choice came from. */
export interface Inherited {
  /** The canonical port paths whose binding is the parent's. */
  bindings: string[];
  /** The canonical connection paths whose stand-in is the parent's. */
  connections: string[];
  /** Whether the permits list is the parent's whole, the child writing none. */
  permits: boolean;
}

/** A profile as every reader reads it: its choices keyed by canonical path, and what of them came from the parent. */
export interface ResolvedProfile {
  description?: string;
  default?: boolean;
  /** The parent resolution followed; absent where the profile extends nothing, or names no declared profile but itself. */
  extends?: string;
  /** The binding that meets each domain port, by the port's canonical path. */
  bindings: Record<string, string>;
  /** The stand-in for each connection, by the replaced connection's canonical path. */
  connections: Record<string, string>;
  /** What the place permits; absent: everything. */
  permits?: string[];
  /**
   * For an inherited list: each entry naming what the parent reaches for a connection the child stands in for, with
   * the child's stand-ins (canonical) it permits always. It permits its own connection only where the child still
   * reaches that another way, which is the reach's to say and the checker's to judge.
   */
  alsoPermits: Record<string, string[]>;
  inherited: Inherited;
}

type Canon = (ref: string) => string;

/** A map of written paths keyed by their canonical path; where two keys meet, the first written wins. */
function keyed(written: Record<string, string> | undefined, canon: Canon): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [ref, value] of Object.entries(written ?? {})) {
    const key = canon(ref);
    if (!Object.hasOwn(out, key)) out[key] = value;
  }
  return out;
}

/** The profile a child names under `extends`, where it is declared and is not the child; never followed further. */
function parentOf(profiles: Record<string, ProfileDoc>, name: string): ProfileDoc | undefined {
  const parent = profiles[name].extends;
  if (parent === undefined || parent === name || !Object.hasOwn(profiles, parent)) return undefined;
  return profiles[parent];
}

/**
 * The stand-ins each of the parent's permits also permits under the child: an entry naming what the parent reaches
 * for a connection the child stands in for -- the parent's stand-in for it, else the connection itself.
 */
function carried(parent: ProfileDoc, own: Record<string, string>, canon: Canon): Record<string, string[]> {
  const parentConnections = keyed(parent.connections, canon);
  const out: Record<string, string[]> = {};
  for (const [replaced, standIn] of Object.entries(own)) {
    const reached = Object.hasOwn(parentConnections, replaced) ? canon(parentConnections[replaced]) : replaced;
    const target = canon(standIn);
    if (target === reached) continue;
    for (const entry of entriesNaming(parent.permits, reached, canon)) out[entry] = [...(out[entry] ?? []), target];
  }
  return out;
}

/** The entries of a permits list that name one connection, as written; an operation entry names none. */
function entriesNaming(permits: string[] | undefined, connection: string, canon: Canon): string[] {
  return (permits ?? []).filter(entry => !entry.includes('#') && canon(entry) === connection);
}

/** The child's own map written over the parent's, and the keys that stayed the parent's. */
function over(parent: Record<string, string>, own: Record<string, string>): [Record<string, string>, string[]] {
  return [{ ...parent, ...own }, Object.keys(parent).filter(key => !Object.hasOwn(own, key))];
}

/** A child's choices: the parent's bindings and stand-ins under its own, and the parent's permits where it writes none. */
function inherit(resolved: ResolvedProfile, parent: ProfileDoc, child: ProfileDoc, canon: Canon): ResolvedProfile {
  const [bindings, keptBindings] = over(keyed(parent.bindings, canon), resolved.bindings);
  const [connections, keptConnections] = over(keyed(parent.connections, canon), resolved.connections);
  const permitsInherited = child.permits === undefined && parent.permits !== undefined;
  return {
    ...resolved,
    bindings,
    connections,
    ...(permitsInherited && { permits: parent.permits }),
    alsoPermits: permitsInherited ? carried(parent, resolved.connections, canon) : {},
    inherited: { bindings: keptBindings, connections: keptConnections, permits: permitsInherited },
  };
}

/**
 * What the profile `name` means, or nothing where the project declares no such profile. Pure and total: a parent
 * that is not declared, or is the profile itself, resolves as no `extends`; a parent that extends another resolves
 * as it is written. So resolution follows one step at most and never loops; the checker refuses the wrong `extends`.
 */
export function resolveProfile(
  profiles: Record<string, ProfileDoc> | undefined,
  name: string,
  canon: Canon,
): ResolvedProfile | undefined {
  if (!profiles || !Object.hasOwn(profiles, name)) return undefined;
  const child = profiles[name];
  const resolved: ResolvedProfile = {
    ...(child.description !== undefined && { description: child.description }),
    ...(child.default !== undefined && { default: child.default }),
    bindings: keyed(child.bindings, canon),
    connections: keyed(child.connections, canon),
    ...(child.permits !== undefined && { permits: child.permits }),
    alsoPermits: {},
    inherited: { bindings: [], connections: [], permits: false },
  };
  const parent = parentOf(profiles, name);
  if (!parent) return resolved;
  return inherit({ ...resolved, extends: child.extends }, parent, child, canon);
}
