/**
 * A secret field, from the port that marks it to the report of a run: a plugin operation answers a list of
 * accounts whose password is `secret`, a data graph calls it and hands the list through `@std`'s generic `make`,
 * and a cli trigger fires the domain operation that graph meets. Every report the run writes shows the passwords
 * as the marker -- the call that answered the list, the `make` whose input is typed `$T`, the binding's call of
 * the graph and the nested run hung on it -- while the run answers its caller the accounts themselves.
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
const RUN = '@wilanis/node/run.schema.json';
const TRIGGER = '@features/vault/edge/accounts.trigger.json';
const UNLOCK = '@features/vault/edge/unlock.trigger.json';
const REDACTED = [
  { name: 'ada', password: '«secret»' },
  { name: 'bob', password: '«secret»' },
];

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
  put('features/vault/domain/vault.port.json', {
    operations: {
      accounts: { description: 'd', returns: ACCOUNTS },
      unlock: { description: 'd', accepts: { key: { type: 'string', secret: true } }, returns: 'string' },
    },
  });
  put('features/vault/data/vault.binding.json', {
    port: '@features/vault/domain/vault.port.json',
    operations: {
      accounts: { graph: '@features/vault/data/accounts.graph.json' },
      unlock: { graph: '@features/vault/data/unlock.graph.json' },
    },
  });
  // a graph that takes its input whole: the binding hands it the one field the operation accepts, as `in`
  put('features/vault/data/unlock.graph.json', {
    in: 'string',
    out: { type: 'string', from: 'opened' },
    nodes: [{ type: RUN, id: 'opened', run: '@std/object.port.json#make', in: { value: '{{in}}', type: 'string' } }],
  });
  put('features/vault/data/accounts.graph.json', {
    out: { type: ACCOUNTS, from: 'made' },
    nodes: [
      { type: RUN, id: 'listed', run: '@fake/vault.port.json#accounts' },
      { type: RUN, id: 'made', run: '@std/object.port.json#make', in: { value: '{{listed}}', type: ACCOUNTS } },
    ],
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
  put('features/vault/edge/Key.shape.json', { layer: 'edge', fields: { key: { type: 'string', secret: true } } });
  put('features/vault/edge/unlock.trigger.json', {
    kind: '@cli/cli.trigger-kind.json',
    settings: {},
    in: '@features/vault/edge/Key.shape.json',
    out: 'string',
    fire: { run: '@features/vault/domain/vault.port.json#unlock', in: { key: '{{request.flags.key}}' } },
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

/** One run of one of the tree's triggers, the tree checked first; the tree does not outlive the run. */
async function fired(trigger = TRIGGER, flags: Record<string, string> = {}) {
  const dir = vaultTree();
  try {
    const load = loadTree(dir, { ...BUILTIN_PLUGINS, '@fake': fake });
    expect(checkTree(load).items).toEqual([]);
    return await runTrigger(load, trigger, { flags }, { log: () => {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('a secret field, in the report of a run', () => {
  it('is the marker in each element of the list the call answered', async () => {
    const { report } = await fired();
    expect(report.status).toBe('done');
    expect(nodeNamed(report, 'listed')?.out).toEqual(REDACTED);
  });

  it("is the marker in the input of a generic operation, typed through the call's type binding", async () => {
    const { report } = await fired();
    expect(nodeNamed(report, 'made')?.in).toEqual({ value: REDACTED, type: ACCOUNTS });
    expect(nodeNamed(report, 'made')?.out).toEqual(REDACTED);
  });

  it('is in clear in what the run answers, and in no report the run writes', async () => {
    const { report, answer } = await fired();
    const accounts = [
      { name: 'ada', password: 'p-ada' },
      { name: 'bob', password: 'p-bob' },
    ];
    expect(answer).toEqual(accounts);
    const { output, ...reported } = report;
    expect(output).toEqual(accounts);
    // the binding's call of the graph and the nested run hung on it say the answer as the port marks it
    expect(reported.nodes.op.out).toEqual(REDACTED);
    expect(reported.nodes.op.sub?.output).toEqual(REDACTED);
    const said = JSON.stringify(reported);
    expect(said).not.toContain('p-ada');
    expect(said).not.toContain('p-bob');
  });

  it('is the marker in the input a binding hands a graph that takes it whole, under the name it hands it by', async () => {
    const { report, answer } = await fired(UNLOCK, { key: 'k-1' });
    expect(report.status).toBe('done');
    expect(report.nodes.op.in).toEqual({ in: '«secret»' });
    expect(answer).toBe('k-1');
  });
});
