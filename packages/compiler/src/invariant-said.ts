/**
 * What a reader is told about an access invariant: every trigger that reaches an operation it gates, how the
 * operation was reached, and which attached policy meets each part of `requires`. `wilanis describe`, `wilanis
 * map` and the viewer all ask this, so all three say the same thing and none of them re-derives it.
 *
 * Nothing here judges. `checkInvariantSites` in `check/invariants.ts` has already refused a trigger that does
 * not meet the rule (I001); this answers the same question with the same rule so that what a reader is shown
 * and what the tree was held to cannot drift apart. `requires` is met the way `TriggerGate.unmet` reads it --
 * the named policy *and* every path proved, never either -- because a page that says "satisfied" where
 * `wilanis check` refuses I001 is worse than a page that says nothing.
 *
 * It parts from the checker in two places, both on purpose and both because a reader wants more than a refusal
 * does. The checker stops at the first trigger and the first covered operation, since one is enough to refuse;
 * a reader has opened the invariant and is owed every way in, so the walk here collects. And where the checker
 * is deliberately silent -- `requires.policy` naming a policy the tree does not have (R001 against the
 * invariant), a `proves` path the guard cannot hand (I002 against the invariant) -- the trigger is reported
 * `unjudged` rather than unmet, so that no consumer sends a reader to an I001 that was never emitted.
 */
import type { AccessInvariant, InvariantDoc, Loaded, PolicyDoc, Scope, TriggerDoc } from '@wilanis/core';
import { policyPath, splitRef } from '@wilanis/core';
import { provesFaultIn } from './check/access.js';
import { atOrBelow } from './check/typing.js';
import { profilesWalking } from './reach.js';
import { operationsReachable } from './refusals.js';

/** One way `requires` is met at one trigger: the policy that meets it, and the path it proved where that is why. */
export interface Met {
  /** The canonical path of the attached policy that satisfies this part of `requires`. */
  policy: string;
  /** That policy's own label, for a reader shown names rather than paths; nothing where it declares none. */
  label: string | undefined;
  /** The `requires.proves` path this policy proves; nothing where it is the policy `requires.policy` names. */
  proves: string | undefined;
}

/** One operation an access invariant gates, as its own document writes it: what a table of them shows. */
export interface Covered {
  /** The canonical `path#operation`, as a reaching way names it. */
  op: string;
  /** The operation's own name, the part after the `#`. */
  opName: string;
  /** The canonical path of the port it belongs to. */
  port: string;
  /** That port's label; nothing where it declares none, or where the tree does not have the port (R001). */
  portLabel: string | undefined;
}

/**
 * One way in an access invariant constrains: one trigger reaching one covered operation, and how the rule is
 * met there. A trigger reaching several covered operations yields one of these per operation, in the order
 * `over` writes them, so a consumer that wants one row per trigger dedupes on `trigger` and one that wants the
 * whole table has it. Collecting more than is printed is cheap; the reverse cannot be done at all.
 */
export interface ReachedWay {
  /** The trigger's canonical path. */
  trigger: string;
  /** That trigger's own label, for a reader shown names rather than paths; nothing where it declares none. */
  triggerLabel: string | undefined;
  /** The canonical `path#operation` of `over` this trigger reaches. */
  operation: string;
  /** The operation whose binding led there; nothing where the trigger fires the covered operation itself. */
  through: string | undefined;
  /** How each part of `requires` is met here. Empty with `unjudged` false is exactly what I001 refuses. */
  met: Met[];
  /**
   * Whether the checker declines to judge this way in, because `requires` names something the invariant is
   * itself refused for: a policy the tree has not (R001) or a path the guard cannot hand (I002). No trigger
   * could meet such a requirement, so I001 is not raised and a consumer must not point a reader at one.
   */
  unjudged: boolean;
}

/** What an access invariant covers, as a reader is shown it: every way in, by trigger and then in `over` order. */
export interface InvariantSaid {
  /**
   * Every operation `over` names, in the order it writes them, reached or not. A covered operation nothing
   * reaches is what I003 is about, so the ways in alone cannot fill a table of what the invariant gates.
   */
  covers: Covered[];
  reached: ReachedWay[];
}

/** The policies a trigger attaches, in order; one it names that the tree has not is R001 and is left out. */
function attached(trigger: Loaded<TriggerDoc>, scope: Scope): Loaded<PolicyDoc>[] {
  const out: Loaded<PolicyDoc>[] = [];
  for (const use of trigger.doc.policies ?? []) {
    const policy = scope.get('policy', policyPath(use));
    if (policy) out.push(policy);
  }
  return out;
}

/**
 * Every covered operation this trigger reaches, under any profile that serves it (`profilesWalking`, the list
 * I001 and I003 are judged under), keyed by the operation. The checker stops at the first, since one is enough
 * to refuse; a reader has opened the invariant and is owed every way in. The first way one operation is reached
 * by wins, as `operationsReachable` answers a way and not every way.
 */
function reachesAll(trigger: Loaded<TriggerDoc>, over: Set<string>, scope: Scope): Map<string, string | undefined> {
  const found = new Map<string, string | undefined>();
  for (const profile of profilesWalking(scope, trigger.doc))
    for (const reached of operationsReachable(scope, trigger.doc.fire.run, profile))
      if (over.has(reached.key) && !found.has(reached.key)) found.set(reached.key, reached.through);
  return found;
}

/**
 * Whether `requires` asks for something no trigger could give, which is why the checker judges no trigger by
 * it: a policy the tree has not is R001 against the invariant and a path the guard cannot hand is I002, and
 * in both `TriggerGate.unmet` stays silent about every trigger rather than refusing I001.
 */
function unjudgeable(requires: AccessInvariant['requires'], scope: Scope): boolean {
  if (requires.policy && !scope.get('policy', requires.policy)) return true;
  return (requires.proves ?? []).some(path => provesFaultIn(scope, path) !== undefined);
}

/**
 * How the attached policies meet `requires`, by the rule `TriggerGate.unmet` judges I001 with: the named
 * policy and every proved path, all of them or none, never either. A requirement the checker is silent about
 * is skipped exactly as `unmet` skips it, so a way in the checker does not judge is not reported unmet.
 */
function metBy(policies: Loaded<PolicyDoc>[], requires: AccessInvariant['requires'], scope: Scope): Met[] {
  const met: Met[] = [];
  const { policy, proves } = requires;
  if (policy && scope.get('policy', policy)) {
    const found = policies.find(one => one.path === scope.canon(policy));
    if (!found) return [];
    met.push({ policy: found.path, label: found.doc.label, proves: undefined });
  }
  for (const path of proves ?? []) {
    if (provesFaultIn(scope, path)) continue;
    const found = policies.find(one => (one.doc.proves ?? []).some(proof => atOrBelow(path, proof)));
    if (!found) return [];
    met.push({ policy: found.path, label: found.doc.label, proves: path });
  }
  return met;
}

/** Every operation `over` names, with the port each belongs to, in the order the document writes them. */
function coversOf(access: AccessInvariant, scope: Scope): Covered[] {
  return access.over.map(opRef => {
    const { path, op } = splitRef(opRef);
    const port = scope.canon(path);
    return { op: `${port}#${op}`, opName: op, port, portLabel: scope.get('port', port)?.doc.label };
  });
}

/** Every way one trigger reaches what this invariant gates, in `over` order, with how the rule is met at each. */
function waysOf(trigger: Loaded<TriggerDoc>, access: AccessInvariant, covers: Covered[], scope: Scope): ReachedWay[] {
  const hits = reachesAll(trigger, new Set(covers.map(one => one.op)), scope);
  if (!hits.size) return [];
  const met = metBy(attached(trigger, scope), access.requires, scope);
  const unjudged = unjudgeable(access.requires, scope);
  return covers
    .filter(one => hits.has(one.op))
    .map(one => ({
      trigger: trigger.path,
      triggerLabel: trigger.doc.label,
      operation: one.op,
      through: hits.get(one.op),
      met,
      unjudged,
    }));
}

/**
 * Every trigger that reaches an operation this access invariant gates, and how each meets it; nothing where
 * the document is not the access form. The walk is made per trigger and collects them all, since a reader of
 * the invariant wants every way in and not only the one a refusal would name first.
 */
export function invariantSaidOf(scope: Scope, invariant: Loaded<InvariantDoc>): InvariantSaid | undefined {
  const access = invariant.doc.access;
  if (!access) return undefined;
  const covers = coversOf(access, scope);
  const reached: ReachedWay[] = [];
  for (const trigger of scope.registry.all('trigger')) reached.push(...waysOf(trigger, access, covers, scope));
  return { covers, reached };
}

/**
 * How one trigger meets every access invariant that reaches it: what `describe <trigger>` and `map` print
 * under it, and the one row a page shows beside a trigger. The reach is walked for this trigger alone rather
 * than for the tree and then filtered, since `map` asks this of every trigger in turn and the walk is the
 * expensive part. A trigger reaching several of one invariant's operations is answered once, by the first in
 * `over` order, since what a reader is told beside a trigger is that the rule reaches it.
 */
export function invariantsOfTrigger(scope: Scope, trigger: Loaded<TriggerDoc>): [Loaded<InvariantDoc>, ReachedWay][] {
  const out: [Loaded<InvariantDoc>, ReachedWay][] = [];
  for (const invariant of scope.registry.all('invariant')) {
    const access = invariant.doc.access;
    if (!access) continue;
    const ways = waysOf(trigger, access, coversOf(access, scope), scope);
    if (ways.length) out.push([invariant, ways[0]]);
  }
  return out;
}
