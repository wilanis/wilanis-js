/**
 * An included feature that leans on a guard without naming its plugin (#854). The include names its guard, but its
 * policy only reads `{{context.principal}}`, which any guard hands. So the host is not asked for that one plugin
 * (no D010), and a host that names no guard at all is refused by the A family, with the hint to add one.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree, schemaRef, schemaUrl } from '@wilanis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { forgetGatedTrees, gatedTree } from './gated-tree.js';

const hosts: string[] = [];

afterEach(() => {
  forgetGatedTrees();
  for (const dir of hosts.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * The gated tree as an include whose features name no document of its guard (@fake): the greeting is a graph of
 * @std rather than the guard plugin's port. Its project.json still names @fake.
 */
function guardedInclude() {
  const built = gatedTree(() => ({ context: {} }));
  const put = (rel: string, doc: unknown) => writeFileSync(join(built.dir, rel), JSON.stringify(doc));
  put('features/gate/feature.json', { $schema: schemaRef('feature'), description: 'the gated feature' });
  put('features/gate/domain/greet.graph.json', {
    $schema: schemaRef('graph'),
    description: 'the greeting, made in place',
    out: { type: 'string', from: ['hello'] },
    nodes: [
      {
        type: '@wilanis/node/run.schema.json',
        id: 'hello',
        run: '@std/object.port.json#make',
        in: { value: 'hello', type: 'string' },
      },
    ],
  });
  put('features/gate/data/gate.binding.json', {
    $schema: schemaRef('binding'),
    description: 'every operation by graph',
    port: '@features/gate/domain/gate.port.json',
    operations: {
      signedIn: { graph: '@features/gate/domain/signed-in.graph.json' },
      roled: { graph: '@features/gate/domain/roled.graph.json' },
      greet: { graph: '@features/gate/domain/greet.graph.json' },
    },
  });
  return built;
}

/** A host that names @std and @cli, and no guard. */
function hostWithoutGuard(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-host-'));
  hosts.push(dir);
  writeFileSync(
    join(dir, 'project.json'),
    JSON.stringify({
      $schema: schemaUrl('project'),
      name: 'host',
      description: 'a host that names no guard',
      plugins: [{ use: '@std' }, { use: '@cli' }],
    }),
  );
  return dir;
}

describe('an included policy that reads what a guard hands, under a host with no guard', () => {
  it('A005 with the hint to add a guarding plugin, and no D010 for the guard the include names', () => {
    const built = guardedInclude();
    const load = loadTree(hostWithoutGuard(), built.plugins, [{ from: '@acme/gate', dir: built.dir }]);
    const refusals = checkTree(load).items;
    expect(refusals.filter(one => one.code === 'D010')).toEqual([]);
    const a005 = refusals.filter(one => one.code === 'A005');
    expect(a005.length).toBeGreaterThan(0);
    for (const one of a005) {
      expect(one.message).toContain('no plugin of this project identifies callers');
      expect(one.hint).toBe('add a guarding plugin to project.json → plugins, such as @wilanis/plugin-auth');
    }
  });
});
