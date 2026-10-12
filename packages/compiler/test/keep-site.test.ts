/**
 * A map that only keeps is no site (RFC 0039). It makes no value: each element it answers is an element of the list
 * it was handed, judged where that list was made. In a tree that passes, a keep lowering no guard looks the same as a
 * site whose rule was proved, so the site list is asked directly here, beside a map that runs `make` over the same
 * list, which is a site and carries the guard.
 */
import { type AnyDoc, type Kind, type Loaded, Registry, Scope } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { guardsOf } from '../src/guard.js';
import { siteId, sitesOf } from '../src/sites.js';

const CUSTOMER = '@features/customers/domain/Customer.shape.json';
const ROSTER = '@features/customers/domain/Roster.shape.json';
const DIGEST = '@features/customers/domain/digest.graph.json';

const loaded = (kind: Kind, path: string, doc: unknown, native?: string): Loaded => ({
  kind,
  path,
  doc: doc as AnyDoc,
  name: path.slice(path.lastIndexOf('/') + 1).split('.')[0],
  ...(native ? { native } : { feature: 'customers', layer: 'domain' }),
});

const customer = {
  layer: 'core',
  fields: { name: { type: 'string' }, active: { type: 'boolean', required: false } },
};
const roster = { layer: 'core', fields: { all: { type: `${CUSTOMER}[]` } } };
const named = { label: 'Customers are named', holds: { on: CUSTOMER, when: 'len(name) > 0' } };
const object = {
  operations: {
    make: {
      accepts: { value: { type: '$T' }, type: { type: 'type', binds: '$T' } },
      returns: '$T',
      pure: true,
    },
  },
};
const digest = {
  in: ROSTER,
  nodes: [
    {
      type: '@wilanis/node/map.schema.json',
      id: 'active',
      over: '{{in.all}}',
      where: 'has(item.active) && item.active == true',
    },
    {
      type: '@wilanis/node/map.schema.json',
      id: 'remade',
      run: '@std/object.port.json#make',
      over: '{{in.all}}',
      bind: { value: '' },
      in: { type: CUSTOMER },
    },
  ],
};

/** A tree of the one graph, the shapes it reads, the invariant over customers, and the port `make` is on. */
function scope(): Scope {
  const registry = new Registry();
  registry.add(loaded('shape', CUSTOMER, customer));
  registry.add(loaded('shape', ROSTER, roster));
  registry.add(loaded('invariant', '@features/customers/domain/named.invariant.json', named));
  registry.add(loaded('port', '@std/object.port.json', object, 'std'));
  registry.add(loaded('graph', DIGEST, digest));
  return new Scope(registry, ref => ref);
}

describe('a map that only keeps', () => {
  it('is no site of the shape it keeps, where a map making the same list is one', () => {
    expect(sitesOf(scope(), CUSTOMER).map(siteId)).toEqual(['remade']);
  });

  it('lowers no guard, where the map that makes the list is guarded', () => {
    const tree = scope();
    const graph = tree.registry.get('graph', DIGEST);
    expect(graph && guardsOf(tree, graph).map(guard => guard.id)).toEqual(['remade']);
  });
});
