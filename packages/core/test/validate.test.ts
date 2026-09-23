import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { KINDS, type Kind, NODE_MAP, NODE_RUN, NODE_SWITCH } from '../src/model.js';
import { schemaRef, schemaUrl } from '../src/published.js';
import { SCHEMAS_DIR, validateDocument } from '../src/validate.js';
import { at, doc, refused, run } from './documents.js';

describe('the schemas themselves', () => {
  it('are plain JSON Schema 2020-12: every one compiles under a strict validator with no extensions, and $id matches its place', () => {
    // strict refuses unknown keywords and formats; strictRequired is an Ajv lint (required keys re-listed in the same properties), not a JSON Schema rule
    const ajv = new Ajv2020({ strict: true, strictRequired: false, allowUnionTypes: true });
    const files = [
      ...readdirSync(SCHEMAS_DIR).filter(name => name.endsWith('.schema.json')),
      ...readdirSync(join(SCHEMAS_DIR, 'node')).map(name => `node/${name}`),
    ];
    const schemas = files.map(file => ({
      file,
      schema: JSON.parse(readFileSync(join(SCHEMAS_DIR, file), 'utf8')) as {
        $id: string;
        $schema: string;
        title: string;
      },
    }));
    for (const { file, schema } of schemas) {
      expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(schema.$id).toBe(`${schemaUrl('x' as Kind).replace('/x.schema.json', '')}/${file}`);
      expect(schema.title).toBe(file.replace('.schema.json', ''));
      ajv.addSchema(schema);
    }
    for (const { schema } of schemas) expect(() => ajv.getSchema(schema.$id)).not.toThrow();
    expect(KINDS.map(kind => `${kind}.schema.json`).every(name => files.includes(name))).toBe(true);
  });
});

describe('the baseline', () => {
  it.each(KINDS)('%s: the smallest document conforms, under both $schema forms', kind => {
    expect(validateDocument(doc(kind), 'f.json')).toEqual({ kind, refusals: [] });
    expect(validateDocument(doc(kind, {}, schemaUrl(kind)), 'f.json')).toEqual({ kind, refusals: [] });
  });
  it('a keyed operation, a retried and bounded node, and a retried binding operation conform too', () => {
    const keyed = { description: 'one', accepts: { id: { type: 'string' } }, key: 'id' };
    expect(refused(doc('port', { operations: { get: keyed } }))).toEqual([]);
    expect(refused(doc('graph', { nodes: [run('a', { retry: { times: 2 }, timeoutMs: 5000 })] }))).toEqual([]);
    const retried = { graph: '@features/f/graphs/g.graph.json', retry: { times: 1 }, timeoutMs: 8000 };
    expect(refused(doc('binding', { operations: { get: retried } }))).toEqual([]);
  });
  it('a bounded list field, a limited and paced map, and a scenario that pins a cancellation conform too', () => {
    expect(refused(doc('shape', { fields: { ids: { type: 'string[]', maxItems: 100 } } }))).toEqual([]);
    const map = { type: NODE_MAP, id: 'm', run: '@x/p.json#op', over: '{{in.ids}}', limit: 100, concurrency: 8 };
    expect(refused(doc('graph', { nodes: [map] }))).toEqual([]);
    const expected = { status: 'cancelled', nodes: { 'op.asked': { status: 'failed' } } };
    const pinned = { stubs: { 'op.asked': {} }, cancelAt: 'op.asked', expect: expected };
    expect(refused(doc('scenario', pinned))).toEqual([]);
  });
  it("a switch that catches a node's fault conforms too; a catch is node ids to node ids", () => {
    const route = { type: NODE_SWITCH, id: 's', in: {}, rules: [{ when: 'x', to: 'row' }], else: 'failed' };
    const graph = (caught: unknown) => doc('graph', { nodes: [{ ...route, catch: caught }] });
    expect(refused(graph({ asked: 'unreachable' }))).toEqual([]);
    expect(refused(graph([]))).toEqual([at('nodes/s/catch', 'must be object')]);
    expect(refused(graph({ asked: 1 }))).toEqual([at('nodes/s/catch/asked', 'must be string')]);
  });
});

describe('the envelope', () => {
  it('a document is a JSON object', () => {
    expect(refused([])).toEqual([at(undefined, 'a document is a JSON object')]);
    expect(refused('x')).toEqual([at(undefined, 'a document is a JSON object')]);
    expect(validateDocument(null, 'f.json').refusals[0].hint).toContain('$schema');
  });
  it('$schema must name a wilanis kind, in either form', () => {
    expect(refused({ $schema: '@wilanis/widget.schema.json', description: 'd' })).toEqual([
      at('$schema', 'does not name a wilanis kind'),
    ]);
    expect(refused({ $schema: 'https://example.com/port.schema.json', description: 'd' })).toEqual([
      at('$schema', 'does not name a wilanis kind'),
    ]);
    expect(refused({ description: 'd' })).toEqual([at('$schema', 'does not name a wilanis kind')]);
    expect(validateDocument({ $schema: 'x' }, 'f.json').refusals[0].hint).toContain(schemaRef('port'));
  });
  it.each(KINDS)('%s: description is required and never empty; unknown properties are named', kind => {
    const { description: _, ...without } = doc(kind);
    expect(refused(without)).toEqual([at(undefined, "missing 'description'")]);
    expect(refused(doc(kind, { description: '' }))).toEqual([at('description', 'fewer than 1 characters')]);
    expect(refused(doc(kind, { params: {} }))).toEqual([at(undefined, "unknown property 'params'")]);
  });
  it('every missing required property is reported, not only the first', () => {
    expect(refused({ $schema: schemaRef('trigger'), description: 'd', settings: {} })).toEqual([
      at(undefined, "missing 'kind'"),
      at(undefined, "missing 'fire'"),
    ]);
  });
});

describe('the flags an operation carries', () => {
  const op = (extra: Record<string, unknown>) => doc('port', { operations: { get: { description: 'one', ...extra } } });

  it('transactional is an optional boolean, beside pure, refuses and holds', () => {
    expect(refused(op({ transactional: true }))).toEqual([]);
    expect(refused(op({ transactional: false }))).toEqual([]);
    expect(refused(op({ pure: true, refuses: false, holds: false, transactional: true }))).toEqual([]);
    expect(refused(op({}))).toEqual([]);
    expect(refused(op({ transactional: 'yes' }))).toEqual([at('operations/get/transactional', 'must be boolean')]);
  });
});

describe('a contract that says where a type comes from', () => {
  const port = (resolves: unknown) =>
    doc('port', {
      operations: {
        get: {
          description: 'one record of a collection',
          accepts: {
            store: { type: 'string', static: true, resolves },
            collection: { type: 'string', static: true },
          },
          returns: '$T',
        },
      },
    });

  it('a port document carrying resolves validates, with a substitution and without', () => {
    expect(refused(port({ $T: 'collections[collection].of' }))).toEqual([]);
    expect(refused(port({ $T: 'shape' }))).toEqual([]);
    expect(refused(port({ $T: 'collections[collection].of', $K: 'collections[collection].key' }))).toEqual([]);
  });

  it('a malformed path does not: the grammar is field names, a segment optionally taking a key', () => {
    const grammar = 'The path within the named document whose value is the type';
    expect(refused(port({ $T: 'collections[collection]of' }))).toEqual([
      at('operations/get/accepts/store/resolves/$T', grammar),
    ]);
    expect(refused(port({ $T: '.of' }))).toEqual([at('operations/get/accepts/store/resolves/$T', grammar)]);
    expect(refused(port({ $T: 'collections[Collection].of' }))).toEqual([
      at('operations/get/accepts/store/resolves/$T', grammar),
    ]);
    expect(refused(port({ $T: 'collections[collection][of]' }))).toEqual([
      at('operations/get/accepts/store/resolves/$T', grammar),
    ]);
    expect(refused(port({ $T: '' }))).toEqual([at('operations/get/accepts/store/resolves/$T', grammar)]);
  });

  it('what it binds is a type variable, and it binds at least one', () => {
    expect(refused(port({ T: 'collections[collection].of' }))).toEqual([
      at('operations/get/accepts/store/resolves', "property name 'T'"),
    ]);
    expect(refused(port({}))).toEqual([at('operations/get/accepts/store/resolves', 'fewer than 1 properties')]);
  });
});

describe('graph', () => {
  it('a node is judged against the one node schema its type names', () => {
    expect(refused(doc('graph', { nodes: [{ type: NODE_RUN, id: 'a' }] }))).toEqual([at('nodes/a', "missing 'run'")]);
    expect(refused(doc('graph', { nodes: [{ type: NODE_SWITCH, id: 's', in: {}, rules: [{ when: 'x' }] }] }))).toEqual([
      at('nodes/s', "missing 'else'"),
      at('nodes/s/rules/0', "missing 'to'"),
    ]);
    expect(refused(doc('graph', { nodes: [{ type: NODE_MAP, id: 'm', run: '@x/p.json#op' }] }))).toEqual([
      at('nodes/m', "missing 'over'"),
    ]);
  });
  it('an unknown node type names the three that exist, and offers no fix: the author meant one of them', () => {
    expect(refused(doc('graph', { nodes: [{ type: '@wilanis/node/loop.schema.json', id: 'a' }] }))).toEqual([
      at('nodes/a/type', NODE_RUN, NODE_SWITCH, NODE_MAP),
    ]);
    const { refusals } = validateDocument(
      doc('graph', { nodes: [{ type: '@wilanis/node/loop.schema.json', id: 'a' }] }),
      'f.json',
    );
    for (const refusal of refusals) expect(refusal.fixes).toBeUndefined();
  });
  it('several deviations in one node are all reported, each at its own path', () => {
    expect(refused(doc('graph', { nodes: [{ type: NODE_RUN, id: 'Bad-Id', params: {} }] }))).toEqual([
      at('nodes/Bad-Id', "missing 'run'"),
      at('nodes/Bad-Id', "unknown property 'params'"),
      at('nodes/Bad-Id/id', '^[a-z][A-Za-z0-9_]*$', 'node identifier'),
    ]);
  });
  it('a node is named by its id, so a reorder moves no path; a node without one keeps its index', () => {
    expect(
      refused(doc('graph', { nodes: [run('first'), { type: NODE_RUN, id: 'second', run: '@x/p.json#op', in: 3 }] })),
    ).toEqual([at('nodes/second/in', 'must be object')]);
    expect(refused(doc('graph', { nodes: [{ type: NODE_RUN, run: '@x/p.json#op', in: 3 }] }))).toEqual([
      at('nodes/0', "missing 'id'"),
      at('nodes/0/in', 'must be object'),
    ]);
  });
  it('identifiers, operation references and paths follow the shared grammar, quoted in the refusal', () => {
    expect(refused(doc('graph', { nodes: [run('a', { run: 'object.port.json#make' })] }))).toEqual([
      at('nodes/a/run', 'path#operation'),
    ]);
    expect(refused(doc('graph', { nodes: [run('a', { run: '@std/object.port.json' })] }))).toEqual([
      at('nodes/a/run', 'path#operation'),
    ]);
    expect(refused(doc('graph', { nodes: [run('a', { in: { 'bad key': 1 } })] }))).toEqual([
      at('nodes/a/in', "property name 'bad key'", 'identifier'),
    ]);
    expect(
      refused(
        doc('graph', {
          nodes: [
            run('a', { in: { x: 1 } }),
            { type: NODE_SWITCH, id: 's', in: {}, rules: [{ when: 'x', to: 'Not-Ident' }], else: 'a' },
          ],
        }),
      ),
    ).toEqual([at('nodes/s/rules/0/to', 'identifier')]);
  });
  it('in, out.type and constants: in is a type reference; out.from is a node or a list of nodes; a constant has type and value', () => {
    expect(refused(doc('graph', { in: { fields: {} } }))).toEqual([at('in', 'must be string')]);
    expect(refused(doc('graph', { in: 'object' }))).toEqual([at('in', 'A type: string, number, boolean, blob')]);
    expect(refused(doc('graph', { out: { type: 'string', from: 3 } }))).toEqual([
      at('out/from', 'must be string or array'),
    ]);
    expect(refused(doc('graph', { out: { type: 'string', from: [] } }))).toEqual([
      at('out/from', 'fewer than 1 items'),
    ]);
    expect(refused(doc('graph', { out: { type: 'string' } }))).toEqual([at('out', "missing 'from'")]);
    expect(refused(doc('graph', { constants: { n: { value: 1 } } }))).toEqual([at('constants/n', "missing 'type'")]);
    expect(refused(doc('graph', { constants: { n: { type: 'number' } } }))).toEqual([
      at('constants/n', "missing 'value'"),
    ]);
  });
  it('atomic is an optional boolean: a graph that declares it validates, and a graph that is not one is unchanged', () => {
    expect(refused(doc('graph', { atomic: true }))).toEqual([]);
    expect(refused(doc('graph', { atomic: false }))).toEqual([]);
    expect(refused(doc('graph', {}))).toEqual([]);
    expect(refused(doc('graph', { atomic: 'yes' }))).toEqual([at('atomic', 'must be boolean')]);
  });
  it('a value in in is any JSON: the schema does not judge it, the checker does', () => {
    expect(
      refused(
        doc('graph', {
          nodes: [
            run('a', { in: { s: '{{in.x}}', n: 1, b: true, l: [1, '{{in.y}}'], o: { k: '{{in.z}}' }, z: null } }),
          ],
        }),
      ),
    ).toEqual([]);
  });
  it('a map\'s bind is input -> dotted path or ""; onItemFailure is fail or collect', () => {
    const map = (extra: Record<string, unknown>) =>
      doc('graph', { nodes: [{ type: NODE_MAP, id: 'm', run: '@x/p.json#op', over: '{{in.list}}', ...extra }] });
    expect(refused(map({ bind: { item: '' } }))).toEqual([]);
    expect(refused(map({ bind: { item: 'a.b' } }))).toEqual([]);
    expect(refused(map({ bind: { item: '.a' } }))).toEqual([at('nodes/m/bind/item', 'dotted path within the element')]);
    expect(refused(map({ onItemFailure: 'ignore' }))).toEqual([at('nodes/m/onItemFailure', '"fail", "collect"')]);
  });
});

describe('invariant', () => {
  const access = (requires: unknown) => ({
    over: ['@features/customers/domain/customer.port.json#register'],
    requires,
  });
  const holds = {
    on: '@features/customers/domain/Customer.shape.json',
    when: "len(name) > 0 && len(email) > 0 && (tier != 'gold' || has(note))",
  };
  const form = (body: Record<string, unknown>) => {
    const { holds: _baseline, ...envelope } = doc('invariant');
    return { ...envelope, ...body };
  };

  it('the access form: operations, and the policy or the proofs every reaching trigger must carry', () => {
    expect(refused(form({ access: access({ policy: '@access/edge/can-register.policy.json' }) }))).toEqual([]);
    expect(refused(form({ access: access({ proves: ['request.principal'] }) }))).toEqual([]);
    expect(
      refused(
        form({ access: access({ policy: '@access/edge/can-register.policy.json', proves: ['request.session.id'] }) }),
      ),
    ).toEqual([]);
  });

  it('the field form: a shape, and a rule over its fields', () => {
    expect(refused(form({ holds }))).toEqual([]);
    expect(refused(form({ label: 'A customer is reachable', holds }))).toEqual([]);
  });

  it('a document is exactly one of the two forms: both is refused, and neither', () => {
    expect(refused(form({ access: access({ proves: ['request.principal'] }), holds }))).toEqual([
      at('holds', "'holds' is not allowed here"),
      at('access', "'access' is not allowed here"),
    ]);
    expect(refused(form({}))).toEqual([at(undefined, "missing 'access'"), at(undefined, "missing 'holds'")]);
  });

  it('over names at least one operation without repeating one, and requires says at least one thing', () => {
    expect(refused(form({ access: { over: [], requires: { proves: ['request.principal'] } } }))).toEqual([
      at('access/over', 'fewer than 1 items'),
    ]);
    const twice = ['@features/f/domain/f.port.json#write', '@features/f/domain/f.port.json#write'];
    expect(refused(form({ access: { over: twice, requires: { proves: ['request.principal'] } } }))).toEqual([
      at('access/over', 'duplicate items'),
    ]);
    expect(refused(form({ access: access({}) }))).toEqual([at('access/requires', 'fewer than 1 properties')]);
    expect(refused(form({ access: access({ proves: ['principal'] }) }))).toEqual([
      at('access/requires/proves/0', '^request'),
    ]);
    expect(
      refused(
        form({ access: { over: ['@features/f/domain/f.port.json'], requires: { proves: ['request.principal'] } } }),
      ),
    ).toEqual([at('access/over/0', 'path#operation')]);
  });

  it('holds names a shape and a rule, and nothing else', () => {
    expect(refused(form({ holds: { on: holds.on } }))).toEqual([at('holds', "missing 'when'")]);
    expect(refused(form({ holds: { when: 'true' } }))).toEqual([at('holds', "missing 'on'")]);
    expect(refused(form({ holds: { ...holds, when: '' } }))).toEqual([at('holds/when', 'fewer than 1 characters')]);
    expect(refused(form({ holds: { ...holds, over: [] } }))).toEqual([at('holds', "unknown property 'over'")]);
  });
});
