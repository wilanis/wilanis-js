/**
 * What a span is allowed to carry, at the level the tree asked for.
 *
 * The RFC puts the judgement of *what a trace says* in the runtime's `traceOf`, which already drops the
 * values at `summary`. This holds the same line at the edge, where the bytes actually leave the process: an
 * exporter set to `summary` must not send a value whatever it was handed, because a trace built by a newer
 * runtime, a hand-built one, or one a later rule adds an attribute to would otherwise export a value that
 * the operator asked never to leave. The level that is safe by default is only safe if the thing that sends
 * enforces it.
 */
import type { Trace, TraceAttributes } from '@wilanis/core';
import type { Level } from './paths.js';

/**
 * The attributes that carry what a run said rather than what it did: the report's redacted in and out, and a
 * node's message. `summary` carries none of them -- a reason is a word the author declared and cannot leak,
 * a message is prose that interpolates whatever was written into it.
 */
const VALUED = ['wilanis.in', 'wilanis.out', 'wilanis.error'];

/** One span's attributes at this level: all of them at `full`, and none of the valued ones at `summary`. */
function attributesAt(attributes: TraceAttributes, level: Level): TraceAttributes {
  if (level === 'full') return attributes;
  const out: TraceAttributes = {};
  for (const [key, value] of Object.entries(attributes)) if (!VALUED.includes(key)) out[key] = value;
  return out;
}

/**
 * A trace as this level lets it leave: the same spans and the same nesting, carrying only what the level
 * allows. A cancelled node is kept at `full` and dropped at `summary`, so a reader at `summary` sees what
 * ran and a reader at `full` also sees the branches not taken.
 */
export function at(trace: Trace, level: Level): Trace {
  const children = trace.children
    .filter(child => level === 'full' || child.status !== 'cancelled')
    .map(child => at(child, level));
  return { ...trace, attributes: attributesAt(trace.attributes, level), children };
}
