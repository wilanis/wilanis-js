/**
 * What `wilanis describe`, `wilanis map` and `wilanis ls` print about an invariant: the rule it states, what
 * it covers, and how the tree meets it. A rule stated once is worth nothing if a reader cannot see where it
 * bites, so the access form names every trigger that reaches an operation it gates and the policy that
 * satisfies it there, and a trigger says which invariants hold over it and through what.
 *
 * Nothing here judges or walks. `invariantSaidOf` in the compiler answers both questions with the checker's
 * own rule -- reaching by `operationsReachable`, `requires` the way `TriggerGate` reads it -- and this module
 * turns its answer into lines. The viewer asks the same function, so the CLI and the page cannot drift apart,
 * and neither can say "satisfied" where `wilanis check` refuses I001.
 *
 * The `holds` form says its shape and its rule alone: which sites are proved and which are guarded is the
 * compiler's to answer once it lowers a guard, and a line claiming a site was proved before then would be a lie.
 */
import { type InvariantSaid, invariantSaidOf, invariantsOfTrigger, type ReachedWay } from '@wilanis/compiler';
import type { AccessInvariant, InvariantDoc, Loaded, Scope, TriggerDoc } from '@wilanis/core';

/** How a reader is told which invariant is meant: its label where it has one, and its path either way. */
export const invariantName = (invariant: Loaded<InvariantDoc>): string =>
  invariant.doc.label ? `'${invariant.doc.label}' (${invariant.path})` : invariant.path;

/** The policies that meet `requires` at one trigger, each with the path it proved where that is why it counts. */
const metSaid = (reached: ReachedWay): string =>
  reached.met.map(one => `${one.policy}${one.proves ? ` (proves ${one.proves})` : ''}`).join(', ');

/**
 * How one trigger stands against one invariant, in a few words. A trigger meeting nothing is named as what
 * I001 refuses -- but only where the checker judges it: where the invariant asks for a policy the tree has not
 * or a proof the guard cannot hand, it is refused against the invariant itself (R001, I002) and no I001 is
 * raised, so a reader is sent to the document rather than to a code `wilanis check` never printed.
 */
function howSaid(reached: ReachedWay): string {
  if (reached.met.length) return metSaid(reached);
  return reached.unjudged ? 'not judged -- the invariant itself is refused' : 'nothing -- I001 refuses this';
}

/** What one access invariant asks of every way in, as one line a reader of the invariant sees. */
export function requiresLine(requires: AccessInvariant['requires']): string {
  const said: string[] = [];
  if (requires.policy) said.push(`attaches ${requires.policy}`);
  if (requires.proves?.length) said.push(`attaches a policy proving ${requires.proves.join(', ')}`);
  return said.join(' and ');
}

/** The invariants that hold over one trigger, as `describe <trigger>` and `wilanis map` print them under it. */
export function holdsLines(trigger: Loaded<TriggerDoc>, scope: Scope): string[] {
  return invariantsOfTrigger(scope, trigger).map(
    ([invariant, reached]) => `  holds  ${invariant.path}  through ${howSaid(reached)}`,
  );
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

/** Every way in an access invariant constrains, one trigger to a pair of lines: what it reaches, and how it meets it. */
function reachedLines(said: InvariantSaid): string[] {
  if (!said.reached.length) return ['reached by  nothing yet -- no trigger reaches any operation of over'];
  const lines = ['reached by (the policy that meets it, and how the operation was reached):'];
  for (const one of said.reached) {
    const by = one.through ? `  reached through ${one.through}` : '';
    lines.push(`    ${one.trigger}  ${one.operation}${by}`, `        met by ${howSaid(one)}`);
  }
  return lines;
}

/** The access form, said: what it gates, what it asks, and every trigger that reaches it with how each meets it. */
function accessLines(doc: Loaded<InvariantDoc>, access: AccessInvariant, scope: Scope): string[] {
  const lines = [
    'access: every trigger reaching these domain operations is gated',
    ...access.over.map(op => `    ${op}`),
    `requires: ${requiresLine(access.requires)}`,
  ];
  const said = invariantSaidOf(scope, doc);
  return said ? [...lines, ...reachedLines(said)] : lines;
}

/**
 * An invariant: which form it takes, what it covers, and how it is met. Which sites of the field form are proved
 * and which are guarded waits on the compiler lowering a guard, so the `holds` form says its shape and its rule.
 */
export function invariantLines(doc: Loaded, scope: Scope): string[] {
  const declared = doc.doc as InvariantDoc;
  if (declared.access) return accessLines(doc as Loaded<InvariantDoc>, declared.access, scope);
  const holds = declared.holds;
  if (!holds) return [JSON.stringify(doc.doc, null, 2)];
  return [`holds: every value of ${holds.on} satisfies the rule`, `    when  ${holds.when}`];
}
