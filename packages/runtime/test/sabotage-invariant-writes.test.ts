/**
 * Sabotage: a write of a shape a field invariant guards (RFC 0035). The example's customers are held to 'A customer
 * is reachable', whose rule reads name, email, tier and note, and keep-customer writes the record whole, read from
 * its `in`, where RFC 0007 guards it. Turning that write into a patch of a field the rule reads (I007), or composing
 * the record at the write (I008), is what these rules answer; a patch of a field no rule reads, and the record read
 * whole, are not.
 */
import { describe, expect, it } from 'vitest';
import { sabotage, sabotageHinting, sabotagePointing, sabotageSaying } from './example-harness.js';

const KEEP = 'features/customers/data/keep-customer.graph.json';
const AT = `@${KEEP}#nodes/stored/in`;
const REACHABLE = "'A customer is reachable' (@features/customers/domain/a-customer-is-reachable.invariant.json)";
const WHOLE = 'a rule over the whole record cannot be held on a part of one';

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
    expect(sabotageSaying(KEEP, patching('{{in}}'))).toEqual([
      `I007 patch writes 'name', 'email', 'tier' and 'note', which ${REACHABLE} reads; ${WHOLE}`,
    ]);
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
      `I008 the Customer written here is composed at the write, so nothing judges it against ${REACHABLE} before the store keeps it`,
    ]);
    expect(sabotageHinting(KEEP, writing(COMPOSED))).toEqual([
      'I008 make the Customer whole before the write -- @std/object.port.json#make with "type": "@features/customers/domain/Customer.shape.json", in a domain graph that hands it to this one as in -- and give #put "record": "{{in}}"',
    ]);
  });

  it('none for the record read whole from in', () => {
    expect(sabotage(KEEP, writing('{{in}}'))).toEqual([]);
  });
});
