import { fileURLToPath } from 'node:url';
import { loadProject } from '@wilanis/runtime';
import { describe, expect, it } from 'vitest';
import { type DocView, viewOf } from '../src/index.js';

const EXAMPLE = fileURLToPath(new URL('../../../example', import.meta.url));
const GET_ROW = '@features/customers/data/get-row.graph.json';

const view = async (path: string): Promise<DocView> => {
  const seen = viewOf(await loadProject(EXAMPLE), path);
  if (!seen) throw new Error(`no view for ${path}`);
  return seen;
};
/** The edge between two ports, as the view drew it. */
const edge = (view: DocView, ends: { from: string; fromPort: string; to: string; toPort: string }) =>
  view.graph!.edges.find(
    one => one.from === ends.from && one.fromPort === ends.fromPort && one.to === ends.to && one.toPort === ends.toPort,
  );

describe('the view model of a graph', () => {
  it('draws a data graph: in, every node, out, with typed ports', async () => {
    const seen = await view(GET_ROW);
    const ids = seen.graph!.nodes.map(node => node.id);
    expect(ids).toEqual([
      'in',
      'fetched',
      'outcome/1',
      'outcome/2',
      'customer',
      'noCustomer',
      'upstreamFailed',
      'unreachable',
      'out',
    ]);
    const fetched = seen.graph!.nodes.find(node => node.id === 'fetched')!;
    expect(fetched.kind).toBe('run');
    expect(fetched.label).toBe('GET the row');
    expect(fetched.op).toBe('@http/http.port.json#request');
    expect(fetched.target).toMatchObject({ op: '@http/http.port.json#request', native: true, effect: true });
    // every declared input is a port: given literals carry their value, reads carry nothing, absent optionals are marked
    expect(fetched.inputs.find(port => port.name === 'method')).toMatchObject({
      type: expect.stringContaining('"GET"'),
      literal: '"GET"',
      static: true,
    });
    expect(fetched.inputs.find(port => port.name === 'path')).toMatchObject({ text: '/customer/{{in.id}}' });
    expect(fetched.inputs.find(port => port.name === 'body')).toMatchObject({ missing: true, required: false });
    // a literal that names a document carries the canonical path, so the page can label and link it
    expect(fetched.inputs.find(port => port.name === 'returns')).toMatchObject({
      literal: '"@customers/edge/CustomerRow.shape.json"',
      ref: '@features/customers/edge/CustomerRow.shape.json',
    });
    expect(fetched.inputs.find(port => port.name === 'connection')?.ref).toBe(
      '@connections/customers-api.connection.json',
    );
    // the result's fields are output ports, with the type variable bound from `returns`
    expect(fetched.outputs.map(port => port.name)).toEqual(['', 'status', 'headers', 'body']);
    expect(fetched.outputs.find(port => port.name === 'body')?.type).toBe(
      '@features/customers/edge/CustomerRow.shape.json',
    );
    const input = seen.graph!.nodes.find(node => node.id === 'in')!;
    expect(input.label).toBe('Input');
    expect(input.type).toBe('@features/customers/domain/CustomerRef.shape.json');
    expect(input.outputs.map(port => port.name)).toEqual(['', 'id']);
  });

  it('wires a data edge per read, from the field read to the input that reads it', async () => {
    const seen = await view(GET_ROW);
    expect(edge(seen, { from: 'in', fromPort: 'id', to: 'fetched', toPort: 'path' })).toMatchObject({ kind: 'data' });
    expect(edge(seen, { from: 'fetched', fromPort: 'status', to: 'outcome/1', toPort: 'status' })).toMatchObject({
      kind: 'data',
    });
    expect(edge(seen, { from: 'fetched', fromPort: 'body', to: 'customer', toPort: 'value' })).toMatchObject({
      kind: 'data',
    });
    expect(edge(seen, { from: 'fetched', fromPort: 'status', to: 'upstreamFailed', toPort: 'message' })).toMatchObject({
      kind: 'data',
    });
  });

  it('draws a switch as a ladder: one rule node per rule, reading only what its condition names, then to its target, otherwise down or out', async () => {
    const seen = await view(GET_ROW);
    const first = seen.graph!.nodes.find(node => node.id === 'outcome/1')!,
      second = seen.graph!.nodes.find(node => node.id === 'outcome/2')!;
    expect(first).toMatchObject({
      kind: 'rule',
      label: 'if status is 404',
      inputs: [{ name: 'status' }],
      outputs: [{ name: 'then', description: 'noCustomer' }],
    });
    expect(first.decision).toEqual({
      id: 'outcome',
      label: 'What did the API say?',
      description: undefined,
      when: 'status == 404',
      rule: 1,
      of: 2,
      then: 'noCustomer',
      otherwise: 'outcome/2',
      last: false,
      catch: { fetched: 'unreachable' },
    });
    // a condition is said in words, one clause per line, each input named so the page can point at its port
    expect(second.label).toBe('if status is 200 and body exists');
    expect(second.says).toEqual([
      { lead: 'if', parts: [{ input: 'status', text: 'status' }, { text: ' is ' }, { value: '200' }] },
      { lead: 'and', parts: [{ input: 'body', text: 'body' }, { text: ' exists' }] },
    ]);
    expect(second.inputs.map(port => port.name)).toEqual(['status', 'body']);
    expect(second.outputs.map(port => port.name)).toEqual(['then', 'otherwise']);
    expect(second.decision).toMatchObject({ rule: 2, then: 'customer', otherwise: 'upstreamFailed', last: true });
    expect(edge(seen, { from: 'outcome/1', fromPort: 'then', to: 'noCustomer', toPort: '' })).toMatchObject({
      kind: 'route',
    });
    expect(edge(seen, { from: 'outcome/1', fromPort: 'otherwise', to: 'outcome/2', toPort: '' })).toMatchObject({
      kind: 'route',
    });
    expect(edge(seen, { from: 'outcome/2', fromPort: 'then', to: 'customer', toPort: '' })).toMatchObject({
      kind: 'route',
    });
    expect(edge(seen, { from: 'outcome/2', fromPort: 'otherwise', to: 'upstreamFailed', toPort: '' })).toMatchObject({
      kind: 'route',
    });
    // the body is read by the second rule only: the first never looks at it
    expect(edge(seen, { from: 'fetched', fromPort: 'body', to: 'outcome/2', toPort: 'body' })).toMatchObject({
      kind: 'data',
    });
    expect(edge(seen, { from: 'fetched', fromPort: 'body', to: 'outcome/1', toPort: 'body' })).toBeUndefined();
  });

  it('says a membership rule in words, so every operator of the grammar draws', async () => {
    // 'registrar' in principal.roles used to crash the view: the page 500'd on the graph behind every write
    const seen = await view('@features/access/domain/require-registrar.graph.json');
    const rule = seen.graph!.nodes.find(node =>
      node.says?.some(line => line.parts.some(part => part.text === ' is among ')),
    );
    expect(rule?.label).toBe('if principal exists and "registrar" is among principal \u203a roles');
  });

  it('shows the out node as the fields it answers, fed by each candidate in order', async () => {
    const seen = await view(GET_ROW);
    const out = seen.graph!.nodes.find(node => node.id === 'out')!;
    expect(out.inputs).toEqual([]);
    expect(out.type).toBe('@features/customers/domain/Customer.shape.json');
    expect(out.fields!.map(port => [port.name, port.type, port.required])).toEqual([
      ['id', 'string', true],
      ['name', 'string', true],
      ['email', 'string', true],
      ['tier', 'string', true],
      ['registrar', 'string', false],
      ['active', 'boolean', false],
      ['note', 'string', false],
    ]);
    expect(edge(seen, { from: 'customer', fromPort: '', to: 'out', toPort: '' })).toMatchObject({
      kind: 'out',
      label: '1st candidate',
    });
    expect(edge(seen, { from: 'upstreamFailed', fromPort: '', to: 'out', toPort: '' })).toMatchObject({
      kind: 'out',
      label: '3rd candidate',
    });
    // one candidate needs no ordinal: nothing else could have answered
    const single = await view('@features/customers/domain/register-customer.graph.json');
    expect(edge(single, { from: 'registered', fromPort: '', to: 'out', toPort: '' })?.label).toBeUndefined();
  });

  it('names who calls a graph: the binding that binds it, and the trigger that fires the port operation, via it', async () => {
    const seen = await view(GET_ROW);
    expect(seen.callers).toContainEqual({
      path: '@features/customers/data/customers-rest.binding.json',
      label: 'REST storage',
      kind: 'binding',
      at: '/operations/get/graph',
    });
    expect(seen.callers).toContainEqual({
      path: '@features/customers/edge/get-customer.trigger.json',
      label: 'GET /customers/{id}',
      kind: 'trigger',
      at: '/fire/run',
      via: '@features/customers/domain/customer.port.json#get',
    });
  });

  it('points a domain call at its implementation: the graph behind the binding', async () => {
    const seen = await view('@features/customers/domain/list-customers.graph.json');
    expect(seen.graph!.role).toBe('domain');
    const byTier = seen.graph!.nodes.find(node => node.id === 'byTier')!;
    const ByMethod = '@features/customers/data/list-rows-by-tier.graph.json';
    expect(byTier.target).toEqual({
      op: '@features/customers/domain/customer.port.json#listByTier',
      opName: 'listByTier',
      port: '@features/customers/domain/customer.port.json',
      portLabel: 'Customer storage',
      native: false,
      // the port has three bindings now, and the viewer names both: which one answers is the profile's
      bindings: [
        {
          path: '@features/customers/data/customers-postgres.binding.json',
          label: 'PostgreSQL storage',
          graph: '@features/customers/data/kept-list-by-tier-postgres.graph.json',
          graphLabel: 'List what is kept, by tier',
        },
        {
          path: '@features/customers/data/customers-rest.binding.json',
          label: 'REST storage',
          graph: ByMethod,
          graphLabel: 'List rows by method',
        },
        {
          path: '@features/customers/data/customers-store.binding.json',
          label: 'Customers over a store',
          graph: '@features/customers/data/kept-list-by-tier.graph.json',
          graphLabel: 'List what is kept, by tier',
        },
      ],
      // the first binding by path, which is what the page offers before a reader picks a profile
      implementation: '@features/customers/data/kept-list-by-tier-postgres.graph.json',
    });
    const fetched = (await view(GET_ROW)).graph!.nodes.find(node => node.id === 'fetched')!;
    expect(fetched.target).toMatchObject({
      portLabel: 'HTTP',
      opName: 'request',
      implementation: '@http/http.port.json',
    });
  });

  // what each port of the request node then says -- the name the graph reads it by, the document that
  // declares it -- is `reads.test.ts`, which is what RFC 0029 made a concern of its own
  it('draws the request as a node whose ports are the paths the resolvers read, edged to what reads them', async () => {
    const seen = await view('@features/customers/data/create-row.graph.json');
    const ids = seen.graph!.nodes.map(node => node.id);
    expect(ids.slice(0, 2)).toEqual(['request', 'in']);
    const request = seen.graph!.nodes.find(node => node.id === 'request')!;
    expect(request.outputs.map(port => port.name)).toEqual(['headers', 'headers.user-agent']);
    expect(
      edge(seen, { from: 'request', fromPort: 'headers.user-agent', to: 'posted', toPort: 'headers' }),
    ).toMatchObject({
      kind: 'data',
    });
    // no node stands between the request and the node that reads it
    expect(ids).not.toContain('agent');
  });

  it('opens a deep read as an attribute port under its parent', async () => {
    const seen = await view('@features/customers/data/get-row.graph.json');
    const fetched = seen.graph!.nodes.find(node => node.id === 'fetched')!;
    // {{fetched.status}} and {{fetched.body}} read top-level fields, which are ports already: nothing is added
    expect(fetched.outputs.map(port => port.name)).toEqual(['', 'status', 'headers', 'body']);
    const other = await view('@features/customers/domain/register-customer.graph.json');
    const input = other.graph!.nodes.find(node => node.id === 'in')!;
    expect(input.outputs.map(port => port.name)).toEqual(['', 'name', 'email', 'tier']);
  });
});
