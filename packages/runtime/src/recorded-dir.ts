/**
 * The directory `wilanis rehearse --record` owns (RFC 0018): where it may be, and how the scenarios in it are written,
 * removed and compared with what the tree writes today. Everything under it is owned and nothing else is: not the
 * scenarios a person or fuzz wrote, and not what a link inside it leads to.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ScenarioDoc } from '@wilanis/core';
import { SCENARIOS as FUZZED, HOME_DIR } from './fuzz.js';

/** Where `--record` writes, under the root, when the flag names no directory. */
export const RECORDED = `${HOME_DIR}/rehearsed`;

/** The bytes a scenario is written as. */
const rendered = (doc: ScenarioDoc) => `${JSON.stringify(doc, null, 2)}\n`;

/** Whether `abs` is strictly inside `root`. */
function strictlyInside(root: string, abs: string): boolean {
  const inside = relative(root, abs);
  return Boolean(inside) && !inside.startsWith('..') && !isAbsolute(inside);
}

/** The real path of a path that may not exist yet: its nearest existing ancestor's, followed by the rest as written. */
function realOf(abs: string): string {
  const rest: string[] = [];
  let at = abs;
  for (; !existsSync(at) && dirname(at) !== at; at = dirname(at)) rest.unshift(basename(at));
  return join(realpathSync(at), ...rest);
}

/**
 * Whether a path below the root may hold the recorded directory: strictly below the scenarios' home, where no
 * hand-written scenario sits in it, and outside what fuzz owns.
 */
function ownable(root: string, abs: string): boolean {
  const inside = relative(root, abs).split(sep).join('/');
  const fuzzed = inside === FUZZED || inside.startsWith(`${FUZZED}/`);
  return inside.startsWith(`${HOME_DIR}/`) && !fuzzed;
}

/**
 * Why `dir` may not be the recorded directory, or nothing. Everything in it is owned -- a scenario `--record` did not
 * write there is removed -- so it may not hold the scenarios a person wrote or the ones fuzz wrote. It is judged on
 * the real paths too, so a link on the way cannot carry the directory anywhere else.
 */
export function refusedDir(root: string, dir: string): string | undefined {
  const abs = resolve(root, dir);
  const where = `it may be any directory below ${HOME_DIR}/ outside ${FUZZED}/, as ${RECORDED}/ is`;
  if (!ownable(resolve(root), abs))
    return `--record owns ${dir} and removes every scenario in it that it did not write: ${where}`;
  const real = realOf(abs);
  if (!ownable(realOf(resolve(root)), real))
    return `the recorded directory ${dir} leads through a link to ${real}: ${where}`;
  return undefined;
}

/** The recorded directory `record` names, `scenarios/rehearsed` where it names none; throws where `refusedDir` refuses it. */
export function recordedDir(root: string, record?: string): string {
  const dir = record ?? RECORDED;
  const refused = refusedDir(root, dir);
  if (refused) throw new Error(refused);
  return dir;
}

/** The recorded directory on disk, where `refusedDir` accepts it, since everything in it is owned. */
const ownedDir = (root: string, dir: string) => resolve(root, recordedDir(root, dir));

/**
 * Every scenario file under the directory, by its path inside it with `/` between segments: only regular files, and
 * only below real directories, since a link inside it may lead anywhere and what it leads to is not owned.
 */
function onDisk(abs: string): string[] {
  if (!existsSync(abs)) return [];
  const found: string[] = [];
  scenarioFiles(abs, [], found);
  return found.sort();
}

/** The scenario files under one directory, walked through its real subdirectories and never through a link. */
function scenarioFiles(at: string, prefix: string[], into: string[]): void {
  for (const entry of readdirSync(at, { withFileTypes: true })) {
    const path = [...prefix, entry.name];
    if (entry.isDirectory()) scenarioFiles(join(at, entry.name), path, into);
    else if (entry.isFile() && entry.name.endsWith('.scenario.json')) into.push(path.join('/'));
  }
}

/** The files a write would reach through a link inside the directory, and so possibly outside the tree. */
function throughLinks(abs: string, files: string[]): string[] {
  const home = realOf(abs);
  return files.filter(file => {
    const target = join(abs, file);
    const parent = realOf(dirname(target));
    const linked = lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
    return linked || (parent !== home && !strictlyInside(home, parent));
  });
}

/**
 * Write every recorded scenario under `dir` and remove every `*.scenario.json` under it this run did not write, with
 * any directory that leaves empty; nothing outside `dir` is touched, and nothing is reached through a link in it.
 * Answers the files written, root-relative.
 */
export function writeRecorded(root: string, dir: string, docs: Record<string, ScenarioDoc>): string[] {
  const abs = ownedDir(root, dir);
  const linked = throughLinks(abs, Object.keys(docs));
  if (linked.length)
    throw new Error(
      `${linked.map(file => `${dir}/${file}`).join(', ')} would be written through a link, which may lead out of ` +
        'the tree; the recorded directory holds only what --record writes: remove the link',
    );
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
