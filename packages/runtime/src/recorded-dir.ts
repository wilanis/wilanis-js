/**
 * The directories the scenario commands own (RFC 0018): where `wilanis rehearse --record` and `wilanis fuzz --edges`
 * may write, and how the scenarios in such a directory are written, removed and compared with what the tree writes
 * today. What a command owns is what it wrote, a scenario carrying its `generated` mark, and nothing else: not a
 * scenario a person or another command wrote, even one in the directory, and not what a link inside it leads to.
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
import { HOME, type ScenarioDoc } from '@wilanis/core';

/** The one directory placement says a scenario lives in (HOME, D008). */
export const HOME_DIR = HOME.scenario?.dir ?? 'scenarios';

/**
 * Where plain fuzz writes, under the root: a directory of its own inside the scenarios' home, so what fuzz owns sits
 * apart from what a person wrote and from what the other commands record (RFC 0018).
 */
export const SCENARIOS = `${HOME_DIR}/fuzz`;

/** Where `fuzz --edges` writes, under the root: the one directory it owns. */
export const EDGES = `${HOME_DIR}/edges`;

/** Where `--record` writes, under the root, when the flag names no directory. */
export const RECORDED = `${HOME_DIR}/rehearsed`;

/** The directories fuzz writes, plain and `--edges`, which `--record` may not own. */
const FUZZED = [SCENARIOS, EDGES];

/**
 * A command that owns a directory of scenarios: the `generated` mark on what it wrote, the words a refusal names it
 * by, and why a directory may not be its own.
 */
export interface Owner {
  generated: 'rehearse' | 'edges';
  by: string;
  refused: (root: string, dir: string) => string | undefined;
}

/** The bytes a scenario is written as. */
const rendered = (doc: ScenarioDoc) => `${JSON.stringify(doc, null, 2)}\n`;

/** A path below the root, with `/` between segments and without case, as a filesystem that ignores case reads it. */
const caseless = (root: string, abs: string) => relative(root, abs).split(sep).join('/').toLowerCase();

/** Whether `abs` is strictly inside `root`. */
function strictlyInside(root: string, abs: string): boolean {
  const inside = relative(root, abs);
  return Boolean(inside) && !inside.startsWith('..') && !isAbsolute(inside);
}

/**
 * The real path of a path that may not exist yet: its nearest existing ancestor's, followed by the rest as written.
 * The operating system's own answer (`realpathSync.native`), so a case-insensitive filesystem answers the case on
 * disk and `scenarios/FUZZ` is read as the `scenarios/fuzz` it is.
 */
function realOf(abs: string): string {
  const rest: string[] = [];
  let at = abs;
  for (; !existsSync(at) && dirname(at) !== at; at = dirname(at)) rest.unshift(basename(at));
  return join(realpathSync.native(at), ...rest);
}

/**
 * Whether a path below the root may hold the recorded directory: strictly below the scenarios' home, where no
 * hand-written scenario sits in it, and outside what fuzz writes, plain or `--edges`. Compared without case, since
 * on a filesystem that ignores it `Scenarios/fuzz` is fuzz's directory, and one not made yet has no case on disk.
 */
function ownable(root: string, abs: string): boolean {
  const inside = caseless(root, abs);
  const fuzzed = FUZZED.map(dir => dir.toLowerCase()).some(dir => inside === dir || inside.startsWith(`${dir}/`));
  return inside.startsWith(`${HOME_DIR.toLowerCase()}/`) && !fuzzed;
}

/**
 * Why `dir` may not be the recorded directory, or nothing: it sits apart from the scenarios a person keeps at the
 * home and from what fuzz owns. It is judged on the real paths too, so a link on the way cannot carry the directory
 * anywhere else.
 */
export function refusedDir(root: string, dir: string): string | undefined {
  const abs = resolve(root, dir);
  const outside = FUZZED.map(one => `${one}/`).join(' and ');
  const where = `it may be any directory below ${HOME_DIR}/ outside ${outside}, as ${RECORDED}/ is`;
  if (!ownable(resolve(root), abs))
    return `--record may not own ${dir}, beside the scenarios a person or fuzz wrote: ${where}`;
  const real = realOf(abs);
  if (!ownable(realOf(resolve(root)), real))
    return `the recorded directory ${dir} leads through a link to ${real}: ${where}`;
  return undefined;
}

/**
 * Why `dir` may not be what `fuzz --edges` owns, or nothing: it is `scenarios/edges/` and no other, on the path as
 * written and on its real path, so a link on the way cannot carry what it writes and removes anywhere else.
 */
function refusedEdges(root: string, dir: string): string | undefined {
  const abs = resolve(root, dir);
  if (caseless(resolve(root), abs) !== EDGES.toLowerCase()) return `fuzz --edges owns ${EDGES}/ alone, not ${dir}`;
  const real = realOf(abs);
  if (caseless(realOf(resolve(root)), real) !== EDGES.toLowerCase())
    return `${dir} leads through a link to ${real}: fuzz --edges writes to ${EDGES}/ in the tree and nowhere else`;
  return undefined;
}

/** What `wilanis rehearse --record` owns: the scenarios marked `rehearse`, in a directory `refusedDir` accepts. */
export const REHEARSED: Owner = { generated: 'rehearse', by: '--record', refused: refusedDir };

/** What `wilanis fuzz --edges` owns: the scenarios marked `edges`, in `scenarios/edges/`. */
export const EDGED: Owner = { generated: 'edges', by: 'fuzz --edges', refused: refusedEdges };

/** The recorded directory `record` names, `scenarios/rehearsed` where it names none; throws where `refusedDir` refuses it. */
export function recordedDir(root: string, record?: string): string {
  const dir = record ?? RECORDED;
  const refused = refusedDir(root, dir);
  if (refused) throw new Error(refused);
  return dir;
}

/** An owned directory on disk, where its owner accepts it; throws where the owner refuses it. */
function ownedDir(root: string, dir: string, owner: Owner): string {
  const refused = owner.refused(root, dir);
  if (refused) throw new Error(refused);
  return resolve(root, dir);
}

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

/** Whether a scenario on disk is one the owner wrote, which carries its `generated` mark; an unreadable one is not. */
function wroteIt(abs: string, file: string, owner: Owner): boolean {
  try {
    const doc = JSON.parse(readFileSync(join(abs, file), 'utf8')) as { generated?: unknown };
    return doc.generated === owner.generated;
  } catch {
    return false;
  }
}

/** The scenarios under the directory, parted into those the owner wrote and the rest, which it never touches. */
function held(abs: string, owner: Owner): { owned: string[]; others: string[] } {
  const files = onDisk(abs);
  const owned = files.filter(file => wroteIt(abs, file, owner));
  return { owned, others: files.filter(file => !owned.includes(file)) };
}

/** The scenarios under `dir` that its owner did not write and would not write over, root-relative: left as they are. */
export function keptIn(root: string, dir: string, docs: Record<string, ScenarioDoc>, owner = REHEARSED): string[] {
  return held(ownedDir(root, dir, owner), owner)
    .others.filter(file => !(file in docs))
    .map(file => `${dir}/${file}`);
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
 * Write every scenario under `dir` for its owner, `--record` unless another is named, and remove every scenario
 * under it that an earlier run of the owner wrote and this one does not, with any directory that leaves empty. A
 * scenario the owner did not write is left, and one in the way of a file it writes refuses the write; nothing
 * outside `dir` is touched, and nothing is reached through a link in it. Answers the files written, root-relative.
 */
export function writeRecorded(
  root: string,
  dir: string,
  docs: Record<string, ScenarioDoc>,
  owner = REHEARSED,
): string[] {
  const abs = ownedDir(root, dir, owner);
  const linked = throughLinks(abs, Object.keys(docs));
  if (linked.length)
    throw new Error(
      `${linked.map(file => `${dir}/${file}`).join(', ')} would be written through a link, which may lead out of ` +
        `the tree; ${dir}/ holds only what ${owner.by} writes: remove the link`,
    );
  const { owned, others } = held(abs, owner);
  const inTheWay = others.filter(file => file in docs).map(file => `${dir}/${file}`);
  if (inTheWay.length)
    throw new Error(
      `${inTheWay.join(', ')} would be written over, and ${owner.by} did not write it ` +
        `(no "generated": "${owner.generated}"): move it out of ${dir}/, where ${owner.by} writes`,
    );
  for (const file of owned) if (!(file in docs)) removeOwned(abs, file);
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

/** How an owned directory differs from what the tree writes today, each list root-relative and sorted. */
export interface RecordCheck {
  /** On disk, with different bytes. */
  stale: string[];
  /** Would be written, and is not on disk. */
  missing: string[];
  /** On disk under the directory, written by its owner, and would not be written now. */
  extra: string[];
}

/** Render every scenario as `writeRecorded` would for the owner and compare the bytes with what is on disk; never writes. */
export function checkRecorded(
  root: string,
  dir: string,
  docs: Record<string, ScenarioDoc>,
  owner = REHEARSED,
): RecordCheck {
  const abs = ownedDir(root, dir, owner);
  const { owned, others } = held(abs, owner);
  const present = new Set([...owned, ...others]);
  const out: RecordCheck = { stale: [], missing: [], extra: [] };
  for (const [file, doc] of Object.entries(docs)) {
    if (!present.has(file)) out.missing.push(`${dir}/${file}`);
    else if (readFileSync(join(abs, file), 'utf8') !== rendered(doc)) out.stale.push(`${dir}/${file}`);
  }
  for (const file of owned) if (!(file in docs)) out.extra.push(`${dir}/${file}`);
  for (const list of Object.values(out)) list.sort();
  return out;
}
