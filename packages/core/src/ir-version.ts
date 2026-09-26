/**
 * The IR version rules of RFC 0008, the loader's first judgement: a document naming an IR version this runtime does
 * not read (D013), and a tree whose documents name more than one (D014). Both are judged over every document a load
 * reads -- the tree's, each include's, and the docs of each plugin the project names -- from its `$schema` alone,
 * before any document is judged against a schema. A tree either rule refuses is judged no further, since a document
 * of another version read against this one's schemas would be refused for every difference between the two, and
 * everything naming it refused after it.
 *
 * The alias names no version of its own and is read as the one this runtime reads, so a tree writing the alias
 * beside the published URL of that version mixes nothing. A runtime reads one version, so a tree that mixes two
 * always holds a document of a version it does not read: D014 stands beside D013 there, saying the tree is not one
 * version, where D013 alone says each document this runtime cannot read.
 */
import { join, relative } from 'node:path';
import { nativePath, PROJECT_FILE, parseJson, takes } from './documents.js';
import { subdirectories, treePath, walk } from './paths.js';
import type { PluginModule } from './plugin.js';
import { IR_READ, irOfSchema, SCHEMA_BASE } from './published.js';
import type { Refusal } from './registry.js';

/** Where a load reads from, as the version rules need it: the tree's files, its includes, and the plugins at hand. */
export interface Reading {
  root: string;
  files: string[];
  includes: { from: string; dir: string; features?: string[] }[];
  available: Record<string, PluginModule>;
}

/** One document a load reads: the path its refusals name, and where it sits on disk. */
type Read = [file: string, abs: string];

/** D013 for each document naming a version this runtime does not read, then D014 once where they name two or more. */
export function versionsRefused(reading: Reading): Refusal[] {
  const byVersion = new Map<string, string[]>();
  const refusals: Refusal[] = [];
  for (const [file, abs] of documentsRead(reading)) {
    const version = versionAt(abs);
    if (!version) continue;
    const naming = byVersion.get(version) ?? [];
    byVersion.set(version, naming);
    naming.push(file);
    if (version !== IR_READ) refusals.push(unread(file, version));
  }
  return byVersion.size > 1 ? [...refusals, mixed(byVersion)] : refusals;
}

/** Every document a load reads: the tree's, each include's, and each named plugin's. */
function documentsRead({ root, files, includes, available }: Reading): Read[] {
  return [
    ...files.map((abs): Read => [treePath(relative(root, abs)), abs]),
    ...includes.flatMap(included),
    ...pluginsNamed(root, available).flatMap(shipped),
  ];
}

/** An include's project.json, which the loader reads for its plugins and aliases, and the features taken from it. */
function included(include: Reading['includes'][number]): Read[] {
  const dir = join(include.dir, 'features');
  const names = orNothing(() => subdirectories(dir)).filter(name => takes(include, name));
  return [
    [`${include.from}/${PROJECT_FILE}`, join(include.dir, PROJECT_FILE)],
    ...names.flatMap(name => walk(join(dir, name)).map((abs): Read => [treePath(relative(include.dir, abs)), abs])),
  ];
}

/** Every document a plugin ships, under its root; nothing where its docs cannot be read, which D006 says later. */
function shipped(plugin: PluginModule): Read[] {
  return orNothing(() => walk(plugin.docs)).map((abs): Read => [nativePath(plugin, abs), abs]);
}

/**
 * The plugins project.json names, read off it before it is judged, as the runtime reads it to find their packages:
 * which plugin's documents the version rules read is the one thing they take from a document not yet judged.
 */
function pluginsNamed(root: string, available: Record<string, PluginModule>): PluginModule[] {
  const parsed = parseJson(join(root, PROJECT_FILE), PROJECT_FILE);
  const plugins = 'doc' in parsed ? member(parsed.doc, 'plugins') : undefined;
  if (!Array.isArray(plugins)) return [];
  return plugins.flatMap(use => {
    const name = member(use, 'use');
    const plugin = typeof name === 'string' ? available[name] : undefined;
    return plugin ? [plugin] : [];
  });
}

/** The IR version the document at a path names; nothing when it is not JSON or its `$schema` is not a wilanis one. */
function versionAt(abs: string): string | undefined {
  const parsed = parseJson(abs, abs);
  return 'doc' in parsed ? irOfSchema(member(parsed.doc, '$schema')) : undefined;
}

/** One member of a value that may be an object; nothing when it is not one. */
const member = (value: unknown, name: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[name] : undefined;

/** What a directory read answers, or nothing where it cannot be read. */
function orNothing(read: () => string[]): string[] {
  try {
    return read();
  } catch {
    return [];
  }
}

/** D013: a document naming a version this runtime does not read, at its `$schema`. */
function unread(file: string, version: string): Refusal {
  return {
    code: 'D013',
    file,
    at: '$schema',
    message: `names IR ${version}, which this runtime does not read`,
    hint: `this runtime reads ${IR_READ}; the document names ${version}: upgrade @wilanis/runtime, or rewrite the document against ${IR_READ}, its $schema under ${SCHEMA_BASE}`,
  };
}

/** D014: the versions a tree's documents name, how many name each, and one of them, said once at the project. */
function mixed(byVersion: Map<string, string[]>): Refusal {
  const said = [...byVersion].map(
    ([version, files]) => `${version} (${files.length}, ${files[0]}${files.length > 1 ? ' among them' : ''})`,
  );
  return {
    code: 'D014',
    file: PROJECT_FILE,
    message: `the documents of this tree name more than one IR version: ${said.join(', ')}`,
    hint: `a tree is one version: upgrade the rest to the newer one, or rewrite every $schema against ${IR_READ}, under ${SCHEMA_BASE} (docs/rfcs/0008-ir-versioning.md)`,
  };
}
