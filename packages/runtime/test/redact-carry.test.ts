/**
 * A secret read into a type that does not mark it carries its mark. A graph hands a login's password through
 * `@std`'s `make` typed `string`, and builds a credential header from it with text; the graph that takes the vault's
 * key whole hands it back as a plain `string`; a startup step builds a header from a `{{secrets.*}}` read for an
 * operation that marks nothing. Each report shows the secret as the marker from the node that read it on, while the
 * run hands on the values themselves.
 */
import { rmSync } from 'node:fs';
import { checkTree, runGraph } from '@wilanis/compiler';
import { type LoadResult, loadTree } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, embedderFor } from '../src/index.js';
import { ADA, clearIn, fake, fired, LOGIN, nodeNamed, putter, SECRET, vaultTree, withVault } from './redact-tree.js';

const BADGE = '@features/vault/domain/badge.port.json';
const RUN = '@wilanis/node/run.schema.json';
const MAKE = '@std/object.port.json#make';

/** A node making a plain string of what it is given. */
const text = (id: string, value: string) => ({ type: RUN, id, run: MAKE, in: { value, type: 'string' } });

/**
 * The vault, with a port whose one operation takes a login and answers a header, met by a data graph that reads the
 * password into a plain string, builds a header from that string and one from the password itself, and joins them.
 */
function badgeTree(): string {
  const dir = vaultTree();
  const put = putter(dir);
  put('features/vault/domain/badge.port.json', {
    operations: { badge: { description: 'd', accepts: LOGIN, returns: 'string' } },
  });
  put('features/vault/data/badge.binding.json', {
    port: BADGE,
    operations: { badge: { graph: '@features/vault/data/badge.graph.json' } },
  });
  put('features/vault/data/badge.graph.json', {
    in: LOGIN,
    out: { type: 'string', from: 'joined' },
    nodes: [
      text('pass', '{{in.password}}'),
      text('basic', 'Basic {{pass}}'),
      text('bearer', 'Bearer {{in.password}}'),
      text('joined', '{{basic}}, {{bearer}}, for {{in.name}}'),
    ],
  });
  return dir;
}

/** The badge's operation run through its binding, as a plugin or a startup step fires one, with the login given. */
async function badged(): Promise<Awaited<ReturnType<typeof runGraph>>> {
  const dir = badgeTree();
  try {
    const load: LoadResult = loadTree(dir, { ...BUILTIN_PLUGINS, '@fake': fake });
    expect(checkTree(load).items).toEqual([]);
    const emb = embedderFor(load, { env: {} });
    return await runGraph(emb.operation(`${BADGE}#badge`), { initial: { in: { ...ADA } }, env: emb.env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('a secret read into a type that does not mark it', () => {
  it('is the marker in the answer of a make typed string, and in the text that reads it', async () => {
    const report = await badged();
    expect(report.status).toBe('done');
    expect(nodeNamed(report, 'pass')?.in).toEqual({ value: SECRET, type: 'string' });
    expect(nodeNamed(report, 'pass')?.out).toBe(SECRET);
    expect(nodeNamed(report, 'basic')?.in).toEqual({ value: SECRET, type: 'string' });
    expect(nodeNamed(report, 'basic')?.out).toBe(SECRET);
  });

  it('is the marker whole in text that interpolates it, in the node given the text and in its answer', async () => {
    const report = await badged();
    expect(nodeNamed(report, 'bearer')?.in).toEqual({ value: SECRET, type: 'string' });
    expect(nodeNamed(report, 'bearer')?.out).toBe(SECRET);
    expect(nodeNamed(report, 'joined')?.out).toBe(SECRET);
  });

  it('is the marker in the call of the graph that answers it as a plain string, and in clear in its answer alone', async () => {
    const report = await badged();
    expect(report.nodes.op.out).toBe(SECRET);
    expect(report.nodes.op.sub?.output).toBe(SECRET);
    expect(report.output).toBe('Basic p-ada, Bearer p-ada, for ada');
    expect(clearIn(report, ['p-ada'])).toEqual([]);
  });

  it('is the marker where a graph that takes it whole hands it back as a plain string', async () => {
    const { report, answer } = await fired('unlock', { key: 'k-1' });
    expect(report.status).toBe('done');
    expect(nodeNamed(report, 'opened')?.out).toBe(SECRET);
    expect(report.nodes.op.out).toBe(SECRET);
    expect(clearIn(report, ['k-1'])).toEqual([]);
    expect(answer).toBe('k-1');
  });
});

describe("a startup step's input built from a secret", () => {
  it('is the marker whole where text interpolates the secret, for an operation that marks nothing', async () => {
    const report = await withVault(async load => {
      const emb = embedderFor(load, { env: { VAULT_KEY: 'v-1' } });
      const step = {
        label: 'Announce',
        run: '@fake/vault.port.json#announce',
        in: { header: 'Bearer {{secrets.vaultKey}}' },
      };
      return emb.startup(step, { at: 1 });
    });
    expect(report.status).toBe('done');
    expect(report.nodes.op.in).toEqual({ header: SECRET });
    expect(clearIn(report, ['v-1'])).toEqual([]);
  });
});
