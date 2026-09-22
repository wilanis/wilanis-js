import { collectionOf, effectsOfGraph } from '@wilanis/compiler';
import { loadTree, Scope } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { codes, EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

describe('the collection a call site is over, and the scope edge that follows it', () => {
  const scope = () => {
    const load = loadTree(EXAMPLE, PLUGINS, INCLUDES);
    return new Scope(load.registry, load.resolve);
  };
  const site = (key: string, given: Record<string, unknown>) => collectionOf(scope(), { key, given });

  it('reads the store and the collection off a storage site, through the port own resolves channel', () => {
    // nothing here knows the word `store`: the port says that its `store` input names a document keyed by
    // its `collection` input (`collections[collection].of`), and that is what is read
    expect(
      site('@storage/store.port.json#get', { store: '@customers/data/customers.store.json', collection: 'customers' }),
    ).toEqual({ store: '@features/customers/data/customers.store.json', collection: 'customers' });
    expect(
      site('@storage/store.port.json#find', { store: '@customers/data/customers.store.json', collection: 'latest' }),
    ).toEqual({ store: '@features/customers/data/customers.store.json', collection: 'latest' });
  });
  it('answers a site of an operation that binds no type, since the address is the port and not the operation', () => {
    // count resolves nothing -- it answers a number -- and is over a collection all the same
    expect(
      site('@storage/store.port.json#count', {
        store: '@customers/data/customers.store.json',
        collection: 'customers',
      }),
    ).toEqual({ store: '@features/customers/data/customers.store.json', collection: 'customers' });
  });
  it('answers nothing where a site is over no collection', () => {
    // an http request names no store; ensure names a store and no collection; a collection the store does
    // not declare is X204 where it is named, and nothing here pretends to know which one was meant
    expect(site('@http/http.port.json#request', { url: 'https://example.test' })).toBeUndefined();
    expect(
      site('@storage/storage.port.json#ensure', { store: '@customers/data/customers.store.json' }),
    ).toBeUndefined();
    expect(
      site('@storage/store.port.json#get', { store: '@customers/data/customers.store.json', collection: 'nope' }),
    ).toBeUndefined();
    expect(
      site('@storage/store.port.json#get', { store: '@customers/data/nope.store.json', collection: 'customers' }),
    ).toBeUndefined();
  });
  it('answers nothing for a site whose store or collection is not written down', () => {
    // both inputs are static, so a call that does not write one names no collection the compiler can read
    expect(site('@storage/store.port.json#get', { collection: 'customers' })).toBeUndefined();
    expect(
      site('@storage/store.port.json#get', {
        store: '@customers/data/customers.store.json',
        collection: '{{in.which}}',
      }),
    ).toBeUndefined();
  });
  it('every storage site the example reaches names a collection, and none of them is scoped today', () => {
    // the example keeps its customers unscoped until RFC 0015 step 10, so the edge adds nothing to this tree:
    // that it adds A006 and B008 the moment a collection is scoped is sabotage-scoping.test.ts
    const tree = scope();
    const sites = effectsOfGraph(tree, '@features/customers/data/kept-get.graph.json');
    const named = sites.map(one => collectionOf(tree, one)).filter(Boolean);
    expect(named).toEqual([{ store: '@features/customers/data/customers.store.json', collection: 'customers' }]);
    expect(codes(EXAMPLE)).toEqual([]);
  });
});
