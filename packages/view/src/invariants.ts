/**
 * What an invariant page shows beyond the JSON. An invariant states a rule once and the tree is held to it
 * everywhere, so the thing a reader cannot see in the document is where "everywhere" falls: for the access form,
 * every trigger that reaches a covered operation and the policy that satisfies the rule there; for the field
 * form, the shape and the rule over its fields. The reaching walk is the compiler's `operationsReachable`, the
 * one the checker judges I001 by, so the page and the refusal can never disagree about what reaches what.
 */
import { operationsReachable } from '@wilanis/compiler';
import type { InvariantDoc, Loaded, PolicyDoc, Scope, ShapeDoc, TriggerDoc } from '@wilanis/core';
import { policyPath, splitOp } from '@wilanis/core';
import type { VAccessInvariant, VCovered, VHoldsInvariant, VInvariant, VReaching } from './types.js';
import { labelOf } from './types.js';

/** The profiles a reaching walk is made under: each the project declares, or the one unnamed default. */
const profilesOf = (scope: Scope): (string | undefined)[] => (scope.profiles().length ? scope.profiles() : [undefined]);

/** path#operation with the path made canonical, so what the invariant names and what the walk answers compare. */
const canonOp = (scope: Scope, opRef: string): string => {
  const { path, op } = splitOp(opRef);
  return `${scope.canon(path)}#${op}`;
};

/** Whether a proved path is at or below one a policy claims: `request.principal.id` is proved by `request.principal`. */
const atOrBelow = (path: string, proof: string): boolean => path === proof || path.startsWith(`${proof}.`);

/** One operation an invariant covers, named the way the port declares it so a click lands on the contract. */
function coveredOf(scope: Scope, opRef: string): VCovered {
  const hit = scope.op(opRef);
  const { path, op } = splitOp(opRef);
  if (typeof hit === 'string')
    return { op: canonOp(scope, opRef), opName: op, port: scope.canon(path), portLabel: scope.canon(path) };
  return { op: `${hit.path}#${hit.opName}`, opName: hit.opName, port: hit.path, portLabel: labelOf(hit.port) };
}

/** The policies a trigger attaches that the tree has, in the order it attaches them. */
function attached(scope: Scope, trigger: Loaded<TriggerDoc>): Loaded<PolicyDoc>[] {
  const out: Loaded<PolicyDoc>[] = [];
  for (const use of trigger.doc.policies ?? []) {
    const policy = scope.get('policy', policyPath(use));
    if (policy) out.push(policy);
  }
  return out;
}

/**
 * Every covered operation a trigger reaches, under any profile, each with the operation it was reached through,
 * in the order `over` names them. Reaching is transitive: a trigger firing `#import` reaches `#record` when the
 * graph behind the import calls it, which is why one page can say which routes a rule binds and the document
 * alone cannot. The checker stops at the first, since one is enough to refuse; a reader is shown them all.
 */
function reaches(scope: Scope, trigger: Loaded<TriggerDoc>, covered: string[]) {
  const through = new Map<string, string | undefined>();
  for (const profile of profilesOf(scope))
    for (const reached of operationsReachable(scope, trigger.doc.fire.run, profile))
      if (covered.includes(reached.key) && !through.has(reached.key)) through.set(reached.key, reached.through);
  return covered.filter(key => through.has(key)).map(key => ({ key, through: through.get(key) }));
}

/** Which of a trigger's policies satisfy the invariant: the one it names, and every one whose proves cover a path asked. */
function satisfiedBy(invariant: InvariantDoc, scope: Scope, policies: Loaded<PolicyDoc>[]) {
  const { policy, proves } = invariant.access?.requires ?? {};
  const wanted = policy ? scope.canon(policy) : undefined;
  return policies
    .filter(
      one =>
        one.path === wanted ||
        (proves ?? []).some(path => (one.doc.proves ?? []).some(proof => atOrBelow(path, proof))),
    )
    .map(one => ({ path: one.path, label: labelOf(one) }));
}

/** Every trigger that reaches a covered operation, one row per operation reached, with how it got there and what meets the rule. */
function reachingOf(scope: Scope, invariant: Loaded<InvariantDoc>, covers: VCovered[]): VReaching[] {
  const covered = covers.map(one => one.op);
  const out: VReaching[] = [];
  for (const trigger of scope.registry.all('trigger')) {
    const hits = reaches(scope, trigger, covered);
    if (!hits.length) continue;
    const meets = satisfiedBy(invariant.doc, scope, attached(scope, trigger));
    for (const hit of hits)
      out.push({
        trigger: trigger.path,
        triggerLabel: labelOf(trigger),
        op: hit.key,
        ...(hit.through ? { through: hit.through } : {}),
        satisfiedBy: meets,
      });
  }
  return out;
}

/** The access form: what it gates, the operations it covers, and every way in it binds. */
function accessView(scope: Scope, invariant: Loaded<InvariantDoc>): VAccessInvariant {
  const access = invariant.doc.access;
  const { policy, proves } = access?.requires ?? {};
  const found = policy ? scope.get('policy', policy) : undefined;
  const covers = (access?.over ?? []).map(opRef => coveredOf(scope, opRef));
  return {
    form: 'access',
    ...(policy ? { policy: found?.path ?? scope.canon(policy), policyLabel: labelOf(found) } : {}),
    ...(proves?.length ? { proves } : {}),
    covers,
    reached: reachingOf(scope, invariant, covers),
  };
}

/**
 * The field form: the shape the rule is about, the rule as written, and the field names its roots may be. Where
 * each value of the shape is made or taken -- and whether the rule is proved there or guarded -- is the
 * compiler's answer, and this page says nothing about it until the compiler does.
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
  };
}

/** What an invariant adds to its view: the form it takes, and what that form binds. */
export function invariantView(scope: Scope, doc: Loaded): VInvariant {
  const invariant = doc as Loaded<InvariantDoc>;
  return invariant.doc.access ? accessView(scope, invariant) : holdsView(scope, invariant);
}
