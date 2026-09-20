/**
 * `env.ports`: how a plugin calls a port it requires. The operation runs through the binding the active
 * profile chose, as a nested run the way a trigger's operation runs, and answers what it returns. Only the
 * ports a plugin manifest requires are reachable, and only through their bindings, never a graph by path.
 */

import { runGraph } from '@wilanis/compiler';
import { type FirePort, type FiringContext, PortError } from '@wilanis/core';
import { outcomeOf } from '@wilanis/engine';
import type { Embedder } from './embed.js';

/**
 * The `env.ports` one embedder hands its plugins: a required operation fired through its binding.
 *
 * The binding runs nested the way a trigger's operation and a startup step do, under the calling run's
 * `signal` and in its blob scope: a handler fires this from inside a run, so the binding must end when that
 * run is aborted and must make its blobs where that run's scope will release them. A caller outside a run
 * (a `postLoad`) passes no context and gets the tree's own environment.
 */
export function portsOf(emb: Embedder): FirePort {
  return async (opRef, input, ctx) => {
    const hit = emb.scope.op(opRef);
    if (typeof hit === 'string') throw new Error(`env.ports: ${hit}`);
    if (!hit.port.requiredBy)
      throw new Error(`env.ports fires the ports a plugin requires, and '${hit.path}' is not one`);
    const report = await runGraph(emb.operation(opRef), {
      initial: { in: input },
      signal: ctx?.signal,
      clock: emb.clock,
      env: emb.envFor(blobsOf(ctx)),
    });
    const outcome = outcomeOf(report);
    if (outcome.kind === 'answered') return outcome.output;
    throw new PortError(`${hit.path}#${hit.opName}`, outcome);
  };
}

/** The calling run's blob scope, where it has one of its own; nothing, where the caller is outside a run. */
function blobsOf(ctx: FiringContext | undefined): unknown {
  return ctx?.env?.blobs;
}
