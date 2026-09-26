/**
 * Loading a project for the runtime: the builtin plugins plus every plugin package project.json names with
 * `from`, resolved from the project's own node_modules and imported. Only npm package names are accepted
 * there, so a JSON document can never point at an arbitrary file on disk.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type LoadResult, loadTree, type PluginModule, type Refusal, type ResolvedInclude } from '@wilanis/core';
import { BUILTIN_PLUGINS } from './plugins/index.js';

const PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

export interface PluginResolution {
  available: Record<string, PluginModule>;
  refusals: Refusal[];
  /** The version of each plugin package imported, by its `use`: its package.json's, beside the `from` it was named by. */
  versions: Record<string, string>;
}

/** What the runtime resolved a tree's packages to: each imported plugin's version by its `use`, and each include. */
export interface Resolved {
  plugins: Record<string, string>;
  includes: ResolvedInclude[];
}

/** A tree as the runtime loads it: what the loader answers, and the packages it was loaded from (RFC 0026). */
export type ProjectLoad = LoadResult & { resolved: Resolved };

/** The array project.json holds under one key, or none when the file or the key is not there. loadTree reports D000 / D005. */
function listedIn(root: string, key: 'plugins' | 'includes'): unknown[] {
  try {
    const found = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8'))[key];
    return Array.isArray(found) ? found : [];
  } catch {
    return [];
  }
}

/** Import every plugin project.json names with `from`, on top of the builtins and `extra`. */
export async function resolvePlugins(
  root: string,
  extra: Record<string, PluginModule> = {},
): Promise<PluginResolution> {
  const available: Record<string, PluginModule> = { ...BUILTIN_PLUGINS, ...extra };
  const refusals: Refusal[] = [];
  const versions: Record<string, string> = {};
  const require = createRequire(join(root, 'package.json'));
  for (const [at, entry] of listedIn(root, 'plugins').entries()) {
    const named = entry as { use?: unknown; from?: unknown };
    if (!named || typeof named !== 'object' || typeof named.from !== 'string' || typeof named.use !== 'string')
      continue;
    const found = await pluginFrom(require, named.from, named.use, `plugins/${at}/from`);
    if ('refusal' in found) {
      refusals.push(found.refusal);
      continue;
    }
    available[named.use] = found.plugin;
    if (found.version !== undefined) versions[named.use] = found.version;
  }
  return { available, refusals, versions };
}

/**
 * The version in the package.json of the package `from` names, found by walking up from the file it resolved to:
 * a plugin package's `exports` need not name its package.json, so it cannot be required by name.
 */
function versionAbove(entry: string, from: string): string | undefined {
  for (let dir = dirname(entry); dir !== dirname(dir); dir = dirname(dir)) {
    const file = join(dir, 'package.json');
    if (!existsSync(file)) continue;
    const found = JSON.parse(readFileSync(file, 'utf8'));
    if (found.name === from) return typeof found.version === 'string' ? found.version : undefined;
  }
  return undefined;
}

/** The version a package.json says, or nothing when it says none. */
const versionIn = (file: string): string | undefined => {
  const found = JSON.parse(readFileSync(file, 'utf8')).version;
  return typeof found === 'string' ? found : undefined;
};

/** One D006: what a plugin entry got wrong. */
const badPlugin = (at: string, message: string, hint: string): Refusal => ({
  code: 'D006',
  file: 'project.json',
  at,
  message,
  hint,
});

/** The plugin one entry names, imported and checked to be the plugin it says it is. */
async function pluginFrom(
  require: NodeJS.Require,
  from: string,
  use: string,
  at: string,
): Promise<{ plugin: PluginModule; version?: string } | { refusal: Refusal }> {
  if (!PACKAGE_NAME.test(from))
    return {
      refusal: badPlugin(
        at,
        `'${from}' is not an npm package name`,
        'from names a published package, never a file path',
      ),
    };
  let mod: Record<string, unknown>;
  let entry: string;
  try {
    entry = require.resolve(from);
    mod = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
  } catch (error) {
    return {
      refusal: badPlugin(
        at,
        `cannot load plugin package '${from}': ${(error as Error).message}`,
        `npm install ${from}`,
      ),
    };
  }
  const plugin = (mod.default ?? mod.plugin) as PluginModule | undefined;
  if (!plugin || typeof plugin !== 'object' || typeof plugin.root !== 'string' || !plugin.docs)
    return {
      refusal: badPlugin(
        at,
        `'${from}' does not export a wilanis plugin`,
        'a plugin package exports its PluginModule as default',
      ),
    };
  if (plugin.root !== use)
    return {
      refusal: badPlugin(at, `'${from}' is the plugin '${plugin.root}', not '${use}'`, `"use": "${plugin.root}"`),
    };
  return { plugin, version: versionAbove(entry, from) };
}

/**
 * Where each tree project.json includes sits: the package's directory, resolved from the project's own node_modules.
 * Only npm package names are accepted, as for plugins: a JSON document never points at a file on disk.
 */
export function resolveIncludes(root: string): { includes: ResolvedInclude[]; refusals: Refusal[] } {
  const includes: ResolvedInclude[] = [];
  const refusals: Refusal[] = [];
  const require = createRequire(join(root, 'package.json'));
  for (const [at, entry] of listedIn(root, 'includes').entries()) {
    const named = entry as { from?: unknown; features?: unknown };
    if (!named || typeof named !== 'object' || typeof named.from !== 'string') continue;
    const found = includeFrom(require, { ...named, from: named.from }, `includes/${at}/from`);
    if ('refusal' in found) refusals.push(found.refusal);
    else includes.push(found.include);
  }
  return { includes, refusals };
}

/** One D010: what an include entry got wrong. */
const badInclude = (at: string, message: string, hint: string): Refusal => ({
  code: 'D010',
  file: 'project.json',
  at,
  message,
  hint,
});

/** Where the tree one entry includes sits, resolved from the project's own node_modules. */
function includeFrom(
  require: NodeJS.Require,
  named: { from: string; features?: unknown },
  at: string,
): { include: ResolvedInclude } | { refusal: Refusal } {
  if (!PACKAGE_NAME.test(named.from))
    return {
      refusal: badInclude(
        at,
        `'${named.from}' is not an npm package name`,
        'from names a published package, never a file path',
      ),
    };
  try {
    const manifest = require.resolve(`${named.from}/package.json`);
    const version = versionIn(manifest);
    return {
      include: {
        from: named.from,
        dir: dirname(manifest),
        ...(Array.isArray(named.features) ? { features: named.features.map(String) } : {}),
        ...(version === undefined ? {} : { version }),
      },
    };
  } catch (error) {
    return {
      refusal: badInclude(
        at,
        `cannot find the included package '${named.from}': ${(error as Error).message}`,
        `npm install ${named.from}`,
      ),
    };
  }
}

/**
 * Load the tree at root with its plugins and includes resolved: builtins, `extra`, and the packages project.json
 * names; the load carries the versions they were resolved at, which the manifest prints.
 */
export async function loadProject(
  root: string,
  opts: { plugins?: Record<string, PluginModule>; includes?: ResolvedInclude[] } = {},
): Promise<ProjectLoad> {
  const { available, refusals, versions } = await resolvePlugins(root, opts.plugins);
  const resolved = resolveIncludes(root);
  const includes = [...(opts.includes ?? []), ...resolved.includes];
  const load = loadTree(root, available, includes);
  refusals.push(...resolved.refusals);
  // a plugin whose package failed to load is reported once, with the install hint, not also as unknown
  const failed = new Set(refusals.map(refusal => refusal.at?.replace(/\/from$/, '')));
  const kept = load.refusals.items.filter(item => !(item.code === 'D006' && failed.has(item.at)));
  load.refusals.items.splice(0, load.refusals.items.length, ...kept, ...refusals);
  return { ...load, resolved: { plugins: versions, includes } };
}
