/**
 * A tree whose every document is there to carry a secret somewhere a report could show it: a plugin that answers
 * accounts whose password it marks secret, and opens the vault at startup with a key it marks secret; data graphs
 * that hand those accounts through `@std`'s generic `make`, through a guard a field invariant lowers, and up a port
 * whose `returns` drops the mark; a graph that takes its input whole; and a cli trigger for each.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { type Kind, type LoadResult, loadTree, type PluginModule, schemaRef, schemaUrl } from '@wilanis/core';
import type { NodeReport, Report } from '@wilanis/engine';
import { expect } from 'vitest';
import { BUILTIN_PLUGINS, runTrigger } from '../src/index.js';
import { docsDir } from './example-harness.js';

export const SECRET = '«secret»';
export const ACCOUNT = '@fake/Account.shape.json';
export const ACCOUNTS = `${ACCOUNT}[]`;
export const LOGIN = '@features/vault/domain/Login.shape.json';
const RUN = '@wilanis/node/run.schema.json';
const PORT = '@features/vault/domain/vault.port.json';
const MAKE = '@std/object.port.json#make';
const VIEW = '@features/vault/edge/AccountView.shape.json';

/** The accounts the plugin answers, as it answers them. */
export const ADA = { name: 'ada', password: 'p-ada' };
export const BOB = { name: 'bob', password: 'p-bob' };
export const REDACTED = [
  { name: 'ada', password: SECRET },
  { name: 'bob', password: SECRET },
];

/** The plugin behind the accounts and the vault's key: its operations, and the shape that marks a password. */
export const fake: PluginModule = {
  root: '@fake',
  docs: docsDir({
    'plugin.json': {
      $schema: schemaRef('plugin'),
      description: 'd',
      grants: { ports: ['@fake/vault.port.json'], shapes: [ACCOUNT, '@fake/Plain.shape.json'] },
    },
    // the same fields as an account, the password not marked: what `plain` answers
    'Plain.shape.json': {
      $schema: schemaRef('shape'),
      description: 'd',
      layer: 'core',
      fields: { name: { type: 'string' }, password: { type: 'string' } },
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
      operations: {
        accounts: { description: 'every account', returns: ACCOUNTS },
        account: { description: 'one account', returns: ACCOUNT },
        plain: { description: 'one account, its password unmarked', returns: '@fake/Plain.shape.json' },
        open: {
          description: 'open the vault for as long as the tree serves',
          accepts: { key: { type: 'string', secret: true } },
          holds: true,
        },
      },
    },
  }),
  handlers: {
    '@fake/vault.port.json#accounts': async () => [{ ...ADA }, { ...BOB }],
    '@fake/vault.port.json#account': async () => ({ ...ADA }),
    '@fake/vault.port.json#plain': async () => ({ ...ADA }),
    '@fake/vault.port.json#open': async () => undefined,
  },
};

/** A node running an operation, with what it is given. */
const node = (id: string, run: string, input?: object) => ({ type: RUN, id, run, ...(input ? { in: input } : {}) });

/** The domain's port and the binding that meets every operation of it with a data graph. */
function domain(put: (rel: string, doc: object) => void): void {
  put('features/vault/domain/Login.shape.json', {
    layer: 'core',
    fields: { name: { type: 'string' }, password: { type: 'string', secret: true } },
  });
  // what `peek` answers: the same fields, the password not marked
  put('features/vault/domain/Peek.shape.json', {
    layer: 'core',
    fields: { name: { type: 'string' }, password: { type: 'string' } },
  });
  put('features/vault/domain/logins-are-named.invariant.json', {
    holds: { on: LOGIN, when: 'len(name) > 0 && len(password) > 0' },
  });
  put(`features/vault/domain/vault.port.json`, {
    operations: {
      accounts: { description: 'd', returns: ACCOUNTS },
      unlock: { description: 'd', accepts: { key: { type: 'string', secret: true } }, returns: 'string' },
      login: { description: 'd', returns: LOGIN },
      logins: { description: 'd', returns: `${LOGIN}[]` },
      peek: { description: 'd', returns: '@features/vault/domain/Peek.shape.json' },
      glance: { description: 'd', returns: LOGIN },
    },
  });
  const graphs = ['accounts', 'unlock', 'login', 'logins', 'peek'];
  // `glance` delegates to an operation whose `returns` drops the mark the port carries
  const delegated = { glance: { run: '@fake/vault.port.json#plain' } };
  put('features/vault/data/vault.binding.json', {
    port: PORT,
    operations: {
      ...Object.fromEntries(graphs.map(op => [op, { graph: `@features/vault/data/${op}.graph.json` }])),
      ...delegated,
    },
  });
}

/** One data graph per operation of the port. */
function graphs(put: (rel: string, doc: object) => void): void {
  put('features/vault/data/accounts.graph.json', {
    out: { type: ACCOUNTS, from: 'made' },
    nodes: [
      node('listed', '@fake/vault.port.json#accounts'),
      node('made', MAKE, { value: '{{listed}}', type: ACCOUNTS }),
    ],
  });
  // a graph that takes its input whole: the binding hands it the one field the operation accepts, as `in`
  put('features/vault/data/unlock.graph.json', {
    in: 'string',
    out: { type: 'string', from: 'opened' },
    nodes: [node('opened', MAKE, { value: '{{in}}', type: 'string' })],
  });
  // a made site of Login, and a list of them: each is guarded, since nothing proves the rule of what the plugin says
  put('features/vault/data/login.graph.json', {
    out: { type: LOGIN, from: 'login' },
    nodes: [
      node('fetched', '@fake/vault.port.json#account'),
      node('login', MAKE, { value: '{{fetched}}', type: LOGIN }),
    ],
  });
  put('features/vault/data/logins.graph.json', {
    out: { type: `${LOGIN}[]`, from: 'logins' },
    nodes: [
      node('listed', '@fake/vault.port.json#accounts'),
      node('logins', MAKE, { value: '{{listed}}', type: `${LOGIN}[]` }),
    ],
  });
  // the answering node marks the password; the port's `returns` does not
  put('features/vault/data/peek.graph.json', {
    out: { type: '@features/vault/domain/Peek.shape.json', from: 'fetched' },
    nodes: [node('fetched', '@fake/vault.port.json#account')],
  });
}

/** One cli trigger per operation, and the edge shapes they answer and take. */
function edge(put: (rel: string, doc: object) => void): void {
  put('features/vault/edge/AccountView.shape.json', {
    layer: 'edge',
    fields: { name: { type: 'string' }, password: { type: 'string', secret: true } },
  });
  put('features/vault/edge/PeekView.shape.json', {
    layer: 'edge',
    fields: { name: { type: 'string' }, password: { type: 'string' } },
  });
  put('features/vault/edge/Key.shape.json', { layer: 'edge', fields: { key: { type: 'string', secret: true } } });
  const outs: Record<string, string> = {
    accounts: `${VIEW}[]`,
    login: VIEW,
    logins: `${VIEW}[]`,
    peek: '@features/vault/edge/PeekView.shape.json',
    glance: VIEW,
  };
  for (const [op, out] of Object.entries(outs))
    put(`features/vault/edge/${op}.trigger.json`, {
      kind: '@cli/cli.trigger-kind.json',
      settings: {},
      out,
      fire: { run: `${PORT}#${op}` },
    });
  put('features/vault/edge/unlock.trigger.json', {
    kind: '@cli/cli.trigger-kind.json',
    settings: {},
    in: '@features/vault/edge/Key.shape.json',
    out: 'string',
    fire: { run: `${PORT}#unlock`, in: { key: '{{request.flags.key}}' } },
  });
}

/** The tree's directory, written fresh; the caller removes it. */
export function vaultTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-vault-'));
  const put = (rel: string, doc: object) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    const kind = rel
      .replace(/\.json$/, '')
      .split(/[./]/)
      .at(-1) as Kind;
    writeFileSync(join(dir, rel), JSON.stringify({ $schema: schemaUrl(kind), description: 'd', ...doc }));
  };
  put('project.json', {
    name: 'vault',
    plugins: [{ use: '@std' }, { use: '@cli' }, { use: '@fake' }],
    secrets: { vaultKey: 'VAULT_KEY' },
    startup: [{ label: 'Open the vault', run: '@fake/vault.port.json#open', in: { key: '{{secrets.vaultKey}}' } }],
  });
  put('features/vault/feature.json', {
    exports: [],
    effects: ['@fake/vault.port.json#accounts', '@fake/vault.port.json#account', '@fake/vault.port.json#plain'],
  });
  domain(put);
  graphs(put);
  edge(put);
  return dir;
}

/** The tree loaded and checked, handed to `use`; the tree does not outlive it. */
export async function withVault<T>(use: (load: LoadResult) => Promise<T>): Promise<T> {
  const dir = vaultTree();
  try {
    const load = loadTree(dir, { ...BUILTIN_PLUGINS, '@fake': fake });
    expect(checkTree(load).items).toEqual([]);
    return await use(load);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One run of one of the tree's triggers, by its operation's name. */
export const fired = (op: string, flags: Record<string, string> = {}) =>
  withVault(load => runTrigger(load, `@features/vault/edge/${op}.trigger.json`, { flags }, { log: () => {} }));

/** The report of the node with this id, wherever it ran in the run's nested reports. */
export function nodeNamed(report: Report, id: string): NodeReport | undefined {
  for (const [name, one] of Object.entries(report.nodes)) {
    if (name === id) return one;
    const below = one.sub && nodeNamed(one.sub, id);
    if (below) return below;
  }
  return undefined;
}

/**
 * Every place a report shows one of `values` in clear, by the path of node ids that leads there: each node's in and
 * out, the output of a nested run hung on it or on an attempt, and a map's elements. The run's own output is what
 * the caller is handed, so it is not a place a report shows.
 */
export function clearIn(report: Report, values: string[], at = ''): string[] {
  return Object.entries(report.nodes).flatMap(([id, one]) => clearInNode(one, `${at}${id}`, values));
}

/** The places one node's report shows a value in clear, and the nested runs below it. */
function clearInNode(one: NodeReport, at: string, values: string[]): string[] {
  const shows = (said: unknown) => values.some(value => JSON.stringify(said ?? null).includes(value));
  const nested = [one.sub, ...(one.attempts ?? []).map(attempt => attempt.sub)].filter(sub => sub !== undefined);
  return [
    ...(shows(one.in) ? [`${at}.in`] : []),
    ...(shows(one.out) ? [`${at}.out`] : []),
    ...nested.flatMap(sub => [...(shows(sub.output) ? [`${at}.sub.output`] : []), ...clearIn(sub, values, `${at}/`)]),
    ...(one.items ?? []).flatMap((item, index) => clearInNode(item, `${at}.${index}`, values)),
  ];
}
