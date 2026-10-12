/**
 * What the viewer shows about a store, and about a graph node that reaches one. A store page has to answer
 * the questions the document does not: which engine keeps the records and which package grants it, what type
 * a key is, and which graphs run against it. A node that reaches a store has to say so, so a reader following
 * a graph arrives at the records rather than at the port that speaks for them.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { schemaUrl } from '@wilanis/core';
import { loadProject } from '@wilanis/runtime';
import { describe, expect, it } from 'vitest';
import { type DocView, viewOf } from '../src/index.js';
import { type Drawn, lifted, PAGE, words } from './page-harness.js';
import { plantedViews } from './scoped-harness.js';

const EXAMPLE = fileURLToPath(new URL('../../../example', import.meta.url));
const STORE = '@features/customers/data/customers.store.json';

const view = async (path: string): Promise<DocView> => {
  const seen = viewOf(await loadProject(EXAMPLE), path);
  if (!seen) throw new Error(`no view for ${path}`);
  return seen;
};

describe('the view of a store', () => {
  it('names the connection and the engine kind behind it, each by a path the page can link', async () => {
    const store = (await view(STORE)).store;
    expect(store?.connection).toBe('@connections/customers.connection.json');
    expect(store?.connectionLabel).toBe('Customers');
    expect(store?.kind).toBe('@storage-memory/memory.connection-kind.json');
    expect(store?.kindLabel).toBe('Records in memory');
  });

  it('names the plugin that grants the engine and the package that ships it, as a native port does', async () => {
    const store = (await view(STORE)).store;
    expect(store?.plugin).toBe('@storage-memory');
    expect(store?.from).toBe('@wilanis/plugin-storage-memory');
  });

  it("gives each collection's key its type, read from the shape the collection names", async () => {
    // latest is keyed by the tier it records, which is the one field identifying one of its rows
    expect((await view(STORE)).store?.keyTypes).toEqual({ customers: 'string', latest: 'string' });
  });

  it('lists every call run against it: the document, the node, the operation and the collection', async () => {
    const calls = (await view(STORE)).store?.calls ?? [];
    expect(calls.map(call => `${call.file}#${call.where} ${call.op} ${call.collection}`)).toEqual([
      '@features/customers/data/keep-customer.graph.json#stored put customers',
      '@features/customers/data/kept-get.graph.json#stored get customers',
      '@features/customers/data/kept-list-by-tier.graph.json#customers find customers',
      // the digest reads every tenant's customers through the view, and the call is listed under the view's name
      '@features/customers/data/kept-list-every.graph.json#customers find everyCustomer',
      '@features/customers/data/kept-list.graph.json#customers find customers',
      '@features/customers/data/kept-remove.graph.json#removed remove customers',
      '@features/customers/data/next-id.graph.json#key newKey customers',
      // the atomic graph writes twice, to two collections, and both writes are listed against the store
      '@features/customers/data/store-and-latest.graph.json#stored put customers',
      '@features/customers/data/store-and-latest.graph.json#latest put latest',
    ]);
    expect(calls[1].label).toBe('Get what is kept');
  });

  it('says nothing of the sort for a kind that is not a store', async () => {
    expect((await view('@connections/customers.connection.json')).store).toBeUndefined();
  });
});

describe('the view of a node that reaches a store', () => {
  it('links the store and names the collection, the operation and the shape the records are of', async () => {
    const graph = await view('@features/customers/data/kept-get.graph.json');
    const node = graph.graph?.nodes.find(one => one.id === 'stored');
    expect(node?.keeps).toEqual({
      store: STORE,
      label: 'Customers',
      collection: 'customers',
      of: '@features/customers/domain/Customer.shape.json',
      op: 'get',
      // the collection is kept per tenant, and the node says so, since the compiler carries the store's scope to it
      scope: {
        store: STORE,
        by: [
          {
            column: 'tenant',
            read: 'tenant',
            from: 'session.attributes.tenant',
            opens: '@features/customers/edge/request.resolvers.json',
          },
        ],
      },
    });
  });

  it('says which collection each node of a graph that writes reaches', async () => {
    const graph = await view('@features/customers/data/store-and-latest.graph.json');
    const reached = (graph.graph?.nodes ?? []).flatMap(node => (node.keeps ? [`${node.id} ${node.keeps.op}`] : []));
    expect(reached).toEqual(['stored put', 'latest put']);
  });

  it('leaves a node that reaches no store without one', async () => {
    const graph = await view('@features/customers/data/kept-get.graph.json');
    expect(graph.graph?.nodes.find(one => one.id === 'customer')?.keeps).toBeUndefined();
  });
});

describe('the view of a store another tree keeps (RFC 0042)', () => {
  const keptSaid = 'this tree reads it; wilanis migrate never plans it and no graph writes it';
  const billedStore = '@features/customers/data/billed.store.json';
  const billed = () =>
    plantedViews(
      {
        'features/customers/data/billed.store.json': {
          $schema: schemaUrl('store'),
          label: 'Billed customers',
          description: 'The customers the billing tree writes, read here.',
          connection: '@connections/customers.connection.json',
          keptBy: 'billing',
          collections: { customers: { of: '@customers/domain/Customer.shape.json', key: 'id' } },
        },
      },
      [billedStore],
    )[0];

  it('names the keeping tree, with the sentence describe prints', () => {
    expect(billed().store?.kept).toEqual({ by: 'billing', said: keptSaid });
  });

  it('says nothing of the sort for a store the tree keeps itself', async () => {
    expect((await view(STORE)).store?.kept).toBeUndefined();
  });

  it('shows the sentence under the heading, before the engine the records live behind', async () => {
    const { keptEl } = await lifted('keptEl');
    const drawn = keptEl({ by: 'billing', said: keptSaid }) as Drawn;
    expect(drawn).toMatchObject({ tag: 'p', cls: 'lead' });
    expect(words(drawn)).toBe(`Kept by billing \u2014 ${keptSaid}.`);
    const page = await readFile(PAGE, 'utf8');
    expect(page).toMatch(
      /case 'store': \{\n.*\n\s+if \(s\.kept\) page\.appendChild\(keptEl\(s\.kept\)\);\n\s+const chain/,
    );
  });

  it('leaves out the default and renamed columns, which a kept store cannot have', async () => {
    const { storeColumns } = await lifted('storeColumns');
    const all = ['collection', 'records of', 'keyed by', 'unique', 'scoped by', 'refs', 'default', 'renamed', 'holds'];
    expect(storeColumns(undefined)).toEqual(all);
    expect(storeColumns({ by: 'billing', said: keptSaid })).toEqual(
      all.filter(heading => heading !== 'default' && heading !== 'renamed'),
    );
    // each row leaves out the same two cells, so the rest stay under their headings
    const page = await readFile(PAGE, 'utf8');
    expect(page).toContain('for (const h of storeColumns(s.kept)) hd.appendChild');
    expect(page).toContain(
      "if (!s.kept) { tr.appendChild(el('td', 'mono', defaultsOf(c))); tr.appendChild(renamedCell(c)); }",
    );
  });
});
