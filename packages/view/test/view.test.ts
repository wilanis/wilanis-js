import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadProject } from '@wilanis/runtime';
import { describe, expect, it } from 'vitest';
import { type DocView, indexOf, viewOf } from '../src/index.js';

const EXAMPLE = fileURLToPath(new URL('../../../example', import.meta.url));
const PAGE = fileURLToPath(new URL('../client/index.html', import.meta.url));
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

describe('the view model of the example', () => {
  it('lists every document, sorted by kind then path, with no refusals', async () => {
    const idx = indexOf(await loadProject(EXAMPLE));
    expect(idx.project).toBe('customers');
    expect(idx.refusals).toEqual([]);
    expect(idx.docs.map(doc => doc.kind)).toEqual(
      idx.docs
        .map(doc => doc.kind)
        .slice()
        .sort(),
    );
    expect(idx.docs.some(doc => doc.path === '@http/http.port.json' && doc.native === '@http')).toBe(true);
    expect(idx.aliases).toEqual({
      '@customers': '@features/customers',
      '@access': '@features/access',
      '@hello': '@features/hello',
    });
  });

  it('labels every document: its own label, or its file name made readable', async () => {
    const idx = indexOf(await loadProject(EXAMPLE));
    expect(idx.docs.find(doc => doc.path === GET_ROW)?.label).toBe('Get a row');
    expect(idx.docs.find(doc => doc.path === '@http/http.port.json')?.label).toBe('HTTP');
    const seen = await view('@features/customers/domain/Customer.shape.json');
    expect(seen.label).toBe('Customer');
    expect(seen.refs).toEqual([]);
    expect(seen.callers.find(caller => caller.path === GET_ROW)?.label).toBe('Get a row');
  });

  it('answers undefined for a path that names nothing', async () => {
    expect(viewOf(await loadProject(EXAMPLE), '@features/nope.graph.json')).toBeUndefined();
  });

  it('accepts an alias and answers the canonical path', async () => {
    const seen = await view('@customers/data/get-row.graph.json');
    expect(seen.path).toBe(GET_ROW);
    expect(seen.kind).toBe('graph');
    expect(seen.graph!.role).toBe('data');
  });

  it('names the port operation a trigger fires and where it leads', async () => {
    const seen = await view('@features/customers/edge/get-customer.trigger.json');
    expect(seen.fires).toMatchObject({
      op: '@features/customers/domain/customer.port.json#get',
      opName: 'get',
      portLabel: 'Customer storage',
      native: false,
      // the first binding by path; the REST one is still there, one along
      implementation: '@features/customers/data/kept-get-postgres.graph.json',
    });
    expect(seen.fires!.bindings![1]).toMatchObject({ label: 'REST storage', graphLabel: 'Get a row' });
    // the graph behind the binding knows the trigger reaches it
    const graph = await view(GET_ROW);
    expect(graph.callers).toContainEqual({
      path: '@features/customers/edge/get-customer.trigger.json',
      label: 'GET /customers/{id}',
      kind: 'trigger',
      at: '/fire/run',
      via: '@features/customers/domain/customer.port.json#get',
    });
  });

  it('views a policy: what it decides through, its outcomes, what it proves, and the triggers it gates', async () => {
    const seen = await view('@features/access/edge/employees-only.policy.json');
    expect(seen.kind).toBe('policy');
    expect(seen.decides).toMatchObject({
      op: '@features/access/domain/access.port.json#requireEmployee',
      opName: 'requireEmployee',
      native: false,
      implementation: '@features/access/domain/require-employee.graph.json',
    });
    expect(seen.outcomes!.forbidden).toMatchObject({ effect: 'deny' });
    expect(seen.proves).toEqual(['request.principal', 'request.session']);
    expect(seen.gates?.map(gate => gate.path)).toEqual(
      expect.arrayContaining([
        '@features/customers/edge/register-customer.trigger.json',
        '@features/customers/edge/update-customer.trigger.json',
        '@features/customers/edge/delete-customer.trigger.json',
      ]),
    );
    // the trigger attaches its policies in order, giving the guard the token where it may sit, and answers the reasons they reach and the guard's own
    const trigger = await view('@features/customers/edge/register-customer.trigger.json');
    expect(trigger.policies).toHaveLength(2);
    expect(trigger.policies![0]).toMatchObject({
      path: '@features/access/edge/employees-only.policy.json',
      label: 'Employees only',
      decide: '@access/domain/access.port.json#requireEmployee',
      gives: { token: ['{{request.headers.authorization}}', '{{request.cookies.session}}'] },
    });
    expect(trigger.policies![1].gives).toBeUndefined();
    const reasons = trigger.answers!.map(answer => answer.reason);
    expect(reasons).toEqual(expect.arrayContaining(['forbidden', 'anonymous', 'invalid_credential', 'upstream']));
    expect(trigger.answers!.find(answer => answer.reason === 'invalid_credential')).toMatchObject({
      answer: 401,
      from: [{ graph: '@auth/plugin.json', node: 'identify' }],
    });
    expect(trigger.answers!.find(answer => answer.reason === 'forbidden')?.from.map(field => field.graph)).toEqual(
      expect.arrayContaining([
        '@features/access/domain/require-employee.graph.json',
        '@features/access/domain/require-registrar.graph.json',
      ]),
    );
  });
  it('composes two nodes into one output: the digest', async () => {
    const seen = await view('@features/customers/domain/digest.graph.json');
    expect(edge(seen, { from: 'count', fromPort: '', to: 'digest', toPort: 'value' })).toMatchObject({ kind: 'data' });
    expect(seen.graph!.nodes.find(node => node.id === 'digest')?.target).toMatchObject({
      portLabel: 'Objects',
      opName: 'make',
      pure: true,
    });
    expect(edge(seen, { from: 'joined', fromPort: '', to: 'digest', toPort: 'value' })).toMatchObject({ kind: 'data' });
    const out = seen.graph!.nodes.find(node => node.id === 'out')!;
    expect(out.fields!.map(port => port.name)).toEqual(['count', 'text']);
    expect(edge(seen, { from: 'digest', fromPort: '', to: 'out', toPort: '' })).toMatchObject({ kind: 'out' });
  });

  it('draws a map node with its over port and a list result', async () => {
    const seen = await view('@features/customers/domain/digest.graph.json');
    const lines = seen.graph!.nodes.find(node => node.id === 'lines')!;
    expect(lines.kind).toBe('map');
    expect(lines.inputs[0].name).toBe('over');
    expect(lines.outputs).toEqual([{ name: '', type: 'string[]' }]);
    expect(edge(seen, { from: 'all', fromPort: '', to: 'lines', toPort: 'over' })).toMatchObject({ kind: 'data' });
  });

  it('a map with bind shows each bound input as read from the element, never as missing; an input typed by a bound variable shows the bound type', async () => {
    // the map that binds the draft's fields moved into register-all when the import was split around its transaction
    const recorded = (await view('@features/customers/domain/register-all.graph.json')).graph!.nodes.find(
      node => node.id === 'recorded',
    )!;
    expect(recorded.inputs.map(port => [port.name, port.bound, port.missing])).toEqual([
      ['over', undefined, undefined],
      ['name', 'name', undefined],
      ['email', 'email', undefined],
      ['tier', 'tier', undefined],
    ]);
    const remove = (await view('@features/customers/domain/remove-customers.graph.json')).graph!.nodes.find(
      node => node.id === 'removed',
    )!;
    expect(remove.inputs.find(port => port.name === 'id')).toMatchObject({ bound: '' });
    const file = (await view('@features/customers/data/write-csv.graph.json')).graph!.nodes.find(
      node => node.id === 'file',
    )!;
    expect(file.inputs.find(port => port.name === 'rows')?.type).toBe(
      '@features/customers/domain/Customer.shape.json[]',
    );
  });

  it('draws a graph that takes and answers a file: the blob type on the in and out nodes', async () => {
    const seen = await view('@features/customers/data/parse-drafts.graph.json');
    expect(seen.graph!.nodes.find(node => node.id === 'in')).toMatchObject({
      type: 'blob',
      outputs: [{ name: '', type: 'blob' }],
    });
    expect(edge(seen, { from: 'in', fromPort: '', to: 'rows', toPort: 'file' })).toMatchObject({ kind: 'data' });
    const wrote = await view('@features/customers/data/write-csv.graph.json');
    expect(wrote.graph!.nodes.find(node => node.id === 'out')).toMatchObject({ type: 'blob' });
    expect((await view('@features/customers/edge/export-customers.trigger.json')).fires).toMatchObject({
      opName: 'export',
      implementation: '@features/customers/domain/export-customers.graph.json',
    });
  });

  it('answers references both ways for a document that is not a graph', async () => {
    const port = await view('@features/customers/domain/customer.port.json');
    expect(port.graph).toBeUndefined();
    expect(port.callers.map(caller => caller.path)).toContain('@features/customers/data/customers-rest.binding.json');
    expect(port.callers.map(caller => caller.path)).toContain('@features/customers/domain/list-customers.graph.json');
    expect(port.refs.map(refusal => refusal.path)).toContain('@features/customers/domain/Customer.shape.json');
    // every binding of the port, so the page says what meets it under any profile
    expect(port.implementations).toEqual([
      {
        path: '@features/customers/data/customers-postgres.binding.json',
        label: 'PostgreSQL storage',
        operations: expect.objectContaining({
          get: { graph: '@features/customers/data/kept-get-postgres.graph.json', graphLabel: 'Get what is kept' },
        }),
      },
      {
        path: '@features/customers/data/customers-rest.binding.json',
        label: 'REST storage',
        operations: expect.objectContaining({ get: { graph: GET_ROW, graphLabel: 'Get a row' } }),
      },
      {
        path: '@features/customers/data/customers-store.binding.json',
        label: 'Customers over a store',
        operations: expect.objectContaining({
          get: { graph: '@features/customers/data/kept-get.graph.json', graphLabel: 'Get what is kept' },
        }),
      },
    ]);
    // a native port has no binding: the page names the plugin that grants it instead
    expect(await view('@http/server.port.json')).toMatchObject({
      native: '@http',
      from: '@wilanis/plugin-http',
      implementations: [],
    });
    expect(await view('@std/list.port.json')).toMatchObject({ native: '@std', from: undefined });
  });
});

// the page is one static file with no build step, so what it draws is read from its own source
describe("the store page's marks the database has not caught up with", () => {
  it('strikes through the name a renamed field had before, beside the name it has now', async () => {
    const page = await readFile(PAGE, 'utf8');
    // `was` is the struck class, and the stylesheet is the one place that strikes it
    expect(page).toMatch(/\.was\s*\{[^}]*line-through/);
    // the renamed column draws the name now, then the name before in that class
    expect(page).toMatch(/renamedCell = c => \{[\s\S]*?'was', before\)/);
    expect(page).toContain("'renamed'");
  });

  it("puts a collection's was under its name, struck the same way, and says what has yet to happen", async () => {
    const page = await readFile(PAGE, 'utf8');
    expect(page).toMatch(/c\.was[\s\S]*?'was', c\.was\)/);
    // under, not beside: the struck name is a block inside the name cell
    expect(page).toMatch(/td\.name \.was \{ display: block/);
    expect(page).toContain('until wilanis migrate has applied it everywhere');
  });

  it('draws them from the store document alone, so the page opens no connection', async () => {
    const store = (await view('@features/customers/data/customers.store.json')).store;
    // the view model says what the tree says: the engine behind the store, its key types and its call sites,
    // and nothing about what any database has recorded
    expect(Object.keys(store ?? {}).sort()).toEqual([
      'calls',
      'connection',
      'connectionLabel',
      'from',
      'keyTypes',
      'kind',
      'kindLabel',
      'plugin',
    ]);
  });
});
