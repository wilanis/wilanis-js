/**
 * What `after` lowers to (RFC 0041). A run or a map that says `after` waits for those nodes without reading them, and
 * the lowering copies the list onto the kernel node as it is written: on a call, on a map that runs, and on a map that
 * only keeps. A guard at a made site moves the made node aside to `<id>:made` whole, so its own `after` goes with it,
 * and a node that waits for `<id>` keeps naming `<id>`, which after lowering is the value the guard let through. In a
 * tree that passes none of this is a refusal, so the lowered spec is asked directly here.
 */
import { type AnyDoc, type Kind, type Loaded, type PluginModule, Registry, Scope } from '@wilanis/core';
import type { KCall, KMap } from '@wilanis/engine';
import { describe, expect, it } from 'vitest';
import { Compiler } from '../src/compiler.js';
import { guardsOf } from '../src/guard.js';

const CUSTOMER = '@features/customers/domain/Customer.shape.json';
const DRAFT = '@features/customers/domain/Draft.shape.json';
const GRAPH = '@features/customers/data/made.graph.json';
const MAKE = '@std/object.port.json#make';

const loaded = (kind: Kind, path: string, doc: unknown, native?: string): Loaded => ({
  kind,
  path,
  doc: doc as AnyDoc,
  name: path.slice(path.lastIndexOf('/') + 1).split('.')[0],
  ...(native ? { native } : { feature: 'customers', layer: path.includes('/data/') ? 'data' : 'domain' }),
});

const customer = { layer: 'core', fields: { name: { type: 'string' } } };
const draft = { layer: 'core', fields: { name: { type: 'string' }, tags: { type: 'string[]' } } };
const named = { label: 'Customers are named', holds: { on: CUSTOMER, when: 'len(name) > 0' } };
const object = {
  operations: {
    make: { accepts: { value: { type: '$T' }, type: { type: 'type', binds: '$T' } }, returns: '$T', pure: true },
  },
};
const outcome = {
  operations: {
    refuse: {
      accepts: {
        reason: { type: 'string', static: true },
        message: { type: 'string' },
        type: { type: 'type', binds: '$T' },
      },
      returns: '$T',
      refuses: true,
    },
  },
};

const run = (id: string, input: Record<string, unknown>, after?: string[]) => ({
  type: '@wilanis/node/run.schema.json',
  id,
  run: MAKE,
  in: input,
  ...(after ? { after } : {}),
});

/** A graph whose `customer` is a made site the invariant is unproved at, with a node on every side of a wait. */
const graph = {
  in: DRAFT,
  out: { type: CUSTOMER, from: 'customer' },
  nodes: [
    run('first', { value: '{{in.name}}', type: 'string' }),
    run('customer', { value: { name: '{{in.name}}' }, type: CUSTOMER }, ['first']),
    run('later', { value: '{{in.name}}', type: 'string' }, ['customer']),
    run('plain', { value: '{{in.name}}', type: 'string' }),
    {
      type: '@wilanis/node/map.schema.json',
      id: 'each',
      run: MAKE,
      over: '{{in.tags}}',
      bind: { value: '' },
      in: { type: 'string' },
      after: ['first'],
    },
    {
      type: '@wilanis/node/map.schema.json',
      id: 'kept',
      over: '{{in.tags}}',
      where: 'len(item) > 0',
      after: ['first'],
    },
  ],
};

/** A plugin that answers the two std operations a guard is built from; the lowering never calls them. */
const std = {
  handlers: { [MAKE]: async () => ({}), '@std/outcome.port.json#refuse': async () => ({}) },
} as unknown as PluginModule;

function compiled() {
  const registry = new Registry();
  registry.add(loaded('shape', CUSTOMER, customer));
  registry.add(loaded('shape', DRAFT, draft));
  registry.add(loaded('invariant', '@features/customers/domain/named.invariant.json', named));
  registry.add(loaded('port', '@std/object.port.json', object, 'std'));
  registry.add(loaded('port', '@std/outcome.port.json', outcome, 'std'));
  registry.add(loaded('graph', GRAPH, graph));
  const scope = new Scope(registry, ref => ref);
  return { scope, spec: new Compiler(scope, [std]).graph(GRAPH).spec };
}

describe('lowering after', () => {
  it('copies it onto a call, a map that runs and a map that only keeps, and adds none where none is written', () => {
    const { spec } = compiled();
    expect((spec.nodes.each as KMap).after).toEqual(['first']);
    expect((spec.nodes.kept as KMap).after).toEqual(['first']);
    expect((spec.nodes.kept as KMap).handler).toBeUndefined();
    expect((spec.nodes.later as KCall).after).toEqual(['customer']);
    expect(spec.nodes.plain).not.toHaveProperty('after');
  });

  it('keeps a made node its own after when a guard moves it aside, and a waiter on it waits for the guarded value', () => {
    const { scope, spec } = compiled();
    const made = scope.get('graph', GRAPH);
    expect(made && guardsOf(scope, made).map(guard => guard.id)).toEqual(['customer']);
    expect((spec.nodes['customer:made'] as KCall).after).toEqual(['first']);
    // `customer` is now what the guard let through: the waiter starts only once the rule held
    expect(spec.nodes.customer).not.toHaveProperty('after');
    expect((spec.nodes.later as KCall).after).toEqual(['customer']);
  });
});
