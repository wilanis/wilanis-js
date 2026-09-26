/**
 * A secret field inside a list, from the port that marks it to the report of a run: a plugin operation answers
 * a list of accounts whose password is `secret`, a data graph calls it, and a cli trigger fires the domain
 * operation that graph meets. The compiler's paths name fields only, a list adding no segment, and the engine
 * walks each list it meets, so the call that answered the list shows every password as the marker, and no report
 * of the run shows one in clear.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { type Kind, loadTree, type PluginModule, schemaRef, schemaUrl } from '@wilanis/core';
import type { NodeReport, Report } from '@wilanis/engine';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, runTrigger } from '../src/index.js';
import { docsDir } from './example-harness.js';

const ACCOUNTS = '@fake/Account.shape.json[]';

/** The plugin behind `listed`: one operation answering two accounts, and the shape that marks their password. */
const fake: PluginModule = {
  root: '@fake',
  docs: docsDir({
    'plugin.json': {
      $schema: schemaRef('plugin'),
      description: 'd',
      grants: { ports: ['@fake/vault.port.json'], shapes: ['@fake/Account.shape.json'] },
    },
    'Account.shape.json': {
      $schema: schemaRef('shape'),
      description: 'd',
      layer: 'core',
      fields: { name: { type: 'string' }, password: { type: 'string', secret: true } },
    },
    'vault.port.json': {
      $schema: schemaRef('port'),
      description: 'd',
      operations: { accounts: { description: 'every account', returns: ACCOUNTS } },
    },
  }),
  handlers: {
    '@fake/vault.port.json#accounts': async () => [
      { name: 'ada', password: 'p-ada' },
      { name: 'bob', password: 'p-bob' },
    ],
  },
};

/** The tree's directory, written fresh. */
function vaultTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-vault-'));
  const put = (rel: string, doc: object) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    const kind = rel
      .replace(/\.json$/, '')
      .split(/[./]/)
      .at(-1) as Kind;
    writeFileSync(join(dir, rel), JSON.stringify({ $schema: schemaUrl(kind), description: 'd', ...doc }));
  };
  put('project.json', { name: 'vault', plugins: [{ use: '@std' }, { use: '@cli' }, { use: '@fake' }] });
  put('features/vault/feature.json', { exports: [], effects: ['@fake/vault.port.json#accounts'] });
  put('features/vault/domain/vault.port.json', { operations: { accounts: { description: 'd', returns: ACCOUNTS } } });
  put('features/vault/data/vault.binding.json', {
    port: '@features/vault/domain/vault.port.json',
    operations: { accounts: { graph: '@features/vault/data/accounts.graph.json' } },
  });
  put('features/vault/data/accounts.graph.json', {
    out: { type: ACCOUNTS, from: 'listed' },
    nodes: [{ type: '@wilanis/node/run.schema.json', id: 'listed', run: '@fake/vault.port.json#accounts' }],
  });
  // the edge answers its own shape, field for field the core one
  put('features/vault/edge/AccountView.shape.json', {
    layer: 'edge',
    fields: { name: { type: 'string' }, password: { type: 'string', secret: true } },
  });
  put('features/vault/edge/accounts.trigger.json', {
    kind: '@cli/cli.trigger-kind.json',
    settings: {},
    out: '@features/vault/edge/AccountView.shape.json[]',
    fire: { run: '@features/vault/domain/vault.port.json#accounts' },
  });
  return dir;
}

/** The report of the node with this id, wherever it ran in the run's nested reports. */
function nodeNamed(report: Report, id: string): NodeReport | undefined {
  for (const [name, node] of Object.entries(report.nodes)) {
    if (name === id) return node;
    const below = node.sub && nodeNamed(node.sub, id);
    if (below) return below;
  }
  return undefined;
}

describe('a secret field inside a list, in the report of a run', () => {
  it('is the marker in every report the run writes, the call that answered the list among them', async () => {
    const dir = vaultTree();
    const load = loadTree(dir, { ...BUILTIN_PLUGINS, '@fake': fake });
    expect(checkTree(load).items).toEqual([]);

    const { report } = await runTrigger(load, '@features/vault/edge/accounts.trigger.json', {}, { log: () => {} });

    expect(report.status).toBe('done');
    expect(nodeNamed(report, 'listed')?.out).toEqual([
      { name: 'ada', password: '«secret»' },
      { name: 'bob', password: '«secret»' },
    ]);
    const said = JSON.stringify(report);
    expect(said).not.toContain('p-ada');
    expect(said).not.toContain('p-bob');
    rmSync(dir, { recursive: true, force: true });
  });
});
