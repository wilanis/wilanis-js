/**
 * A profile's choices as `Scope.profile` resolves them (RFC 0043), read back for a reader: each binding and stand-in
 * spelled as the line that writes it, marked with the parent where the line is the parent's, and what a `permits`
 * list permits under the profile, read as the checker reads it. `describe`, the viewer and the manifest all read a
 * profile here, so none of them can say a child inherits something the checker does not hold it to.
 */
import { reachOf } from '@wilanis/compiler';
import type { ResolvedProfile, Scope } from '@wilanis/core';

/** One choice as written: what the documents name, what the profile puts in its place, and the parent it came from. */
export interface Choice {
  named: string;
  chosen: string;
  /** The profile the choice is taken from; absent where the profile writes it itself. */
  from?: string;
}

/**
 * A profile's bindings or stand-ins as resolved, each spelled as the line that writes it: its own first, then each
 * it takes from the parent, marked with the parent's name. Nothing for the unnamed profile.
 */
export function choicesOf(scope: Scope, name: string | undefined, which: 'bindings' | 'connections'): Choice[] {
  const declared = scope.project?.profiles ?? {};
  const resolved = name ? scope.profile(name) : undefined;
  if (!name || !resolved) return [];
  const own = Object.entries(declared[name][which] ?? {}).map(([named, chosen]) => ({ named, chosen }));
  const parent = resolved.extends;
  if (parent === undefined) return own;
  // the parent's lines that resolution kept, the first of two that name one document through two aliases
  const kept = new Set(resolved.inherited[which]);
  const taken = Object.entries(declared[parent][which] ?? {}).filter(([named]) => kept.delete(scope.canon(named)));
  return [...own, ...taken.map(([named, chosen]) => ({ named, chosen, from: parent }))];
}

/**
 * What a resolved profile's `permits` permits, entry by entry: its own list as written; an inherited list as the
 * checker reads it, an entry naming what the parent reaches for a connection the child stands in for giving the
 * child's stand-ins, and its own connection only where `reached` (the profile's `reach.connections`) still holds it.
 * Absent where the profile has no list, and so permits everything.
 */
export function permitsRead(
  scope: Scope,
  profile: ResolvedProfile | undefined,
  reached: string[],
): string[] | undefined {
  if (!profile?.permits) return undefined;
  const read = profile.permits.flatMap(entry => {
    const standIns = profile.alsoPermits[entry];
    if (!standIns) return [entry];
    return reached.includes(scope.canon(entry)) ? [entry, ...standIns] : standIns;
  });
  return [...new Set(read)];
}

/** What one declared profile's `permits` permits, walking its reach only where an inherited entry carries a stand-in. */
export function permitsOfProfile(scope: Scope, name: string): string[] | undefined {
  const resolved = scope.profile(name);
  const carries = Object.keys(resolved?.alsoPermits ?? {}).length > 0;
  return permitsRead(scope, resolved, carries ? reachOf(scope, name).connections : []);
}
