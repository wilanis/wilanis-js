import { describe, expect, it } from 'vitest';
import { keeps, kept as keptOf, type StoreDoc } from '../src/model.js';
import { at, doc, refused } from './documents.js';

describe('store', () => {
  it('names one connection by path and at least one collection', () => {
    expect(refused(doc('store', { connection: 'postgres' }))).toEqual([at('connection', 'A document path')]);
    expect(refused(doc('store', { collections: {} }))).toEqual([
      at('collections', 'must NOT have fewer than 1 properties'),
    ]);
    const { connection: _, ...without } = doc('store');
    expect(refused(without)).toEqual([at(undefined, "missing 'connection'")]);
  });
  it('a collection is named by an identifier and says the shape it keeps and the field that keys it', () => {
    const collections = (one: Record<string, unknown>) => doc('store', { collections: { entries: one } });
    expect(refused(collections({ of: '@features/f/domain/Customer.shape.json' }))).toEqual([
      at('collections/entries', "missing 'key'"),
    ]);
    expect(refused(collections({ key: 'id' }))).toEqual([at('collections/entries', "missing 'of'")]);
    expect(refused(collections({ of: 'Entry', key: 'id' }))).toEqual([at('collections/entries/of', 'A type:')]);
    expect(refused(collections({ of: '@features/f/domain/Customer.shape.json', key: 'the id' }))).toEqual([
      at('collections/entries/key', 'identifier'),
    ]);
    expect(refused(collections({ of: '@features/f/domain/Customer.shape.json', key: 'id', table: 'entries' }))).toEqual(
      [at('collections/entries', "unknown property 'table'")],
    );
    expect(refused(doc('store', { collections: { 'Bad Name': { of: 'unknown', key: 'id' } } }))).toEqual([
      at('collections', "property name 'Bad Name'", 'identifier'),
    ]);
  });
  it('a collection may declare what no two records repeat, which field holds another collection key, what existing rows receive, and what it was called before', () => {
    const entries = {
      of: '@features/f/domain/Customer.shape.json',
      key: 'id',
      unique: [['url', 'method']],
      defaults: { ua: 'unknown' },
      renamed: { agent: 'ua' },
      was: 'calls',
      description: 'observed calls',
    };
    const notes = {
      of: '@features/f/domain/Note.shape.json',
      key: 'id',
      refs: { entryId: { collection: 'entries', onRemove: 'refuse', description: 'the entry observed' } },
    };
    expect(refused(doc('store', { collections: { entries, notes } }))).toEqual([]);
  });
  it('a rename names both names by an identifier, and a previous collection name is one identifier', () => {
    const collections = (one: Record<string, unknown>) =>
      doc('store', { collections: { entries: { of: '@features/f/domain/Customer.shape.json', key: 'id', ...one } } });
    expect(refused(collections({ renamed: { agent: 7 } }))).toEqual([
      at('collections/entries/renamed/agent', 'must be string'),
    ]);
    expect(refused(collections({ renamed: { 'the agent': 'ua' } }))).toEqual([
      at('collections/entries/renamed', "property name 'the agent'", 'identifier'),
    ]);
    expect(refused(collections({ renamed: { agent: 'the ua' } }))).toEqual([
      at('collections/entries/renamed/agent', 'identifier'),
    ]);
    expect(refused(collections({ was: 'two words' }))).toEqual([at('collections/entries/was', 'identifier')]);
  });
  it('a constraint names each field by its identifier, and names at least one', () => {
    const collections = (one: Record<string, unknown>) =>
      doc('store', { collections: { entries: { of: '@features/f/domain/Customer.shape.json', key: 'id', ...one } } });
    expect(refused(collections({ unique: [[]] }))).toEqual([
      at('collections/entries/unique/0', 'must NOT have fewer than 1 items'),
    ]);
    expect(refused(collections({ unique: [['url', 'url']] }))).toEqual([
      at('collections/entries/unique/0', 'must NOT have duplicate items'),
    ]);
    expect(refused(collections({ unique: [['the url']] }))).toEqual([
      at('collections/entries/unique/0/0', 'identifier'),
    ]);
    expect(refused(collections({ unique: ['url'] }))).toEqual([at('collections/entries/unique/0', 'must be array')]);
    expect(refused(collections({ defaults: { 'not a field': 1 } }))).toEqual([
      at('collections/entries/defaults', "property name 'not a field'", 'identifier'),
    ]);
  });
  it('a reference names one collection and refuses a removal, and admits nothing else', () => {
    const collections = (ref: Record<string, unknown>) =>
      doc('store', {
        collections: { entries: { of: '@features/f/domain/Customer.shape.json', key: 'id', refs: { entryId: ref } } },
      });
    expect(refused(collections({}))).toEqual([at('collections/entries/refs/entryId', "missing 'collection'")]);
    expect(refused(collections({ collection: 'entries', onRemove: 'cascade' }))).toEqual([
      at('collections/entries/refs/entryId/onRemove', 'must be one of "refuse"'),
    ]);
    expect(refused(collections({ collection: '@features/f/data/other.store.json' }))).toEqual([
      at('collections/entries/refs/entryId/collection', 'identifier'),
    ]);
    expect(refused(collections({ collection: 'entries', of: 'string' }))).toEqual([
      at('collections/entries/refs/entryId', "unknown property 'of'"),
    ]);
  });
});

describe('a store that scopes what a caller sees', () => {
  const kept = { of: '@features/f/domain/Customer.shape.json', key: 'id' };
  const store = (collections: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    doc('store', { collections, ...extra });

  it('a scope is columns the store keeps, filled by reads it binds as a data graph binds one', () => {
    expect(
      refused(
        store(
          { entries: { ...kept, unique: [['url', 'method']], scoped: { tenant: '{{tenant}}' } } },
          { reads: { tenant: '@features/f/edge/request.resolvers.json#tenant' } },
        ),
      ),
    ).toEqual([]);
    // several scopes at once: a collection may be a tenant's and an owner's, each column filled from its own read
    expect(
      refused(
        store(
          { entries: { ...kept, scoped: { tenant: '{{tenant}}', owner: '{{owner}}' } } },
          {
            reads: {
              tenant: '@features/f/edge/request.resolvers.json#tenant',
              owner: '@features/f/edge/request.resolvers.json#owner',
            },
          },
        ),
      ),
    ).toEqual([]);
  });

  it('a view is the same rows across every scope, behind the policy that guards them', () => {
    expect(
      refused(
        store({
          entries: { ...kept, scoped: { tenant: '{{tenant}}' } },
          everyEntry: {
            view: 'entries',
            behind: '@access/edge/employees-only.policy.json',
            description: "the same rows, every tenant's",
          },
        }),
      ),
    ).toEqual([]);
  });

  it('a collection is exactly one of the two shapes: a view declares nothing a kept collection does', () => {
    // `view` tells the two apart, so an author is answered about the shape they wrote and not about the other
    expect(refused(store({ everyEntry: { view: 'entries', behind: '@a/edge/p.policy.json', ...kept } }))).toEqual([
      at('collections/everyEntry/of', "'of' is not allowed here"),
      at('collections/everyEntry/key', "'key' is not allowed here"),
    ]);
    expect(
      refused(
        store({
          everyEntry: { view: 'entries', behind: '@a/edge/p.policy.json', scoped: { tenant: '{{tenant}}' } },
        }),
      ),
    ).toEqual([at('collections/everyEntry/scoped', "'scoped' is not allowed here")]);
    expect(refused(store({ everyEntry: { view: 'entries' } }))).toEqual([
      at('collections/everyEntry', "missing 'behind'"),
    ]);
    // and `behind` is a view's alone: a collection that keeps records may not be gated by one
    expect(refused(store({ entries: { ...kept, behind: '@a/edge/p.policy.json' } }))).toEqual([
      at('collections/entries/behind', "'behind' is not allowed here"),
    ]);
  });

  it('a scope names a column and a string that reads it; a read names a resolver of a document, not the document', () => {
    expect(refused(store({ entries: { ...kept, scoped: { tenant: 7 } } }))).toEqual([
      at('collections/entries/scoped/tenant', 'must be string'),
    ]);
    expect(refused(store({ entries: { ...kept, scoped: {} } }))).toEqual([
      at('collections/entries/scoped', 'fewer than 1 properties'),
    ]);
    expect(refused(store({ entries: { ...kept, scoped: { 'not a column': '{{tenant}}' } } }))).toEqual([
      at('collections/entries/scoped', "property name 'not a column'", 'identifier'),
    ]);
    expect(refused(store({ entries: kept }, { reads: { tenant: '@features/f/edge/request.resolvers.json' } }))).toEqual(
      [at('reads/tenant', '#')],
    );
    expect(refused(store({ entries: kept }, { reads: {} }))).toEqual([at('reads', 'fewer than 1 properties')]);
  });

  it('a view names one collection of this store by identifier, and the policy it is seen behind by path', () => {
    expect(refused(store({ everyEntry: { view: 'two words', behind: '@a/edge/p.policy.json' } }))).toEqual([
      at('collections/everyEntry/view', 'identifier'),
    ]);
    expect(refused(store({ everyEntry: { view: 'entries', behind: 'employees-only' } }))).toEqual([
      at('collections/everyEntry/behind', 'A document path'),
    ]);
  });

  it('keeps tells the two shapes apart, and kept answers only the collections that hold records', () => {
    // a reader asks this rather than reading `of` and `key` off whatever the map holds: the schema stopped
    // guaranteeing the pair the moment a view became a collection, and a view has neither to read
    const entries = { of: '@features/f/domain/Customer.shape.json', key: 'id' };
    const everyEntry = { view: 'entries', behind: '@a/edge/p.policy.json' };
    expect(keeps(entries)).toBe(true);
    expect(keeps(everyEntry)).toBe(false);
    const doc = { connection: '@connections/c.connection.json', collections: { entries, everyEntry } } as StoreDoc;
    expect(keptOf(doc)).toEqual([['entries', entries]]);
    // and the narrowing is what lets a reader reach the pair at all: this is the type, not just the value
    for (const [, collection] of keptOf(doc)) expect(typeof collection.of).toBe('string');
  });
});
