/**
 * What `wilanis describe`, `wilanis map` and `wilanis ls` say about an invariant: the rule it states, what it
 * covers, and how the tree meets it. A rule stated once is worth nothing if a reader cannot see where it bites,
 * so the access form names every trigger that reaches an operation it gates and the policy that satisfies it
 * there, and a trigger says which invariants hold over it and through what.
 *
 * Reaching is not recomputed here: `operationsReachable` is the walk the checker judges I001 by, so what a
 * reader is told and what the tree was held to are one answer. The `holds` form says its shape and its rule
 * alone -- which sites are proved and which are guarded is the compiler's to answer, and is not lowered yet.
 */
import { operationsReachable } from '@wilanis/compiler';
import type { AccessInvariant, InvariantDoc, Loaded, PolicyDoc, Scope, TriggerDoc } from '@wilanis/core';
import { policyPath, splitOp } from '@wilanis/core';

/** How a reader is told which invariant is meant: its label where it has one, and its path either way. */
export const invariantName = (invariant: Loaded<InvariantDoc>): string =>
  invariant.doc.label ? `'${invariant.doc.label}' (${invariant.path})` : invariant.path;

/** Is a dotted path the prefix itself, or below it? What a policy proves covers everything under it. */
const atOrBelow = (path: string, prefix: string): boolean => path === prefix || path.startsWith(`${prefix}.`);

/** Every access invariant of the tree, with the form it takes, so a walk over the triggers reads them once. */
export function accessInvariants(scope: Scope): [Loaded<InvariantDoc>, AccessInvariant][] {
  const out: [Loaded<InvariantDoc>, AccessInvariant][] = [];
  for (const one of scope.registry.all('invariant')) if (one.doc.access) out.push([one, one.doc.access]);
  return out;
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

/** The first operation of an invariant this trigger reaches, under any profile, and what it was reached through. */
function reaches(trigger: Loaded<TriggerDoc>, over: Set<string>, scope: Scope) {
  const profiles: (string | undefined)[] = scope.profiles().length ? scope.profiles() : [undefined];
  for (const profile of profiles)
    for (const reached of operationsReachable(scope, trigger.doc.fire.run, profile))
      if (over.has(reached.key)) return reached;
  return undefined;
}

/** How a trigger meets one requirement of an access invariant: the policy that satisfies it, or nothing. */
function through(policies: Loaded<PolicyDoc>[], requires: AccessInvariant['requires'], scope: Scope): string[] {
  const met: string[] = [];
  const want = requires.policy ? scope.canon(requires.policy) : undefined;
  if (want) {
    const found = policies.find(one => one.path === want);
    if (!found) return [];
    met.push(found.path);
  }
  for (const path of requires.proves ?? []) {
    const found = policies.find(one => (one.doc.proves ?? []).some(proof => atOrBelow(path, proof)));
    if (!found) return [];
    met.push(`${found.path} (proves ${path})`);
  }
  return met;
}

/** One way in an access invariant constrains: the trigger, the operation it reaches, and how the gate is met. */
export interface Reaching {
  trigger: string;
  /** The canonical operation of `over` this trigger reaches. */
  operation: string;
  /** The operation whose binding led there, when the trigger did not fire it directly. */
  by: string | undefined;
  /** The policies that satisfy `requires` here; empty where none does, which is what I001 refuses. */
  met: string[];
}

/** One operation reference as the reaching walk names it: the path canonical, the operation as written. */
const canonOp = (opRef: string, scope: Scope): string => {
  const { path, op } = splitOp(opRef);
  return `${scope.canon(path)}#${op}`;
};

/** Every trigger that reaches an operation this access invariant gates, and how each one meets it. */
export function reachingTriggers(access: AccessInvariant, scope: Scope): Reaching[] {
  const over = new Set(access.over.map(opRef => canonOp(opRef, scope)));
  const out: Reaching[] = [];
  for (const trigger of scope.registry.all('trigger')) {
    const reached = reaches(trigger, over, scope);
    if (!reached) continue;
    out.push({
      trigger: trigger.path,
      operation: reached.key,
      by: reached.through,
      met: through(attached(trigger, scope), access.requires, scope),
    });
  }
  return out;
}

/** What one access invariant asks of every way in, as one line a reader of the invariant or of a trigger sees. */
export function requiresLine(requires: AccessInvariant['requires']): string {
  const said: string[] = [];
  if (requires.policy) said.push(`attaches ${requires.policy}`);
  if (requires.proves?.length) said.push(`attaches a policy proving ${requires.proves.join(', ')}`);
  return said.join(' and ');
}

/** The invariants that hold over one trigger, as `describe <trigger>` and `wilanis map` print them under it. */
export function holdsLines(trigger: Loaded<TriggerDoc>, scope: Scope): string[] {
  const lines: string[] = [];
  for (const [invariant, access] of accessInvariants(scope)) {
    const here = reachingTriggers(access, scope).find(one => one.trigger === trigger.path);
    if (!here) continue;
    const how = here.met.length ? `through ${here.met.join(', ')}` : 'through nothing -- see I001';
    lines.push(`  holds  ${invariant.path}  ${how}`);
  }
  return lines;
}

/** The invariants stated over one shape, so a shape says what its values are always held to. */
export function overShape(shape: string, scope: Scope): string[] {
  const lines: string[] = [];
  for (const one of scope.registry.all('invariant')) {
    const holds = one.doc.holds;
    if (holds && scope.canon(holds.on) === shape) lines.push(`held to  ${invariantName(one)}: ${holds.when}`);
  }
  return lines;
}

/** The access form, said: what it gates, what it asks, and every trigger that reaches it with how each meets it. */
function accessLines(access: AccessInvariant, scope: Scope): string[] {
  const lines = [
    'access: every trigger reaching these domain operations is gated',
    ...access.over.map(op => `    ${op}`),
  ];
  lines.push(`requires: ${requiresLine(access.requires)}`);
  const reaching = reachingTriggers(access, scope);
  if (!reaching.length) return [...lines, 'reached by  nothing yet -- no trigger reaches any operation of over'];
  lines.push('reached by (the policy that meets it, and how the operation was reached):');
  for (const one of reaching) {
    const by = one.by ? `  reached through ${one.by}` : '';
    const met = one.met.length ? one.met.join(', ') : 'nothing -- see I001';
    lines.push(`    ${one.trigger}  ${one.operation}${by}`, `        met by ${met}`);
  }
  return lines;
}

/**
 * An invariant: which form it takes, what it covers, and how it is met. Which sites of the field form are proved
 * and which are guarded waits on the compiler lowering a guard, so the `holds` form says its shape and its rule.
 */
export function invariantLines(doc: Loaded, scope: Scope): string[] {
  const declared = doc.doc as InvariantDoc;
  if (declared.access) return accessLines(declared.access, scope);
  const holds = declared.holds;
  if (!holds) return [JSON.stringify(doc.doc, null, 2)];
  return [`holds: every value of ${holds.on} satisfies the rule`, `    when  ${holds.when}`];
}
