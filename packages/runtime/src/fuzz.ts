/**
 * `wilanis fuzz` and `wilanis regress`: many runs of a trigger against stubbed effects, each written out as a scenario,
 * and those scenarios replayed to say whether the tree still answers as it did.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { walkedUnder } from '@wilanis/compiler';
import type { Loaded, LoadResult } from '@wilanis/core';
import {
  answersAbove,
  canonicalJson,
  nodesOf,
  SCENARIOS_DIR,
  type ScenarioDoc,
  type ScenarioNode,
  Scope,
  schemaUrl,
  secretPaths,
  stubsOf,
  type TriggerDoc,
} from '@wilanis/core';
import { type Report, refusalOf, shownOutput } from '@wilanis/engine';
import { type Fuzzing, fuzzEdges, unwritten } from './fuzz-edges.js';
import { activeProfile, skippedLines } from './profile.js';
import { asWritten } from './recorded-answers.js';
import { SCENARIOS } from './recorded-owner.js';
import { replayedDoc, solvedAgain } from './rehearse-recorded.js';
import { type Replayer, recordedReport, replayedReport, replayerFor, triggerOf } from './replay.js';
import { unreadSaid } from './scenario-said.js';
import { embedderFor, generatedFire } from './stubbing.js';

export { SCENARIOS } from './recorded-owner.js';

// ---- fuzz / regress ----------------------------------------------------------------------------------

/**
 * What one node did: how it ended, the reason it refused with, the operation it ran, where a switch routed, and
 * what it answered. The handler is kept beside the rest because a node whose binding was changed under it answers
 * differently for a reason no diff of the answer alone can name; the reason, because a refusal and a fault at the
 * same node are both `failed`.
 *
 * Durations are deliberately absent: they are not reproducible, so a scenario would diff against itself.
 */
function did(node: Report['nodes'][string]): ScenarioNode {
  return {
    status: node.status,
    ...(node.status === 'failed' && node.reason !== undefined ? { reason: node.reason } : {}),
    ...(node.handler ? { handler: node.handler } : {}),
    ...(node.selected ? { selected: node.selected } : {}),
    ...(node.status === 'done' && node.out !== undefined ? { out: node.out } : {}),
  };
}

/** What every node of a run did, by its dotted path, a nested graph's nodes under the node that called it. */
function pick(report: Report, prefix = ''): Record<string, ScenarioNode> {
  const out: Record<string, ScenarioNode> = {};
  for (const [id, node] of Object.entries(report.nodes)) {
    const key = prefix ? `${prefix}.${id}` : id;
    out[key] = did(node);
    if (node.sub) Object.assign(out, pick(node.sub, key));
  }
  return out;
}

/**
 * What a run is recorded as expecting: how it ended, what it answered as its report shows it (`shownOutput`, with the
 * fields `secret` marks as the marker too), the reason the refuse node it failed at declared (`refusalOf`, which no
 * node's `out` carries), and what every node did.
 */
export function expectOf(report: Report, secret: string[][]): ScenarioDoc['expect'] {
  const reason = refusalOf(report)?.reason;
  return {
    status: report.status,
    ...(report.status === 'done' ? { output: shownOutput(report, secret) } : {}),
    ...(reason !== undefined ? { reason } : {}),
    nodes: pick(report),
  };
}

/**
 * One fuzzed run: the trigger fired under a seed, what it was fired with, what the stubs answered, the report of the
 * run that chose those answers, and the report of their replay, which the scenario's expectation is read off.
 */
interface Fuzzed {
  trigger: Loaded<TriggerDoc>;
  seed: number;
  input: unknown;
  context: Record<string, unknown>;
  record: Record<string, unknown>;
  first: Report;
  report: Report;
  /** Where the trigger's `out` marks a field secret: the marker in the output, beside what its report marks. */
  secret: string[][];
}

/**
 * Fire one trigger under one seed with stubbed effects, recording every stub's answer, and read what it is expected to
 * do off the replay of those stubs (`recordedReport`), so the scenario replays as it was written.
 */
async function fuzzed(
  load: LoadResult,
  trigger: Loaded<TriggerDoc>,
  seed: number,
  how: { profile?: string; replayer: Replayer },
): Promise<Fuzzed> {
  const record: Record<string, unknown> = {};
  const emb = embedderFor(load, { seed, record, profile: how.profile });
  const { input, context } = generatedFire(emb, trigger, seed);
  const first = await emb.fire(trigger.doc, input, context);
  const report = await recordedReport(load, how.replayer, { trigger: trigger.path, in: input, context, stubs: record });
  return { trigger, seed, input, context, record, first, report, secret: secretPaths(emb.types(trigger.doc).out) };
}

/** The scenario a fuzzed run is written as. */
function scenarioOf({ trigger, seed, input, context, record, report, secret }: Fuzzed): ScenarioDoc {
  return {
    $schema: schemaUrl('scenario'),
    description: `${trigger.path} under seed ${seed}: ${report.status}. Written by wilanis fuzz; regenerate it, do not edit it -- to pin a case, run wilanis scenarios --pin <this file>, which copies it into ${SCENARIOS_DIR}/.`,
    generated: 'fuzz',
    trigger: trigger.path,
    seed,
    in: input,
    context,
    stubs: record,
    expect: expectOf(report, secret),
  };
}

/**
 * Run each trigger the profile serves with stubbed effects and write one scenario per run: under N seeds, or with
 * `edges` once per fixed edge of its input, to the directory `fuzz --edges` owns or under `check` compared with it
 * (`fuzzEdges`).
 */
export function fuzz(
  load: LoadResult,
  opts: { runs?: number; profile?: string; out?: string; edges?: boolean; check?: boolean } = {},
): Promise<Fuzzing> {
  return opts.edges || opts.check ? fuzzEdges(load, opts) : fuzzSeeds(load, opts);
}

/**
 * Run each trigger the profile serves under N seeds with stubbed effects and write one scenario per run -- but never
 * one of a fault, or one whose replay ended otherwise than the run (`unwritten`). The stubbed world never throws, so a
 * run that faults under stubs is the tree's own bug (a `make` whose value does not fit, a `refuse` whose reason is not
 * a word, a wiring hole), and a scenario pinning it would hold the tree to breaking: the fault is said, nothing is
 * written for it, and the answer is not ok. A trigger the profile does not serve (`walkedUnder`) is not run, and
 * `skipped` says how many and where they are served.
 */
async function fuzzSeeds(load: LoadResult, opts: { runs?: number; profile?: string; out?: string }): Promise<Fuzzing> {
  const written: string[] = [];
  const lines: string[] = [];
  const profile = activeProfile(load.registry.project?.doc, { flag: opts.profile, env: process.env });
  const scope = new Scope(load.registry, load.resolve);
  const dir = join(load.root, opts.out ?? SCENARIOS);
  mkdirSync(dir, { recursive: true });
  const how = { profile, replayer: replayerFor(load, profile) };
  for (const trigger of load.registry.all('trigger')) {
    if (!walkedUnder(scope, trigger.doc, profile)) continue;
    for (let seed = 1; seed <= (opts.runs ?? 5); seed++) {
      const run = await fuzzed(load, trigger, seed, how);
      const why = unwritten(run, 'wilanis fuzz');
      if (why) {
        lines.push(`${trigger.path} under seed ${seed}: ${why}`);
        continue;
      }
      const file = join(dir, `${trigger.name}.${seed}.scenario.json`);
      writeFileSync(file, `${JSON.stringify(scenarioOf(run), null, 2)}\n`);
      written.push(file);
    }
  }
  const skipped = skippedLines(scope, profile, load.registry.all('trigger'), 'trigger(s)');
  return { ok: lines.length === 0, written, lines, skipped };
}

/** A value as the JSON written for it reads back, in canonical form; nothing where JSON writes nothing. */
function canonical(value: unknown): string | undefined {
  const written = asWritten(value);
  return written === undefined ? undefined : canonicalJson(written);
}

/**
 * Whether two values write the same JSON, whatever the order of their keys: an answers file holds each value in
 * canonical form, its keys sorted, so a replay fed a stub from it builds its objects in another order than the run
 * that was recorded, and means the same.
 */
const same = (one: unknown, other: unknown) => canonical(one) === canonical(other);

/**
 * How a reason differs, a node's (`id`) or the run's: `none` for one that answered or broke, so a refusal become a
 * fault reads as one.
 */
function reasonDiffs(was: string | undefined, now: string | undefined, id?: string): string[] {
  return now === was ? [] : [`${id ? `${id}: ` : ''}reason ${was ?? 'none'} → ${now ?? 'none'}`];
}

/**
 * How the refusal the run declared differs from the one the scenario recorded. It is diffed where the scenario pins
 * it: it records one, or a command that records one wrote it, so a hand-written scenario, and one fuzz wrote before
 * it recorded the reason, replay as they did.
 */
function refusalDiffs(report: Report, sc: ScenarioDoc): string[] {
  if (sc.expect.reason === undefined && sc.generated === undefined) return [];
  return reasonDiffs(sc.expect.reason, refusalOf(report)?.reason);
}

/**
 * How one node differs from what the scenario recorded. A reason is diffed only where the scenario pins reasons at
 * all: one written before fuzz recorded them has none on any node, and replays as it did.
 */
function nodeDiffs(id: string, was: ScenarioNode, now: ScenarioNode | undefined, pinsReasons: boolean): string[] {
  if (!now) return [`${id}: gone`];
  const out: string[] = [];
  if (now.status !== was.status) out.push(`${id}: ${was.status} → ${now.status}`);
  if (pinsReasons) out.push(...reasonDiffs(was.reason, now.reason, id));
  if (was.handler && now.handler !== was.handler) out.push(`${id}: ran ${was.handler} → ${now.handler}`);
  if (was.selected && now.selected !== was.selected) out.push(`${id}: routed ${was.selected} → ${now.selected}`);
  if ('out' in was && !same(now.out, was.out)) out.push(`${id}: out changed`);
  return out;
}

/**
 * How this run differs from what the scenario recorded: its status, its output, every node -- as `nodesOf` resolved
 * them -- and its declared refusal.
 */
function diffOf(report: Report, sc: ScenarioDoc, nodes: Record<string, ScenarioNode>, secret: string[][]): string[] {
  const { expect } = sc;
  const diffs: string[] = [];
  if (report.status !== expect.status) diffs.push(`status ${expect.status} → ${report.status}`);
  if (expect.status === 'done' && !same(shownOutput(report, secret), expect.output)) diffs.push('output changed');
  const got = pick(report);
  const pinsReasons = Object.values(nodes).some(node => node.reason !== undefined);
  for (const [id, was] of Object.entries(nodes)) diffs.push(...nodeDiffs(id, was, got[id], pinsReasons));
  for (const id of Object.keys(got)) if (!(id in nodes)) diffs.push(`${id}: new`);
  diffs.push(...refusalDiffs(report, sc));
  return branchFirst(sc, { was: nodes, got }, diffs);
}

/**
 * The diffs with the decision named first, where the scenario proves a branch and its switch no longer routes where
 * the recording did, so a decision is named before the nodes that moved with it.
 */
function branchFirst(
  sc: ScenarioDoc,
  nodes: { was: Record<string, ScenarioNode>; got: Record<string, ScenarioNode> },
  diffs: string[],
): string[] {
  const branch = sc.branch;
  const at = branch && switchPath(nodes.was, branch);
  if (!branch || at === undefined || !diffs.length) return diffs;
  if (nodes.got[at]?.selected === nodes.was[at].selected) return diffs;
  const [first, ...rest] = diffs;
  return [`branch '${branch.when}' → ${branch.to} no longer routes there: ${first}`, ...rest];
}

/**
 * Where a scenario's recording has the switch its branch names: under the node that ran the branch's graph, the
 * switch that routed. The graph is matched first, since two graphs of one run may each have a switch of that id.
 */
function switchPath(nodes: Record<string, ScenarioNode>, branch: { graph: string; node: string }): string | undefined {
  const ran = `graph:${branch.graph}`;
  for (const [id, node] of Object.entries(nodes))
    if (node.handler === ran && nodes[`${id}.${branch.node}`]?.selected !== undefined) return `${id}.${branch.node}`;
  return undefined;
}

/** One scenario replayed: whether the run matched what it recorded, and each difference said in words. */
export interface Replayed {
  scenario: string;
  same: boolean;
  diffs: string[];
}

/** What `regress` answers: whether every scenario replayed the same, one line and one result per scenario. */
export interface Regression {
  ok: boolean;
  lines: string[];
  results: Replayed[];
}

/**
 * Replay every scenario with its recorded stubs, under the profile `activeProfile` picks, and diff the report node by
 * node. A scenario whose trigger the profile does not serve (`walkedUnder`) is not replayed, and the last lines say
 * how many and where their triggers are served.
 */
export async function regress(load: LoadResult, opts: { profile?: string } = {}): Promise<Regression> {
  const profile = activeProfile(load.registry.project?.doc, { flag: opts.profile, env: process.env });
  const replayer = replayerFor(load, profile);
  const scope = new Scope(load.registry, load.resolve);
  const results: Replayed[] = [];
  const lines: string[] = [];
  const unserved: Loaded<TriggerDoc>[] = [];
  for (const sc of load.registry.all('scenario')) {
    const trigger = triggerOf(load, sc.doc);
    // S001 has already refused a scenario whose trigger is gone; skip rather than replay nothing.
    if (!trigger) {
      const gone = `names unknown trigger '${sc.doc.trigger}'`;
      results.push({ scenario: sc.path, same: false, diffs: [gone] });
      lines.push(`${sc.path}: ${gone}`);
      continue;
    }
    if (!walkedUnder(scope, trigger.doc, profile)) {
      unserved.push(trigger);
      continue;
    }
    const diffs = await replayedDiffs(load, replayer, sc, trigger);
    results.push({ scenario: sc.path, same: diffs.length === 0, diffs });
    lines.push(`${sc.path}: ${diffs.length ? `DIFF ${diffs.join('; ')}` : 'same'}`);
  }
  lines.push(...skippedLines(scope, profile, unserved, 'scenario(s) whose trigger'));
  return { ok: results.every(one => one.same), lines, results };
}

/**
 * How one served scenario replays: its pointers resolved once (`nodesOf`, `stubsOf`), fired again with its recorded
 * stubs and diffed, or -- where it recorded its branch unreachable, and so has nothing to run -- solved again
 * (`solvedAgain`, RFC 0018). A pointer its answers document does not hold is a difference, and nothing is fired.
 */
async function replayedDiffs(
  load: LoadResult,
  replayer: Replayer,
  loaded: Loaded<ScenarioDoc>,
  trigger: Loaded<TriggerDoc>,
): Promise<string[]> {
  const sc = loaded.doc;
  if (sc.expect.status === 'unreachable') return solvedAgain(load, sc, trigger, replayer.stubbed.profile);
  const above = answersAbove(load.registry, loaded.path);
  const { nodes, unresolved } = nodesOf(sc, above.own?.doc);
  const { stubs, unresolved: unstubbed } = stubsOf(sc, above.own?.doc);
  if (unresolved.length || unstubbed.length) return unheldDiffs(sc, above, { unresolved, unstubbed });
  const report = await replayedReport(load, replayer, sc, { trigger, stubs });
  return diffOf(report, sc, nodes, secretPaths(replayer.emb.types(replayedDoc(load, sc, trigger)).out));
}

/**
 * The pointers of a scenario that do not resolve, one difference each: `op.x: points at <digest>, which <file> does not
 * hold`, `stub op.x: ...` for a stub, or, with no answers document of its own, why (`unreadSaid`, as `describe` says).
 */
function unheldDiffs(
  sc: ScenarioDoc,
  above: ReturnType<typeof answersAbove>,
  paths: { unresolved: string[]; unstubbed: string[] },
): string[] {
  const holder = above.own ? `which ${above.own.path.slice(1)} does not hold` : `and ${unreadSaid(above, sc)}`;
  const nodes = paths.unresolved.map(path => `${path}: points at ${sc.expect.nodes[path]}, ${holder}`);
  const stubs = paths.unstubbed.map(path => `stub ${path}: points at ${sc.sharedStubs?.[path]}, ${holder}`);
  return [...nodes, ...stubs];
}
