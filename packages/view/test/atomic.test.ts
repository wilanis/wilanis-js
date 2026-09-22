/**
 * What the view model says about a graph whose effects move together. An author writes one word, `atomic`,
 * and a page has to draw three things the document never says: that the graph is one transaction, which
 * connection it falls on, and which of the drawn nodes take part. All three are read from the same walk the
 * checker judges by, so the page and the refusal cannot disagree.
 *
 * The example carries both kinds of its own, so nothing here is planted or marked: `store-and-latest` writes
 * two collections of one store, and `record-all` is a domain graph whose own nodes reach no store at all --
 * what takes part is written in the data graph its operations are bound to, which is why a participant is a
 * node of the graph being read rather than the node the effect is written at.
 */
import { fileURLToPath } from 'node:url';
import { loadProject } from '@wilanis/runtime';
import { beforeAll, describe, expect, it } from 'vitest';
import { type DocView, viewOf } from '../src/index.js';

const EXAMPLE = fileURLToPath(new URL('../../../example', import.meta.url));
const LATEST = '@features/customers/data/store-and-latest.graph.json';
const ALL = '@features/customers/domain/register-all.graph.json';

let load: Awaited<ReturnType<typeof loadProject>>;
beforeAll(async () => {
  load = await loadProject(EXAMPLE);
});

const view = (path: string): DocView => {
  const seen = viewOf(load, path);
  if (!seen) throw new Error(`no view for ${path}`);
  return seen;
};

describe('the view model of an atomic data graph', () => {
  it('carries the connection its one transaction falls on, which no node of it writes down', () => {
    // the nodes name a store and a collection; the store names the connection. 'conflict' is the graph's own,
    // for a unique the store answered violated; 'invariant' is beside 'upstream' because the guard the compiler
    // lowers at this graph's `row` refuses inside the transaction
    expect(view(LATEST).graph?.atomic).toEqual({
      connections: ['@connections/customers.connection.json'],
      rollsBackOn: ['conflict', 'invariant', 'upstream'],
    });
  });

  it('marks the nodes that take part, and only those', () => {
    const nodes = view(LATEST).graph!.nodes;
    expect(nodes.filter(node => node.participates).map(node => node.id)).toEqual(['key', 'stored', 'latest']);
    // route is a switch, row makes an object, failed refuses: none of them reaches the store
    for (const id of ['in', 'route/1', 'row', 'failed', 'out']) {
      expect(nodes.find(node => node.id === id)?.participates).toBeUndefined();
    }
  });

  it('carries nothing on a graph that does not declare it, however many effects it reaches', () => {
    const plain = view('@features/customers/data/kept-update.graph.json').graph!;
    expect(plain.atomic).toBeUndefined();
    expect(plain.nodes.every(node => node.participates === undefined)).toBe(true);
  });
});

describe('the view model of an atomic domain graph', () => {
  it('marks the node whose operation leads to the store, not the data graph below it', () => {
    expect(
      view(ALL)
        .graph!.nodes.filter(node => node.participates)
        .map(node => node.id),
    ).toEqual(['recorded']);
  });

  it('names every connection the profiles that bind it fall on, which the graph never mentions', () => {
    // local keeps the entries in memory and production in PostgreSQL: one graph, two connections, and a
    // reader chooses a profile before running
    expect(view(ALL).graph!.atomic?.connections).toEqual([
      '@connections/customers-postgres.connection.json',
      '@connections/customers.connection.json',
    ]);
  });
});
