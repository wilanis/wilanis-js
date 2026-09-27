/**
 * A pure operation's answer is a function of its inputs alone. A data graph fills and joins a login's password into
 * text with `@std`'s text operations, and fills its name alone; the graph runs as a nested run of the binding that
 * meets the port, so the nodes that fill are lowered with the operation's `pure` and nothing is handed down to the
 * nested kernel beside the spec. Every report shows the text built from the password as the marker.
 */
import { rmSync } from 'node:fs';
import { checkTree, runGraph } from '@wilanis/compiler';
import { loadTree } from '@wilanis/core';
import type { KCall, Report } from '@wilanis/engine';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, type Embedder, embedderFor } from '../src/index.js';
import { ADA, clearIn, fake, LOGIN, nodeNamed, putter, SECRET, vaultTree } from './redact-tree.js';

const HEADER = '@features/vault/domain/header.port.json';
const GRAPH = '@features/vault/data/header.graph.json';
const RUN = '@wilanis/node/run.schema.json';
const FILL = '@std/text.port.json#fill';
const JOIN = '@std/text.port.json#join';

/**
 * The vault, with a port whose one operation takes a login and answers a header, met by a data graph that fills the
 * password into a header, joins the name and password, fills the name alone, and fills the three into one line.
 */
function headerTree(): string {
  const dir = vaultTree();
  const put = putter(dir);
  put('features/vault/domain/header.port.json', {
    operations: { header: { description: 'd', accepts: LOGIN, returns: 'string' } },
  });
  put('features/vault/data/header.binding.json', {
    port: HEADER,
    operations: { header: { graph: GRAPH } },
  });
  const fill = (id: string, template: string, values: Record<string, string>) => ({
    type: RUN,
    id,
    run: FILL,
    in: { template, values },
  });
  put('features/vault/data/header.graph.json', {
    in: LOGIN,
    out: { type: 'string', from: 'line' },
    nodes: [
      fill('basic', 'Basic {password}', { password: '{{in.password}}' }),
      { type: RUN, id: 'pair', run: JOIN, in: { parts: ['{{in.name}}', '{{in.password}}'], separator: ':' } },
      fill('greeting', 'hello {name}', { name: '{{in.name}}' }),
      fill('line', '{a}; {b}; {c}', { a: '{{basic}}', b: '{{pair}}', c: '{{greeting}}' }),
    ],
  });
  return dir;
}

/** The tree loaded, checked and embedded, handed to `use`; the tree does not outlive it. */
async function withHeader<T>(use: (emb: Embedder) => Promise<T>): Promise<T> {
  const dir = headerTree();
  try {
    const load = loadTree(dir, { ...BUILTIN_PLUGINS, '@fake': fake });
    expect(checkTree(load).items).toEqual([]);
    return await use(embedderFor(load, { env: {} }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The header's operation run through its binding, as a plugin or a startup step fires one, with the login given. */
const headed = (): Promise<Report> =>
  withHeader(emb => runGraph(emb.operation(`${HEADER}#header`), { initial: { in: { ...ADA } }, env: emb.env }));

describe('a pure operation in a data graph that reads a secret', () => {
  it('is lowered as pure, where the call of the graph that runs it is not', async () => {
    const [graph, operation] = await withHeader(async emb => [
      emb.graph(GRAPH).spec,
      emb.operation(`${HEADER}#header`).spec,
    ]);
    expect((graph.nodes.basic as KCall).pure).toBe(true);
    expect((graph.nodes.pair as KCall).pure).toBe(true);
    expect((operation.nodes.op as KCall).pure).toBeUndefined();
  });

  it('shows text filled or joined from the secret as the marker in the nested run, and each read of it', async () => {
    const report = await headed();
    expect(report.status).toBe('done');
    expect(nodeNamed(report, 'basic')?.in).toEqual({ template: 'Basic {password}', values: { password: SECRET } });
    expect(nodeNamed(report, 'basic')?.out).toBe(SECRET);
    expect(nodeNamed(report, 'pair')?.out).toBe(SECRET);
    expect(nodeNamed(report, 'line')?.in).toEqual({
      template: '{a}; {b}; {c}',
      values: { a: SECRET, b: SECRET, c: 'hello ada' },
    });
    expect(nodeNamed(report, 'line')?.out).toBe(SECRET);
    expect(report.nodes.op.out).toBe(SECRET);
    expect(clearIn(report, ['p-ada'])).toEqual([]);
    // the run hands its caller the value itself
    expect(report.output).toBe('Basic p-ada; ada:p-ada; hello ada');
  });

  it('shows what it filled from nothing marked as it answered it', async () => {
    const report = await headed();
    expect(nodeNamed(report, 'greeting')?.in).toEqual({ template: 'hello {name}', values: { name: 'ada' } });
    expect(nodeNamed(report, 'greeting')?.out).toBe('hello ada');
  });
});
