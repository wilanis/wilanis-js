/**
 * Sabotage: the root a trigger kind hands is `context` (RFC 0034). A trigger's `fire.in` reads it, and a read
 * spelt the retired way is told the new spelling (T003); a data graph reads it only through a resolver it binds
 * (G003); and the word is reserved wherever a name could shadow the root -- a node's id (G001), a resolver's name
 * (P003), a name under `reads` (P006) -- while `request`, no longer a root, is a name like any other.
 */
import { describe, expect, it } from 'vitest';
import { sabotage, sabotageHinting, sabotageSaying } from './example-harness.js';

const GET_CUSTOMER = 'features/customers/edge/get-customer.trigger.json';
const GET_ROW = 'features/customers/data/get-row.graph.json';
const CREATE_ROW = 'features/customers/data/create-row.graph.json';
const RESOLVERS = 'features/customers/edge/request.resolvers.json';

/** get-row with its `fetched` node, and every read of it, renamed to `id`. */
const renamingFetched = (id: string) => (graph: any) => {
  Object.assign(graph, JSON.parse(JSON.stringify(graph).replaceAll('fetched', id)));
};

describe('sabotage: context is the root, and request is not', () => {
  it('T003 a trigger reading the retired root, told what to write instead', () => {
    const said = sabotageSaying(GET_CUSTOMER, trigger => {
      trigger.fire.in.id = '{{request.params.id}}';
    });
    expect(said).toEqual([
      "T003 fire.in: id: 'request': the root is context, what the trigger kind hands; write {{context.params.id}}",
    ]);
  });
  it('G003 a data graph reading context.* where only a resolver it binds may', () => {
    const said = sabotageSaying(CREATE_ROW, graph => {
      graph.nodes[0].in.headers.host = '{{context.headers.host}}';
    });
    expect(said).toEqual([
      'G003 host: graphs do not read context.* -- a resolvers document does; bind it under reads and read {{name}}',
    ]);
  });
  it('G001 a node named context, which a read would take for the root', () => {
    expect(sabotageSaying(GET_ROW, renamingFetched('context'))).toContain("G001 node id 'context' is reserved");
    expect(sabotageHinting(GET_ROW, renamingFetched('context'))).toContain(
      'G001 rename the node; in, const, context, secrets are roots a read may name',
    );
  });
  it('P003 a resolver named context, and P006 a read bound under that name', () => {
    const resolver = sabotageSaying(RESOLVERS, resolvers => {
      resolvers.resolvers.context = { read: 'context.headers.host' };
    });
    expect(resolver).toEqual(["P003 resolver name 'context' is reserved"]);
    const read = sabotageSaying(CREATE_ROW, graph => {
      graph.reads.context = '@customers/edge/request.resolvers.json#agent';
    });
    expect(read.filter(one => one.startsWith('P006'))).toEqual(["P006 read name 'context' is reserved"]);
  });
  it('accepts a node named request, which is no longer a root', () => {
    expect(sabotage(GET_ROW, renamingFetched('request'))).toEqual([]);
  });
});
