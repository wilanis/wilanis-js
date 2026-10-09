/**
 * `wilanis rehearse --record` and `--check`: the runs the branch solver made, written to the tree as scenario
 * documents under a directory the command owns, and that directory compared with what the tree would write today
 * (RFC 0018). Rendering is pure, so the directory is a function of the tree and the one seed it is solved under;
 * what the directory may be and what in it is owned is `recorded-dir.ts`'s.
 */
import { featureOf, type ScenarioBranch, type ScenarioDoc, schemaUrl, stem } from '@wilanis/core';
import { type Report, refusalOf } from '@wilanis/engine';
import { expectOf } from './fuzz.js';
import { checkRecorded, keptIn, type RecordCheck, writeRecorded } from './recorded-dir.js';
import { RECORDED, REHEARSED } from './recorded-owner.js';

/** What `--check` says after the files it lists: the one command that brings the directory back. */
export const RECORD_HINT = 'run wilanis rehearse --record and review the diff';

/** What names a recorded scenario, and so its file: the way in, the decision it proves, and the seed. */
interface Named {
  /** The trigger the scenario replays through: for a policy's decision, an attaching one whose kind the run borrowed. */
  trigger: { path: string; name: string };
  /** The policy whose `decide` the run fired in the trigger's place, for a policy's decision. */
  policy?: { path: string; name: string };
  /**
   * The decision the run proves; none for a trigger with no switch under it, which one run covers whole. `n` is the
   * case's position among its switch's cases (a rule's index, then the else, then each catch), set only where another
   * case of the switch routes to the same node, so the common case is named by its target alone.
   */
  branch?: ScenarioBranch & { n?: number };
  seed: number;
}

/** One run the rehearsal made, as it is recorded: what was fired, what every effect answered, what it produced. */
export interface RecordedRun extends Named {
  input: unknown;
  context: Record<string, unknown>;
  /** Every effect's answer by dotted node path: what the run generated, with what the case stubbed written over it. */
  stubs: Record<string, unknown>;
  report: Report;
  /** Where the trigger's `out` marks a field secret: the output is written with those as the marker. */
  secret: string[][];
}

/**
 * A branch the solver could not reach, as it is recorded: nothing ran, so there is no input, no stub and no report,
 * only why -- the sentence the rehearsal prints after `NEVER RUN` -- so the fix that reaches it is a diff (RFC 0018).
 */
export interface UnreachedBranch extends Named {
  branch: NonNullable<Named['branch']>;
  unreachable: string;
}

/** What the rehearsal records of one branch or one whole trigger: the run it made, or why it could make none. */
export type Recording = RecordedRun | UnreachedBranch;

const WRITTEN = 'Written by wilanis rehearse --record; regenerate it, do not edit it.';

/** How a run ended, as the tail of a sentence about it. */
function endedAs(report: Report): string {
  const reason = refusalOf(report)?.reason;
  if (reason !== undefined) return `refuses as ${reason}`;
  if (report.status === 'done') return 'answers';
  if (report.status === 'failed') return 'fails';
  return report.status === 'blocked' ? 'blocks' : 'is cancelled';
}

/**
 * A document's feature and file stem, read off its canonical path as core reads them (`featureOf`, `stem`):
 * `@features/customers/data/get-row.graph.json` is `customers` and `get-row`. A path in no feature answers its first
 * segment in the feature's place.
 */
function partsOf(path: string): { feature: string; stem: string } {
  const rel = path.replace(/^@/, '');
  return { feature: featureOf(rel) ?? rel.split('/')[0], stem: stem(rel) };
}

/** A branch as a recorded scenario's first line says it: the graph, the switch, the rule and where it routes. */
function provenAs({ graph, node, when, to }: ScenarioBranch): string {
  const rule = when === 'else' ? 'otherwise' : `when ${when}`;
  return `${partsOf(graph).stem} '${node}' ${rule} routes to ${to}`;
}

/** What a recorded scenario says it proves, in its first line: how its run ended, or why no input reaches it. */
function descriptionOf(run: Recording): string {
  const way = run.policy ? `${run.policy.name} as attached by ${run.trigger.name}` : run.trigger.name;
  if ('unreachable' in run)
    return `${way}: ${provenAs(run.branch)}, and no input reaches it: ${run.unreachable}. ${WRITTEN}`;
  const ended = endedAs(run.report);
  if (!run.branch) return `${way}: no switch under it, so one run is the whole of it, and it ${ended}. ${WRITTEN}`;
  return `${way}: ${provenAs(run.branch)}, which ${ended}. ${WRITTEN}`;
}

/** The stubs in the order of their paths, so the file does not depend on the order the effects happened to answer in. */
const sorted = (stubs: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(stubs).sort(([one], [other]) => (one < other ? -1 : Number(one > other))));

/**
 * The scenario one recorded run is written as. A branch no input reaches is written with nothing to run -- no `in`, no
 * `context`, no `stubs` -- and an expectation that says why, which `regress` answers by solving the branch again.
 */
export function scenarioOf(run: Recording): ScenarioDoc {
  const branch = run.branch && {
    graph: run.branch.graph,
    node: run.branch.node,
    when: run.branch.when,
    to: run.branch.to,
  };
  const named = {
    $schema: schemaUrl('scenario'),
    description: descriptionOf(run),
    generated: 'rehearse' as const,
    trigger: run.trigger.path,
    ...(run.policy ? { policy: run.policy.path } : {}),
    ...(branch ? { branch } : {}),
    seed: run.seed,
  };
  if ('unreachable' in run)
    return { ...named, expect: { status: 'unreachable', nodes: {}, unreachable: run.unreachable } };
  return {
    ...named,
    in: run.input,
    context: run.context,
    stubs: sorted(run.stubs),
    expect: expectOf(run.report, run.secret),
  };
}

/** Where the policies' decisions are recorded, inside the recorded directory: no trigger's directory, which holds a dot. */
const POLICIES = 'policies';

/**
 * The directory a document's recorded runs sit in: `<feature>.<stem>`. D009 keeps a feature's name unique across the
 * tree and every tree it includes, so two features' triggers, or policies, of one name never share one -- a host's
 * beside an included library's among them, which the host cannot rename.
 */
export function dirOf(doc: { path: string }): string {
  const { feature, stem: name } = partsOf(doc.path);
  return `${feature}.${name}`;
}

/**
 * The directory one run is recorded in, inside the recorded directory: its trigger's, or for a policy's decision the
 * policy's under `policies/`, since that run replays the decision and the trigger only lends it a kind.
 */
const underOf = (run: Named) => (run.policy ? `${POLICIES}/${dirOf(run.policy)}` : dirOf(run.trigger));

/**
 * Where one recorded run is written, inside the recorded directory: `<feature>.<trigger stem>/<feature>.<graph
 * stem>.<switch id>.<to>[.<n>].scenario.json`, or `<feature>.<trigger stem>/whole.scenario.json` for a trigger with no
 * switch, and a policy's decision the same under `policies/<feature>.<policy stem>/`. Named by what it proves, so a
 * reorder of rules moves nothing and a change of target renames one file.
 */
export function fileOf(run: Named): string {
  const under = underOf(run);
  if (!run.branch) return `${under}/whole.scenario.json`;
  const { feature, stem: graph } = partsOf(run.branch.graph);
  const nth = run.branch.n === undefined ? '' : `.${run.branch.n}`;
  return `${under}/${feature}.${graph}.${run.branch.node}.${run.branch.to}${nth}.scenario.json`;
}

/**
 * A command that writes a directory of scenarios, as its lines name it: the directory, what writes the files the tree
 * would have there (`the solver`), the command a file it did not write is said not to be written by (`--record`), and
 * the hint that brings the directory back.
 */
export interface Writer {
  dir: string;
  writes: string;
  by: string;
  hint: string;
}

/** How the lines name `rehearse --record` over the directory it recorded. */
export const recorder = (dir: string): Writer => ({ dir, writes: 'the solver', by: REHEARSED.by, hint: RECORD_HINT });

/** What `--check` prints: one line per file that differs, then how many and the one command, or that it is current. */
export function checkLines(writer: Writer, check: RecordCheck, files: number): string[] {
  const lines = [
    ...check.stale.map(file => `stale    ${file}`),
    ...check.missing.map(file => `missing  ${file}`),
    ...check.extra.map(file => `extra    ${file}`),
  ];
  const what = `what ${writer.writes} writes for this tree`;
  if (!lines.length) return [`${writer.dir}/ is ${what}: ${files} file(s)`];
  return [...lines, `${lines.length} file(s) differ from ${what} -- ${writer.hint}`];
}

/** What `--record` or `--check` did with the runs: the directory, how many files it holds, and what was written or found. */
export interface Recorded {
  dir: string;
  files: number;
  /** Under `--record`: every file written, root-relative. */
  written?: string[];
  /** Under `--check`: how the directory differs from what the tree writes today. */
  check?: RecordCheck;
  /** The scenarios under the directory that `--record` did not write, left as they are, root-relative. */
  kept: string[];
}

/**
 * The runs as documents by file. Where two runs of one trigger name one file the first keeps it, since they prove one
 * branch. Two triggers of one feature and one name -- one under `edge/`, one under `edge/v2/` -- would share a
 * directory, and are refused, naming both, rather than one's runs being dropped for the other's; two policies alike.
 */
function docsOf(runs: Recording[]): Record<string, ScenarioDoc> {
  const held = new Map<string, string>();
  const docs: Record<string, ScenarioDoc> = {};
  for (const run of runs) {
    const under = underOf(run);
    claimDir(held, under, { path: (run.policy ?? run.trigger).path, what: run.policy ? 'policy' : 'trigger' });
    const file = fileOf(run);
    if (!(file in docs)) docs[file] = scenarioOf(run);
  }
  return docs;
}

const MANY = { trigger: 'triggers', policy: 'policies' };

/**
 * Hold a directory, by the path of the trigger or policy whose runs it holds (`held`). A second of one feature and
 * one name would share it, and is refused, naming both.
 */
export function claimDir(
  held: Map<string, string>,
  under: string,
  owner: { path: string; what: keyof typeof MANY },
): void {
  const other = held.get(under) ?? owner.path;
  if (other !== owner.path) throw new Error(sameDir(under, [other, owner.path], owner.what));
  held.set(under, owner.path);
}

/** Why two triggers, or policies, of one feature and one name cannot both be recorded, and the files to rename one of. */
function sameDir(under: string, paths: string[], what: keyof typeof MANY): string {
  const [one, two] = paths.sort();
  const { feature, stem: name } = partsOf(one);
  return (
    `two ${MANY[what]} of feature '${feature}' are named '${name}', and a recorded ${what}'s scenarios are written ` +
    `under its feature and name (${under}/): rename ${one} or ${two}`
  );
}

/** Write the runs to the recorded directory, or under `check` compare them with it and write nothing. */
export function recordRuns(root: string, how: { record?: string; check?: boolean }, runs: Recording[]): Recorded {
  const dir = how.record ?? RECORDED;
  const docs = docsOf(runs);
  const files = Object.keys(docs).length;
  if (how.check) return { dir, files, check: checkRecorded(root, dir, docs), kept: keptIn(root, dir, docs) };
  const written = writeRecorded(root, dir, docs);
  return { dir, files, written, kept: keptIn(root, dir, docs) };
}

/** Whether the recorded directory is what the tree writes: always under `--record`, which just wrote it. */
export const current = (recorded: Recorded) =>
  !recorded.check || Object.values(recorded.check).every(list => list.length === 0);

/**
 * What `--record` or `--check` says after the rehearsal, or what another writer of a directory says of it, and last
 * the scenarios it left, where it left any.
 */
export function recordedLines(recorded: Recorded, writer = recorder(recorded.dir)): string[] {
  const said = recorded.check
    ? checkLines(writer, recorded.check, recorded.files)
    : [`wrote ${recorded.files} scenario(s) under ${writer.dir}/ -- regenerate them, do not edit them`];
  return [...said, ...recorded.kept.map(file => `kept     ${file} -- not written by ${writer.by}, so left as it is`)];
}
