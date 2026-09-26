/**
 * `wilanis rehearse`: every branch of every decision a trigger can reach, walked until each is answered, and what it
 * took to get there said in words. It runs against stubbed effects, so nothing leaves the process.
 */
import { type Guard, guardsOf, idsOf, TAKEN_IDS, walkedUnder } from '@wilanis/compiler';
import type { Loaded, LoadResult, TriggerDoc, Type } from '@wilanis/core';
import { Scope } from '@wilanis/core';
import type { Report } from '@wilanis/engine';
import { outcomeOf } from '@wilanis/engine';
import { type Case, casesFor, type FoundSwitch, nonEmpty, type Stubbing, setPath, switchesOf } from './branches.js';
import type { Embedder } from './embed.js';
import { activeProfile, skippedLines } from './profile.js';
import { type Recorded, type RecordedRun, recordRuns } from './record.js';
import { type Decision, format, gather, type PlainRun, statedOf, stateName } from './rehearsal-report.js';
import { heldUpstream } from './rehearse-held.js';
import { type Ran, recordedOf, secretOut } from './rehearse-recorded.js';
import { atomicAt, declaredAt, rootGraph, specBehind, type Where, whereOf } from './rehearse-where.js';
import { embedderFor, failedBelow, generatedFire, policyRoots, unbroken } from './stubbing.js';

// ---- rehearse ----------------------------------------------------------------------------------------

/** One line per outcome, and whether the whole rehearsal is acceptable; beside them, what the lines were said from. */
export interface Rehearsal {
  ok: boolean;
  lines: string[];
  /** The seed every run was generated under. */
  seed: number;
  /** Every switch reached, once per graph that declares it, with what each branch settled to. */
  decisions: Decision[];
  /** Every trigger with no switch under it, run once. */
  plain: PlainRun[];
  /** The lines `lines` opens with: how many triggers the profile does not serve were skipped, and where they are served. */
  skipped: string[];
  /** Under `record` or `check`: the recorded directory, and what was written to it or found different in it. */
  recorded?: Recorded;
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
 *
 * It runs under the profile `activeProfile` picks, as `start` would, so the bindings it stubs are the ones
 * that place runs; being stubbed, it needs no variable set. It runs only the triggers that profile serves
 * (`walkedUnder`), the ones the checker judged there, and says first how many it skipped and where they are served.
 *
 * With `record` (a directory under the root) or `check`, the runs a trigger's branches made are also recorded as
 * scenarios (`record.ts`): written there, or under `check` compared with what is there. Either solves under seed 1
 * whatever `seed` says, so the directory is a function of the tree alone.
 */
export async function rehearse(
  load: LoadResult,
  opts: { seed?: number; profile?: string; verbose?: boolean; record?: string; check?: boolean } = {},
): Promise<Rehearsal> {
  const recording = opts.record !== undefined || Boolean(opts.check);
  const seed = recording ? 1 : (opts.seed ?? 1);
  const profile = activeProfile(load.registry.project?.doc, { flag: opts.profile, env: process.env });
  const scope = new Scope(load.registry, load.resolve);
  const skipped = skippedLines(scope, profile, load.registry.all('trigger'), 'trigger(s)');
  const lines = [...skipped];
  const gathered: Gathered = { decisions: [], plain: [], runs: recording ? [] : undefined };
  await walkServed(load, { seed, profile, scope }, gathered);
  const { decisions, plain, runs } = gathered;
  // the invariants the tree states, counted over the whole tree rather than per trigger: a rule is stated once.
  // A scope of its own rather than an embedder's: what is asked of it reads documents and runs nothing.
  const said = { verbose: opts.verbose, stated: statedOf(new Scope(load.registry, load.resolve)) };
  const ok = format(decisions, plain, lines, said);
  const recorded = runs ? { recorded: recordRuns(load.root, opts, runs) } : {};
  return { ok, lines, seed, decisions, plain, skipped, ...recorded };
}

/** What walking the triggers gathers: every decision, every plain run, and -- when the rehearsal records -- the runs. */
interface Gathered {
  decisions: Decision[];
  plain: PlainRun[];
  runs?: RecordedRun[];
}

/**
 * Walk every trigger the profile serves, and every policy as a trigger of each kind that attaches it: a decision is
 * walked like any other graph. Only a trigger's runs are recorded: a scenario names a trigger, and a policy's
 * decision is not yet one.
 */
async function walkServed(load: LoadResult, how: { seed: number; profile?: string; scope: Scope }, into: Gathered) {
  const { seed, profile, scope } = how;
  const triggers = load.registry.all('trigger');
  for (const trigger of [...triggers, ...policyRoots(load)]) {
    if (!walkedUnder(scope, trigger.doc, profile)) continue;
    const one = { seed, profile, runs: triggers.includes(trigger) ? into.runs : undefined };
    const found = await rehearseTrigger(load, trigger, one, into.decisions);
    if (!found) into.plain.push(await wholeOf(load, trigger, one));
  }
}

/** How a trigger is walked: the seed, the profile, and -- when its runs are recorded -- where they go. */
interface How {
  seed: number;
  profile?: string;
  runs?: RecordedRun[];
}

/** What broke, when a run failed without declaring a refusal: the node, and what it threw. */
const brokeAt = (fault: { at: string; error: string }) => (fault.at ? `${fault.at}: ${fault.error}` : 'failed');

/** A trigger with no switch anywhere under it: one run is the whole of it, and recorded whole where runs are. */
async function wholeOf(load: LoadResult, trigger: Loaded<TriggerDoc>, how: How): Promise<PlainRun> {
  const { seed, profile } = how;
  const record: Record<string, unknown> = {};
  const emb = embedderFor(load, { seed, profile, record });
  const { input, request } = generatedFire(emb, trigger, seed);
  const report = await emb.fire(trigger.doc, input, request);
  // the output is written as the trigger's out type marks it, so a recorded scenario holds no secret in clear
  how.runs?.push({ trigger, seed, input, request, stubs: record, report, secret: secretOut(emb, trigger) });
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
  how: How,
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
  const walk: Walk = { load, trigger, seed, profile, found, stubbing, input, request, probe, runs: how.runs };

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
  /** Where each branch's run is recorded, when the rehearsal records. */
  runs?: RecordedRun[];
}

/** What steers a run: the stubs it is given, the patches to the trigger's input, and the nodes made to break. */
interface Steering {
  stubs: Record<string, unknown>;
  input: { path: string[]; value: unknown }[];
  broken: string[];
}

/**
 * The stubs and input that route every switch enclosing `sw` towards the node that contains it -- and the nodes to
 * break, where only an enclosing switch's catch routes there. A nested switch is otherwise cancelled before it runs,
 * and its own case would land on a dead path.
 */
function reach(walk: Walk, sw: FoundSwitch): Steering {
  const stubs: Record<string, unknown> = {};
  const patches: { path: string[]; value: unknown }[] = [];
  const broken: string[] = [];
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
    broken.push(...(want.broken ?? []));
  }
  return { stubs, input: patches, broken };
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
  const broken = new Set(pre.broken);
  const emb = embedderFor(walk.load, { seed: walk.seed, record, types, profile: walk.profile, broken });
  await emb.fire(walk.trigger.doc, warm, walk.request, { stubs: unbroken(pre.stubs, broken) });
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
 * The guard a decision is, where the switch is one the compiler lowered rather than one the author wrote (RFC 0007);
 * nothing where it is an ordinary switch. Which sites
 * carry a guard is never re-derived here: `guardsOf` is the compiler's own answer, and the ids it occupies are
 * the contract the report, the describe and the viewer all read a guard by, so a node id that is one of them
 * is one.
 *
 * A list site's guard is matched by the site the walk descended through rather than by the node id, because
 * inside the nested spec that guard's switch is the fixed `in:check` whatever the site was called; the id
 * alone would name the site's own guard for a taken site and nothing at all for a made one. Its value answers
 * at the fixed `in:ok` for the same reason (`guardSaid`).
 */
function guardAt(emb: Embedder, at: Where, node: string): Guard | undefined {
  const doc = emb.scope.get('graph', at.graph);
  if (!doc) return undefined;
  const guards = guardsOf(emb.scope, doc);
  return at.site ? guards.find(one => one.id === at.site) : guards.find(one => idsOf(one).check === node);
}

/** A guard as a decision says it: the invariants it stands for, and the node its `holds` branch answers at. */
const guardSaid = (guard: Guard, at: Where): Decision['guard'] => ({
  for: guard.unproved.map(one => stateName(one.invariant)).join('; '),
  answers: at.site ? TAKEN_IDS.ok : idsOf(guard).ok,
});

/** One switch as a decision: every branch, and what each settled to. */
async function decisionFor(walk: Walk, sw: FoundSwitch): Promise<Decision> {
  const pre = reach(walk, sw);
  const downstream = downstreamOf(walk, sw);
  const at = whereOf(walk.probe, walk.trigger, sw.prefix);
  const node = sw.at.split('.').pop() ?? '';
  const guard = guardAt(walk.probe, at, node);
  const decision: Decision = {
    graph: at.graph,
    node,
    atomic: atomicAt(walk.probe, at.graph),
    guard: guard && guardSaid(guard, at),
    triggers: [walk.trigger.name],
    branches: [],
  };
  // a guard whose value an enclosing graph already judged on this path is held there: neither branch is steered,
  // since what reaches it is what the caller handed down, and the one that refuses cannot be reached on this path
  const held = guard && heldUpstream(walk.probe, walk.trigger, sw, guard);
  const cases = casesFor(sw, walk.stubbing);
  for (const one of cases) {
    if (held) {
      decision.branches.push({ when: one.branch.when, to: one.branch.to, held });
      continue;
    }
    const { said, ran } = await branchOf(walk, sw, one, { pre, downstream });
    decision.branches.push(said);
    // a guard's switch is the compiler's, in no document a scenario can name, and a run that broke a node for real
    // is one a scenario's stubs cannot say: neither is recorded
    if (ran && !guard && !ran.broke) walk.runs?.push(recordedOf(walk, decision, { one, cases, ran }));
  }
  return decision;
}

/** One case of a switch: the branch it reaches, or why nothing can reach it. */
async function branchOf(
  walk: Walk,
  sw: FoundSwitch,
  one: Case,
  steer: { pre: Steering; downstream: Record<string, unknown> },
): Promise<{ said: Decision['branches'][number]; ran?: Ran }> {
  const at = { when: one.branch.when, to: one.branch.to };
  if (one.branch.unsolved) return { said: { ...at, uncovered: one.branch.unsolved } };
  if (one.unreachable?.length) {
    const why = `${one.unreachable.join(', ')} is the trigger's own input and the rehearsal cannot vary it`;
    return { said: { ...at, uncovered: why } };
  }
  // a caught node breaks for real: its stubbed effect throws, and nothing recorded answers in its place
  const broken = new Set([...steer.pre.broken, ...(one.broken ?? [])]);
  const record: Record<string, unknown> = {};
  const emb = embedderFor(walk.load, { seed: walk.seed, profile: walk.profile, broken, record });
  // a demand on the graph's own input is met by firing with a patched input, not by a stub
  let fired = walk.input;
  for (const patch of [...steer.pre.input, ...(one.input ?? [])]) fired = setPath(fired, patch.path, patch.value);
  const given = unbroken({ ...steer.downstream, ...steer.pre.stubs, ...one.stubs }, broken);
  const report = await emb.fire(walk.trigger.doc, fired, walk.request, { stubs: given });
  // a stubbed node's handler never runs, so what the case gave is written over what the run generated
  const ran = { input: fired, stubs: { ...record, ...given }, report, broke: broken.size > 0 };
  return { said: { ...at, settled: settle(report, sw, one.branch.to) }, ran };
}
