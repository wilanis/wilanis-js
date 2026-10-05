/**
 * The values that cross the edge: a templated literal filled from what a trigger's kind hands, a value pruned to the
 * shape a graph answers, and what a wire's text becomes when the shape says it is a number or a boolean.
 */
import type { Type } from '@wilanis/core';
import { splitPath, TEMPLATE, WHOLE_TEMPLATE } from '@wilanis/core';
import type { Report } from '@wilanis/engine';
import { readPath } from '@wilanis/engine';

/** One string filled: a whole template takes the value it reads, an embedded one interpolates into the text. */
function filledString(value: string, roots: Record<string, unknown>): unknown {
  const read = (template: string) => {
    const [root, ...path] = splitPath(template);
    return readPath(roots[root], path);
  };
  const whole = WHOLE_TEMPLATE.exec(value);
  if (whole) return read(whole[1]);
  return value.replace(TEMPLATE, (_, template: string) => {
    const found = read(template);
    return found === undefined ? '' : String(found);
  });
}

/** Fill a templated literal from roots (context, ...). Whole templates take the value; embedded ones interpolate. */
export function fillTemplates(value: unknown, roots: Record<string, unknown>): unknown {
  if (typeof value === 'string') return filledString(value, roots);
  if (Array.isArray(value)) return value.map(each => fillTemplates(each, roots));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [name, each] of Object.entries(value as Record<string, unknown>)) {
      const filled = fillTemplates(each, roots);
      if (filled !== undefined) out[name] = filled;
    }
    return out;
  }
  return value;
}

/** A report of a run that ended before any graph ran: the guard refused the credential. */
export function refused(
  graph: string,
  node: string,
  refusal: { reason: string; message: string; detail?: Record<string, unknown> },
): Report {
  const now = Date.now();
  const failed = {
    status: 'failed' as const,
    handler: graph,
    reason: refusal.reason,
    error: refusal.message,
    ...(refusal.detail ? { detail: refusal.detail } : {}),
  };
  return { graph, status: 'failed', nodes: { [node]: failed }, startedAt: now, endedAt: now };
}

/** Drop keys a closed object type does not declare, recursively: core's `prune`, where the edge reads it. */
export { prune } from '@wilanis/core';

/** Coerce wire strings (query, path, headers, form fields) toward the declared field types. */
export function coerceWire(value: unknown, type: Type): unknown {
  if (typeof value !== 'string') return value;
  if (type.kind === 'number' && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value);
  if (type.kind === 'boolean' && (value === 'true' || value === 'false')) return value === 'true';
  return value;
}
