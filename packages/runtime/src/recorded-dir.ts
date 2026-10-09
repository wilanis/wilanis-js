/**
 * What is on disk under a directory a scenario command owns (RFC 0018), and how it is written, removed and compared
 * with what the tree writes today. What a command owns is what it wrote, a file carrying its `generated` mark, and
 * nothing else: not a scenario a person or another command wrote, even one in the directory, and not what a link
 * inside it leads to. Its files are the scenarios and, where they share anything, the answers file at the top of the
 * directory (RFC 0036). Where the directory may be, and who owns it, is `recorded-owner.ts`'s.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { ANSWERS_FILE, type ScenarioDoc } from '@wilanis/core';
import { renderedAnswers, sharedOf } from './recorded-answers.js';
import { type Owner, ownedDir, REHEARSED, realOf, strictlyInside } from './recorded-owner.js';

/** The bytes a scenario is written as: one line, without indentation, and a newline. */
const rendered = (doc: ScenarioDoc) => `${JSON.stringify(doc)}\n`;

/**
 * Every file a command writes under `dir` for these scenarios, by its path inside it, with its bytes: each scenario as
 * `sharedOf` points it, and the answers file where they share anything.
 */
function filesOf(dir: string, docs: Record<string, ScenarioDoc>, owner: Owner): Record<string, string> {
  const shared = sharedOf(docs, dir, owner);
  const files = Object.fromEntries(Object.entries(shared.docs).map(([file, doc]) => [file, rendered(doc)]));
  if (shared.answers) files[ANSWERS_FILE] = renderedAnswers(shared.answers);
  return files;
}

/**
 * An answers file below the top of the directory: no command writes one there, and the scenarios beside it would
 * read it in place of the one at the top (`answersFor` stops at the nearest).
 */
const stray = (file: string) => file !== ANSWERS_FILE && file.endsWith(`/${ANSWERS_FILE}`);

/**
 * Every scenario file and every answers file under the directory, by its path inside it with `/` between segments:
 * only regular files, and only below real directories, since a link inside it may lead anywhere and what it leads to
 * is not owned.
 */
function onDisk(abs: string): string[] {
  if (!existsSync(abs)) return [];
  const found: string[] = [];
  ownableFiles(abs, [], found);
  return found.sort();
}

/** The scenario and answers files under one directory, walked through its real subdirectories and never through a link. */
function ownableFiles(at: string, prefix: string[], into: string[]): void {
  for (const entry of readdirSync(at, { withFileTypes: true })) {
    const path = [...prefix, entry.name];
    if (entry.isDirectory()) ownableFiles(join(at, entry.name), path, into);
    else if (entry.isFile() && (entry.name.endsWith('.scenario.json') || entry.name === ANSWERS_FILE))
      into.push(path.join('/'));
  }
}

/** Whether a file on disk is one the owner wrote, which carries its `generated` mark; an unreadable one is not. */
function wroteIt(abs: string, file: string, owner: Owner): boolean {
  try {
    const doc = JSON.parse(readFileSync(join(abs, file), 'utf8')) as { generated?: unknown };
    return doc.generated === owner.generated;
  } catch {
    return false;
  }
}

/** The files under the directory, parted into those the owner wrote and the rest, which it never touches. */
function held(abs: string, owner: Owner): { owned: string[]; others: string[] } {
  const files = onDisk(abs);
  const owned = files.filter(file => wroteIt(abs, file, owner));
  return { owned, others: files.filter(file => !owned.includes(file)) };
}

/** The files under `dir` that its owner did not write and would not write over, root-relative: left as they are. */
export function keptIn(root: string, dir: string, docs: Record<string, ScenarioDoc>, owner = REHEARSED): string[] {
  const abs = ownedDir(root, dir, owner);
  const files = filesOf(dir, docs, owner);
  return held(abs, owner)
    .others.filter(file => !(file in files) && !stray(file))
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
 * Refuse a write that would touch what the owner did not write: a file in the way of one it writes, or an answers
 * file below the top of the directory, which the scenarios beside it would read in place of the one it writes.
 */
function refuseOthers(dir: string, others: string[], files: Record<string, string>, owner: Owner): void {
  const notMine = `${owner.by} did not write it (no "generated": "${owner.generated}"): move it out of ${dir}/, where ${owner.by} writes`;
  const inTheWay = others.filter(file => file in files).map(file => `${dir}/${file}`);
  if (inTheWay.length) throw new Error(`${inTheWay.join(', ')} would be written over, and ${notMine}`);
  const hiding = others.filter(stray).map(file => `${dir}/${file}`);
  if (hiding.length)
    throw new Error(
      `${hiding.join(', ')} would be read in place of ${dir}/${ANSWERS_FILE} by the scenarios beside it, and ${notMine}`,
    );
}

/**
 * Write every scenario under `dir` for its owner, `--record` unless another is named, with the answers file they
 * share, and remove every file under it that an earlier run of the owner wrote and this one does not, with any
 * directory that leaves empty. A file the owner did not write is left, and one in the way of a file it writes refuses
 * the write; nothing outside `dir` is touched, and nothing is reached through a link in it. Answers the files
 * written, root-relative.
 */
export function writeRecorded(
  root: string,
  dir: string,
  docs: Record<string, ScenarioDoc>,
  owner = REHEARSED,
): string[] {
  const abs = ownedDir(root, dir, owner);
  const files = filesOf(dir, docs, owner);
  const linked = throughLinks(abs, Object.keys(files));
  if (linked.length)
    throw new Error(
      `${linked.map(file => `${dir}/${file}`).join(', ')} would be written through a link, which may lead out of ` +
        `the tree; ${dir}/ holds only what ${owner.by} writes: remove the link`,
    );
  const { owned, others } = held(abs, owner);
  refuseOthers(dir, others, files, owner);
  for (const file of owned) if (!(file in files)) removeOwned(abs, file);
  const written: string[] = [];
  for (const [file, bytes] of Object.entries(files).sort(([one], [other]) => (one < other ? -1 : 1))) {
    mkdirSync(dirname(join(abs, file)), { recursive: true });
    writeFileSync(join(abs, file), bytes);
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
  /**
   * On disk under the directory, written by its owner, and would not be written now; and any answers file below the
   * top of the directory, whoever wrote it, since the scenarios beside it would read it in place of the one at the top.
   */
  extra: string[];
}

/**
 * Render every scenario and the answers file as `writeRecorded` would for the owner and compare the bytes with what is
 * on disk; never writes.
 */
export function checkRecorded(
  root: string,
  dir: string,
  docs: Record<string, ScenarioDoc>,
  owner = REHEARSED,
): RecordCheck {
  const abs = ownedDir(root, dir, owner);
  const files = filesOf(dir, docs, owner);
  const { owned, others } = held(abs, owner);
  const present = new Set([...owned, ...others]);
  const out: RecordCheck = { stale: [], missing: [], extra: [] };
  for (const [file, bytes] of Object.entries(files)) {
    if (!present.has(file)) out.missing.push(`${dir}/${file}`);
    else if (readFileSync(join(abs, file), 'utf8') !== bytes) out.stale.push(`${dir}/${file}`);
  }
  for (const file of [...owned.filter(one => !(one in files)), ...others.filter(stray)])
    out.extra.push(`${dir}/${file}`);
  for (const list of Object.values(out)) list.sort();
  return out;
}
