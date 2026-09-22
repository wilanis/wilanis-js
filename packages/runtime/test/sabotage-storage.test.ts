/**
 * What a store holds its records to, and what the compiler will not let it say. `unique`, `refs` and
 * `defaults` name fields of the shape a collection declares, and a name the shape lacks, a default the field
 * would not accept or a reference that leaves the store is refused before anything runs (C003 to C008). The
 * marks a rename is written as -- `renamed` on a field, `was` on the collection -- name something that could
 * have been renamed, and a name still taken on the connection is refused (C010, C011).
 *
 * What a store *means* at a call site -- a filter over it, a patch of it -- is @storage's to judge (X208 to
 * X213, renumbered after RFC 0002's X207).
 *
 * The example's own store declares a `unique` and a `defaults`, and the last cases break those where they are
 * written, so the declaration a reader learns the DSL from is the one the rules are proved against. The rest
 * plant the store they break: a `refs` needs a second collection and a numeric key a second shape, and
 * neither is something the example has a use for.
 */
import { schemaUrl } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { planted, plantedAll, plantedPointing, sabotage, sabotagePointing } from './example-harness.js';

const KEPT = '@connections/customers.connection.json';
const shape = (label: string, fields: Record<string, unknown>) => ({
  $schema: schemaUrl('shape'),
  label,
  layer: 'core',
  description: `A ${label} as the domain knows it.`,
  fields,
});

/** A note of a customer, and a counted thing keyed by a number, so a reference has something to get wrong. */
const SHAPES = {
  'features/customers/domain/Note.shape.json': shape('Note', {
    id: { type: 'string' },
    customerId: { type: 'string' },
    byId: { type: 'string', required: false, description: 'the customer this note answers, where it answers one' },
    tags: { type: 'string[]' },
    text: { type: 'string' },
  }),
  'features/customers/domain/Counted.shape.json': shape('Counted', {
    n: { type: 'number' },
    label: { type: 'string' },
  }),
  'features/customers/domain/Upload.shape.json': shape('Upload', {
    id: { type: 'string' },
    file: { type: 'blob' },
    tags: { type: 'string[]' },
  }),
  'features/customers/domain/Renamed.shape.json': shape('Renamed', {
    id: { type: 'string' },
    email: { type: 'string' },
    tier: { type: 'string' },
  }),
};

/**
 * The read a case scopes the planted store by, where it declares a view: a view sees a scoped collection
 * (C013), so the one case that plants a view plants this beside it and binds it under `reads`. Every other
 * case scopes nothing, and binding a read no collection reads would be refused as an unused import (P005).
 */
const TENANCY = {
  'features/customers/edge/tenancy.resolvers.json': {
    $schema: schemaUrl('resolvers'),
    label: 'Tenancy',
    description: 'Which tenant the caller speaks for, as the sign-in wrote it into their session.',
    resolvers: { tenant: { read: 'request.session.attributes.displayName', required: true } },
  },
};
const READS = { tenant: '@customers/edge/tenancy.resolvers.json#tenant' };

/** The store the cases break: rows keyed by a string, notes referring to them, counted keyed by a number. */
const keeping = (collections: Record<string, unknown>, reads?: Record<string, string>) => ({
  ...SHAPES,
  ...(reads ? TENANCY : {}),
  'features/customers/data/planted.store.json': {
    $schema: schemaUrl('store'),
    label: 'Customers',
    description: 'The rows registered so far, and the notes hung off them.',
    connection: KEPT,
    ...(reads ? { reads } : {}),
    collections,
  },
});

const entry = (extra: Record<string, unknown> = {}) => ({
  of: '@customers/domain/Customer.shape.json',
  key: 'id',
  ...extra,
});
const notes = (extra: Record<string, unknown> = {}) => ({
  of: '@customers/domain/Note.shape.json',
  key: 'id',
  ...extra,
});
const counted = { of: '@customers/domain/Counted.shape.json', key: 'n' };
const codesOf = (collections: Record<string, unknown>, reads?: Record<string, string>) =>
  plantedAll(keeping(collections, reads));
const pointingAt = (collections: Record<string, unknown>, reads?: Record<string, string>) =>
  plantedPointing(keeping(collections, reads));

/** One refusal as a case expects it: the code, and the constraint of the planted store it points at. */
const STORE = '@features/customers/data/planted.store.json';
const at = (code: string, where: string) => [`${code} ${STORE}#collections/${where}`];

describe('sabotage: what a store holds its records to', () => {
  it('passes check when every constraint names a field the shape has, and means what it can mean', () => {
    expect(
      codesOf({
        rows: entry({ unique: [['email']], defaults: { tier: 'bronze' } }),
        notes: notes({ refs: { customerId: { collection: 'rows', onRemove: 'refuse' } } }),
      }),
    ).toEqual([]);
  });

  it('C003 a constraint naming a field the shape does not have, pointing at the constraint that named it', () => {
    expect(pointingAt({ rows: entry({ unique: [['emaill']] }) })).toEqual(at('C003', 'rows/unique/0'));
    expect(pointingAt({ rows: entry({ defaults: { nope: 1 } }) })).toEqual(at('C003', 'rows/defaults/nope'));
    expect(pointingAt({ rows: entry({ refs: { nope: { collection: 'rows' } } }) })).toEqual(
      at('C003', 'rows/refs/nope'),
    );
  });

  it('C004 a default the field would not accept, or one given for the key', () => {
    expect(pointingAt({ rows: entry({ defaults: { tier: 7 } }) })).toEqual(at('C004', 'rows/defaults/tier'));
    expect(pointingAt({ rows: entry({ defaults: { id: 'x' } }) })).toEqual(at('C004', 'rows/defaults/id'));
    expect(codesOf({ rows: entry({ defaults: { tier: 'bronze' } }) })).toEqual([]);
  });

  it("the example's own unique and defaults are judged where they are written", () => {
    const kept = '@features/customers/data/customers.store.json#collections/customers';
    const breaking = (edit: (collection: any) => void) =>
      sabotagePointing('features/customers/data/customers.store.json', doc => edit(doc.collections.customers));

    expect(breaking(customers => customers.unique.push(['emaill']))).toEqual([`C003 ${kept}/unique/1`]);
    expect(breaking(customers => (customers.defaults.tier = 7))).toEqual([`C004 ${kept}/defaults/tier`]);
    expect(breaking(customers => (customers.defaults.id = customers.defaults.tier))).toEqual([
      `C004 ${kept}/defaults/id`,
    ]);
  });

  it('C005 a reference to a collection this store does not declare', () => {
    const broken = { rows: entry(), notes: notes({ refs: { customerId: { collection: 'nowhere' } } }) };
    expect(pointingAt(broken)).toEqual(at('C005', 'notes/refs/customerId'));
  });

  it('a view keeps no records, so it is judged as one and never as a collection that does', () => {
    // A view declares no shape and no key, so every rule that reads one passes it by rather than refusing a
    // field the author never wrote: this is the whole of what `keeps` buys a reader. A view sees a scoped
    // collection (C013), so the rows it views are scoped by a read the store binds -- see sabotage-scoping.
    const scoped = entry({ scoped: { tenant: '{{tenant}}' } });
    const view = { view: 'rows', behind: '@access/edge/employees-only.policy.json' };
    expect(codesOf({ rows: scoped, everyRow: view }, READS)).toEqual([]);
    // and a reference names something with a key to hold, which a view has not
    expect(
      pointingAt(
        { rows: scoped, everyRow: view, notes: notes({ refs: { customerId: { collection: 'everyRow' } } }) },
        READS,
      ),
    ).toEqual(at('C005', 'notes/refs/customerId'));
  });

  it('C006 a reference of one type to records keyed by another', () => {
    const broken = { counted, notes: notes({ refs: { customerId: { collection: 'counted' } } }) };
    expect(pointingAt(broken)).toEqual(at('C006', 'notes/refs/customerId'));
    expect(codesOf({ rows: entry(), notes: notes({ refs: { customerId: { collection: 'rows' } } }) })).toEqual([]);
  });

  it('a reference on a field that may be absent is an ordinary nullable one, and passes', () => {
    // Nothing in RFC 0003's table forbids it: a note that answers no entry holds no reference, which is what
    // an optional field says. The rule that would refuse it is not written down, so it is not judged here.
    const optional = { rows: entry(), notes: notes({ refs: { byId: { collection: 'rows' } } }) };
    expect(codesOf(optional)).toEqual([]);
  });

  it('C007 a constraint that names the key, which identifies a record and is unique already', () => {
    expect(pointingAt({ rows: entry({ unique: [['id']] }) })).toEqual(at('C007', 'rows/unique/0'));
    const onItsKey = { rows: entry(), notes: notes({ refs: { id: { collection: 'rows' } } }) };
    expect(pointingAt(onItsKey)).toEqual(at('C007', 'notes/refs/id'));
  });

  it("a constraint naming one field twice is the schema's to refuse, so C007 never has to", () => {
    expect(codesOf({ rows: entry({ unique: [['email', 'email']] }) })).toEqual(['D001']);
  });

  it('C008 a constraint over a field an engine holds no value of: bytes, a shape or a list', () => {
    const uploads = (extra: Record<string, unknown>) => ({
      of: '@customers/domain/Upload.shape.json',
      key: 'id',
      ...extra,
    });
    expect(pointingAt({ uploads: uploads({ unique: [['file']] }) })).toEqual(at('C008', 'uploads/unique/0'));
    expect(pointingAt({ uploads: uploads({ unique: [['tags']] }) })).toEqual(at('C008', 'uploads/unique/0'));
    expect(codesOf({ uploads: uploads({ unique: [['id']] }) })).not.toContain('C008');
  });

  it('a reference on a list field is C008 alone: a field an engine holds no value of refers to nothing', () => {
    const broken = { rows: entry(), notes: notes({ refs: { tags: { collection: 'rows' } } }) };
    expect(pointingAt(broken)).toEqual(at('C008', 'notes/refs/tags'));
  });

  it('C010 a renamed keyed by a field the shape does not have: there is nothing to rename to', () => {
    expect(pointingAt({ rows: entry({ renamed: { nope: 'emailAddress' } }) })).toEqual(at('C010', 'rows/renamed/nope'));
  });

  it('C010 a renamed whose value is a field of the shape still, so nothing was renamed', () => {
    const both = { of: '@customers/domain/Renamed.shape.json', key: 'id', renamed: { tier: 'email' } };
    expect(pointingAt({ rows: both })).toEqual(at('C010', 'rows/renamed/tier'));
  });

  it('C010 one name under two keys: one column cannot become two', () => {
    const twice = { of: '@customers/domain/Renamed.shape.json', key: 'id', renamed: { email: 'addr', tier: 'addr' } };
    expect(pointingAt({ rows: twice })).toEqual(at('C010', 'rows/renamed/tier'));
  });

  it('a renamed naming the key passes: a key is a column like any other, and renaming it loses nothing', () => {
    expect(codesOf({ rows: entry({ renamed: { id: 'rowId' }, defaults: { tier: 'bronze' } }) })).toEqual([]);
  });

  it("C011 a was equal to the collection's own name, which was never renamed", () => {
    expect(pointingAt({ rows: entry({ was: 'rows' }) })).toEqual(at('C011', 'rows/was'));
  });

  it('C011 a was naming another collection of the same store', () => {
    const broken = { rows: entry({ was: 'notes' }), notes: notes() };
    expect(pointingAt(broken)).toEqual(at('C011', 'rows/was'));
  });

  it('C011 a was naming a collection of another store on the same connection: (connection, name) is a table', () => {
    // the example's own store keeps `customers` on this connection, so no collection here was ever called that
    expect(pointingAt({ rows: entry({ was: 'customers' }) })).toEqual(at('C011', 'rows/was'));
  });

  it('a was naming nothing this connection keeps passes: that is what a rename says', () => {
    expect(codesOf({ rows: entry({ was: 'observed' }) })).toEqual([]);
  });

  it('an unknown shape is R001 once, wherever else the collection is looked at', () => {
    const missing = { rows: { of: '@customers/domain/Nowhere.shape.json', key: 'id' } };
    expect(pointingAt(missing)).toEqual(at('R001', 'rows/of'));
    const referring = {
      rows: { of: '@customers/domain/Nowhere.shape.json', key: 'id' },
      notes: notes({ refs: { customerId: { collection: 'rows' } } }),
    };
    expect(pointingAt(referring)).toEqual(at('R001', 'rows/of'));
  });
});

/**
 * What a call means once the store is understood: which fields a patch may change, where `ensure` is reached
 * from, and whose records a feature keeps. These break the example's own documents, since RFC 0002 step 8
 * gave it a store that graphs really call.
 */
describe('what a call may do to the records', () => {
  it('X211 a patch that changes the key: a key identifies, so it is never patched', () => {
    const found = sabotage('features/customers/data/kept-update.graph.json', doc => {
      doc.nodes[0].in.changes.id = 'other';
    });
    expect(found).toContain('X211');
  });

  it('X211 a patch that changes a field the shape does not have', () => {
    const found = sabotage('features/customers/data/kept-update.graph.json', doc => {
      doc.nodes[0].in.changes.nope = 'x';
    });
    expect(found).toContain('X211');
  });

  it('X211 a patch whose value the field would not accept', () => {
    const found = sabotage('features/customers/data/kept-update.graph.json', doc => {
      doc.nodes[0].in.changes.url = 7;
    });
    expect(found).toContain('X211');
  });

  it('X212 ensure run by a graph node: it prepares the engine once, before the port opens', () => {
    const found = sabotage('features/customers/data/kept-get.graph.json', doc => {
      doc.nodes[0].run = '@storage/storage.port.json#ensure';
    });
    expect(found).toContain('X212');
  });

  it("X213 a graph of one feature naming another feature's store", () => {
    // hello keeps nothing; monitor's records are monitor's, and hello asks monitor's domain port for them
    const found = planted('features/hello/data/peek.graph.json', {
      $schema: schemaUrl('graph'),
      label: 'Peek at what monitor keeps',
      description: "A data graph of one feature reaching into another feature's collection.",
      nodes: [
        {
          type: '@wilanis/node/run.schema.json',
          id: 'asked',
          label: 'Read a record',
          run: '@storage/store.port.json#get',
          in: { store: '@customers/data/customers.store.json', collection: 'entries', key: 'x' },
        },
      ],
    });
    expect(found).toContain('X213');
  });
});
