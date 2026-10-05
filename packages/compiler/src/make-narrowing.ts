/**
 * The one place a value is narrowed at run time: a graph's `make` whose `value` is one whole read keeps only the
 * fields its closed `type` declares (`trimsAt` in check/inputs.ts says where, and the checker judges those sites
 * with `assignableTrimmed`). The plugin's `make` judges what it is handed strictly; the compiler tags each narrowing
 * call with its site and wraps the handler, so a value the author wrote out in the node is never trimmed -- a key
 * there that the type does not declare is refused, by the checker first (G004) and by the run if it gets that far.
 */
import { type Node, prune, type Type, WHOLE_TEMPLATE } from '@wilanis/core';
import type { Handler } from '@wilanis/engine';

/** The type each narrowing call keeps, by the site tag the call carries. */
export type Narrows = Map<string, Type>;

/** Does this node narrow -- `make`, of `value` read whole -- and to which type? Records it under `name` when it does. */
export function tagNarrowing(narrows: Narrows, name: string, node: Node, typeOf: (spec: string) => Type | undefined) {
  const value = node.in?.value;
  const type = node.in?.type;
  if (typeof value !== 'string' || !WHOLE_TEMPLATE.test(value) || typeof type !== 'string') return false;
  const resolved = typeOf(type);
  if (resolved) narrows.set(name, resolved);
  return resolved !== undefined;
}

/** `make` as a narrowing call runs it: `value` trimmed to the type its site keeps; at any other call, `base` as it is. */
export function narrowing(base: Handler, narrows: Narrows): Handler {
  return args => {
    const type = args.ctx.site === undefined ? undefined : narrows.get(args.ctx.site);
    return base(type ? { ...args, in: { ...args.in, value: prune(args.in.value, type) } } : args);
  };
}
