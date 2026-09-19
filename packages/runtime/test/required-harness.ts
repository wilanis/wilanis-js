/**
 * What the tests of a port a plugin requires run against (RFC 0005): @keep, a plugin that grants files.port.json
 * and requires memory.port.json, and copies of the example that use it, with its memory bound or not.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { type LoadResult, loadTree, type PluginModule, schemaRef } from '@wilanis/core';
import { docsDir, EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const port = (description: string) => ({
  $schema: schemaRef('port'),
  description,
  operations: {
    get: {
      description: 'read what was kept under one key',
      accepts: { key: { type: 'string' } },
      returns: { fields: { record: { type: 'string', required: false } } },
    },
  },
});

/** What files.port.json#get answers: what was kept under the key, and a fault for the key 'broken'. */
async function kept({ in: given }: { in: Record<string, unknown> }) {
  if (given.key === 'broken') throw new Error('the disk is gone');
  return { record: `kept ${given.key}` };
}

/** A plugin that grants files.port.json and requires memory.port.json; `manifest` edits what its plugin.json says. */
export function keeper(manifest: (grants: string[], requires: string[]) => void = () => {}): PluginModule {
  const grants = ['@keep/files.port.json'];
  const requires = ['@keep/memory.port.json'];
  manifest(grants, requires);
  return {
    root: '@keep',
    docs: docsDir({
      'plugin.json': {
        $schema: schemaRef('plugin'),
        description: 'keeps what it is given, where the host says',
        grants: { ports: grants },
        requires: { ports: requires },
      },
      'files.port.json': port('what is kept in files'),
      'memory.port.json': port('where the plugin keeps what it is given; the host binds it'),
    }),
    handlers: { '@keep/files.port.json#get': kept },
  };
}

/** The binding the host writes: memory in files, one delegation. `edit` changes it before it is written. */
const binding = (edit: (doc: any) => void) => {
  const doc = {
    $schema: schemaRef('binding'),
    description: "the keeper's memory in files",
    port: '@keep/memory.port.json',
    operations: { get: { run: '@keep/files.port.json#get' } },
  };
  edit(doc);
  return doc;
};

export const BINDING = '@features/state/data/keep-files.binding.json';

/**
 * A copy of the example that uses @keep, its memory bound under every profile, or under none with no binding
 * written; `edit` changes the binding.
 */
function tree(bound: boolean, edit: (doc: any) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-requires-'));
  cpSync(EXAMPLE, dir, { recursive: true, filter: path => !path.includes('node_modules') });
  mkdirSync(join(dir, 'features/state/data'), { recursive: true });
  const feature = { $schema: schemaRef('feature'), description: 'where this deployment keeps things' };
  writeFileSync(
    join(dir, 'features/state/feature.json'),
    JSON.stringify({ ...feature, effects: ['@keep/files.port.json#get'] }),
  );
  const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
  project.plugins.push({ use: '@keep' });
  if (bound) {
    writeFileSync(join(dir, 'features/state/data/keep-files.binding.json'), JSON.stringify(binding(edit)));
    for (const profile of Object.values<{ bindings: Record<string, string> }>(project.profiles))
      profile.bindings['@keep/memory.port.json'] = BINDING;
  }
  writeFileSync(join(dir, 'project.json'), JSON.stringify(project));
  return dir;
}

/** What one copy answers, read however the case needs; the copy does not outlive the answer. */
export async function reading<T>(
  bound: boolean,
  plugin: PluginModule,
  read: (load: LoadResult) => T | Promise<T>,
  edit: (doc: any) => void = () => {},
): Promise<T> {
  const dir = tree(bound, edit);
  try {
    return await read(loadTree(dir, { ...PLUGINS, '@keep': plugin }, INCLUDES));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The refusals one copy answers with, as `code message → hint`. */
export const refusals = (bound: boolean, plugin = keeper(), edit: (doc: any) => void = () => {}) =>
  reading(bound, plugin, load => checkTree(load).items.map(one => `${one.code} ${one.message} → ${one.hint}`), edit);

/** The profiles the example declares, in order. */
export const PROFILES = Object.keys(JSON.parse(readFileSync(join(EXAMPLE, 'project.json'), 'utf8')).profiles);
