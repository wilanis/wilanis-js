/**
 * `env.ports`: how a plugin calls a port it requires. The operation runs through the binding the active
 * profile chose, as a nested run the way a trigger's operation runs, and answers what it returns. Only the
 * ports a plugin manifest requires are reachable, and only through their bindings, never a graph by path.
 */

import { runGraph } from '@wilanis/compiler';
import { type FirePort, PortError } from '@wilanis/core';
import { outcomeOf } from '@wilanis/engine';
import type { Embedder } from './embed.js';

/** The `env.ports` one embedder hands its plugins: a required operation fired through its binding. */
export function portsOf(emb: Embedder): FirePort {
  return async (opRef, input) => {
    const hit = emb.scope.op(opRef);
    if (typeof hit === 'string') throw new Error(`env.ports: ${hit}`);
    if (!hit.port.requiredBy)
      throw new Error(`env.ports fires the ports a plugin requires, and '${hit.path}' is not one`);
    const report = await runGraph(emb.operation(opRef), { initial: { in: input }, clock: emb.clock, env: emb.env });
    const outcome = outcomeOf(report);
    if (outcome.kind === 'answered') return outcome.output;
    throw new PortError(`${hit.path}#${hit.opName}`, outcome);
  };
}
