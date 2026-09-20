/**
 * A binding of a port a plugin requires (RFC 0005). The plugin fires it through env.ports from inside its own
 * code -- the guard's among them, which runs before any policy -- so the binding runs with no request judged
 * and must not read one (B009), and it answers or fails but never ends the run on purpose (B010).
 */
import type { BindingDoc, Loaded, PortDoc } from '@wilanis/core';
import { effectsReachable, refusalsReachable } from '../refusals.js';
import { type Judge, underProfile } from './judge.js';
import { opNeeds } from './resolvers.js';

/** B009, B010: every binding of a port a plugin requires reads no request, and reaches nothing that holds or refuses. */
export function checkRequired(judge: Judge): void {
  for (const binding of judge.scope.registry.all('binding')) {
    const port = judge.scope.get('port', binding.doc.port);
    if (!port?.requiredBy) continue;
    checkNoReads(judge, binding, port.requiredBy);
  }
  for (const port of judge.scope.registry.all('port')) if (port.requiredBy) checkOperations(judge, port);
}

/** B009 and B010 over every operation of one required port, under every profile: whatever binding it chose. */
function checkOperations(judge: Judge, port: Loaded<PortDoc>): void {
  for (const profile of judge.profiles())
    for (const name of Object.keys(port.doc.operations)) {
      const opRef = `${port.path}#${name}`;
      checkReached(judge, opRef, profile);
      checkEnding(judge, opRef, port.requiredBy ?? '', profile);
    }
}

const NO_READS = 'remove reads; an operation of a port a plugin requires reads only its in';

/** B009: the binding declares no reads, since a plugin fires it with no request judged. */
function checkNoReads(judge: Judge, binding: Loaded<BindingDoc>, plugin: string): void {
  if (!Object.keys(binding.doc.reads ?? {}).length) return;
  const message = `binding of '${binding.doc.port}' declares reads, but ${plugin} fires it with no request judged`;
  judge.refuser(binding.path)('B009', message, 'reads', NO_READS);
}

/** B009: nothing a required operation reaches under a profile reads request.*. */
function checkReached(judge: Judge, opRef: string, profile: string | undefined): void {
  const plugin = judge.scope.get('port', opRef.split('#')[0])?.requiredBy;
  for (const need of opNeeds(judge, opRef, profile)) {
    const message = `${opRef} reaches ${need.file}, which reads request.${need.path.join('.')}, but ${plugin} fires it with no request judged${underProfile(profile)}`;
    judge.refuser(need.file)('B009', message, undefined, NO_READS);
  }
}

const ANSWERS_OR_FAILS = 'answer or fail; a required operation never ends the run on purpose';

/**
 * B010: what a required operation reaches answers or fails, and never holds or refuses on purpose. It is the
 * walk that is judged rather than the delegation written in the binding, since a binding that runs a *graph*
 * whose last node is `refuse` ends the run just as surely as one that delegates to a refusing operation, and
 * the plugin firing it through `env.ports` expects an answer or a failure either way.
 */
function checkEnding(judge: Judge, opRef: string, plugin: string, profile: string | undefined): void {
  for (const refusal of refusalsReachable(judge.scope, opRef, profile))
    judge.refuser(refusal.file)(
      'B010',
      `${opRef} reaches a refuse of '${refusal.reason}', but ${plugin} fires it expecting an answer or a failure${underProfile(profile)}`,
      refusal.node,
      ANSWERS_OR_FAILS,
    );
  for (const effect of effectsReachable(judge.scope, opRef, profile)) {
    const hit = judge.scope.op(effect.key);
    if (typeof hit === 'string' || !hit.op.holds) continue;
    judge.refuser(effect.file)(
      'B010',
      `${opRef} reaches '${effect.key}', which holds something past the run, but ${plugin} fires it expecting an answer or a failure${underProfile(profile)}`,
      effect.node,
      ANSWERS_OR_FAILS,
    );
  }
}
