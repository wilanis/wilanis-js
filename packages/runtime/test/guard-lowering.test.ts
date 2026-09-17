/**
 * What a guarded site lowers to (RFC 0007, step 5). The example's field invariant over `Entry` is proved at no
 * site of the monitor's data graphs, so each of them is compiled with a guard: the node that makes the entry
 * moves aside to `<id>:made`, a switch on the rule takes its place between it and everything downstream, and
 * the branch the rule did not hold on refuses with the one reserved word.
 *
 * The four ids are a contract, not a choice -- the rehearsal, `describe` and the viewer all read a guard by
 * them -- so they are asserted here rather than left to whatever the lowering happens to spell.
 */
import { Compiler, guardsOf, hasGuard } from '@wilanis/compiler';
import { loadTree, Scope } from '@wilanis/core';
import type { KCall, KSwitch } from '@wilanis/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS } from '../src/index.js';
import { EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

const KEPT_GET = '@features/monitor/data/kept-get.graph.json';
const WRITE_CSV = '@features/monitor/data/write-csv.graph.json';
const KEPT_LIST = '@features/monitor/data/kept-list.graph.json';
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
