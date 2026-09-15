/**
 * What the view model says about a graph whose effects move together. An author writes one word, `atomic`,
 * and a page has to draw three things the document never says: that the graph is one transaction, which
 * connection it falls on, and which of the drawn nodes take part. All three are read from the same walk the
 * checker judges by, so the page and the refusal cannot disagree.
 *
 * The example has no atomic graph of its own yet, so a copy of it is marked: `kept-record` asks the store for
 * a key and writes the record under it, two effects on one connection, and the graph an atomic declaration
 * suits. The domain graph bound to it is the case that matters most -- its own nodes reach no store at all,
 * and the participants are the nodes whose operations lead to one through the profile's binding.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTree } from '@wilanis/core';
import { resolveIncludes, resolvePlugins } from '@wilanis/runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DocView, viewOf } from '../src/index.js';

const EXAMPLE = fileURLToPath(new URL('../../../example', import.meta.url));
const KEPT = '@features/monitor/data/kept-record.graph.json';
const RECORD = '@features/monitor/domain/record-entry.graph.json';

/**
 * A copy of the example with the named graphs marked atomic, loaded as the viewer loads a tree. The plugins
 * and the included tree are resolved against the example itself, since a copy has no `node_modules`; this is
 * the same tree either way, with one word added to one document.
 */
function markedAtomic(...files: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-view-atomic-'));
  cpSync(EXAMPLE, dir, { recursive: true, filter: path => !path.includes('node_modules') });
  for (const file of files) {
    const at = join(dir, file);
    writeFileSync(at, JSON.stringify({ ...JSON.parse(readFileSync(at, 'utf8')), atomic: true }));
  }
  return dir;
}

let kept: ReturnType<typeof loadTree>;
let domain: ReturnType<typeof loadTree>;
const dirs: string[] = [];

beforeAll(async () => {
  const { available } = await resolvePlugins(EXAMPLE);
  const { includes } = resolveIncludes(EXAMPLE);
  const load = (...files: string[]) => {
    const dir = markedAtomic(...files);
    dirs.push(dir);
    return loadTree(dir, available, includes);
  };
  kept = load('features/monitor/data/kept-record.graph.json');
  domain = load('features/monitor/domain/record-entry.graph.json');
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const viewIn = (tree: ReturnType<typeof loadTree>, path: string): DocView => {
  const seen = viewOf(tree, path);
  if (!seen) throw new Error(`no view for ${path}`);
  return seen;
};
const view = (path: string): DocView => viewIn(kept, path);

describe('the view model of an atomic graph', () => {
  it('carries the connection its one transaction falls on, which no node of it writes down', () => {
    // the nodes name a store and a collection; the store names the connection
    expect(view(KEPT).graph!.atomic).toEqual({
      connections: ['@connections/entries.connection.json'],
      rollsBackOn: ['upstream'],
    });
  });

  it('marks the nodes that take part, and only those', () => {
    const nodes = view(KEPT).graph!.nodes;
    const taking = nodes.filter(node => node.participates).map(node => node.id);
    expect(taking).toEqual(['key', 'saved']);
    // route is a switch, row makes an object, failed refuses: none of them reaches the store
    for (const id of ['in', 'route/1', 'row', 'failed', 'out']) {
      expect(nodes.find(node => node.id === id)?.participates).toBeUndefined();
    }
  });

  it('carries nothing on a graph that does not declare it, however many effects it reaches', () => {
    const plain = view('@features/monitor/data/kept-update.graph.json').graph!;
    expect(plain.atomic).toBeUndefined();
    expect(plain.nodes.every(node => node.participates === undefined)).toBe(true);
  });
});

/**
 * A domain graph names no store: the effects its transaction holds are written in the data graph its
 * operations are bound to. What a reader can point at is still a node of the graph in front of them, so a
 * participant is the run or map node the effect descended from, not the node the effect is written at.
 *
 * `record-entry` is that graph in the example, and it is marked here alone: the tree it makes does not pass
 * the checker, since the `live` profile meets the same operation with an HTTP call that cannot take part
 * (L009, proved in the runtime's sabotage cases). What is claimed here is only what the walk finds where a
 * store is reached -- the example gets an atomic domain graph of its own with `record-all` (RFC 0004, step 8).
 */
describe('the view model of an atomic domain graph', () => {
  it('marks the node whose operation leads to the store, not the data graph below it', () => {
    const seen = viewIn(domain, RECORD).graph!;
    expect(seen.nodes.filter(node => node.participates).map(node => node.id)).toEqual(['recorded']);
  });

  it('names the connection the binding leads to, which the domain graph never mentions', () => {
    expect(viewIn(domain, RECORD).graph!.atomic!.connections).toContain('@connections/entries.connection.json');
  });
});
