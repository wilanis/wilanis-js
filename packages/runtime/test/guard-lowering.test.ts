/**
 * What a guarded site lowers to (RFC 0007, step 5). The example's field invariant over `Entry` is proved at no
 * site of the monitor's data graphs, so each of them is compiled with a guard: the node that makes the entry
 * moves aside to `<id>:made`, a switch on the rule takes its place between it and everything downstream, and
 * the branch the rule did not hold on refuses with the one reserved word.
 *
 * The four ids are a contract, not a choice -- the rehearsal, `describe` and the viewer all read a guard by
 * them -- so they are asserted here rather than left to whatever the lowering happens to spell.
 */
import { rmSync } from 'node:fs';
import { Compiler, guardsOf, hasGuard, runGraph } from '@wilanis/compiler';
import { loadTree, Scope, schemaUrl } from '@wilanis/core';
import { type KCall, type KSwitch, outcomeOf } from '@wilanis/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, Embedder } from '../src/index.js';
import { EXAMPLE, INCLUDES, loadedWith, PLUGINS } from './example-harness.js';

const KEPT_GET = '@features/customers/data/kept-get.graph.json';
const WRITE_CSV = '@features/customers/data/write-csv.graph.json';
const KEPT_LIST = '@features/customers/data/kept-list.graph.json';
const GREET = '@features/hello/domain/greet.graph.json';

let scope: Scope;
let compiler: Compiler;

beforeAll(() => {
  const load = loadTree(EXAMPLE, PLUGINS, INCLUDES);
  scope = new Scope(load.registry, load.resolve);
  compiler = new Compiler(scope, load.plugins, { profile: 'local' });
});

const specOf = (path: string) => compiler.graph(path).spec;
const graphOf = (path: string) => {
  const graph = scope.get('graph', path);
  if (!graph) throw new Error(`no graph ${path}`);
  return graph;
};

describe('lowering a guard', () => {
  it('finds the sites the checker could not prove, and only those', () => {
    // every entry the monitor's data graphs make comes out of the store, which nothing narrows: all guarded
    expect(hasGuard(scope, graphOf(KEPT_GET))).toBe(true);
    // the greeting names no shape an invariant holds over, so nothing of it is guarded
    expect(hasGuard(scope, graphOf(GREET))).toBe(false);
    const guards = guardsOf(scope, graphOf(KEPT_GET));
    expect(guards.map(one => [one.id, one.arity, one.site.kind])).toEqual([['row', 'one', 'made']]);
    expect(guards[0].unproved.map(one => one.invariant.doc.label)).toEqual(['An entry names a call']);
  });

  it('puts the original node aside and the guard in its place, under the four ids the RFC names', () => {
    const spec = specOf(KEPT_GET);
    expect(Object.keys(spec.nodes).sort()).toEqual([
      'asked',
      'missing',
      'route',
      'row',
      'row:check',
      'row:made',
      'row:violated',
    ]);
    // the node that made the entry is the one the author wrote, moved aside and otherwise untouched
    expect((spec.nodes['row:made'] as KCall).handler).toBe('@std/object.port.json#make');
    expect((spec.nodes['row:made'] as KCall).in.value).toEqual({ ref: 'asked', path: ['record'] });
  });

  it('routes the rule to the value and the refusal, reading one input per root it names', () => {
    const check = specOf(KEPT_GET).nodes['row:check'] as KSwitch;
    expect(check.kind).toBe('switch');
    expect(check.in).toEqual({
      url: { ref: 'row:made', path: ['url'] },
      method: { ref: 'row:made', path: ['method'] },
      agent: { ref: 'row:made', path: ['agent'] },
    });
    expect(check.rules.map(rule => [rule.label, rule.to])).toEqual([
      ["(len(url) > 0 && (method != 'DELETE' || has(agent)))", 'row'],
    ]);
    expect(check.else).toBe('row:violated');
  });

  it('answers the value the rule let through, and refuses the other branch as invariant', () => {
    const spec = specOf(KEPT_GET);
    const ok = spec.nodes.row as KCall;
    // it declares no type: the node it reads already made a value of the shape and was judged against it
    expect(ok).toMatchObject({ handler: '@std/object.port.json#make', in: { value: { ref: 'row:made', path: [] } } });
    expect(ok.in.type).toBeUndefined();
    const violated = spec.nodes['row:violated'] as KCall;
    expect(violated.handler).toBe('@std/outcome.port.json#refuse');
    expect(violated.in.reason).toEqual({ value: 'invariant' });
    expect(violated.in.message).toEqual({
      value: "'An entry names a call' does not hold: len(url) > 0 && (method != 'DELETE' || has(agent))",
    });
  });

  it('routes whatever routed the node to the node that moved aside, so it is made where it was made', () => {
    const route = specOf(KEPT_GET).nodes.route as KSwitch;
    expect(route.rules.map(rule => rule.to)).toEqual(['row:made']);
    expect(route.else).toBe('missing');
  });

  it('appends the refusal after the value wherever the graph answered with it', () => {
    // out.from was ["row", "missing"]; the graph refuses where its guard does, so row:violated follows row
    expect(specOf(KEPT_GET).output).toEqual(['row', 'row:violated', 'missing']);
  });

  it('guards a list element by element, through a map over a nested spec', () => {
    const spec = specOf(KEPT_LIST);
    expect(Object.keys(spec.nodes).sort()).toEqual(['rows', 'rows:made']);
    expect(spec.nodes.rows).toMatchObject({
      kind: 'map',
      over: { ref: 'rows:made', path: [] },
      bind: { in: [] },
      onItemFailure: 'fail',
    });
    // the element's own three nodes, read off the `in` the map hands it whole
    const nested = compiler.graph(KEPT_LIST).handlers;
    expect(Object.keys(nested)).toContain(`guard:${KEPT_LIST}#rows`);
  });

  it('guards a taken value at in:ok, leaving the caller the graph was handed at in', () => {
    const spec = specOf(WRITE_CSV);
    // write-csv takes Entry[], so its guard is a map over what the caller handed it
    expect(Object.keys(spec.nodes).sort()).toEqual(['file', 'in:ok']);
    expect(spec.nodes['in:ok']).toMatchObject({ kind: 'map', over: { ref: 'in', path: [] } });
    // and the node that reads {{in}} reads the judged value instead: that is what Roots.aliases renames
    expect((spec.nodes.file as KCall).in.rows).toEqual({ ref: 'in:ok', path: [] });
  });

  it('leaves a graph with nothing to guard exactly as it was', () => {
    const spec = new Compiler(scope, Object.values(BUILTIN_PLUGINS), { profile: 'local' }).graph(GREET).spec;
    expect(Object.keys(spec.nodes).some(id => id.includes(':'))).toBe(false);
  });
});

// ---- two rules over one shape, unproved at one site -------------------------------------------------

/**
 * A site is guarded once however many rules are unproved there, and the caller is told the one that broke
 * (#492). The switch's first rule is still the conjunction, routing to the value; where it fails, one rule per
 * invariant but the last asks whether that invariant's own rule is what did not hold and routes to its own
 * refusal, and the last invariant's refusal is the `else`. So the first pair keeps `<id>:check` and
 * `<id>:violated`, a second rule adds `<id>:violated:2` and nothing else, and a value that satisfies one rule
 * and not the other is refused with that other's sentence alone. The second rule is `len(method) > 0`, which
 * the registry holds before the example's own, so it is the first the switch asks about.
 */
const METHOD_RULE = 'len(method) > 0';
const CALL_RULE = "len(url) > 0 && (method != 'DELETE' || has(agent))";
const two = loadedWith({
  'features/customers/domain/an-entry-has-a-method.invariant.json': {
    $schema: schemaUrl('invariant'),
    label: 'An entry has a method',
    description: 'A second rule over the same shape, unproved at the same sites, so one guard stands for both.',
    holds: { on: '@customers/domain/Customer.shape.json', when: METHOD_RULE },
  },
});
afterAll(() => rmSync(two.dir, { recursive: true, force: true }));

describe('lowering a guard two invariants are unproved at', () => {
  const twoScope = new Scope(two.load.registry, two.load.resolve);
  const embedder = new Embedder(twoScope, two.load.plugins, { env: {}, root: two.dir, profile: 'local' });
  const spec = () => embedder.graph(KEPT_GET).spec;

  it('keeps the four ids of the frame and adds one refusal for the second rule', () => {
    expect(Object.keys(spec().nodes).sort()).toEqual([
      'asked',
      'missing',
      'route',
      'row',
      'row:check',
      'row:made',
      'row:violated',
      'row:violated:2',
    ]);
  });

  it('tests the conjunction first, then asks which rule failed, the last being what remains', () => {
    const check = spec().nodes['row:check'] as KSwitch;
    expect(check.rules.map(rule => [rule.label, rule.to])).toEqual([
      [`(${METHOD_RULE}) && (${CALL_RULE})`, 'row'],
      [`!(${METHOD_RULE})`, 'row:violated'],
    ]);
    expect(check.else).toBe('row:violated:2');
    // one input per root either rule reads, still read off the made value
    expect(Object.keys(check.in).sort()).toEqual(['agent', 'method', 'url']);
  });

  it('gives each refusal the sentence of its own invariant and no other', () => {
    const first = spec().nodes['row:violated'] as KCall;
    const second = spec().nodes['row:violated:2'] as KCall;
    expect(first.in.message).toEqual({ value: `'An entry has a method' does not hold: ${METHOD_RULE}` });
    expect(second.in.message).toEqual({ value: `'An entry names a call' does not hold: ${CALL_RULE}` });
    for (const node of [first, second]) {
      expect(node.handler).toBe('@std/outcome.port.json#refuse');
      expect(node.in.reason).toEqual({ value: 'invariant' });
    }
  });

  it('appends every refusal after the value wherever the graph answered with it', () => {
    expect(spec().output).toEqual(['row', 'row:violated', 'row:violated:2', 'missing']);
  });

  /** The graph run with the store's answer seeded, so the guard judges exactly the entry a case hands it. */
  const judged = async (record: Record<string, unknown>) => {
    const compiled = embedder.graph(KEPT_GET);
    const report = await runGraph(compiled, { initial: { in: { id: 'x' }, asked: { record } }, env: embedder.env });
    return outcomeOf(report);
  };

  it('refuses a value that breaks one rule with that invariant alone, whichever of the two it is', async () => {
    // the URL is fine and the method is empty: only the second invariant's rule fails
    const noMethod = await judged({ id: 'x', url: 'https://x', method: '', agent: 'probe' });
    expect(noMethod).toMatchObject({
      kind: 'refused',
      reason: 'invariant',
      at: 'row:violated',
      message: `'An entry has a method' does not hold: ${METHOD_RULE}`,
    });
    // the method is fine and the URL is empty: only the example's own rule fails
    const noUrl = await judged({ id: 'x', url: '', method: 'GET', agent: 'probe' });
    expect(noUrl).toMatchObject({
      kind: 'refused',
      reason: 'invariant',
      at: 'row:violated:2',
      message: `'An entry names a call' does not hold: ${CALL_RULE}`,
    });
    for (const outcome of [noMethod, noUrl]) {
      if (outcome.kind !== 'refused') throw new Error(outcome.kind);
      expect(outcome.message).not.toContain(';');
    }
  });

  it('names the first rule where both fail, and lets a value satisfying both through', async () => {
    const both = await judged({ id: 'x', url: '', method: '', agent: 'probe' });
    expect(both).toMatchObject({ kind: 'refused', at: 'row:violated' });
    const fine = await judged({ id: 'x', url: 'https://x', method: 'GET', agent: 'probe' });
    expect(fine).toMatchObject({ kind: 'answered', output: { id: 'x', url: 'https://x', method: 'GET' } });
  });
});
