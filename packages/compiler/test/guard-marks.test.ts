/**
 * The marks a guard's answer is shown with, where the node that made the value marks less than its shape does.
 * A made site's node answers the shape, so in a tree that passes its operation marks exactly what the shape
 * marks and the two cannot be told apart; the lowering is asked directly here, with a made node that marks less,
 * so that what the guard shows is seen to be the union of the two and never the made node's alone (#716).
 */
import type { GraphDoc, InvariantDoc, Loaded } from '@wilanis/core';
import type { KCall, KernelSpec, KMap, KNode } from '@wilanis/engine';
import { describe, expect, it } from 'vitest';
import type { Guard, GuardHandlers } from '../src/guard.js';
import { lowerGuards } from '../src/guard-lowering.js';

const LOGIN = '@features/vault/domain/Login.shape.json';
const RULE = 'len(name) > 0';

const invariant = {
  path: '@features/vault/domain/logins-are-named.invariant.json',
  doc: { description: 'd', label: 'Logins are named', holds: { on: LOGIN, when: RULE } },
} as Loaded<InvariantDoc>;
const graph = { path: '@features/vault/data/login.graph.json', doc: { nodes: [] } } as unknown as Loaded<GraphDoc>;

/** A guard of the node `id`, whose shape marks the password and the pin secret. */
const guardOf = (id: string, arity: Guard['arity']): Guard => ({
  site: { graph, node: undefined, kind: 'made', arity },
  id,
  arity,
  shape: LOGIN,
  unproved: [{ invariant, when: RULE }],
  when: `(${RULE})`,
  secret: [['password'], ['pin']],
});

/** A spec whose one node `id` is what `made` says, answering the graph. */
const specOf = (id: string, made: KNode): KernelSpec => ({ name: graph.path, nodes: { [id]: made }, output: [id] });

/** A call that answers a login and marks only its pin: less than the shape marks. */
const marksPin: KCall = { kind: 'call', handler: 'fetch', in: {}, redact: { in: [], out: [['pin']] } };

const handlers = (): GuardHandlers & { specs: KernelSpec[] } => {
  const specs: KernelSpec[] = [];
  return { make: 'make', refuse: 'refuse', nested: spec => specs.push(spec), specs };
};

describe('a guard at a made site whose node marks less than its shape', () => {
  it("shows its answer with every path the shape marks and the made node's, each once", () => {
    const spec = lowerGuards(specOf('login', { ...marksPin }), [guardOf('login', 'one')], handlers());
    expect((spec.nodes.login as KCall).redact).toEqual({ out: [['password'], ['pin']] });
    // the node moved aside is shown as it was: the guard adds its marks to its own answer, not to what it reads
    expect((spec.nodes['login:made'] as KCall).redact).toEqual({ in: [], out: [['pin']] });
  });

  it('shows a list it judges with the same union, on the map that runs each element through it', () => {
    const spec = lowerGuards(specOf('logins', { ...marksPin }), [guardOf('logins', 'list')], handlers());
    expect((spec.nodes.logins as KMap).redact).toEqual({ out: [['password'], ['pin']] });
  });

  it('shows its answer with the shape alone where the made node marks nothing', () => {
    const plain: KCall = { kind: 'call', handler: 'fetch', in: {} };
    const spec = lowerGuards(specOf('login', plain), [guardOf('login', 'one')], handlers());
    expect((spec.nodes.login as KCall).redact).toEqual({ out: [['password'], ['pin']] });
  });
});
