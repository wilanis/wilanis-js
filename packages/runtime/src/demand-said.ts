/**
 * Why one demand of a rehearsal case is not met, in the words the report prints after `NEVER RUN`. `demands.ts` meets
 * each demand where it can and, where it cannot, says why here: a value no text the rehearsal makes can be, or one it
 * cannot pair; a read of `in` whose trace stopped at something the rehearsal does not set (RFC 0038), each sentence
 * naming the field, the node and the graph where the trace stopped, and the edit that makes it steerable; and a literal
 * a caller hands that the branch excludes, which closes the branch on that path. A demand that leaves no member of a
 * field's enum says nothing here: `uncoveredBy` names every such field in one sentence, beside the rule that excluded
 * them.
 */
import type { Type } from '@wilanis/core';
import type { Domain } from './domains.js';
import type { Stopped } from './frames.js';
import { short } from './rehearsal-report.js';

/**
 * Why a demand is not met: nothing the rehearsal sets reaches it, no value of its field's type meets it, or a literal
 * on the way fixes a value it excludes, so no run takes the branch on this path.
 */
export type Missed = 'unreachable' | 'exhausted' | 'closed';

/** A demand not met: why, and the sentence that says so for its field, where one says more than the field's kind. */
export interface Unmet {
  missed: Missed;
  why?: string;
}

/**
 * Why no value of a field's type meets a demand, said for the field: a text compared with another value cannot be
 * changed to hold or lack a word, since its partner would not change with it; any other text is one the rehearsal
 * cannot make hold and lack every word the branch asks for. A field whose type is an enum says nothing here, since
 * every member being excluded is said once for all such fields (`uncoveredBy`).
 */
export function exhaustedOf(field: string, domain: Domain, type: Type | undefined): Unmet {
  if (domain.paired)
    return {
      missed: 'exhausted',
      why: `${field} is compared with another value, so the rehearsal cannot change it to hold and lack the words this branch asks for`,
    };
  if (type?.kind === 'string' && type.enum?.length) return { missed: 'exhausted' };
  return {
    missed: 'exhausted',
    why: `the rehearsal can make no text for ${field} that holds and lacks every word this branch asks for`,
  };
}

/** The graph document the node at a dotted path stands in, where the rehearsal can say it. */
export type GraphOf = (nodePath: string) => string | undefined;

/** A node a trace stopped at, as a reader finds it: its id in the graph it stands in, else its dotted path. */
function nodeSaid(nodePath: string, graphOf?: GraphOf): string {
  const graph = graphOf?.(nodePath);
  return graph ? `'${nodePath.split('.').at(-1)}' in ${short(graph)}` : `'${nodePath}'`;
}

/** A value the tree fixes, as a sentence says it. */
const literalSaid = (value: unknown) => (value === undefined ? 'no value' : `the literal ${JSON.stringify(value)}`);

/**
 * Why a read of `in` cannot be steered where its trace stopped: what the value is there, at which node of which graph,
 * and the edit that makes it steerable. `read` is the switch's own read, `in.<path>`, as its graph writes it.
 */
export function stoppedSaid(read: string[], stopped: Stopped, graphOf?: GraphOf): string {
  const field = ['in', ...read].join('.');
  const at = nodeSaid(stopped.stopped, graphOf);
  const node = 'hand it as one read of a node there';
  if (stopped.reason === 'composed')
    return `${field} is composed at ${at}, so the rehearsal cannot vary it: ${node}, or decide before the call`;
  if (stopped.reason === 'context')
    return `${field} reads context.${stopped.context?.join('.')} at ${at}, which the rehearsal does not vary: ${node} to steer it`;
  if (stopped.reason === 'composed list')
    return `${field} is an element of the list composed at ${at}, so the rehearsal cannot vary it: map over one read of a node there`;
  if (stopped.reason === 'literal')
    return `${field} is ${literalSaid(stopped.value)} at ${at}, and the rehearsal cannot steer a rule that compares it with another value: ${node}`;
  return `${field} is not handed on at ${at}, so the rehearsal cannot vary it: ${node}`;
}

/** A literal a caller hands that a branch excludes, which closes the branch on that path: where, and what it hands. */
export function closedSaid(read: string[], stopped: Stopped, graphOf?: GraphOf): string {
  return `${nodeSaid(stopped.stopped, graphOf)} hands ${['in', ...read].join('.')} ${literalSaid(stopped.value)}`;
}
