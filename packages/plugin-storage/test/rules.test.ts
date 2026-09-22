/**
 * What only @storage can judge. Each case breaks the small tree one way and expects the code and the place
 * the refusal points at -- a code alone would pass for a refusal about something else entirely.
 *
 * Two rows of RFC 0002's table are not rules, and the last two cases say so by asserting what does answer:
 * the tree already refuses them, and a rule lives in one place.
 */
import { describe, expect, it } from 'vitest';
import { CONNECTION, codes, type Docs, editing, refusals, SHAPE, STORE, tree } from './harness.js';

const edit = (file: string, change: (doc: any) => void) => refusals(editing(file, change));
const store = (change: (doc: any) => void) => edit('features/customers/data/customers.store.json', change);
const graph = (change: (doc: any) => void) => edit('features/customers/data/read-customer.graph.json', change);
const at = (found: ReturnType<typeof refusals>, code: string) => found.filter(one => one.code === code);

/** The tree with a second feature keeping the same collection name over the same connection. */
function alsoKeeping(of: string, shape?: Docs): Docs {
  const base = tree();
  // sharing a collection deliberately means the shape is one the other feature may name
  (base['features/customers/feature.json'] as { exports: string[] }).exports = [SHAPE];
  return {
    ...base,
    ...shape,
    'features/other/feature.json': {
      $schema: '@wilanis/feature.schema.json',
      description: 'another feature that keeps things',
      dependsOn: ['customers'],
    },
    'features/other/data/customers.store.json': {
      $schema: '@wilanis/store.schema.json',
      description: 'the same collection, over the same connection',
      connection: CONNECTION,
      collections: { customers: { of, key: 'id' } },
    },
  };
}

describe('a tree that keeps what it observes', () => {
  it('stands: a store over a storage connection, and a graph that reads it', () => {
    expect(refusals(tree())).toEqual([]);
  });
});

describe('what a collection may keep, and what identifies one record', () => {
  it("X201 an edge shape: the world's shape is not what a tree keeps", () => {
    const found = at(
      store(doc => {
        doc.collections.customers.of = '@features/customers/edge/CustomerRow.shape.json';
      }),
      'X201',
    );
    expect(found).toHaveLength(1);
    expect(found[0].at).toBe('collections/customers/of');
    expect(found[0].message).toMatch(/is an edge shape/);
  });

  it('X202 a key the shape does not have, with the fields it does', () => {
    const found = at(
      store(doc => {
        doc.collections.customers.key = 'nope';
      }),
      'X202',
    );
    expect(found).toHaveLength(1);
    expect(found[0].at).toBe('collections/customers/key');
    expect(found[0].message).toMatch(/\(fields: id, email, orders, active, tags, note\)/);
  });

  it('X202 a key that may be absent, since a key identifies every record', () => {
    const found = at(
      store(doc => {
        doc.collections.customers.key = 'note';
      }),
      'X202',
    );
    expect(found).toHaveLength(1);
    expect(found[0].message).toMatch(/is optional in .*, and a key identifies every record/);
  });
});

describe('what a store may sit on', () => {
  it('X203 a connection of a kind that reaches no storage engine', () => {
    const found = at(
      edit('connections/records.connection.json', doc => {
        doc.kind = '@fake-upstream/upstream.connection-kind.json';
      }),
      'X203',
    );
    expect(found).toHaveLength(1);
    expect(found[0].at).toBe('connection');
    expect(found[0].message).toMatch(/does not say "storage": true/);
  });

  it('X203 a connection of a kind no loaded plugin grants', () => {
    const broken = editing('connections/records.connection.json', doc => {
      doc.kind = '@nobody/nothing.connection-kind.json';
    });
    const found = at(refusals(broken), 'X203');
    expect(found[0].message).toMatch(/which no loaded plugin grants/);
  });
});

describe('what a call may name', () => {
  it('X204 a store this tree does not hold, pointing at the input that named it', () => {
    const found = at(
      graph(doc => {
        doc.nodes[0].in.store = '@features/customers/data/nope.store.json';
      }),
      'X204',
    );
    expect(found).toHaveLength(1);
    expect(found[0].at).toBe('nodes/asked/in/store');
  });

  it('X204 a collection the store does not declare, naming the ones it does', () => {
    const found = at(
      graph(doc => {
        doc.nodes[0].in.collection = 'nope';
      }),
      'X204',
    );
    expect(found).toHaveLength(1);
    expect(found[0].at).toBe('nodes/asked/in/collection');
    expect(found[0].message).toMatch(/\(collections: customers\)/);
  });
});

describe('two stores over one connection', () => {
  it('X207 one collection name, two shapes: the pair is the collection, so they would be one table', () => {
    const other = {
      'features/other/domain/Thing.shape.json': {
        $schema: '@wilanis/shape.schema.json',
        description: 'something else entirely',
        layer: 'core',
        fields: { id: { type: 'string' }, size: { type: 'number' } },
      },
    };
    const found = at(refusals(alsoKeeping('@features/other/domain/Thing.shape.json', other)), 'X207');
    expect(found).toHaveLength(1);
    expect(found[0].at).toBe('collections/customers/of');
    expect(found[0].message).toMatch(/already keeps .*Customer.shape.json/);
  });

  it('the same name with the same shape is how two features share a collection on purpose', () => {
    expect(codes(alsoKeeping(SHAPE))).toEqual([]);
  });
});

describe('what a call may ask of the records', () => {
  const where = (filter: unknown) =>
    graph(doc => {
      doc.nodes[0].in.where = filter;
    });
  const only = (filter: unknown, code: string) => at(where(filter), code);

  it('X208 a filter naming a field the shape does not have, at any nesting', () => {
    expect(only({ methd: 'GET' }, 'X208')[0].at).toBe('nodes/asked/in/where/methd');
    expect(only({ any: [{ nope: 1 }] }, 'X208')).toHaveLength(1);
  });

  it('X208 an order by a field the shape does not have', () => {
    const found = at(
      graph(doc => {
        doc.nodes[0].in.order = [{ by: 'nope' }];
      }),
      'X208',
    );
    expect(found).toHaveLength(1);
    expect(found[0].at).toBe('nodes/asked/in/order/0/by');
  });

  it('X209 a literal the field would not accept', () => {
    expect(only({ email: 7 }, 'X209')).toHaveLength(1);
    expect(only({ note: { has: 'yes' } }, 'X209')).toHaveLength(1);
    expect(only({ orders: { in: ['a'] } }, 'X209')).toHaveLength(1);
    expect(only({ orders: 7 }, 'X209')).toEqual([]);
  });

  it('X210 an operator the grammar does not name, or one the field type does not admit', () => {
    expect(only({ email: { like: 'x' } }, 'X210')).toHaveLength(1);
    expect(only({ orders: { contains: '2' } }, 'X210')).toHaveLength(1);
    expect(only({ active: { gt: false } }, 'X210')).toHaveLength(1);
    expect(only({ tags: { eq: ['a'] } }, 'X210')).toHaveLength(1);
    expect(only({ tags: { has: true } }, 'X210')).toEqual([]);
  });

  it('X209 a read of the graph in, typed by the shape the graph declares', () => {
    // `orders` is a number and `in.id` a string: the graph's in shape is a document, so this is judgeable
    const found = only({ orders: '{{in.id}}' }, 'X209');
    expect(found).toHaveLength(1);
    expect(found[0].at).toBe('nodes/asked/in/where/orders');
    expect(only({ email: '{{in.id}}' }, 'X209')).toEqual([]);
  });

  it('a read is judged by the type it reads, never by the shape of the read itself', () => {
    // `{{in.emails}}` is not an array until it is read, and `{{in.tagged}}` is not a boolean; judging either by
    // how it is spelled would refuse a filter the run then accepts, which is the opposite of the promise
    expect(codes(tree())).toEqual([]);
    expect(only({ email: { in: '{{in.emails}}' } }, 'X210')).toEqual([]);
    expect(only({ tags: { has: '{{in.tagged}}' } }, 'X209')).toEqual([]);
    // and the type it reads is still judged: a list of the wrong thing, and a boolean that is not one
    expect(only({ orders: { in: '{{in.emails}}' } }, 'X209')).toHaveLength(1);
    expect(only({ tags: { has: '{{in.id}}' } }, 'X209')).toHaveLength(1);
  });

  it("a read of an earlier node is left unjudged: that table is the graph checker's, not a plugin's", () => {
    // the gap RFC 0003 records beside X209: a plugin sees documents, and a node's output is not one
    const found = graph(doc => {
      doc.nodes.unshift({
        id: 'said',
        type: '@wilanis/node/run.schema.json',
        run: '@std/object.port.json#make',
        in: { value: { text: '{{in.id}}' }, type: '@features/customers/edge/CustomerRow.shape.json' },
      });
      doc.nodes[1].in.where = { orders: '{{said.id}}' };
    });
    expect(found.filter(one => one.code === 'X209')).toEqual([]);
  });

  it('a refusal points where the document says it, under a combinator and at a bare value', () => {
    expect(only({ any: [{ methd: 'x' }] }, 'X208')[0].at).toBe('nodes/asked/in/where/any/0/methd');
    // a bare value has no `eq` key to point at, so the field is where it points
    expect(only({ email: 7 }, 'X209')[0].at).toBe('nodes/asked/in/where/email');
    expect(only({ email: { contains: 7 } }, 'X209')[0].at).toBe('nodes/asked/in/where/email/contains');
  });
});

describe('the scope a document wrote', () => {
  /** The tree with `customers` scoped by a tenant, and whatever else a case asks of it. */
  const scoping = (change: (docs: Docs) => void): Docs => {
    const docs = tree();
    const store = docs['features/customers/data/customers.store.json'] as any;
    store.reads = { tenant: '@features/customers/edge/request.resolvers.json#tenant' };
    store.collections.customers.scoped = { tenant: '{{tenant}}' };
    change(docs);
    return docs;
  };
  /** What a tree answers with X214, and nothing else: how the store's read is bound is C012's and A's. */
  const scoped = (change: (docs: Docs) => void) => at(refusals(scoping(change)), 'X214');
  const wrote = (scope: unknown, over = 'customers') =>
    scoped(docs => {
      const store = docs['features/customers/data/customers.store.json'] as any;
      store.collections.everyCustomer = { view: 'customers', behind: '@features/customers/edge/nobody.policy.json' };
      const graph = docs['features/customers/data/read-customer.graph.json'] as any;
      graph.nodes[0].in.collection = over;
      graph.nodes[0].in.scope = scope;
    });

  it('X214 a scope written on a site over a scoped collection: the compiler puts it there', () => {
    const found = wrote({ tenant: '{{in.id}}' });
    expect(found).toHaveLength(1);
    expect(found[0].at).toBe('nodes/asked/in/scope');
    expect(found[0].message).toMatch(/scope is the store's: 'customers' is scoped by tenant ← \{\{tenant\}\}/);
    expect(found[0].hint).toMatch(
      /to change how 'customers' is scoped, change @features\/customers\/data\/customers.store.json/,
    );
  });

  it('X214 a scope over a collection that keeps none: there is no column for it to fill', () => {
    const found = at(
      graph(doc => {
        doc.nodes[0].in.scope = { tenant: 'acme' };
      }),
      'X214',
    );
    expect(found).toHaveLength(1);
    expect(found[0].message).toMatch(/declares no scoped columns, so it keeps no scope/);
    expect(found[0].hint).toBe('drop "scope": this collection keeps no scope');
  });

  it('X214 a scope over a view, which sees every row whatever a site says', () => {
    const found = wrote({ tenant: 'acme' }, 'everyCustomer');
    expect(found).toHaveLength(1);
    expect(found[0].message).toBe("'everyCustomer' is a view of 'customers', and a view sees every row");
    expect(found[0].hint).toBe(`drop "scope": read 'customers' where a scope is meant`);
  });

  it('X214 a scope on newKey, which mints a key across every scope and takes none', () => {
    const found = scoped(docs => {
      const graph = docs['features/customers/data/read-customer.graph.json'] as any;
      graph.nodes[0].run = '@storage/store.port.json#newKey';
      graph.nodes[0].in = { store: STORE, collection: 'customers', scope: { tenant: 'acme' } };
    });
    expect(found).toHaveLength(1);
    expect(found[0].at).toBe('nodes/asked/in/scope');
  });

  it('X214 a scope written in a binding delegation, where a call site is written too', () => {
    const found = scoped(docs => {
      docs['features/customers/domain/customer.port.json'] = {
        $schema: '@wilanis/port.schema.json',
        description: 'what the monitor answers about what it kept',
        layer: 'domain',
        operations: { listed: { description: 'every entry', accepts: {}, answers: { type: `${SHAPE}[]` } } },
      };
      docs['features/customers/data/monitor.binding.json'] = {
        $schema: '@wilanis/binding.schema.json',
        description: 'the registry over the customers it keeps',
        port: '@features/customers/domain/customer.port.json',
        operations: {
          listed: {
            run: '@storage/store.port.json#find',
            in: { store: STORE, collection: 'customers', scope: { tenant: 'acme' } },
          },
        },
      };
    });
    expect(found).toHaveLength(1);
    expect(found[0].at).toBe('operations/listed/in/scope');
    expect(found[0].file).toBe('@features/customers/data/monitor.binding.json');
  });

  it('a site over a scoped collection that writes no scope is refused nothing here', () => {
    expect(scoped(() => {})).toEqual([]);
  });
});

describe('what the tree already answers, so @storage does not', () => {
  it('an input the operation does not accept is G006, which names the inputs it does', () => {
    const found = graph(doc => {
      doc.nodes[0].in.key = 'x';
    });
    expect(found.map(one => one.code)).toEqual(['G006']);
    expect(found[0].message).toMatch(/inputs: store, collection, where, order, limit, offset/);
  });

  it('a collection name that is not an identifier is D001, from the store schema', () => {
    // in a store nothing calls, so the case says one thing: a document that fails validation is not
    // registered, and every call naming one would be refused again for having no store to name
    const found = refusals({
      ...tree(),
      'features/customers/data/other.store.json': {
        $schema: '@wilanis/store.schema.json',
        description: 'a store whose collection is named wrongly',
        connection: CONNECTION,
        collections: { 'Bad Name': { of: SHAPE, key: 'id' } },
      },
    });
    expect(found.some(one => one.code === 'D001' && one.at === 'collections')).toBe(true);
    expect(found.filter(one => one.code.startsWith('X2'))).toEqual([]);
  });
});

describe('the store the tree holds', () => {
  it('is the one the graph names', () => {
    expect(STORE).toBe('@features/customers/data/customers.store.json');
  });
});
