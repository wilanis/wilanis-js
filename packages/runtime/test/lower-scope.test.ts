/**
 * What a scope lowers to. A store says which columns it keeps beside a collection and the read that fills
 * each, and the compiler carries them to every storage site over it, so no document writes a scope and none
 * can forget one (RFC 0015). These read the kernel spec rather than the refusals: the claim is not that a
 * tree is refused but that what runs carries the read, and that nothing else about the spec moved.
 *
 * The example keeps its customers unscoped until RFC 0015 step 10, so every case here compiles a scoped copy
 * of it -- the one `scoping-harness` makes -- and the unscoped example beside it says what did not change.
 */
import { Compiler } from '@wilanis/compiler';
import { type LoadResult, loadTree, type PluginModule, Scope } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';
import { scopedTree } from './scoping-harness.js';

/** What the store's one read lowers to: the session attribute the sign-in wrote, read off what the guard hands. */
const tenant = { ref: 'request', path: ['session', 'attributes', 'tenant'] };
/** The binding whose operations a case plants a delegation in, to reach the other shape a site takes. */
const binding = 'features/customers/data/customers-store.binding.json';
const modules = Object.values(PLUGINS) as PluginModule[];

const compilerOf = (load: LoadResult, profile?: string) =>
  new Compiler(new Scope(load.registry, load.resolve), modules, { profile });
const nodesOf = (graph: string) => scopedTree(load => compilerOf(load).graph(graph).spec.nodes as Record<string, any>);
const plainNodesOf = (graph: string) =>
  compilerOf(loadTree(EXAMPLE, PLUGINS, INCLUDES)).graph(graph).spec.nodes as Record<string, any>;

describe('the scope the lowering fills, which no document writes', () => {
  it('carries the store read to a site over a scoped collection, and adds no node for it', () => {
    // `asked` is written with a store, a collection and a key and nothing else; the scope is the compiler's,
    // and it is exactly what lowerRef makes of {{tenant}} on a graph
    const nodes = nodesOf('@features/customers/data/kept-get.graph.json');
    expect(nodes.asked.in.scope).toEqual({ object: { tenant } });
    // the site's own inputs are untouched beside it
    expect(nodes.asked.in.key).toEqual({ ref: 'in', path: ['id'] });
    // and not one node more than the same graph lowers to unscoped: a scope is a source, never a step
    const plain = plainNodesOf('@features/customers/data/kept-get.graph.json');
    expect(Object.keys(nodes).sort()).toEqual(Object.keys(plain).sort());
  });
  it('carries none to a site over a collection the store does not scope', () => {
    // one graph, two collections of one store: customers is scoped and latest is not, and each site answers
    // for itself, so a scope is per collection and never per store
    const nodes = nodesOf('@features/customers/data/store-and-latest.graph.json');
    expect(nodes.stored.in.scope).toEqual({ object: { tenant } });
    expect(nodes.latest.in.scope).toBeUndefined();
    // and newKey takes none, because it declares none: a key is global to the table whatever the scope
    expect(nodes.key.in.scope).toBeUndefined();
  });
  it('carries none where nothing is scoped, so a tree that scopes nothing lowers as it did', () => {
    // the example itself, whose store declares no scoped column: the same graph, and no scope on its site
    expect(plainNodesOf('@features/customers/data/kept-get.graph.json').asked.in.scope).toBeUndefined();
  });
  it('carries the read a binding delegation names, since a delegation is a site like any other', () => {
    // the example meets every read with a data graph, so this plants the other shape a site takes: listAll
    // met by a run over the store itself, which is a call site with no graph around it
    const spec = scopedTree(
      load => compilerOf(load, 'local').operation('@customers/domain/customer.port.json#listAll').spec,
      {
        [binding]: (doc: any) => {
          doc.operations.listAll = {
            run: '@storage/store.port.json#find',
            in: { store: '@customers/data/customers.store.json', collection: 'customers' },
          };
        },
      },
    );
    expect((spec.nodes.op as any).in.scope).toEqual({ object: { tenant } });
  });
});
