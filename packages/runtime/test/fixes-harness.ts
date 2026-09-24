/**
 * What a test needs to prove a fix rather than describe it (RFC 0019): the refusals a broken copy answers,
 * whole; one fix applied to a copied tree under the `at` grammar; and the judgement of whether a refusal's
 * fixes, applied, repair it -- the every-rule guard in `sabotage-fixes.test.ts` asks that of every check.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import {
  type Fix,
  type LoadResult,
  loadTree,
  type PluginModule,
  type Refusal,
  type ResolvedInclude,
} from '@wilanis/core';
import { copyOfExample, INCLUDES, PLUGINS } from './example-harness.js';

/** How a tree is checked: what the guard is handed, so it re-checks with the checker it is guarding. */
export type Check = (load: LoadResult) => { items: Refusal[] };

/** The refusals a copy of the example answers, whole, once it has been broken. */
export function refusalsAfter(change: (dir: string) => void): Refusal[] {
  return withCopy(change, dir => checkTree(loadTree(dir, PLUGINS, INCLUDES)).items);
}

/**
 * Break a copy of the example, apply the fixes `pick` chooses from what it answers, and answer `read` of the
 * repaired copy: what a case needs when applying the fix is the claim.
 */
export function afterFixing<T>(
  change: (dir: string) => void,
  pick: (refusals: Refusal[]) => Fix[],
  read: (dir: string) => T,
): T {
  return withCopy(change, dir => {
    for (const fix of pick(checkTree(loadTree(dir, PLUGINS, INCLUDES)).items)) applyFix(dir, fix);
    return read(dir);
  });
}

/** A change to a copied tree: one document edited in place. */
export const editing = (file: string, change: (doc: any) => void) => (dir: string) => {
  const doc = readDoc(dir, file);
  change(doc);
  writeFileSync(onDisk(dir, file), JSON.stringify(doc));
};

/** A change to a copied tree: one document moved from one tree-relative path to another. */
export const moving = (from: string, to: string) => (dir: string) => {
  mkdirSync(dirname(join(dir, to)), { recursive: true });
  renameSync(join(dir, from), join(dir, to));
};

/** A change to a copied tree: documents written at tree-relative paths it does not have, then `and` applied. */
export const planting =
  (docs: Record<string, unknown>, and: (dir: string) => void = () => {}) =>
  (dir: string) => {
    for (const [file, doc] of Object.entries(docs)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), JSON.stringify(doc));
    }
    and(dir);
  };

/**
 * What the guard says of a broken copy's refusals once `alter` has had its way with them: how a case proves
 * the guard bites, by handing it a fix the rule never offered.
 */
export function unrepairedAfter(change: (dir: string) => void, alter: (refusals: Refusal[]) => Refusal[]): string[] {
  return withCopy(change, dir => {
    const load = loadTree(dir, PLUGINS, INCLUDES);
    return unrepaired(load, alter(checkTree(load).items), checkTree);
  });
}

/** A document of a tree on disk, parsed, by the path a refusal names it with. */
export function readDoc(dir: string, file: string): any {
  return JSON.parse(readFileSync(onDisk(dir, file), 'utf8'));
}

/**
 * Apply one fix to the tree at `dir`, in place: `set`, `add` or `remove` at a path of a document, or a file
 * moved. `where` finds a document the fix names on disk; by default under `dir`.
 */
export function applyFix(dir: string, fix: Fix, where = (file: string) => onDisk(dir, file)): void {
  if ('move' in fix) {
    const to = join(dir, fix.move);
    mkdirSync(dirname(to), { recursive: true });
    renameSync(where(fix.file), to);
    return;
  }
  const path = where(fix.file);
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  edit(doc, fix);
  writeFileSync(path, JSON.stringify(doc, null, 2));
}

/**
 * Every refusal among `refusals` whose fix, applied to a copy of the tree `load` read, leaves the same refusal
 * (its code, file and place) behind -- one sentence each. A fix several refusals share is applied once.
 */
export function unrepaired(load: LoadResult, refusals: Refusal[], check: Check): string[] {
  const offering = new Map<string, { fix: Fix; by: Refusal[] }>();
  for (const refusal of refusals) {
    for (const fix of refusal.fixes ?? []) {
      const key = JSON.stringify(fix);
      offering.set(key, { fix, by: [...(offering.get(key)?.by ?? []), refusal] });
    }
  }
  return [...offering.values()].flatMap(({ fix, by }) => leftBehind(load, fix, by, check));
}

/** The refusals among `by` that the one fix, applied to a copy of the tree and of what it includes, does not remove. */
function leftBehind(load: LoadResult, fix: Fix, by: Refusal[], check: Check): string[] {
  const available: Record<string, PluginModule> = { ...PLUGINS };
  for (const plugin of load.plugins) available[plugin.root] = plugin;
  const copy = copyOfLoaded(load);
  try {
    applyFix(copy.dir, fix, copy.where);
    const after = new Set(check(loadTree(copy.dir, available, copy.includes)).items.map(identity));
    return by
      .filter(refusal => after.has(identity(refusal)))
      .map(refusal => `${identity(refusal)} offers ${JSON.stringify(fix)}, which leaves it behind`);
  } finally {
    for (const [, to] of copy.bases) rmSync(to, { recursive: true, force: true });
  }
}

/** A loaded tree copied whole: its root, each tree it includes, and where a document it names now sits. */
interface Copied {
  dir: string;
  includes: ResolvedInclude[];
  bases: [string, string][];
  where: (file: string) => string;
}

/** Copy the tree a load read, and every tree it included, so a fix may edit either without touching the original. */
function copyOfLoaded(load: LoadResult): Copied {
  const dir = copyOf(load.root);
  const includes = includesOf(load).map(include => ({ ...include, dir: copyOf(include.dir) }));
  const originals = includesOf(load).map(include => include.dir);
  const bases: [string, string][] = [
    [load.root, dir],
    ...originals.map((from, index): [string, string] => [from, includes[index].dir]),
  ];
  const where = (file: string) => {
    const onFile = load.registry.any(file)?.file;
    const base = onFile && bases.find(([from]) => onFile.startsWith(`${from}/`));
    return base ? join(base[1], relative(base[0], onFile)) : onDisk(dir, file);
  };
  return { dir, includes, bases, where };
}

/** The trees a load included, read back off its documents: each package, the directory it sits in, and its features. */
function includesOf(load: LoadResult): ResolvedInclude[] {
  const found = new Map<string, ResolvedInclude>();
  for (const one of load.registry.all('feature')) {
    if (!one.included || !one.file || !one.feature) continue;
    const dir = one.file.slice(0, one.file.lastIndexOf('/features/'));
    const include = found.get(one.included) ?? { from: one.included, dir, features: [] };
    include.features?.push(one.feature);
    found.set(one.included, include);
  }
  return [...found.values()];
}

/** A throwaway copy of a directory, without what a check must not read. */
function copyOf(from: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-fix-'));
  cpSync(from, dir, { recursive: true, filter: path => !path.includes('node_modules') });
  return dir;
}

/** A refusal as the guard tells one from another: the rule and the place it points at. */
const identity = (refusal: Refusal) => `${refusal.code} ${refusal.file}${refusal.at ? `#${refusal.at}` : ''}`;

/** A copy of the example, broken by `change`, answered by `read`; the copy does not outlive the answer. */
function withCopy<T>(change: (dir: string) => void, read: (dir: string) => T): T {
  const dir = copyOfExample();
  try {
    change(dir);
    return read(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Where a document a refusal names sits under the tree: `@`-rooted names the tree's root, anything else is tree-relative. */
function onDisk(dir: string, file: string): string {
  const path = join(dir, file.startsWith('@') ? file.slice(1) : file);
  if (!existsSync(path)) throw new Error(`${file} is not a document of the tree at ${dir}`);
  return path;
}

/** Apply a `set`, `add` or `remove` to a parsed document, at the path the fix names. */
function edit(doc: any, fix: Exclude<Fix, { move: string }>): void {
  const segments = fix.at.split('/');
  const last = segments.pop() as string;
  const parent = segments.reduce((value, segment) => value[keyOf(value, segment)], doc);
  const key = keyOf(parent, last);
  if ('set' in fix) parent[key] = fix.set;
  else if ('add' in fix) {
    parent[key] ??= [];
    if (!parent[key].some((one: unknown) => JSON.stringify(one) === JSON.stringify(fix.add))) parent[key].push(fix.add);
  } else if (Array.isArray(parent)) parent.splice(Number(key), 1);
  else delete parent[key];
}

/** One segment of `at` read against the value it indexes: a member by name, an element by index, a node by its id. */
function keyOf(value: any, segment: string): string | number {
  if (!Array.isArray(value) || /^\d+$/.test(segment)) return segment;
  const index = value.findIndex(one => one?.id === segment);
  if (index < 0) throw new Error(`no element with id '${segment}'`);
  return index;
}
