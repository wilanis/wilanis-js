/**
 * `wilanis fuzz --edges` and its `--check` (RFC 0018): every trigger fired once per fixed edge of its input type
 * (`edges` in core) -- the seed's input with that one field set, the seed's context, every effect stubbed and
 * recorded -- and each run written as a scenario under `scenarios/edges/`, the directory the command owns, or under
 * `--check` compared with what is there. It fires under seed 1 and the profile project.json marks default, as
 * `rehearse --record` solves, so the directory is a function of the tree alone.
 */
import { join } from 'node:path';
import { walkedUnder } from '@wilanis/compiler';
import {
  type Edge,
  edges,
  generate,
  type Loaded,
  type LoadResult,
  rng,
  type ScenarioDoc,
  Scope,
  schemaUrl,
  secretPaths,
  type TriggerDoc,
  type Type,
  typeAt,
} from '@wilanis/core';
import { outcomeOf, type Report } from '@wilanis/engine';
import { expectOf } from './fuzz.js';
import { recordedProfile, skippedLines } from './profile.js';
import type { Recorded } from './record.js';
import { checkRecorded, EDGED, EDGES, keptIn, type RecordCheck, writeRecorded } from './recorded-dir.js';
import { embedderFor, generatedFire } from './stubbing.js';
import { getPath, setPath } from './stubs.js';

/**
 * What `fuzz` answers: whether no run faulted, every file written, a line per fault, what the profile skipped, and
 * under `edges` the directory it owns with what was written to it or found different in it.
 */
export interface Fuzzing {
  ok: boolean;
  written: string[];
  lines: string[];
  skipped: string[];
  recorded?: Recorded;
}

/** The seed every edge is fired under: the one `--record` solves under, so no number given changes the directory. */
const SEED = 1;

/** What `--check` says after the files it lists: the one command that brings the directory back. */
export const EDGES_HINT = 'run wilanis fuzz --edges and review the diff';

/** What may not be given beside `--edges`, each since it would make the directory depend on more than the tree. */
export const BESIDE_EDGES: Record<string, string> = {
  runs: 'fuzz --edges fires each trigger once per edge of its input, not once per seed: drop --runs',
  seed: `${EDGES}/ is fired under seed 1: drop --seed`,
  profile:
    `${EDGES}/ is fired under the profile project.json marks "default": true, whatever --profile or ` +
    'WILANIS_PROFILE say, so that it is a function of the tree alone: drop --profile',
  out: `fuzz --edges writes ${EDGES}/ and no other directory: drop --out`,
  json: "fuzz --edges prints no envelope, and an envelope for staleness is RFC 0019's to add: drop --json",
};

/** One edge's run: the trigger, the edge, what it was fired with, what every effect answered, and its report. */
interface EdgeRun {
  trigger: Loaded<TriggerDoc>;
  edge: Edge;
  input: unknown;
  context: Record<string, unknown>;
  stubs: Record<string, unknown>;
  report: Report;
  /** Where the trigger's `out` marks a field secret: the output is written with those as the marker. */
  secret: string[][];
}

/** What firing the edges gathers: each run's scenario by file, and a line per run that faulted. */
interface Gathered {
  docs: Record<string, ScenarioDoc>;
  faults: string[];
  /** The path of the trigger that holds each trigger's directory, by the directory. */
  dirs: Map<string, string>;
}

/**
 * Fire every trigger the default profile serves once per edge of its input and write each run under
 * `scenarios/edges/` -- or under `check` compare them with it and write nothing -- but never one of a fault, which
 * is said instead, as plain fuzz says it. A trigger with no input, or none whose values are the caller's to choose,
 * has no edge and no file. Throws for an option that would make the directory depend on more than the tree.
 */
export async function fuzzEdges(
  load: LoadResult,
  opts: { edges?: boolean; check?: boolean; runs?: number; profile?: string; out?: string } = {},
): Promise<Fuzzing> {
  if (!opts.edges) throw new Error(`check says whether ${EDGES}/ is what fuzz --edges writes: fuzz --edges --check`);
  const beside = Object.keys(BESIDE_EDGES).find(key => (opts as Record<string, unknown>)[key] !== undefined);
  if (beside) throw new Error(BESIDE_EDGES[beside]);
  const profile = recordedProfile(load.registry.project?.doc);
  const scope = new Scope(load.registry, load.resolve);
  const triggers = load.registry.all('trigger');
  const gathered: Gathered = { docs: {}, faults: [], dirs: new Map() };
  for (const trigger of triggers)
    if (walkedUnder(scope, trigger.doc, profile)) await fireEdges(load, { trigger, profile }, gathered);
  const recorded = recordedOf(load.root, gathered.docs, opts.check);
  const written = (recorded.written ?? []).map(file => join(load.root, file));
  const skipped = skippedLines(scope, profile, triggers, 'trigger(s)');
  return { ok: gathered.faults.length === 0, written, lines: gathered.faults, skipped, recorded };
}

/** Write the scenarios to the edges directory, or under `check` compare them with it and write nothing. */
function recordedOf(root: string, docs: Record<string, ScenarioDoc>, check?: boolean): Recorded {
  const done = check
    ? { check: checkRecorded(root, EDGES, docs, EDGED) }
    : { written: writeRecorded(root, EDGES, docs, EDGED) };
  return { dir: EDGES, files: Object.keys(docs).length, ...done, kept: keptIn(root, EDGES, docs, EDGED) };
}

/** Fire one trigger once per edge of its input, each run from the seed's input and context. */
async function fireEdges(load: LoadResult, how: { trigger: Loaded<TriggerDoc>; profile?: string }, into: Gathered) {
  const { trigger } = how;
  const emb = embedderFor(load, { seed: SEED, profile: how.profile });
  const type = emb.types(trigger.doc).in;
  if (!type) return;
  claim(into, trigger);
  const { input, context } = generatedFire(emb, trigger, SEED);
  for (const edge of edges(type)) {
    const run = await fired(load, how, { edge, input: withEdge(input, type, edge), context });
    const outcome = outcomeOf(run.report);
    if (outcome.kind === 'faulted')
      into.faults.push(`${trigger.path} with ${edgeSaid(edge)}: FAULT at '${outcome.at}': ${outcome.error}`);
    else into.docs[fileOf(trigger, edge)] = scenarioOf(run);
  }
}

/** One run of a trigger with an edge set, every effect stubbed under the seed and recorded. */
async function fired(
  load: LoadResult,
  how: { trigger: Loaded<TriggerDoc>; profile?: string },
  given: { edge: Edge; input: unknown; context: Record<string, unknown> },
): Promise<EdgeRun> {
  const stubs: Record<string, unknown> = {};
  const emb = embedderFor(load, { seed: SEED, record: stubs, profile: how.profile });
  const report = await emb.fire(how.trigger.doc, given.input, given.context);
  return { trigger: how.trigger, ...given, stubs, report, secret: secretPaths(emb.types(how.trigger.doc).out) };
}

/**
 * The seed's input with one edge set, `absent` removing the key. An edge inside an object the seed left out is set
 * in one generated whole under the same seed, so the input stays a value of its type.
 */
function withEdge(input: unknown, type: Type, edge: Edge): unknown {
  let base = input;
  for (let depth = 1; depth < edge.at.length; depth++) {
    const parent = edge.at.slice(0, depth);
    const read = typeAt(type, parent);
    if (getPath(base, parent) === undefined && typeof read !== 'string')
      base = setPath(base, parent, generate(read.type, rng(SEED)));
  }
  return setPath(base, edge.at, edge.value);
}

/**
 * The directory a trigger's edges sit in, `<feature>.<trigger stem>`, as its recorded runs do: D009 keeps a
 * feature's name unique across the tree and the trees it includes, so an included trigger and a host's of one name
 * sit apart.
 */
const triggerDir = (trigger: Loaded<TriggerDoc>) => `${trigger.feature}.${trigger.name}`;

/**
 * Hold a trigger's directory for it. Two triggers of one feature and one name -- one under `edge/`, one under
 * `edge/v2/` -- would share one, and are refused, naming both, rather than one's runs being written over the other's.
 */
function claim(into: Gathered, trigger: Loaded<TriggerDoc>): void {
  const under = triggerDir(trigger);
  const other = into.dirs.get(under) ?? trigger.path;
  if (other !== trigger.path) {
    const [one, two] = [other, trigger.path].sort();
    throw new Error(
      `two triggers of feature '${trigger.feature}' are named '${trigger.name}', and a trigger's edges are written ` +
        `under its feature and name (${EDGES}/${under}/): rename ${one} or ${two}`,
    );
  }
  into.dirs.set(under, trigger.path);
}

/**
 * Where one edge's run is written inside the edges directory,
 * `<feature>.<trigger stem>/<dotted field>.<edge>.scenario.json`, each part escaped as a URI component, so an enum
 * member that holds a `/` names a file and not a directory.
 */
function fileOf(trigger: Loaded<TriggerDoc>, edge: Edge): string {
  return `${triggerDir(trigger)}/${[...edge.at, edge.name].map(encodeURIComponent).join('.')}.scenario.json`;
}

/** An edge in words: the dotted field and the edge's name, `id empty` or `tier absent`. */
const edgeSaid = (edge: Edge) => [edge.at.join('.') || 'the input', edge.name].join(' ');

/** The stubs in the order of their paths, so the file does not depend on the order the effects happened to answer in. */
const sorted = (stubs: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(stubs).sort(([one], [other]) => (one < other ? -1 : Number(one > other))));

/** The scenario one edge's run is written as. */
function scenarioOf(run: EdgeRun): ScenarioDoc {
  return {
    $schema: schemaUrl('scenario'),
    description: `${run.trigger.name} under seed ${SEED} with ${edgeSaid(run.edge)}: ${run.report.status}. Written by wilanis fuzz --edges; regenerate it, do not edit it.`,
    generated: 'edges',
    trigger: run.trigger.path,
    seed: SEED,
    in: run.input,
    context: run.context,
    stubs: sorted(run.stubs),
    expect: expectOf(run.report, run.secret),
  };
}

/** What `--check` found: one line per file that differs, then how many and the one command, or that it is current. */
function checkLines(check: RecordCheck, files: number): string[] {
  const lines = [
    ...check.stale.map(file => `stale    ${file}`),
    ...check.missing.map(file => `missing  ${file}`),
    ...check.extra.map(file => `extra    ${file}`),
  ];
  if (!lines.length) return [`${EDGES}/ is what fuzz --edges writes for this tree: ${files} file(s)`];
  return [...lines, `${lines.length} file(s) differ from what fuzz --edges writes for this tree -- ${EDGES_HINT}`];
}

/** What `fuzz --edges` says of its directory: what it wrote or found, and last the scenarios it left, where it left any. */
export function edgesLines(recorded: Recorded): string[] {
  const said = recorded.check
    ? checkLines(recorded.check, recorded.files)
    : [`wrote ${recorded.files} scenario(s) under ${EDGES}/ -- regenerate them, do not edit them`];
  return [...said, ...recorded.kept.map(file => `kept     ${file} -- not written by fuzz --edges, so left as it is`)];
}
