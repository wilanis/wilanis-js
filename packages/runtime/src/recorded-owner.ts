/**
 * Who owns a recorded directory, and where it may be (RFC 0018): `wilanis rehearse --record` any directory below
 * `scenarios/` outside what fuzz writes, and `wilanis fuzz --edges` `scenarios/edges/` alone. Each is judged on the
 * path as written and on its real path, so a link on the way cannot carry what a command writes and removes anywhere
 * else. What is on disk under such a directory, and how it is written, is `recorded-dir.ts`'s.
 */
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { HOME } from '@wilanis/core';

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

/** A path below the root, with `/` between segments and without case, as a filesystem that ignores case reads it. */
const caseless = (root: string, abs: string) => relative(root, abs).split(sep).join('/').toLowerCase();

/** Whether `abs` is strictly inside `root`. */
export function strictlyInside(root: string, abs: string): boolean {
  const inside = relative(root, abs);
  return Boolean(inside) && !inside.startsWith('..') && !isAbsolute(inside);
}

/**
 * The real path of a path that may not exist yet: its nearest existing ancestor's, followed by the rest as written.
 * The operating system's own answer (`realpathSync.native`), so a case-insensitive filesystem answers the case on
 * disk and `scenarios/FUZZ` is read as the `scenarios/fuzz` it is.
 */
export function realOf(abs: string): string {
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
export function ownedDir(root: string, dir: string, owner: Owner): string {
  const refused = owner.refused(root, dir);
  if (refused) throw new Error(refused);
  return resolve(root, dir);
}
