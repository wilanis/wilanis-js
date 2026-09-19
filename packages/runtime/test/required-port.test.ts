/**
 * A port a plugin requires (RFC 0005): it ships under the plugin's docs/ and the host binds it. The loader
 * registers it as an open domain port, so B002 holds a tree to binding it under every profile and says which
 * plugin requires it; D012 refuses a manifest that grants and requires one path, or requires one it does not
 * ship; `describe` says who requires the port and what each profile binds it to.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree, type PluginModule, schemaRef } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { describe as describeDoc, ls } from '../src/index.js';
import { docsDir, EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const port = (description: string) => ({
  $schema: schemaRef('port'),
  description,
  operations: { get: { description: 'read what was kept' } },
});

/** A plugin that grants files.port.json and requires memory.port.json; `manifest` edits what its plugin.json says. */
function keeper(manifest: (grants: string[], requires: string[]) => void = () => {}): PluginModule {
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
    handlers: { '@keep/files.port.json#get': async () => ({}) },
  };
}

const BINDING = {
  $schema: schemaRef('binding'),
  description: "the keeper's memory in files",
  port: '@keep/memory.port.json',
  operations: { get: { run: '@keep/files.port.json#get' } },
};

/** A copy of the example that uses @keep, its memory bound under every profile, or under none with no binding written. */
function tree(bound: boolean): string {
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
    writeFileSync(join(dir, 'features/state/data/keep-files.binding.json'), JSON.stringify(BINDING));
    for (const profile of Object.values<{ bindings: Record<string, string> }>(project.profiles))
      profile.bindings['@keep/memory.port.json'] = '@features/state/data/keep-files.binding.json';
  }
  writeFileSync(join(dir, 'project.json'), JSON.stringify(project));
  return dir;
}

/** What one copy answers, read however the case needs; the copy does not outlive the answer. */
function reading<T>(bound: boolean, plugin: PluginModule, read: (load: ReturnType<typeof loadTree>) => T): T {
  const dir = tree(bound);
  try {
    return read(loadTree(dir, { ...PLUGINS, '@keep': plugin }, INCLUDES));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const refusals = (bound: boolean, plugin = keeper()) =>
  reading(bound, plugin, load => checkTree(load).items.map(one => `${one.code} ${one.message} → ${one.hint}`));

const PROFILES = Object.keys(JSON.parse(readFileSync(join(EXAMPLE, 'project.json'), 'utf8')).profiles);

describe('a port a plugin requires', () => {
  it('is registered as a domain port the plugin requires, not a native one', () => {
    reading(true, keeper(), load => {
      const memory = load.registry.get('port', '@keep/memory.port.json');
      expect(memory?.native).toBeUndefined();
      expect(memory?.requiredBy).toBe('@keep');
      expect(load.registry.get('port', '@keep/files.port.json')?.native).toBe('@keep');
      expect(ls(load, 'port')).toContain(`${'port'.padEnd(16)} @keep/memory.port.json  (required by @keep)`);
    });
  });

  it('checks clean once every profile binds it', () => {
    expect(refusals(true)).toEqual([]);
  });

  it('B002 under every profile while nothing binds it, naming the plugin that requires it', () => {
    expect(refusals(false)).toEqual(
      PROFILES.map(
        profile =>
          `B002 profile '${profile}': no binding implements port '@keep/memory.port.json' (required by @keep) → wilanis new binding <feature>/<name> --port @keep/memory.port.json`,
      ),
    );
  });

  it('D012 when the manifest both grants and requires one path', () => {
    const both = keeper(grants => grants.push('@keep/memory.port.json'));
    expect(refusals(true, both)).toEqual([
      "D012 '@keep/memory.port.json' is both granted and required: a port is the plugin's to implement or the host's to bind, never both → list it once: under grants.ports if the plugin implements it, under requires.ports if the host binds it",
    ]);
  });

  it('D012 when the manifest requires a port it does not ship', () => {
    const absent = keeper((_, requires) => requires.push('@keep/absent.port.json', '@http/http.port.json'));
    const codes = refusals(true, absent).map(said => said.split(' ')[0]);
    expect(codes).toEqual(['D012', 'D012']);
  });

  it('describe says who requires it, and what each profile binds it to', () => {
    const bound = (indent: string) =>
      PROFILES.map(profile => `${indent}bound by  profile ${profile} → @features/state/data/keep-files.binding.json`);
    reading(true, keeper(), load => {
      expect(describeDoc(load, '@keep/memory.port.json')).toContain(['required by  @keep', ...bound('')].join('\n'));
      expect(describeDoc(load, '@keep/plugin.json')).toContain(
        ['requires (the host binds each):', '  @keep/memory.port.json', ...bound('    ')].join('\n'),
      );
    });
    reading(false, keeper(), load => {
      expect(describeDoc(load, '@keep/memory.port.json')).toContain(
        `bound by  profile ${PROFILES[0]} → nothing -- no binding implements port '@keep/memory.port.json'`,
      );
    });
  });
});
