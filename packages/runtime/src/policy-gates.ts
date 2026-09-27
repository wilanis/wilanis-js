/**
 * Which triggers a policy gates, answered once for every reader of the tree: `describe` says them under the policy,
 * the viewer lists them on its page, and the manifest's policy rows print them. A trigger gates on a policy by naming
 * it under `policies`, bare or with the inputs it gives the guard, through any alias the project declares.
 */
import { type Loaded, policyPath, type Scope, type TriggerDoc } from '@wilanis/core';

/** Which triggers a policy gates: those naming it under `policies`, matched by canonical path, in the registry's order. */
export function triggersGatedBy(scope: Scope, policy: string): Loaded<TriggerDoc>[] {
  return scope.registry
    .all('trigger')
    .filter(trigger => (trigger.doc.policies ?? []).some(use => scope.canon(policyPath(use)) === policy));
}
