/**
 * What a run's pre-supplied values show. A root is shown as the run was told to show it, else as it is. A node
 * seeded in a replay is shown as its own report would have shown what it answered had it run: redacted by its
 * operation's paths, and carrying the mark of what it would have read as a secret, so far as what it reads was
 * supplied too. A seeded node's sources are shown before it, so a seed reading a seed reads what that one shows.
 */
import { seededAnswer } from './map.js';
import { readAsSecret, redactValue, shownOut } from './redact.js';
import { nodeRefs, type Reader, readAll } from './sources.js';
import type { KCall, KernelSpec, RunOptions } from './spec.js';

/** What the seeds are read from and shown into: the run's values, what their reports show, and its reader over them. */
export interface Seeding {
  values: Map<string, unknown>;
  shown: Map<string, unknown>;
  showing: Reader;
}

/** Show every pre-supplied value, each seeded node after the pre-supplied values it reads. */
export function showSeeds(spec: KernelSpec, opts: RunOptions, run: Seeding): void {
  const pending = new Set(Object.keys(opts.initial ?? {}));
  const show = (key: string) => {
    if (!pending.delete(key)) return;
    const node = Object.hasOwn(spec.nodes, key) ? spec.nodes[key] : undefined;
    for (const ref of node ? nodeRefs(node) : []) show(ref);
    run.shown.set(key, shownSeed(spec, opts, run, key));
  };
  for (const key of [...pending]) show(key);
}

/** One pre-supplied value as a report shows it. */
function shownSeed(spec: KernelSpec, opts: RunOptions, run: Seeding, key: string): unknown {
  const value = run.values.get(key);
  const told = opts.shown?.[key];
  if (told !== undefined) return told;
  const node = Object.hasOwn(spec.nodes, key) ? spec.nodes[key] : undefined;
  if (node?.kind === 'call') return shownOut(undefined, value, node, readBySeed(node, run));
  return node?.kind === 'map' && Array.isArray(value) ? seededAnswer(node, value, run) : value;
}

/** What a seeded call would have read as a secret, over what is supplied of what it reads. */
function readBySeed(node: KCall, run: Seeding): Set<unknown> {
  const shown = redactValue(readAll(node.in, run.showing), node.redact?.in);
  return readAsSecret(readAll(node.in, run.values), shown);
}
