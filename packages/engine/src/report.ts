/**
 * What a run reports. Every node's report exists before anything runs and is written as the node goes; at
 * quiescence the run's own report is assembled from them and from how the run ended, and nothing else: the
 * scheduler decides what runs, this module only says what came of it.
 */
import { PSEUDO, rootPaths, sourcesOf } from './sources.js';
import type { KernelSpec, NodeReport, Report } from './spec.js';
import { isRefusal } from './spec.js';

/** How a run ended before quiescence could answer for it: a node broke or refused. Absent: it ran out. */
export type Ending = 'failed';

/** What a run's report is assembled from, read at quiescence. */
export interface Settled {
  spec: KernelSpec;
  nodes: Record<string, NodeReport>;
  /** Every value the run holds: the pre-supplied roots and seeds, and what each finished node answered. */
  values: Map<string, unknown>;
  ending: Ending | undefined;
  startedAt: number;
  endedAt: number;
}

/** A node or element whose value was pre-supplied is seeded, never executed: that is replay. */
export function initialReport(values: Map<string, unknown>, key: string): NodeReport {
  return values.has(key) ? { status: 'seeded', out: values.get(key) } : { status: 'pending' };
}

/** Whether a node has a value others may read: it ran to an answer, or it was seeded. */
export function answered(node: NodeReport): boolean {
  return node.status === 'done' || node.status === 'seeded';
}

/** A handler that refused on purpose leaves its reason (and detail) on the report; a fault leaves neither. */
export function noteRefusal(report: NodeReport, error: unknown): void {
  if (!isRefusal(error)) return;
  report.reason = error.reason;
  if (error.detail) report.detail = error.detail;
}

/** The run's report: how it ended; else done with the first answered output candidate; else blocked on what was never supplied. */
export function reportOf(run: Settled): Report {
  const base = { graph: run.spec.name, nodes: run.nodes, startedAt: run.startedAt, endedAt: run.endedAt };
  if (run.ending) return { ...base, status: run.ending };
  if (!run.spec.output) return { ...base, status: 'done' };
  const answer = run.spec.output.find(id => answered(run.nodes[id]));
  if (answer !== undefined) return { ...base, status: 'done', output: run.nodes[answer].out };
  return { ...base, status: 'blocked', needs: needs(run) };
}

/** The root paths pending nodes read that were never supplied, sorted. */
function needs(run: Settled): string[] {
  const pending = Object.keys(run.spec.nodes).filter(id => run.nodes[id].status === 'pending');
  const paths = pending.flatMap(id => sourcesOf(run.spec.nodes[id]).flatMap(source => rootPaths(source)));
  return [...new Set(paths.filter(path => unsupplied(run.values, path)))].sort();
}

/** Whether a path reads a root (`in`, `request`, ...) the run was never given. */
function unsupplied(values: Map<string, unknown>, path: string): boolean {
  const root = path.split('.')[0];
  return PSEUDO.has(root) && !values.has(root);
}
