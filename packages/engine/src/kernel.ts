/**
 * The kernel. Stateless: it takes a spec, handlers and initial values, runs every node the instant its
 * sources have settled (all of them concurrently), routes, cancels, and answers a report at quiescence.
 * It never decides whether to run again -- the embedder reads the report and decides. It reads a clock only
 * to stamp what it reports (`RunOptions.clock`, `Date.now` unless given); it never waits on one.
 *
 * A graph whose inputs are not supplied is valid: the report says `blocked` and names what it needs.
 * Any node's value may be pre-supplied (`initial[nodeId]`): the node is `seeded`, not executed. That is replay.
 * One element of a map may be pre-supplied the same way (`initial['m.2']`): a failed map reports every element's
 * outcome in `items`, so the embedder can seed the ones that answered and run only the rest.
 */
import { Run } from './run.js';
import type { Handlers, KernelSpec, NodeReport, Report, RunOptions } from './spec.js';

/** Runs a spec against a fixed set of handlers and answers its report; stateless, so one kernel runs any spec. */
export class Kernel {
  constructor(private readonly handlers: Handlers) {}

  /** Run a spec to quiescence and answer its report. */
  run(spec: KernelSpec, opts: RunOptions = {}): Promise<Report> {
    return new Run(this.handlers, spec, opts).execute();
  }
}

/** The refusal a failed report carries, when the node that failed did so on purpose. */
export interface ReportRefusal {
  reason: string;
  message: string;
  detail?: Record<string, unknown>;
}

/**
 * The refusal a failed report carries: the reason and message of the node that refused on purpose. A nested
 * run's refusal reaches the node that ran it, so the top level answers for the whole run. Absent when the
 * run answered, blocked, or failed on a fault.
 */
export function refusalOf(report: Report): ReportRefusal | undefined {
  const outcome = outcomeOf(report);
  if (outcome.kind !== 'refused') return undefined;
  const { reason, message, detail } = outcome;
  return { reason, message, ...(detail ? { detail } : {}) };
}

/** How a run ended, in the tree's words: read by every trigger kind, the startup runner, rehearse and the trace. */
export type Outcome =
  | { kind: 'answered'; output: unknown }
  | { kind: 'refused'; reason: string; message: string; detail?: Record<string, unknown>; at: string }
  | { kind: 'faulted'; at: string; error: string }
  | { kind: 'blocked'; needs: string[] };

/** The node that ended the run: the first `failed` one a refusal was wanted from, or a fault was. */
function endedAt(report: Report, refused: boolean): [string, NodeReport] | undefined {
  const failed = Object.entries(report.nodes).filter(([, node]) => node.status === 'failed');
  if (refused) return failed.find(([, node]) => node.reason !== undefined);
  return failed.find(([, node]) => node.reason === undefined && node.caught === undefined);
}

/** A failed run's ending: the refusal the graph declared, or the fault of the node that broke. */
function failure(report: Report): Outcome {
  const refusal = endedAt(report, true);
  if (refusal) {
    const [at, node] = refusal;
    const detail = node.detail ? { detail: node.detail } : {};
    return { kind: 'refused', reason: node.reason ?? '', message: node.error ?? '', ...detail, at };
  }
  const fault = endedAt(report, false);
  return { kind: 'faulted', at: fault?.[0] ?? '', error: fault?.[1].error ?? 'failed' };
}

/**
 * How a run ended, in one word with what that word carries: `answered` with the output, `refused` with the
 * reason the graph declared and the node that gave it, `faulted` with the node that broke and what it threw,
 * or `blocked` with the roots nothing supplied. A nested run's ending has already reached the node that ran
 * it, so the top level answers for the whole run.
 */
export function outcomeOf(report: Report): Outcome {
  if (report.status === 'blocked') return { kind: 'blocked', needs: report.needs ?? [] };
  if (report.status === 'failed') return failure(report);
  return { kind: 'answered', output: report.output };
}
