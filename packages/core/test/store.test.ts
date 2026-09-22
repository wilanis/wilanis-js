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
    const collections = (one: Record<string, unknown>) => doc('store', { collections: { customers: one } });
    expect(refused(collections({ of: '@features/f/domain/Customer.shape.json' }))).toEqual([
      at('collections/customers', "missing 'key'"),
    ]);
    expect(refused(collections({ key: 'id' }))).toEqual([at('collections/customers', "missing 'of'")]);
    expect(refused(collections({ of: 'Customer', key: 'id' }))).toEqual([at('collections/customers/of', 'A type:')]);
    expect(refused(collections({ of: '@features/f/domain/Customer.shape.json', key: 'the id' }))).toEqual([
      at('collections/customers/key', 'identifier'),
    ]);
    expect(
      refused(collections({ of: '@features/f/domain/Customer.shape.json', key: 'id', table: 'customers' })),
    ).toEqual([at('collections/customers', "unknown property 'table'")]);
    expect(refused(doc('store', { collections: { 'Bad Name': { of: 'unknown', key: 'id' } } }))).toEqual([
      at('collections', "property name 'Bad Name'", 'identifier'),
    ]);
  });
  it('a collection may declare what no two records repeat, which field holds another collection key, what existing rows receive, and what it was called before', () => {
    const customers = {
      of: '@features/f/domain/Customer.shape.json',
      key: 'id',
      unique: [['email', 'tier']],
      defaults: { tier: 'bronze' },
      renamed: { email: 'emailAddress' },
      was: 'people',
      description: 'the registered customers',
    };
    const notes = {
      of: '@features/f/domain/Note.shape.json',
      key: 'id',
      refs: {
        customerId: { collection: 'customers', onRemove: 'refuse', description: 'the customer the note is about' },
      },
    };
    expect(refused(doc('store', { collections: { customers, notes } }))).toEqual([]);
  });
  it('a rename names both names by an identifier, and a previous collection name is one identifier', () => {
    const collections = (one: Record<string, unknown>) =>
      doc('store', { collections: { customers: { of: '@features/f/domain/Customer.shape.json', key: 'id', ...one } } });
    expect(refused(collections({ renamed: { email: 7 } }))).toEqual([
      at('collections/customers/renamed/email', 'must be string'),
    ]);
    expect(refused(collections({ renamed: { 'the email': 'emailAddress' } }))).toEqual([
      at('collections/customers/renamed', "property name 'the email'", 'identifier'),
    ]);
    expect(refused(collections({ renamed: { email: 'the address' } }))).toEqual([
      at('collections/customers/renamed/email', 'identifier'),
    ]);
    expect(refused(collections({ was: 'two words' }))).toEqual([at('collections/customers/was', 'identifier')]);
  });
  it('a constraint names each field by its identifier, and names at least one', () => {
    const collections = (one: Record<string, unknown>) =>
      doc('store', { collections: { customers: { of: '@features/f/domain/Customer.shape.json', key: 'id', ...one } } });
    expect(refused(collections({ unique: [[]] }))).toEqual([
      at('collections/customers/unique/0', 'must NOT have fewer than 1 items'),
    ]);
    expect(refused(collections({ unique: [['email', 'email']] }))).toEqual([
      at('collections/customers/unique/0', 'must NOT have duplicate items'),
    ]);
    expect(refused(collections({ unique: [['the email']] }))).toEqual([
      at('collections/customers/unique/0/0', 'identifier'),
    ]);
    expect(refused(collections({ unique: ['email'] }))).toEqual([
      at('collections/customers/unique/0', 'must be array'),
    ]);
    expect(refused(collections({ defaults: { 'not a field': 1 } }))).toEqual([
      at('collections/customers/defaults', "property name 'not a field'", 'identifier'),
    ]);
  });
  it('a reference names one collection and refuses a removal, and admits nothing else', () => {
    const collections = (ref: Record<string, unknown>) =>
      doc('store', {
        collections: {
          customers: { of: '@features/f/domain/Customer.shape.json', key: 'id', refs: { customerId: ref } },
        },
      });
    expect(refused(collections({}))).toEqual([at('collections/customers/refs/customerId', "missing 'collection'")]);
    expect(refused(collections({ collection: 'customers', onRemove: 'cascade' }))).toEqual([
      at('collections/customers/refs/customerId/onRemove', 'must be one of "refuse"'),
    ]);
    expect(refused(collections({ collection: '@features/f/data/other.store.json' }))).toEqual([
      at('collections/customers/refs/customerId/collection', 'identifier'),
    ]);
    expect(refused(collections({ collection: 'customers', of: 'string' }))).toEqual([
      at('collections/customers/refs/customerId', "unknown property 'of'"),
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
          { customers: { ...kept, unique: [['email', 'tier']], scoped: { tenant: '{{tenant}}' } } },
          { reads: { tenant: '@features/f/edge/request.resolvers.json#tenant' } },
        ),
      ),
    ).toEqual([]);
    // several scopes at once: a collection may be a tenant's and an owner's, each column filled from its own read
    expect(
      refused(
        store(
          { customers: { ...kept, scoped: { tenant: '{{tenant}}', owner: '{{owner}}' } } },
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
          customers: { ...kept, scoped: { tenant: '{{tenant}}' } },
          everyCustomer: {
            view: 'customers',
            behind: '@access/edge/employees-only.policy.json',
            description: "the same rows, every tenant's",
          },
        }),
      ),
    ).toEqual([]);
  });

  it('a collection is exactly one of the two shapes: a view declares nothing a kept collection does', () => {
    // `view` tells the two apart, so an author is answered about the shape they wrote and not about the other
    expect(refused(store({ everyCustomer: { view: 'customers', behind: '@a/edge/p.policy.json', ...kept } }))).toEqual([
      at('collections/everyCustomer/of', "'of' is not allowed here"),
      at('collections/everyCustomer/key', "'key' is not allowed here"),
    ]);
    expect(
      refused(
        store({
          everyCustomer: { view: 'customers', behind: '@a/edge/p.policy.json', scoped: { tenant: '{{tenant}}' } },
        }),
      ),
    ).toEqual([at('collections/everyCustomer/scoped', "'scoped' is not allowed here")]);
    expect(refused(store({ everyCustomer: { view: 'customers' } }))).toEqual([
      at('collections/everyCustomer', "missing 'behind'"),
    ]);
    // and `behind` is a view's alone: a collection that keeps records may not be gated by one
    expect(refused(store({ customers: { ...kept, behind: '@a/edge/p.policy.json' } }))).toEqual([
      at('collections/customers/behind', "'behind' is not allowed here"),
    ]);
  });

  it('a scope names a column and a string that reads it; a read names a resolver of a document, not the document', () => {
    expect(refused(store({ customers: { ...kept, scoped: { tenant: 7 } } }))).toEqual([
      at('collections/customers/scoped/tenant', 'must be string'),
    ]);
    expect(refused(store({ customers: { ...kept, scoped: {} } }))).toEqual([
      at('collections/customers/scoped', 'fewer than 1 properties'),
    ]);
    expect(refused(store({ customers: { ...kept, scoped: { 'not a column': '{{tenant}}' } } }))).toEqual([
      at('collections/customers/scoped', "property name 'not a column'", 'identifier'),
    ]);
    expect(
      refused(store({ customers: kept }, { reads: { tenant: '@features/f/edge/request.resolvers.json' } })),
    ).toEqual([at('reads/tenant', '#')]);
    expect(refused(store({ customers: kept }, { reads: {} }))).toEqual([at('reads', 'fewer than 1 properties')]);
  });

  it('a view names one collection of this store by identifier, and the policy it is seen behind by path', () => {
    expect(refused(store({ everyCustomer: { view: 'two words', behind: '@a/edge/p.policy.json' } }))).toEqual([
      at('collections/everyCustomer/view', 'identifier'),
    ]);
    expect(refused(store({ everyCustomer: { view: 'customers', behind: 'employees-only' } }))).toEqual([
      at('collections/everyCustomer/behind', 'A document path'),
    ]);
  });

  it('keeps tells the two shapes apart, and kept answers only the collections that hold records', () => {
    // a reader asks this rather than reading `of` and `key` off whatever the map holds: the schema stopped
    // guaranteeing the pair the moment a view became a collection, and a view has neither to read
    const customers = { of: '@features/f/domain/Customer.shape.json', key: 'id' };
    const everyCustomer = { view: 'customers', behind: '@a/edge/p.policy.json' };
    expect(keeps(customers)).toBe(true);
    expect(keeps(everyCustomer)).toBe(false);
    const doc = { connection: '@connections/c.connection.json', collections: { customers, everyCustomer } } as StoreDoc;
    expect(keptOf(doc)).toEqual([['customers', customers]]);
    // and the narrowing is what lets a reader reach the pair at all: this is the type, not just the value
    for (const [, collection] of keptOf(doc)) expect(typeof collection.of).toBe('string');
  });
});
