/**
 * A binding of a port a plugin requires (RFC 0005). The plugin fires it through env.ports from inside its own
 * code -- the guard's among them, which runs before any policy -- so the binding runs with no request judged
 * and must not read one (B009), and it answers or fails but never ends the run on purpose (B010).
 */
import type { BindingDoc, Loaded, PortDoc } from '@wilanis/core';
import { type Judge, underProfile } from './judge.js';
import { opNeeds } from './resolvers.js';

/** B009, B010: every binding of a port a plugin requires reads no request, and delegates to nothing that holds or refuses. */
export function checkRequired(judge: Judge): void {
  for (const binding of judge.scope.registry.all('binding')) {
    const port = judge.scope.get('port', binding.doc.port);
    if (!port?.requiredBy) continue;
    checkNoReads(judge, binding, port.requiredBy);
    checkDelegations(judge, binding, port.requiredBy);
  }
  for (const port of judge.scope.registry.all('port')) if (port.requiredBy) checkOperations(judge, port);
}

/** B009 over every operation of one required port, under every profile: whatever binding the profile chose. */
function checkOperations(judge: Judge, port: Loaded<PortDoc>): void {
  for (const profile of judge.profiles())
    for (const name of Object.keys(port.doc.operations)) checkReached(judge, `${port.path}#${name}`, profile);
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

/** B010: a delegation of a required operation answers or fails; it never holds or refuses. */
function checkDelegations(judge: Judge, binding: Loaded<BindingDoc>, plugin: string): void {
  for (const [name, bound] of Object.entries(binding.doc.operations)) {
    if (!bound.run) continue;
    const hit = judge.scope.op(bound.run);
    if (typeof hit === 'string' || !(hit.op.holds || hit.op.refuses)) continue;
    const does = hit.op.holds ? 'holds something past the run' : 'refuses on purpose';
    judge.refuser(binding.path)(
      'B010',
      `'${name}' delegates to '${bound.run}', which ${does}; ${plugin} expects it to answer or fail`,
      `operations/${name}/run`,
      'delegate to an operation that answers or fails, never one that holds or refuses',
    );
  }
}
