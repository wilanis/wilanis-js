/**
 * Sabotage: a write of a shape a field invariant guards (RFC 0035). The example's customers are held to 'A customer
 * is reachable', whose rule reads name, email, tier and note, and keep-customer writes the record whole, read from
 * its `in`, where RFC 0007 guards it. Turning that write into a patch of a field the rule reads (I007), or writing a
 * record no site of the shape made or took (I008), is what these rules answer, on every path a write takes: a
 * graph's node, a map's bound element, and a binding's delegation straight to the store. A patch of a field no rule
 * reads, and a record read whole from a site, are not.
 */
import { schemaUrl } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import {
  plantedAll,
  plantedEditingAllAt,
  plantedEditingAllSaying,
  plantedPointing,
  sabotage,
  sabotageHinting,
  sabotagePointing,
  sabotageSaying,
} from './example-harness.js';

const KEEP = 'features/customers/data/keep-customer.graph.json';
const AT = `@${KEEP}#nodes/stored/in`;
const REACHABLE = "'A customer is reachable' (@features/customers/domain/a-customer-is-reachable.invariant.json)";
const WHOLE = 'a rule over the whole record cannot be held on a part of one';
const GUARDED = `patch writes 'name', 'email', 'tier' and 'note', which ${REACHABLE} reads; ${WHOLE}`;
const UNJUDGED = `so nothing judges it against ${REACHABLE} before the store keeps it`;
const STORE = { store: '@customers/data/customers.store.json', collection: 'customers' };
const CUSTOMER = '@customers/domain/Customer.shape.json';
const UPDATE = '@customers/domain/CustomerUpdate.shape.json';
const PLANTED = 'features/customers/data/probe.graph.json';

/**
 * keep-customer's write turned into a patch of the customer it takes, changing `changes`, and routed on what a
 * patch answers: a record or none, never a violated constraint.
 */
const patching = (changes: unknown) => (graph: any) => {
  const [stored, outcome] = graph.nodes;
  stored.run = '@storage/store.port.json#patch';
  stored.in = { store: stored.in.store, collection: stored.in.collection, key: '{{in.id}}', changes };
  outcome.in = { record: '{{stored.record}}' };
  outcome.rules = [{ when: 'has(record)', to: 'kept' }];
  graph.nodes = graph.nodes.filter((node: { id: string }) => node.id !== 'repeated');
  graph.out.from = ['kept', 'nothingWritten'];
};

/** keep-customer's write given this `record`. */
const writing = (record: unknown) => (graph: any) => {
  graph.nodes[0].in.record = record;
};

/** The customer written out field by field at the write: every field of `in`, so nothing it declares goes unread. */
const COMPOSED = {
  id: '{{in.id}}',
  name: '{{in.name}}',
  email: '{{in.email}}',
  tier: '{{in.tier}}',
  registrar: '{{in.registrar}}',
  active: '{{in.active}}',
  note: '{{in.note}}',
};

/** The I refusals among what a copy answers: a patch of one field leaves the rest of `in` unread, which is G008's. */
const invariantsOf = (said: string[]) => said.filter(one => one.startsWith('I'));

describe('sabotage: a patch of a guarded field', () => {
  it('I007 a patch of tier, which the invariant reads, at the changes', () => {
    expect(invariantsOf(sabotage(KEEP, patching({ tier: '{{in.tier}}' })))).toEqual(['I007']);
    expect(invariantsOf(sabotagePointing(KEEP, patching({ tier: '{{in.tier}}' })))).toEqual([`I007 ${AT}/changes`]);
  });

  it('I007 names the field and the invariant that reads it', () => {
    expect(invariantsOf(sabotageSaying(KEEP, patching({ tier: '{{in.tier}}' })))).toEqual([
      `I007 patch writes 'tier', which ${REACHABLE} reads; ${WHOLE}`,
    ]);
  });

  it('I007 hints the record loaded, merged in a domain graph and put whole', () => {
    expect(invariantsOf(sabotageHinting(KEEP, patching({ tier: '{{in.tier}}' })))).toEqual([
      'I007 load the record, make the new one with @std/object.port.json#merge in a domain graph, and #put it whole through an operation that takes a Customer',
    ]);
  });

  it('I007 a changes read whole from in writes every guarded field its type has', () => {
    expect(sabotage(KEEP, patching('{{in}}'))).toEqual(['I007']);
    expect(sabotageSaying(KEEP, patching('{{in}}'))).toEqual([`I007 ${GUARDED}`]);
  });

  it('none for a patch of active, which no invariant reads', () => {
    expect(invariantsOf(sabotagePointing(KEEP, patching({ active: '{{in.active}}' })))).toEqual([]);
  });
});

describe('sabotage: a guarded record composed at the write', () => {
  it('I008 a record written out field by field, at the record', () => {
    expect(sabotage(KEEP, writing(COMPOSED))).toEqual(['I008']);
    expect(sabotagePointing(KEEP, writing(COMPOSED))).toEqual([`I008 ${AT}/record`]);
  });

  it('I008 says nothing judges the record, naming the invariant, and hints where to make it', () => {
    expect(sabotageSaying(KEEP, writing(COMPOSED))).toEqual([
      `I008 the Customer written here is composed at the write, ${UNJUDGED}`,
    ]);
    expect(sabotageHinting(KEEP, writing(COMPOSED))).toEqual([
      'I008 make the Customer whole before the write -- @std/object.port.json#make with "type": "@features/customers/domain/Customer.shape.json", in a domain graph that hands it to this one as in -- and give #put "record": "{{in}}"',
    ]);
  });

  it('none for the record read whole from in', () => {
    expect(sabotage(KEEP, writing('{{in}}'))).toEqual([]);
  });
});

// ---- every path a write takes (#682) --------------------------------------------------------------

const run = (id: string, op: string, input: Record<string, unknown>) => ({
  type: '@wilanis/node/run.schema.json',
  id,
  run: op,
  in: input,
});
const graph = (takes: string, out: unknown, nodes: unknown[]) => ({
  $schema: schemaUrl('graph'),
  description: 'A data graph a sabotage plants.',
  in: takes,
  out,
  nodes,
});
/** A planted data graph whose one map writes each element of `over`, answering how many it wrote. */
const writingEach = (takes: string, op: string, over: string, bind: Record<string, string>) =>
  graph(takes, { type: 'number', from: 'written' }, [
    { type: '@wilanis/node/map.schema.json', id: 'stored', run: op, over, bind, in: STORE },
    run('written', '@std/list.port.json#count', { list: '{{stored}}' }),
  ]);
/** A planted data graph whose one write is `write`, answering the customer the store gave back. */
const writingOne = (takes: string, before: unknown[], write: unknown) =>
  graph(takes, { type: CUSTOMER, from: ['kept', 'gone'] }, [
    ...before,
    write,
    {
      type: '@wilanis/node/switch.schema.json',
      id: 'wasThere',
      in: { record: '{{stored.record}}' },
      rules: [{ when: 'has(record)', to: 'kept' }],
      else: 'gone',
    },
    run('kept', '@std/object.port.json#make', { value: '{{stored.record}}', type: CUSTOMER }),
    run('gone', '@std/outcome.port.json#refuse', { reason: 'missing', message: 'no {{in.id}}', type: CUSTOMER }),
  ]);
/** A planted core shape of these fields. */
const shape = (fields: Record<string, unknown>) => ({
  $schema: schemaUrl('shape'),
  layer: 'core',
  description: 'A shape a sabotage plants.',
  fields,
});
/** The refusals of a copy with these documents planted, as `code message`. */
const saying = (docs: Record<string, unknown>) => plantedEditingAllSaying(docs, {});

describe('sabotage: a guarded write through a map', () => {
  it('I007 a map patching each CustomerUpdate it runs over, which carries tier, at the bound changes', () => {
    const each = writingEach(`${UPDATE}[]`, '@storage/store.port.json#patch', '{{in}}', { key: 'id', changes: '' });
    expect(plantedPointing({ [PLANTED]: each })).toEqual([`I007 @${PLANTED}#nodes/stored/bind/changes`]);
    expect(saying({ [PLANTED]: each })).toEqual([`I007 ${GUARDED}`]);
  });

  it('I008 a map putting each customer of a list no site holds, at the bound record', () => {
    const docs = {
      'features/customers/domain/CustomerBatch.shape.json': shape({ customers: { type: `${CUSTOMER}[]` } }),
      [PLANTED]: writingEach(
        '@customers/domain/CustomerBatch.shape.json',
        '@storage/store.port.json#put',
        '{{in.customers}}',
        {
          record: '',
        },
      ),
    };
    expect(plantedPointing(docs)).toEqual([`I008 @${PLANTED}#nodes/stored/bind/record`]);
    expect(saying(docs)).toEqual([
      `I008 the Customer written here is each element of 'in.customers', which is no site of it, ${UNJUDGED}`,
    ]);
  });

  it('none for a map putting each customer of a list taken as in, which is guarded element by element', () => {
    const each = writingEach(`${CUSTOMER}[]`, '@storage/store.port.json#put', '{{in}}', { record: '' });
    expect(plantedAll({ [PLANTED]: each })).toEqual([]);
  });
});

describe('sabotage: a guarded write read from what is no site of the shape', () => {
  it('I007 a patch whose changes is a node that merged a CustomerUpdate carrying tier', () => {
    const merged = run('delta', '@std/object.port.json#merge', {
      base: '{{in}}',
      over: { tier: 'gold' },
      type: UPDATE,
    });
    const patched = run('stored', '@storage/store.port.json#patch', {
      ...STORE,
      key: '{{in.id}}',
      changes: '{{delta}}',
    });
    const docs = { [PLANTED]: writingOne(UPDATE, [merged], patched) };
    expect(plantedPointing(docs)).toEqual([`I007 @${PLANTED}#nodes/stored/in/changes`]);
    expect(saying(docs)).toEqual([`I007 ${GUARDED}`]);
  });

  it('I008 a record read whole from an in wider than Customer, which is no site of it', () => {
    const wide = shape({
      id: { type: 'string' },
      name: { type: 'string' },
      email: { type: 'string' },
      tier: { type: 'string' },
      registrar: { type: 'string', required: false },
      active: { type: 'boolean', required: false },
      note: { type: 'string', required: false },
      source: { type: 'string' },
    });
    const put = run('stored', '@storage/store.port.json#put', { ...STORE, record: '{{in}}' });
    const docs = {
      'features/customers/domain/WideCustomer.shape.json': wide,
      [PLANTED]: writingOne('@customers/domain/WideCustomer.shape.json', [], put),
    };
    expect(saying(docs)).toEqual([
      `I008 the Customer written here is read from 'in', which is no site of it, ${UNJUDGED}`,
    ]);
  });
});

describe('sabotage: a binding delegating a guarded write straight to the store', () => {
  const Port = 'features/customers/domain/archive.port.json';
  const Binding = 'features/customers/data/archive-store.binding.json';
  const docs = {
    [Port]: {
      $schema: schemaUrl('port'),
      description: 'Customers set aside.',
      operations: {
        file: { description: 'Keep one customer as given.', accepts: CUSTOMER },
        retier: {
          description: 'Move one customer to a tier.',
          accepts: { id: { type: 'string' }, tier: { type: 'string' } },
        },
      },
    },
    [Binding]: {
      $schema: schemaUrl('binding'),
      description: 'The archive, met by the store with no graph between.',
      port: '@customers/domain/archive.port.json',
      operations: {
        file: { run: '@storage/store.port.json#put', in: { ...STORE, record: '{{in}}' } },
        retier: {
          run: '@storage/store.port.json#patch',
          in: { ...STORE, key: '{{in.id}}', changes: { tier: '{{in.tier}}' } },
        },
      },
    },
  };
  /** Every profile of the example meets the archive port with the binding. */
  const bound = {
    'project.json': (project: any) => {
      for (const profile of Object.values(project.profiles) as { bindings: Record<string, string> }[])
        profile.bindings['@customers/domain/archive.port.json'] = '@customers/data/archive-store.binding.json';
    },
  };

  it('I008 a put of the in a binding hands on, and I007 a patch of tier, each at its input', () => {
    expect(plantedEditingAllAt(docs, bound)).toEqual([
      `I008 @${Binding}#operations/file/in/record`,
      `I007 @${Binding}#operations/retier/in/changes`,
    ]);
  });

  it('I008 says a binding is no site, and hints the data graph that would be one', () => {
    expect(plantedEditingAllSaying(docs, bound)[0]).toBe(
      `I008 the Customer written here is read from 'in', which is no site of it, ${UNJUDGED}`,
    );
  });
});
