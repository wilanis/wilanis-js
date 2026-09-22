/**
 * `wilanis rehearse`: every branch of every decision a trigger can reach, walked until each is answered, and what it
 * took to get there said in words. It runs against stubbed effects, so nothing leaves the process.
 */
import { guardsOf, idsOf, TAKEN_IDS } from '@wilanis/compiler';
import type { Loaded, LoadResult, TriggerDoc, Type } from '@wilanis/core';
import { Scope } from '@wilanis/core';
import type { Report } from '@wilanis/engine';
import { outcomeOf } from '@wilanis/engine';
import { type Case, casesFor, type FoundSwitch, nonEmpty, type Stubbing, setPath, switchesOf } from './branches.js';
import type { Embedder } from './embed.js';
import { type Decision, format, gather, type Plain, statedOf, stateName } from './rehearsal-report.js';
import { atomicAt, declaredAt, rootGraph, specBehind, type Where, whereOf } from './rehearse-where.js';
import { embedderFor, failedBelow, generatedFire, policyRoots } from './stubbing.js';

// ---- rehearse ----------------------------------------------------------------------------------------

/** One line per outcome, and whether the whole rehearsal is acceptable. */
export interface Rehearsal {
  ok: boolean;
  lines: string[];
}

/** What one run of one branch settled to, judged at the graph that owns the decision. */
export interface Settled {
  /** done, failed, or BLOCKED. */
  status: string;
  /** The declared failure, when the graph refused on purpose: its reason and message. */
  declared?: { reason: string; message: string };
  /** A failure the graph did not declare: a bug, not a designed outcome. */
  error?: string;
  /** A declared failure that came from a graph this one calls, and the node it came through. */
  propagated?: { node: string; reason: string; error: string };
  blocked: boolean;
  /** The node the switch actually routed to, when it is not the one the branch aimed at. */
  misrouted?: string;
  /**
   * How long the graph that owns the decision took, in milliseconds. Effects are stubbed, so this is the
   * cost of the tree's own work and nothing else; it is shown under `--verbose` and never recorded.
   */
  ms?: number;
}

/** The report of the graph at a dotted node path, or the whole report at the top. A map node is followed by the index of the element to read. */
function reportAt(report: Report, prefix: string[]): Report | undefined {
  let cur: Report | undefined = report;
  for (let at = 0; at < prefix.length; at++) {
    const node: Report['nodes'][string] | undefined = cur?.nodes?.[prefix[at]];
    if (!node) return undefined;
    if (node.items) {
      cur = node.items[Number(prefix[++at])]?.sub;
      continue;
    }
    cur = node.sub;
  }
  return cur;
}

/**
 * Judge one run at the graph that owns the switch. A branch that routes correctly into a nested graph
 * which then declares a failure is a success of the routing, so the outcome is read where the decision
 * was made rather than at the trigger, where every nested failure looks alike.
 */
function settle(report: Report, sw: FoundSwitch, aim: string): Settled {
  const local = reportAt(report, sw.prefix) ?? report;
  const took = local.nodes[sw.at.split('.').pop() ?? '']?.selected;
  const out: Settled = {
    status: local.status === 'blocked' ? 'BLOCKED' : local.status,
    blocked: local.status === 'blocked',
    misrouted: took !== undefined && took !== aim ? took : undefined,
    ms: local.endedAt - local.startedAt,
  };
  return { ...out, ...whyFailed(local) };
}

/**
 * Why a run failed, said where the decision was made. A refusal in THIS graph is a declared outcome; a refusal that
 * arrived from a graph this one calls is that graph's declared outcome surfacing here, and naming it as ours would
 * credit the wrong document. Which node ended the run is `outcomeOf`'s to say; only the credit is read below it.
 */
function whyFailed(local: Report): Partial<Settled> {
  const outcome = outcomeOf(local);
  if (outcome.kind !== 'refused' && outcome.kind !== 'faulted') return {};
  const node = local.nodes[outcome.at];
  const deeper = node && failedBelow(outcome.at, node);
  if (deeper?.reason !== undefined)
    return { propagated: { node: outcome.at, reason: deeper.reason, error: deeper.error ?? '' } };
  if (outcome.kind === 'refused') return { declared: { reason: outcome.reason, message: outcome.message } };
  return { error: brokeAt(outcome) };
}

/**
 * Run every trigger with stubbed effects, and every branch of every switch those triggers reach.
 *
 * A rehearsal answers one question: is every path through this project wired up? Effects are stubbed, so
 * nothing leaves the process; what is being judged is the routing, not the data. Each switch is solved
 * from its own rules -- the inputs that make one rule true while the rules before it are false -- so a
 * branch is exercised whether or not a generated value would have happened to reach it.
 *
 * A branch is acceptable when it settles: the graph answers, or it fails at a #refuse node it declared.
 * It is a problem when the graph blocks (an input nothing supplies), fails somewhere it did not declare,
 * routes somewhere other than where its rule points, or when no inputs can reach the branch at all.
 */
export async function rehearse(
  load: LoadResult,
  opts: { seed?: number; profile?: string; verbose?: boolean } = {},
): Promise<Rehearsal> {
  const seed = opts.seed ?? 1;
  const lines: string[] = [];
  const decisions: Decision[] = [];
  const settledGraphs: Plain[] = [];
  // every trigger, and every policy as a trigger of each kind that attaches it: a decision is walked like any other graph
  for (const trigger of [...load.registry.all('trigger'), ...policyRoots(load)]) {
    const found = await rehearseTrigger(load, trigger, { seed, profile: opts.profile }, decisions);
    if (!found) settledGraphs.push(await wholeOf(load, trigger, seed, opts.profile));
  }
  // the invariants the tree states, counted over the whole tree rather than per trigger: a rule is stated once.
  // A scope of its own rather than an embedder's: what is asked of it reads documents and runs nothing.
  const said = { verbose: opts.verbose, stated: statedOf(new Scope(load.registry, load.resolve)) };
  return { ok: format(decisions, settledGraphs, lines, said), lines };
}

/** What broke, when a run failed without declaring a refusal: the node, and what it threw. */
const brokeAt = (fault: { at: string; error: string }) => (fault.at ? `${fault.at}: ${fault.error}` : 'failed');

/** A trigger with no switch anywhere under it: one run is the whole of it. */
async function wholeOf(load: LoadResult, trigger: Loaded<TriggerDoc>, seed: number, profile?: string) {
  const emb = embedderFor(load, { seed, profile });
  const { input, request } = generatedFire(emb, trigger, seed);
  const report = await emb.fire(trigger.doc, input, request);
  const outcome = outcomeOf(report);
  return {
    trigger: trigger.name,
    graph: trigger.doc.fire.run,
    atomic: atomicAt(emb, rootGraph(emb, trigger)),
    status: report.status === 'blocked' ? 'BLOCKED' : report.status,
    declared: outcome.kind === 'refused' ? `${outcome.reason}: "${outcome.message}"` : undefined,
    error: outcome.kind === 'faulted' ? brokeAt(outcome) : undefined,
  };
}

/** One switch, its branches, and what each settled to. Named by the graph that declares it. */
async function rehearseTrigger(
  load: LoadResult,
  trigger: Loaded<TriggerDoc>,
  how: { seed: number; profile?: string },
  decisions: Decision[],
): Promise<boolean> {
  const { seed, profile } = how;
  const opts = { profile };
  // a first run records what the seed generated for every effectful node, the base each case patches,
  // and the type each node declared, so a case can generate a type-correct value for a field the seed
  // left out. Nodes on a branch this run did not take are absent from the recording; those cases start
  // from nothing and generate what they need from the declared type instead.
  const record: Record<string, unknown> = {};
  const types: Record<string, Type> = {};
  const probe = embedderFor(load, { seed, record, types, profile: opts.profile });
  const { input, request } = generatedFire(probe, trigger, seed);
  await probe.fire(trigger.doc, input, request);

  const spec = probe.operation(trigger.doc.fire.run).spec;
  const found = switchesOf(spec, handler => specBehind(probe, handler));
  if (!found.length) return false;

  const inType = probe.types(trigger.doc).in;
  const stubbing = {
    generated: (path: string) => record[path],
    // a node no stub recorded -- a call into a graph -- still declares what it answers, and a value built for it
    // from nothing must be of that type, or whatever reads it downstream is handed only what a demand wrote
    typeOf: (path: string) => types[path] ?? declaredAt(probe, spec, path),
    seed,
    inputSeed: input,
    inType,
  };
  const walk: Walk = { load, trigger, seed, profile, found, stubbing, input, request, probe };

  // The probe took one path, so nodes behind every branch it did not take are absent from the recording
  // and their declared types are unknown -- a case built from nothing cannot generate a typed value. One
  // run per switch, steered to reach it, fills the recording before any case is built from it.
  for (const sw of found) if (sw.via.length) await warmUp(walk, sw, record, types);
  for (const sw of found) gather(decisions, await decisionFor(walk, sw));
  return true;
}

/** What rehearsing one trigger's switches reads: the tree, the trigger, the switches found, and what to stub with. */
interface Walk {
  load: LoadResult;
  trigger: Loaded<TriggerDoc>;
  seed: number;
  profile?: string;
  found: FoundSwitch[];
  stubbing: Stubbing;
  input: unknown;
  request: Record<string, unknown>;
  probe: Embedder;
}

/**
 * The stubs and input that route every switch enclosing `sw` towards the node that contains it. A nested switch is
 * otherwise cancelled before it runs, and its own case would land on a dead path.
 */
function reach(
  walk: Walk,
  sw: FoundSwitch,
): { stubs: Record<string, unknown>; input: { path: string[]; value: unknown }[] } {
  const stubs: Record<string, unknown> = {};
  const patches: { path: string[]; value: unknown }[] = [];
  // a switch inside a mapped operation runs only when the list it maps over has an element to run for
  for (const list of sw.lists) {
    const need = nonEmpty(list, walk.stubbing);
    Object.assign(stubs, need.stubs);
    patches.push(...need.input);
  }
  for (const ancestorAt of sw.via) {
    const want = governingCase(walk, ancestorAt);
    if (!want) continue;
    Object.assign(stubs, want.stubs);
    patches.push(...(want.input ?? []));
  }
  return { stubs, input: patches };
}

/** The case of the switch that governs an enclosing call, which routes into it. */
function governingCase(walk: Walk, ancestorAt: string) {
  // the enclosing call is `<...>.<node>`; the switch governing it is a sibling in the same spec
  const segments = ancestorAt.split('.');
  const nodeId = segments[segments.length - 1];
  const governing = walk.found.find(
    one =>
      one.prefix.join('.') === segments.slice(0, -1).join('.') &&
      [...one.node.rules.map(rule => rule.to), one.node.else].includes(nodeId),
  );
  if (!governing) return undefined;
  return casesFor(governing, walk.stubbing).find(
    one => one.branch.to === nodeId && !one.branch.unsolved && !one.unreachable?.length,
  );
}

/** One run steered to reach a switch, so what it records is there before any case is built from it. */
async function warmUp(walk: Walk, sw: FoundSwitch, record: Record<string, unknown>, types: Record<string, Type>) {
  const pre = reach(walk, sw);
  let warm = walk.input;
  for (const patch of pre.input) warm = setPath(warm, patch.path, patch.value);
  const emb = embedderFor(walk.load, { seed: walk.seed, record, types, profile: walk.profile });
  await emb.fire(walk.trigger.doc, warm, walk.request, { stubs: pre.stubs });
}

/**
 * A branch of this switch is about where it routes. What the graph it routes into then decides is that graph's own
 * business, reported under its own decision -- so steer those to the branch that answers, and this decision reports
 * its routing rather than an incidental downstream refusal.
 */
function downstreamOf(walk: Walk, sw: FoundSwitch): Record<string, unknown> {
  const downstream: Record<string, unknown> = {};
  const here = sw.prefix.join('.');
  for (const other of walk.found) {
    if (other === sw) continue;
    // strictly inside a node this switch routes to: its prefix extends this switch's own
    const there = other.prefix.join('.');
    if (there === here || !(here === '' || there.startsWith(`${here}.`))) continue;
    const answering = casesFor(other, walk.stubbing).find(
      one => one.branch.rule >= 0 && !one.branch.unsolved && !one.unreachable?.length,
    );
    if (answering) Object.assign(downstream, answering.stubs);
  }
  return downstream;
}

/**
 * The invariants a decision guards, and the node it answers the value at, where the switch is one the compiler
 * lowered rather than one the author wrote (RFC 0007); nothing where it is an ordinary switch. Which sites
 * carry a guard is never re-derived here: `guardsOf` is the compiler's own answer, and the ids it occupies are
 * the contract the report, the describe and the viewer all read a guard by, so a node id that is one of them
 * is one.
 *
 * A list site's guard is matched by the site the walk descended through rather than by the node id, because
 * inside the nested spec that guard's switch is the fixed `in:check` whatever the site was called; the id
 * alone would name the site's own guard for a taken site and nothing at all for a made one. Its value answers
 * at the fixed `in:ok` for the same reason.
 */
function guardAt(emb: Embedder, at: Where, node: string): Decision['guard'] {
  const doc = emb.scope.get('graph', at.graph);
  if (!doc) return undefined;
  const guards = guardsOf(emb.scope, doc);
  const guard = at.site ? guards.find(one => one.id === at.site) : guards.find(one => idsOf(one).check === node);
  if (!guard) return undefined;
  return {
    for: guard.unproved.map(one => stateName(one.invariant)).join('; '),
    answers: at.site ? TAKEN_IDS.ok : idsOf(guard).ok,
  };
}

/** One switch as a decision: every branch, and what each settled to. */
async function decisionFor(walk: Walk, sw: FoundSwitch): Promise<Decision> {
  const pre = reach(walk, sw);
  const downstream = downstreamOf(walk, sw);
  const at = whereOf(walk.probe, walk.trigger, sw.prefix);
  const node = sw.at.split('.').pop() ?? '';
  const decision: Decision = {
    graph: at.graph,
    node,
    atomic: atomicAt(walk.probe, at.graph),
    guard: guardAt(walk.probe, at, node),
    triggers: [walk.trigger.name],
    branches: [],
  };
  for (const one of casesFor(sw, walk.stubbing))
    decision.branches.push(await branchOf(walk, sw, one, { pre, downstream }));
  return decision;
}

/** One case of a switch: the branch it reaches, or why nothing can reach it. */
async function branchOf(
  walk: Walk,
  sw: FoundSwitch,
  one: Case,
  steer: {
    pre: { stubs: Record<string, unknown>; input: { path: string[]; value: unknown }[] };
    downstream: Record<string, unknown>;
  },
): Promise<Decision['branches'][number]> {
  const at = { when: one.branch.when, to: one.branch.to };
  if (one.branch.unsolved) return { ...at, uncovered: one.branch.unsolved };
  if (one.unreachable?.length)
    return {
      ...at,
      uncovered: `${one.unreachable.join(', ')} is the trigger's own input and the rehearsal cannot vary it`,
    };
  const emb = embedderFor(walk.load, { seed: walk.seed, profile: walk.profile });
  // a demand on the graph's own input is met by firing with a patched input, not by a stub
  let fired = walk.input;
  for (const patch of [...steer.pre.input, ...(one.input ?? [])]) fired = setPath(fired, patch.path, patch.value);
  const report = await emb.fire(walk.trigger.doc, fired, walk.request, {
    stubs: { ...steer.downstream, ...steer.pre.stubs, ...one.stubs },
  });
  return { ...at, settled: settle(report, sw, one.branch.to) };
}
