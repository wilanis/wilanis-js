/**
 * Sabotage: a data graph that makes a guarded value an effect reads (L016, RFC 0035). The example makes every
 * Customer it writes in a domain graph -- `update-customer` lays the change over the customer with `#merge` and hands
 * the result to `keep` -- and its data graphs take the customer whole as `in` or re-type what the store answered.
 * Moving the making down into a data graph, on the way to a write, is what L016 refuses, at the node that makes it;
 * a value made behind the write, and a read site whatever reads it, are not.
 */
import { schemaUrl } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import {
  plantedAll,
  plantedEditing,
  plantedEditingAllAt,
  plantedEditingHinting,
  plantedEditingSaying,
  plantedPointing,
  sabotage,
  sabotageSaying,
} from './example-harness.js';

const KEEP = 'features/customers/data/keep-customer.graph.json';
const BINDING = 'features/customers/data/customers-store.binding.json';
const KEPT_UPDATE = 'features/customers/data/kept-update.graph.json';
const PLANTED = 'features/customers/data/rewrite-customer.graph.json';
const STORE = { store: '@customers/data/customers.store.json', collection: 'customers' };
const CUSTOMER = '@customers/domain/Customer.shape.json';
const REACHABLE = "'A customer is reachable' (@features/customers/domain/a-customer-is-reachable.invariant.json)";
const HINT = 'a data graph translates; make the record in a domain graph and hand it to this one whole, as its in';

const run = (id: string, op: string, input: Record<string, unknown>) => ({
  type: '@wilanis/node/run.schema.json',
  id,
  run: op,
  in: input,
});
const decide = (
  id: string,
  input: Record<string, string>,
  rules: { when: string; to: string }[],
  otherwise: string,
) => ({
  type: '@wilanis/node/switch.schema.json',
  id,
  in: input,
  rules,
  else: otherwise,
});
const refuse = (id: string, reason: string, message: string) =>
  run(id, '@std/outcome.port.json#refuse', { reason, message, type: CUSTOMER });

/** keep-customer's tail: the write of `record`, and what the store answered, answered. */
const written = (record: string) => [
  run('stored', '@storage/store.port.json#put', { ...STORE, record }),
  decide(
    'outcome',
    { record: '{{stored.record}}', violated: '{{stored.violated}}' },
    [
      { when: 'has(violated)', to: 'repeated' },
      { when: 'has(record)', to: 'kept' },
    ],
    'nothingWritten',
  ),
  run('kept', '@std/object.port.json#make', { value: '{{stored.record}}', type: CUSTOMER }),
  refuse('repeated', 'conflict', 'another customer holds that address ({{stored.violated}})'),
  refuse('nothingWritten', 'upstream', 'the store answered no record for {{in.id}}'),
];

/** A data graph that reads the customer by id, makes one from what it read by `made`, and writes that. */
const readThenWrite = (takes: string, made: Record<string, unknown>) => ({
  $schema: schemaUrl('graph'),
  label: 'Read a customer, then write one',
  description: 'A data graph that reads a customer and writes the customer it makes of what it read.',
  in: takes,
  out: { type: CUSTOMER, from: ['kept', 'repeated', 'nothingWritten', 'noCustomer'] },
  nodes: [
    run('current', '@storage/store.port.json#get', { ...STORE, key: '{{in.id}}' }),
    decide('wasThere', { record: '{{current.record}}' }, [{ when: 'has(record)', to: 'customer' }], 'noCustomer'),
    { ...run('customer', '@std/object.port.json#make', {}), ...made },
    ...written('{{customer}}'),
    refuse('noCustomer', 'missing', 'no customer {{in.id}}'),
  ],
});

/** The graph RFC 0035 found, made again: update-customer's merge moved into the data graph behind customer.update. */
const MERGED_BELOW = readThenWrite('@customers/domain/CustomerUpdate.shape.json', {
  run: '@std/object.port.json#merge',
  in: { base: '{{current.record}}', over: '{{in}}', type: CUSTOMER },
});

/** The store binding meeting customer.update with that data graph rather than with update-customer. */
const REBOUND = {
  [BINDING]: (binding: any) => {
    binding.operations.update = { graph: '@customers/data/kept-update.graph.json' };
  },
};

describe('sabotage: a data graph makes the customer it writes', () => {
  it('L016 the merge moved from update-customer into the data graph behind update, at the node that makes it', () => {
    const [[file, edit]] = Object.entries(REBOUND);
    expect(plantedEditing({ [KEPT_UPDATE]: MERGED_BELOW }, file, edit)).toEqual(['L016']);
    expect(plantedEditingAllAt({ [KEPT_UPDATE]: MERGED_BELOW }, REBOUND)).toEqual([
      `L016 @${KEPT_UPDATE}#nodes/customer`,
    ]);
  });

  it('L016 says what is made, the invariant guarding it and the effect that reads it, and hints the domain graph', () => {
    const [[file, edit]] = Object.entries(REBOUND);
    expect(plantedEditingSaying({ [KEPT_UPDATE]: MERGED_BELOW }, file, edit)).toEqual([
      `L016 data graph makes a Customer, which ${REACHABLE} guards, and the effect 'stored' reads it`,
    ]);
    expect(plantedEditingHinting({ [KEPT_UPDATE]: MERGED_BELOW }, file, edit)).toEqual([`L016 ${HINT}`]);
  });

  it('none for the example as shipped: keep-customer takes the customer as in, and kept re-types what was stored', () => {
    expect(sabotage(KEEP, () => undefined)).toEqual([]);
  });

  it('L016 names the nodes the value passed through on its way to the effect', () => {
    // keep-customer also records the tier's latest, from a customer it made of in rather than from in itself
    const deriving = (graph: any) => {
      graph.nodes.push(
        run('candidate', '@std/object.port.json#make', { value: '{{in}}', type: CUSTOMER }),
        run('latestRow', '@std/object.port.json#make', {
          value: { tier: '{{candidate.tier}}', email: '{{candidate.email}}', customer: '{{candidate.id}}' },
          type: '@customers/domain/TierLatest.shape.json',
        }),
        run('latest', '@storage/store.port.json#put', { ...STORE, collection: 'latest', record: '{{latestRow}}' }),
      );
      graph.nodes[1].in.mark = '{{latest.record}}';
    };
    expect(sabotageSaying(KEEP, deriving)).toEqual([
      `L016 data graph makes a Customer, which ${REACHABLE} guards, and the effect 'latest' reads it through 'latestRow'`,
    ]);
  });

  it('L016 a map that makes each customer, read by a map that writes each, makes a list', () => {
    const each = {
      $schema: schemaUrl('graph'),
      label: 'Keep every customer',
      description: 'A data graph that makes each customer of what it is given, and writes each.',
      in: `${CUSTOMER}[]`,
      out: { type: 'number', from: 'written' },
      nodes: [
        {
          type: '@wilanis/node/map.schema.json',
          id: 'customers',
          run: '@std/object.port.json#make',
          over: '{{in}}',
          bind: { value: '' },
          in: { type: CUSTOMER },
        },
        {
          type: '@wilanis/node/map.schema.json',
          id: 'stored',
          run: '@storage/store.port.json#put',
          over: '{{customers}}',
          bind: { record: '' },
          in: STORE,
        },
        run('written', '@std/list.port.json#count', { list: '{{stored}}' }),
      ],
    };
    expect(plantedPointing({ 'features/customers/data/keep-each.graph.json': each })).toEqual([
      'L016 @features/customers/data/keep-each.graph.json#nodes/customers',
    ]);
  });
});

describe('sabotage: what a data graph may make', () => {
  it('none for a read site an effect reads: a customer made of what the store answered, written back', () => {
    const reread = readThenWrite('@customers/domain/CustomerRef.shape.json', {
      in: { value: '{{current.record}}', type: CUSTOMER },
    });
    expect(plantedAll({ [PLANTED]: reread })).toEqual([]);
  });

  it('none for a read site that is itself an effect: the customers a #find answered, each removed', () => {
    // `found` is a made site of Customer[] and an effect both; what it answered is what the store holds
    const sweep = {
      $schema: schemaUrl('graph'),
      label: 'Remove every bronze customer',
      description: 'A data graph that finds the bronze customers and removes each.',
      out: { type: 'number', from: 'removed' },
      nodes: [
        run('found', '@storage/store.port.json#find', { ...STORE, where: { tier: 'bronze' } }),
        {
          type: '@wilanis/node/map.schema.json',
          id: 'gone',
          run: '@storage/store.port.json#remove',
          over: '{{found}}',
          bind: { key: 'id' },
          in: STORE,
        },
        run('removed', '@std/list.port.json#count', { list: '{{gone}}' }),
      ],
    };
    expect(plantedAll({ 'features/customers/data/remove-bronze.graph.json': sweep })).toEqual([]);
  });

  it('L016 for the same graph once it lays a change over what it read', () => {
    const activated = readThenWrite('@customers/domain/CustomerRef.shape.json', {
      run: '@std/object.port.json#merge',
      in: { base: '{{current.record}}', over: { active: true }, type: CUSTOMER },
    });
    expect(plantedPointing({ [PLANTED]: activated })).toEqual([`L016 @${PLANTED}#nodes/customer`]);
  });
});
