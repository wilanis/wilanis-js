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
  return reached.unjudged ? 'not judged (the invariant itself is refused)' : 'nothing, which I001 refuses';
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

/** One operation as it reads where the `over` block above has already named the port: the bare `#operation`. */
const opSaid = (op: string, ports: Set<string>): string => {
  const [port, name] = [op.slice(0, op.indexOf('#')), op.slice(op.indexOf('#') + 1)];
  return ports.size === 1 && ports.has(port) ? `#${name}` : op;
};

/** One way in, as it reads beside its trigger: what it reaches, and the operation it was reached through. */
const waySaid = (one: ReachedWay, ports: Set<string>): string =>
  `${opSaid(one.operation, ports)}${one.through ? ` (through ${opSaid(one.through, ports)})` : ''}`;

/** The ways in one trigger has, gathered in the order the walk found them, which is the order `over` writes. */
function byTrigger(reached: ReachedWay[]): Map<string, ReachedWay[]> {
  const out = new Map<string, ReachedWay[]>();
  for (const one of reached) out.set(one.trigger, [...(out.get(one.trigger) ?? []), one]);
  return out;
}

/**
 * One trigger, on one line: what it reaches, and how it meets the rule where that is not what every way in
 * does. A trigger reaching three operations is one trigger, and the `over` block above has named the port,
 * so the operations read as `#record, #submit, #import` rather than three canonical paths.
 */
function triggerLine(trigger: string, ways: ReachedWay[], ports: Set<string>, hoisted: boolean): string {
  const reaches = ways.map(one => waySaid(one, ports)).join(', ');
  const how = hoisted ? '' : `  -- met by ${howSaid(ways[0])}`;
  return `    ${trigger}  ${reaches}${how}`;
}

/**
 * Whether every way in is met the same way, so the answer can be said once above the list instead of on every
 * line. `requires` is one rule and most trees meet it with one policy, which the line above has already named;
 * repeating it per trigger says nothing a reader does not have. Where the ways differ -- one unjudged, one
 * meeting nothing, one meeting something else -- each says its own, since that difference is the whole point.
 */
const sameThroughout = (reached: ReachedWay[]): boolean =>
  new Set(reached.map(one => howSaid(one))).size === 1 && reached.every(one => one.met.length);

/** Every way in an access invariant constrains, a trigger to a line, with what they share said once. */
function reachedLines(said: InvariantSaid): string[] {
  if (!said.reached.length) return ['reached by  nothing yet -- no trigger reaches any operation of over'];
  const ports = new Set(said.covers.map(one => one.port));
  const hoisted = sameThroughout(said.reached);
  const head = hoisted
    ? `reached by (every one met by ${howSaid(said.reached[0])}):`
    : 'reached by (the operations each reaches, and how it meets the rule):';
  const grouped = byTrigger(said.reached);
  return [head, ...[...grouped].map(([trigger, ways]) => triggerLine(trigger, ways, ports, hoisted))];
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
