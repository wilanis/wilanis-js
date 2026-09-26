/**
 * `wilanis rehearse --record` and `--check`: the runs the branch solver made, written to the tree as scenario
 * documents under a directory the command owns, and that directory compared with what the tree would write today
 * (RFC 0018). Rendering is pure, so the directory is a function of the tree and the one seed it is solved under.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { type ScenarioBranch, type ScenarioDoc, schemaUrl } from '@wilanis/core';
import { type Report, refusalOf } from '@wilanis/engine';
import { expectOf, HOME_DIR } from './fuzz.js';

/** Where `--record` writes, under the root, when the flag names no directory. */
export const RECORDED = `${HOME_DIR}/rehearsed`;

/** What `--check` says after the files it lists: the one command that brings the directory back. */
export const RECORD_HINT = 'run wilanis rehearse --record and review the diff';

/** One run the rehearsal made, as it is recorded: what was fired, what every effect answered, what it produced. */
export interface RecordedRun {
  trigger: { path: string; name: string };
  /**
   * The decision the run proves; none for a trigger with no switch under it, which one run covers whole. `n` is the
   * case's position among its switch's cases (a rule's index, then the else, then each catch), set only where another
   * case of the switch routes to the same node, so the common case is named by its target alone.
   */
  branch?: ScenarioBranch & { n?: number };
  seed: number;
  input: unknown;
  request: Record<string, unknown>;
  /** Every effect's answer by dotted node path: what the run generated, with what the case stubbed written over it. */
  stubs: Record<string, unknown>;
  report: Report;
}

const WRITTEN = 'Written by wilanis rehearse --record; regenerate it, do not edit it.';

/** How a run ended, as the tail of a sentence about it. */
function endedAs(report: Report): string {
  const reason = refusalOf(report)?.reason;
  if (reason !== undefined) return `refuses as ${reason}`;
  if (report.status === 'done') return 'answers';
  if (report.status === 'failed') return 'fails';
  return report.status === 'blocked' ? 'blocks' : 'is cancelled';
}

/** The graph's feature and file stem, read off its canonical path: `@features/customers/data/get-row.graph.json`. */
function graphParts(graph: string): { feature: string; stem: string } {
  const segments = graph.replace(/^@/, '').split('/');
  const feature = segments[0] === 'features' && segments.length > 2 ? segments[1] : segments[0];
  const stem = (segments.at(-1) ?? graph).replace(/\.graph\.json$/, '');
  return { feature, stem };
}

/** What a recorded scenario says it proves, in its first line. */
function descriptionOf(run: RecordedRun): string {
  const ended = endedAs(run.report);
  if (!run.branch)
    return `${run.trigger.name}: no switch under it, so one run is the whole of it, and it ${ended}. ${WRITTEN}`;
  const { graph, node, when, to } = run.branch;
  const rule = when === 'else' ? 'otherwise' : `when ${when}`;
  return `${run.trigger.name}: ${graphParts(graph).stem} '${node}' ${rule} routes to ${to}, which ${ended}. ${WRITTEN}`;
}

/** The stubs in the order of their paths, so the file does not depend on the order the effects happened to answer in. */
const sorted = (stubs: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(stubs).sort(([one], [other]) => (one < other ? -1 : Number(one > other))));

/** The scenario one recorded run is written as. */
export function scenarioOf(run: RecordedRun): ScenarioDoc {
  const branch = run.branch && {
    graph: run.branch.graph,
    node: run.branch.node,
    when: run.branch.when,
    to: run.branch.to,
  };
  return {
    $schema: schemaUrl('scenario'),
    description: descriptionOf(run),
    generated: 'rehearse',
    trigger: run.trigger.path,
    ...(branch ? { branch } : {}),
    seed: run.seed,
    in: run.input,
    request: run.request,
    stubs: sorted(run.stubs),
    expect: expectOf(run.report),
  };
}

/**
 * Where one recorded run is written, inside the recorded directory: `<trigger stem>/<feature>.<graph stem>.<switch
 * id>.<to>[.<n>].scenario.json`, or `<trigger stem>/whole.scenario.json` for a trigger with no switch. Named by what
 * it proves, so a reorder of rules moves nothing and a change of target renames one file.
 */
export function fileOf(run: RecordedRun): string {
  if (!run.branch) return `${run.trigger.name}/whole.scenario.json`;
  const { feature, stem } = graphParts(run.branch.graph);
  const nth = run.branch.n === undefined ? '' : `.${run.branch.n}`;
  return `${run.trigger.name}/${feature}.${stem}.${run.branch.node}.${run.branch.to}${nth}.scenario.json`;
}

/** The bytes a scenario is written as. */
const rendered = (doc: ScenarioDoc) => `${JSON.stringify(doc, null, 2)}\n`;

/** The recorded directory on disk, refused when it is not strictly inside the root, since everything in it is owned. */
function ownedDir(root: string, dir: string): string {
  const abs = resolve(root, dir);
  const inside = relative(resolve(root), abs);
  if (!inside || inside.startsWith('..') || isAbsolute(inside))
    throw new Error(`the recorded directory must be inside the tree: ${dir}`);
  return abs;
}

/** Every scenario file under the directory, by its path inside it with `/` between segments. */
function onDisk(abs: string): string[] {
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { recursive: true, encoding: 'utf8' })
    .filter(file => file.endsWith('.scenario.json'))
    .map(file => file.split(sep).join('/'))
    .sort();
}

/**
 * Write every recorded scenario under `dir` and remove every `*.scenario.json` under it this run did not write, with
 * any directory that leaves empty; nothing outside `dir` is touched. Answers the files written, root-relative.
 */
export function writeRecorded(root: string, dir: string, docs: Record<string, ScenarioDoc>): string[] {
  const abs = ownedDir(root, dir);
  for (const file of onDisk(abs)) if (!(file in docs)) removeOwned(abs, file);
  const written: string[] = [];
  for (const [file, doc] of Object.entries(docs).sort(([one], [other]) => (one < other ? -1 : 1))) {
    mkdirSync(dirname(join(abs, file)), { recursive: true });
    writeFileSync(join(abs, file), rendered(doc));
    written.push(`${dir}/${file}`);
  }
  return written;
}

/** Remove one owned file, and the directories above it inside `abs` that it leaves empty. */
function removeOwned(abs: string, file: string): void {
  unlinkSync(join(abs, file));
  for (let at = dirname(join(abs, file)); at !== abs && readdirSync(at).length === 0; at = dirname(at)) rmdirSync(at);
}

/** How the recorded directory differs from what the tree writes today, each list root-relative and sorted. */
export interface RecordCheck {
  /** On disk, with different bytes. */
  stale: string[];
  /** Would be written, and is not on disk. */
  missing: string[];
  /** On disk under the directory, and would not be written. */
  extra: string[];
}

/** Render every recorded scenario as `writeRecorded` would and compare the bytes with what is on disk; never writes. */
export function checkRecorded(root: string, dir: string, docs: Record<string, ScenarioDoc>): RecordCheck {
  const abs = ownedDir(root, dir);
  const present = new Set(onDisk(abs));
  const out: RecordCheck = { stale: [], missing: [], extra: [] };
  for (const [file, doc] of Object.entries(docs)) {
    if (!present.has(file)) out.missing.push(`${dir}/${file}`);
    else if (readFileSync(join(abs, file), 'utf8') !== rendered(doc)) out.stale.push(`${dir}/${file}`);
  }
  for (const file of present) if (!(file in docs)) out.extra.push(`${dir}/${file}`);
  for (const list of Object.values(out)) list.sort();
  return out;
}

/** What `--check` prints: one line per file that differs, then how many and the one command, or that it is current. */
export function checkLines(dir: string, check: RecordCheck, files: number): string[] {
  const lines = [
    ...check.stale.map(file => `stale    ${file}`),
    ...check.missing.map(file => `missing  ${file}`),
    ...check.extra.map(file => `extra    ${file}`),
  ];
  if (!lines.length) return [`${dir}/ is what the solver writes for this tree: ${files} file(s)`];
  return [...lines, `${lines.length} file(s) differ from what the solver writes for this tree -- ${RECORD_HINT}`];
}

/** What `--record` or `--check` did with the runs: the directory, how many files it holds, and what was written or found. */
export interface Recorded {
  dir: string;
  files: number;
  /** Under `--record`: every file written, root-relative. */
  written?: string[];
  /** Under `--check`: how the directory differs from what the tree writes today. */
  check?: RecordCheck;
}

/** The runs as documents by file, the first run named by a file keeping it. */
function docsOf(runs: RecordedRun[]): Record<string, ScenarioDoc> {
  const docs: Record<string, ScenarioDoc> = {};
  for (const run of runs) {
    const file = fileOf(run);
    if (!(file in docs)) docs[file] = scenarioOf(run);
  }
  return docs;
}

/** Write the runs to the recorded directory, or under `check` compare them with it and write nothing. */
export function recordRuns(root: string, how: { record?: string; check?: boolean }, runs: RecordedRun[]): Recorded {
  const dir = how.record ?? RECORDED;
  const docs = docsOf(runs);
  const files = Object.keys(docs).length;
  if (how.check) return { dir, files, check: checkRecorded(root, dir, docs) };
  return { dir, files, written: writeRecorded(root, dir, docs) };
}

/** Whether the recorded directory is what the tree writes: always under `--record`, which just wrote it. */
export const current = (recorded: Recorded) =>
  !recorded.check || Object.values(recorded.check).every(list => list.length === 0);

/** What `--record` or `--check` says after the rehearsal. */
export function recordedLines(recorded: Recorded): string[] {
  if (recorded.check) return checkLines(recorded.dir, recorded.check, recorded.files);
  return [`wrote ${recorded.files} scenario(s) under ${recorded.dir}/ -- regenerate them, do not edit them`];
}
