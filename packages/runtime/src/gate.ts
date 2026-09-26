/**
 * The gate before a run: the guard identifies the caller, then every policy the trigger attaches decides, in
 * order. It answers the report that ends the run where one does, and it keeps a record of everything it did --
 * the guard's timing and outcome, and every decision, the ones that allowed as much as the one that did not --
 * because a gate that only says why it refused cannot be read by anyone afterwards. What the record is turned
 * into is the trace's business; the gate only remembers.
 */
import { type Compiled, runGraph } from '@wilanis/compiler';
import { type GuardArgs, type PluginModule, policyPath, type Scope, type TriggerDoc } from '@wilanis/core';
import { outcomeOf, type Report } from '@wilanis/engine';
import type { Decided, Identified } from './fired.js';
import { shownRoots } from './shown.js';
import { fillTemplates, refused } from './values.js';

/** What the gate needs of the embedder to run a decision graph, without the embedder itself. */
export interface Gating {
  scope: Scope;
  guard: PluginModule | undefined;
  /** The compiled binding behind a port operation. */
  operation(opRef: string): Compiled;
  /** The environment a decision graph runs against, with this run's blob scope where it has one. */
  envFor(blobs: unknown): Record<string, unknown>;
  /** What the guard is handed on this fire. */
  guardArgs(trigger: TriggerDoc, request: Record<string, unknown>): GuardArgs;
  /** The clock every stamp of this fire is read from. */
  clock(): number;
}

/** What one gate did: what ended the run where something did, and the record of every step of it. */
export interface Gated {
  /** The report that ends the run: the guard's refusal, a policy's denial or challenge. Absent: the trigger may fire. */
  ended?: Report;
  identify?: Identified;
  decisions: Decided[];
}

/**
 * Run the gate of one trigger and keep what it did. A stubbed run and a trigger with no policies are gated by
 * nothing, and answer an empty record: a rehearsal's generated context already carries a principal, and the
 * policies are rehearsed as roots of their own.
 */
export async function gate(
  emb: Gating,
  trigger: TriggerDoc,
  request: Record<string, unknown>,
  opts: { stubbed?: boolean; signal?: AbortSignal; blobs?: unknown },
): Promise<Gated> {
  const gated: Gated = { decisions: [] };
  if (opts.stubbed || !trigger.policies?.length) return gated;
  const args = emb.guardArgs(trigger, request);
  gated.ended = await identifies(emb, args, request, gated);
  if (gated.ended) return gated;
  for (const use of trigger.policies) {
    const ended = await decide(emb, policyPath(use), { request, args, opts }, gated);
    if (ended) {
      gated.ended = ended;
      return gated;
    }
  }
  return gated;
}

/** The guard's identification, timed: what it added to the context, or the report its refusal ends the run with. */
async function identifies(
  emb: Gating,
  args: GuardArgs,
  request: Record<string, unknown>,
  gated: Gated,
): Promise<Report | undefined> {
  const identify = emb.guard?.guard?.identify;
  if (!emb.guard || !identify) return undefined;
  const startedAt = emb.clock();
  const id = await identify(args);
  const timing = { startedAt, endedAt: emb.clock() };
  if ('refuse' in id) {
    gated.identify = { ...timing, added: [], refused: id.refuse.reason };
    return refused(`${emb.guard.root} guard`, 'identify', id.refuse);
  }
  gated.identify = { ...timing, added: Object.keys(id.context) };
  Object.assign(request, id.context);
  return undefined;
}

/**
 * One policy's decision, kept whichever way it went: nothing when it allows and the run goes on, else the
 * report that ends it. A policy that allows is recorded all the same -- a reader of a gate that only kept the
 * refusal could not tell an unguarded run from one that passed two policies. The decision is handed the request
 * and its input as they are, and its reports show both as a trigger's run shows them: what the kind's context
 * marks is the marker, and so is an input `decide.in` fills from it.
 */
async function decide(
  emb: Gating,
  ref: string,
  run: { request: Record<string, unknown>; args: GuardArgs; opts: { signal?: AbortSignal; blobs?: unknown } },
  gated: Gated,
): Promise<Report | undefined> {
  const policy = emb.scope.get('policy', ref);
  if (!policy) throw new Error(`unknown policy '${ref}'`);
  const filledBy = policy.doc.decide.in ?? {};
  const input = fillTemplates(filledBy, { request: run.request });
  // what the decision's operation accepts it marks itself, on the one call its run makes
  const roots = { request: run.request, input, inType: undefined, filledBy };
  const report = await runGraph(emb.operation(policy.doc.decide.run), {
    initial: { in: input, request: run.request },
    shown: shownRoots(emb.scope, run.args.trigger, roots),
    signal: run.opts.signal,
    clock: emb.clock,
    env: emb.envFor(run.opts.blobs),
  });
  if (report.status === 'done') {
    gated.decisions.push({ policy: policy.path, report });
    return undefined;
  }
  const decided: Report = { ...report, graph: policy.path };
  const outcome = outcomeOf(report);
  const declared = outcome.kind === 'refused' ? policy.doc.outcomes[outcome.reason] : undefined;
  const keep = (ended: Report) => {
    gated.decisions.push({ policy: policy.path, report: ended, ...(declared ? { effect: declared.effect } : {}) });
    return ended;
  };
  if (outcome.kind !== 'refused') return keep(decided); // the decision broke: a fault, answered as one
  if (declared?.effect !== 'challenge' || !emb.guard) return keep(decided);
  return keep(await challenged(emb, decided, run.args, { policy: policy.path, outcome, method: declared.method }));
}

/** A denial the guard turns into a challenge: the same report, the node that refused carrying how to answer it. */
async function challenged(
  emb: Gating,
  decided: Report,
  args: GuardArgs,
  what: { policy: string; outcome: { reason: string; message: string; at: string }; method?: string },
): Promise<Report> {
  const challenge = await emb.guard?.guard?.challenge({
    ...args,
    policy: what.policy,
    reason: what.outcome.reason,
    message: what.outcome.message,
    method: what.method,
  });
  const node = decided.nodes[what.outcome.at];
  if (!challenge || !node) return decided;
  return {
    ...decided,
    nodes: { ...decided.nodes, [what.outcome.at]: { ...node, error: challenge.message, detail: challenge.detail } },
  };
}
