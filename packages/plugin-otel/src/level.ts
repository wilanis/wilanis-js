/**
 * What a span is allowed to carry, at the level the tree asked for.
 *
 * The RFC puts the judgement of *what a trace says* in the runtime's `traceOf`, which already drops the
 * values at `summary`. This holds the same line at the edge, where the bytes actually leave the process: an
 * exporter set to `summary` must not send a value whatever it was handed, because a trace built by a newer
 * runtime, a hand-built one, or one a later rule adds an attribute to would otherwise export a value that
 * the operator asked never to leave. The level that is safe by default is only safe if the thing that sends
 * enforces it.
 *
 * The narrowing itself is core's, beside the `Trace` it describes, so what counts as a value is one list and
 * not two: this module is where the exporter applies it, not a second copy of what it says.
 */
import { atLevel, type Trace } from '@wilanis/core';
import type { Level } from './paths.js';

/**
 * A trace as this level lets it leave: the same spans and the same nesting, carrying only what the level
 * allows. A cancelled node is kept at `full` and dropped at `summary`, so a reader at `summary` sees what
 * ran and a reader at `full` also sees the branches not taken.
 */
export const at = (trace: Trace, level: Level): Trace => atLevel(trace, level);
