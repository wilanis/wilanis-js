/**
 * What an invariant page shows beyond the JSON. An invariant states a rule once and the tree is held to it
 * everywhere, so the thing a reader cannot see in the document is where "everywhere" falls: for the access
 * form, every trigger that reaches a covered operation and the policy that satisfies the rule there; for the
 * field form, the shape and the rule over its fields.
 *
 * Nothing here works out what reaches what, or whether a rule is met. `invariantSaidOf` in the compiler
 * answers both with the rule `check/invariants.ts` refuses I001 by, so the page and the refusal cannot say
 * different things; this maps its answer onto what a page draws. A label the document does not declare is
 * made readable here, which is the one thing the compiler cannot do for a page.
 */
import { type InvariantSaid, invariantSaidOf, type ReachedWay } from '@wilanis/compiler';
import type { InvariantDoc, Loaded, Scope, ShapeDoc } from '@wilanis/core';
import { sitesOfInvariant } from './guards.js';
import type { VAccessInvariant, VCovered, VHoldsInvariant, VInvariant, VReaching } from './types.js';
import { labelOf, readable } from './types.js';

/** A name for a path the page shows: the document's own label, or its file name made readable. */
const nameOf = (label: string | undefined, path: string): string =>
  label ??
  readable(
    path
      .split('/')
      .pop()
      ?.replace(/\.[a-z-]+\.json$/, '') ?? path,
  );

/** One covered operation, named the way the port declares it so a click lands on the contract. */
const coveredOf = (one: InvariantSaid['covers'][number]): VCovered => ({
  op: one.op,
  opName: one.opName,
  port: one.port,
  portLabel: nameOf(one.portLabel, one.port),
});

/** One way in, as a row of the page's table: who reaches what, how, and what meets the rule there. */
const reachingOf = (way: ReachedWay): VReaching => ({
  trigger: way.trigger,
  triggerLabel: nameOf(way.triggerLabel, way.trigger),
  op: way.operation,
  ...(way.through ? { through: way.through } : {}),
  satisfiedBy: way.met.map(met => ({
    path: met.policy,
    label: nameOf(met.label, met.policy),
    ...(met.proves ? { proves: met.proves } : {}),
  })),
  ...(way.unjudged ? { unjudged: true } : {}),
});

/** The access form: what it gates, the operations it covers, and every way in it binds. */
function accessView(said: InvariantSaid, invariant: Loaded<InvariantDoc>, scope: Scope): VAccessInvariant {
  const { policy, proves } = invariant.doc.access?.requires ?? {};
  const found = policy ? scope.get('policy', policy) : undefined;
  return {
    form: 'access',
    ...(policy ? { policy: found?.path ?? scope.canon(policy), policyLabel: labelOf(found) } : {}),
    ...(proves?.length ? { proves } : {}),
    covers: said.covers.map(coveredOf),
    reached: said.reached.map(reachingOf),
  };
}

/**
 * The field form: the shape the rule is about, the rule as written, the field names its roots may be, and every
 * site of the shape with how the rule stands there. Which sites those are and whether each was proved is
 * `sitesOf` and `heldAt` in the compiler -- the same answers the guard it lowers is built from, so the table and
 * the guard cannot disagree.
 */
function holdsView(scope: Scope, invariant: Loaded<InvariantDoc>): VHoldsInvariant {
  const holds = invariant.doc.holds;
  const shape = holds ? scope.get('shape', holds.on) : undefined;
  return {
    form: 'holds',
    on: shape?.path ?? scope.canon(holds?.on ?? ''),
    onLabel: labelOf(shape),
    when: holds?.when ?? '',
    fields: Object.keys((shape?.doc as ShapeDoc | undefined)?.fields ?? {}),
    sites: sitesOfInvariant(scope, invariant),
  };
}

/** What an invariant adds to its view: the form it takes, and what that form binds. */
export function invariantView(scope: Scope, doc: Loaded): VInvariant {
  const invariant = doc as Loaded<InvariantDoc>;
  const said = invariantSaidOf(scope, invariant);
  return said ? accessView(said, invariant, scope) : holdsView(scope, invariant);
}
