/**
 * What the viewer shows about a store, and about a graph node that reaches one. A store page has to answer
 * the questions the document does not: which engine keeps the records and which package grants it, what type
 * a key is, and which graphs run against it. A node that reaches a store has to say so, so a reader following
 * a graph arrives at the records rather than at the port that speaks for them.
 */
import { fileURLToPath } from 'node:url';
import { loadProject } from '@wilanis/runtime';
import { describe, expect, it } from 'vitest';
import { type DocView, viewOf } from '../src/index.js';

const EXAMPLE = fileURLToPath(new URL('../../../example', import.meta.url));
const STORE = '@features/monitor/data/entries.store.json';

const view = async (path: string): Promise<DocView> => {
  const seen = viewOf(await loadProject(EXAMPLE), path);
  if (!seen) throw new Error(`no view for ${path}`);
  return seen;
};

describe('the view of a store', () => {
  it('names the connection and the engine kind behind it, each by a path the page can link', async () => {
    const store = (await view(STORE)).store;
    expect(store?.connection).toBe('@connections/entries.connection.json');
    expect(store?.connectionLabel).toBe('Entries');
    expect(store?.kind).toBe('@storage-memory/memory.connection-kind.json');
    expect(store?.kindLabel).toBe('Records in memory');
  });

  it('names the plugin that grants the engine and the package that ships it, as a native port does', async () => {
    const store = (await view(STORE)).store;
    expect(store?.plugin).toBe('@storage-memory');
    expect(store?.from).toBe('@wilanis/plugin-storage-memory');
  });

  it("gives each collection's key its type, read from the shape the collection names", async () => {
    // latest is keyed by the method it records, which is the one field identifying one of its rows
    expect((await view(STORE)).store?.keyTypes).toEqual({ entries: 'string', latest: 'string' });
  });

  it('lists every call run against it: the document, the node, the operation and the collection', async () => {
    const calls = (await view(STORE)).store?.calls ?? [];
    expect(calls.map(call => `${call.file}#${call.where} ${call.op} ${call.collection}`)).toEqual([
      '@features/monitor/data/kept-get.graph.json#asked get entries',
      '@features/monitor/data/kept-list-by-method.graph.json#rows find entries',
      '@features/monitor/data/kept-list.graph.json#rows find entries',
      '@features/monitor/data/kept-remove.graph.json#asked remove entries',
      '@features/monitor/data/kept-update.graph.json#asked patch entries',
      // the atomic graph writes twice, to two collections, and both writes are listed against the store
      '@features/monitor/data/store-and-latest.graph.json#key newKey entries',
      '@features/monitor/data/store-and-latest.graph.json#stored put entries',
      '@features/monitor/data/store-and-latest.graph.json#latest put latest',
    ]);
    expect(calls[0].label).toBe('Get what is kept');
  });

  it('says nothing of the sort for a kind that is not a store', async () => {
    expect((await view('@connections/entries.connection.json')).store).toBeUndefined();
  });
});

describe('the view of a node that reaches a store', () => {
  it('links the store and names the collection, the operation and the shape the records are of', async () => {
    const graph = await view('@features/monitor/data/kept-get.graph.json');
    const node = graph.graph?.nodes.find(one => one.id === 'asked');
    expect(node?.keeps).toEqual({
      store: STORE,
      label: 'Entries',
      collection: 'entries',
      of: '@features/monitor/domain/Entry.shape.json',
      op: 'get',
    });
  });

  it('says which collection each node of a graph that writes reaches', async () => {
    const graph = await view('@features/monitor/data/store-and-latest.graph.json');
    const reached = (graph.graph?.nodes ?? []).flatMap(node => (node.keeps ? [`${node.id} ${node.keeps.op}`] : []));
    expect(reached).toEqual(['key newKey', 'stored put', 'latest put']);
  });

  it('leaves a node that reaches no store without one', async () => {
    const graph = await view('@features/monitor/data/kept-get.graph.json');
    expect(graph.graph?.nodes.find(one => one.id === 'row')?.keeps).toBeUndefined();
  });
});
