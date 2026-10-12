/**
 * What a guarded site lowers to (RFC 0007, step 5). The example's two field invariants over `Customer` are proved at
 * no site of the customer registry's data graphs, so each of them is compiled with a guard: the node that makes the
 * customer moves aside to `<id>:made`, a switch on the rules takes its place between it and everything downstream,
 * and the branch a rule did not hold on refuses with the one reserved word.
 *
 * The four ids are a contract, not a choice -- the rehearsal, `describe` and the viewer all read a guard by
 * them -- so they are asserted here rather than left to whatever the lowering happens to spell.
 */
import { Compiler, guardsOf, hasGuard, runGraph } from '@wilanis/compiler';
import { loadTree, Scope } from '@wilanis/core';
import { type KCall, type KSwitch, outcomeOf } from '@wilanis/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, Embedder } from '../src/index.js';
import { EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const KEPT_GET = '@features/customers/data/kept-get.graph.json';
const WRITE_CSV = '@features/customers/data/write-csv.graph.json';
const KEPT_LIST = '@features/customers/data/kept-list.graph.json';
const GREET = '@features/hello/domain/greet.graph.json';
/** The example's two rules over `Customer`, in the order the registry holds them and the guard asks them. */
const REACH_RULE = "len(name) > 0 && len(email) > 0 && (tier != 'gold' || has(note))";
const ADDRESS_RULE = "email contains '@'";

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
    // every customer the registry's data graphs make comes out of the store, which nothing narrows: all guarded
    expect(hasGuard(scope, graphOf(KEPT_GET))).toBe(true);
    // the greeting names no shape an invariant holds over, so nothing of it is guarded
    expect(hasGuard(scope, graphOf(GREET))).toBe(false);
    const guards = guardsOf(scope, graphOf(KEPT_GET));
    expect(guards.map(one => [one.id, one.arity, one.site.kind])).toEqual([['customer', 'one', 'made']]);
    expect(guards[0].unproved.map(one => one.invariant.doc.label)).toEqual([
      'A customer is reachable',
      'An address names its domain',
    ]);
  });

  it('puts the original node aside and the guard in its place, under the four ids the RFC names', () => {
    const spec = specOf(KEPT_GET);
    // and one refusal more for the second rule, `<id>:violated:2`
    expect(Object.keys(spec.nodes).sort()).toEqual([
      'customer',
      'customer:check',
      'customer:made',
      'customer:violated',
      'customer:violated:2',
      'isKept',
      'noCustomer',
      'stored',
    ]);
    // the node that made the entry is the one the author wrote, moved aside and otherwise untouched
    expect((spec.nodes['customer:made'] as KCall).handler).toBe('@std/object.port.json#make');
    expect((spec.nodes['customer:made'] as KCall).in.value).toEqual({ ref: 'stored', path: ['record'] });
  });

  it('routes the rule to the value and the refusal, reading one input per root it names', () => {
    const check = specOf(KEPT_GET).nodes['customer:check'] as KSwitch;
    expect(check.kind).toBe('switch');
    expect(check.in).toEqual({
      name: { ref: 'customer:made', path: ['name'] },
      email: { ref: 'customer:made', path: ['email'] },
      tier: { ref: 'customer:made', path: ['tier'] },
      note: { ref: 'customer:made', path: ['note'] },
    });
    expect(check.rules.map(rule => [rule.label, rule.to])).toEqual([
      [`(${REACH_RULE}) && (${ADDRESS_RULE})`, 'customer'],
      [`!(${REACH_RULE})`, 'customer:violated'],
    ]);
    expect(check.else).toBe('customer:violated:2');
  });

  it('answers the value the rule let through, and refuses the other branch as invariant', () => {
    const spec = specOf(KEPT_GET);
    const ok = spec.nodes.customer as KCall;
    // it declares no type: the node it reads already made a value of the shape and was judged against it
    expect(ok).toMatchObject({
      handler: '@std/object.port.json#make',
      in: { value: { ref: 'customer:made', path: [] } },
    });
    expect(ok.in.type).toBeUndefined();
    const violated = spec.nodes['customer:violated'] as KCall;
    expect(violated.handler).toBe('@std/outcome.port.json#refuse');
    expect(violated.in.reason).toEqual({ value: 'invariant' });
    expect(violated.in.message).toEqual({
      value:
        "'A customer is reachable' does not hold: len(name) > 0 && len(email) > 0 && (tier != 'gold' || has(note))",
    });
  });

  it('routes whatever routed the node to the node that moved aside, so it is made where it was made', () => {
    const route = specOf(KEPT_GET).nodes.isKept as KSwitch;
    expect(route.rules.map(rule => rule.to)).toEqual(['customer:made']);
    expect(route.else).toBe('noCustomer');
  });

  it('appends the refusal after the value wherever the graph answered with it', () => {
    // out.from was ["customer", "noCustomer"]; the graph refuses where its guard does, so the refusals follow customer
    expect(specOf(KEPT_GET).output).toEqual(['customer', 'customer:violated', 'customer:violated:2', 'noCustomer']);
  });

  it('guards a list element by element, through a map over a nested spec', () => {
    const spec = specOf(KEPT_LIST);
    expect(Object.keys(spec.nodes).sort()).toEqual(['customers', 'customers:made']);
    expect(spec.nodes.customers).toMatchObject({
      kind: 'map',
      over: { ref: 'customers:made', path: [] },
      bind: { in: [] },
      onItemFailure: 'fail',
    });
    // the element's own three nodes, read off the `in` the map hands it whole
    const nested = compiler.graph(KEPT_LIST).handlers;
    expect(Object.keys(nested)).toContain(`guard:${KEPT_LIST}#customers`);
  });

  it('guards a taken value at in:ok, leaving the caller the graph was handed at in', () => {
    const spec = specOf(WRITE_CSV);
    // write-csv takes Customer[], so its guard is a map over what the caller handed it
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
 * and not the other is refused with that other's sentence alone. The example holds `Customer` to two rules, and
 * the registry holds 'A customer is reachable' first, so it is the one the switch asks about.
 */
describe('lowering a guard two invariants are unproved at', () => {
  const load = loadTree(EXAMPLE, PLUGINS, INCLUDES);
  const embedder = new Embedder(new Scope(load.registry, load.resolve), load.plugins, {
    env: {},
    root: EXAMPLE,
    profile: 'local',
  });
  const spec = () => embedder.graph(KEPT_GET).spec;

  it('reads one input per root either rule reads, still read off the made value', () => {
    const check = spec().nodes['customer:check'] as KSwitch;
    expect(Object.keys(check.in).sort()).toEqual(['email', 'name', 'note', 'tier']);
  });

  it('gives each refusal the sentence of its own invariant and no other', () => {
    const first = spec().nodes['customer:violated'] as KCall;
    const second = spec().nodes['customer:violated:2'] as KCall;
    expect(first.in.message).toEqual({ value: `'A customer is reachable' does not hold: ${REACH_RULE}` });
    expect(second.in.message).toEqual({ value: `'An address names its domain' does not hold: ${ADDRESS_RULE}` });
    for (const node of [first, second]) {
      expect(node.handler).toBe('@std/outcome.port.json#refuse');
      expect(node.in.reason).toEqual({ value: 'invariant' });
    }
  });

  it('appends every refusal after the value wherever the graph answered with it', () => {
    expect(spec().output).toEqual(['customer', 'customer:violated', 'customer:violated:2', 'noCustomer']);
  });

  /** The graph run with the store's answer seeded, so the guard judges exactly the customer a case hands it. */
  const judged = async (record: Record<string, unknown>) => {
    const compiled = embedder.graph(KEPT_GET);
    const report = await runGraph(compiled, {
      initial: { in: { id: 'x' }, stored: { record } },
      env: embedder.env,
    });
    return outcomeOf(report);
  };

  it('refuses a value that breaks one rule with that invariant alone, whichever of the two it is', async () => {
    // the address holds an @ and the name is empty: only the first rule fails
    const noName = await judged({ id: 'x', name: '', email: 'ada@example.com', tier: 'bronze' });
    expect(noName).toMatchObject({
      kind: 'refused',
      reason: 'invariant',
      at: 'customer:violated',
      message: `'A customer is reachable' does not hold: ${REACH_RULE}`,
    });
    // the customer is reachable and the address holds no @: only the second rule fails
    const noAt = await judged({ id: 'x', name: 'Ada', email: 'ada.example.com', tier: 'bronze' });
    expect(noAt).toMatchObject({
      kind: 'refused',
      reason: 'invariant',
      at: 'customer:violated:2',
      message: `'An address names its domain' does not hold: ${ADDRESS_RULE}`,
    });
    for (const outcome of [noName, noAt]) {
      if (outcome.kind !== 'refused') throw new Error(outcome.kind);
      expect(outcome.message).not.toContain(';');
    }
  });

  it('names the first rule where both fail, and lets a value satisfying both through', async () => {
    const both = await judged({ id: 'x', name: '', email: '', tier: 'bronze' });
    expect(both).toMatchObject({ kind: 'refused', at: 'customer:violated' });
    const ok = { id: 'x', name: 'Ada', email: 'ada@example.com', tier: 'bronze' };
    const fine = await judged(ok);
    expect(fine).toMatchObject({ kind: 'answered', output: ok });
  });
});
