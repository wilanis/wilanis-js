/**
 * What `wilanis describe` and `wilanis map` say about a scope: the read a store's column is filled from, how
 * far that scope reaches, where the value it trusts was decided, and which crossings of it a trigger makes.
 *
 * None of it is a judgement. `sabotage-scope-access.test.ts` beside this holds the rules that refuse a bad
 * scope (A007, A008); these cases hold what a reader is told about a good one, which is the other half of the
 * same promise: a rule the checker enforces and no command shows is a rule an author meets only as a refusal.
 *
 * Split from `tools.test.ts`, which holds the commands themselves: these are one family over one fixture, and
 * the file they came from is at the length the house rules allow. The example does not scope its store yet --
 * that is RFC 0015's step 10 -- so every case reads the scoped copy `scoping-harness.ts` plants, and the ones
 * about a view or a sign-in write plant that too.
 */
import { fileURLToPath } from 'node:url';
import { loadTree, type ResolvedInclude } from '@wilanis/core';
import auth from '@wilanis/plugin-auth';
import blobs from '@wilanis/plugin-blob';
import http from '@wilanis/plugin-http';
import otel from '@wilanis/plugin-otel';
import reload from '@wilanis/plugin-reload';
import schedule from '@wilanis/plugin-schedule';
import storage from '@wilanis/plugin-storage';
import memory from '@wilanis/plugin-storage-memory';
import postgres from '@wilanis/plugin-storage-postgres';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, describe as describeDoc, map } from '../src/index.js';
import { type Edits, scopedTree } from './scoping-harness.js';

const EXAMPLE = fileURLToPath(new URL('../../../example', import.meta.url));
/** The tree the example includes, as the runtime would resolve it from the example's node_modules. */
const INCLUDES: ResolvedInclude[] = [
  {
    from: '@wilanis/access',
    dir: fileURLToPath(new URL('../../../libraries/access', import.meta.url)),
    features: ['access'],
  },
];
const PLUGINS = {
  ...BUILTIN_PLUGINS,
  '@http': http,
  '@blob': blobs,
  '@reload': reload,
  '@auth': auth,
  '@schedule': schedule,
  '@storage': storage,
  '@storage-memory': memory,
  '@storage-postgres': postgres,
  '@otel': otel,
};

/** The view of the scoped entries, across every tenant, behind the policy the access tree declares. */
const VIEW = {
  view: 'entries',
  behind: '@access/edge/employees-only.policy.json',
  description: 'the same rows, every tenant’s: the digest, for employees',
};
/** A copy whose digest reads that view, since a view is reached only where a graph names it. */
const VIEWED: Edits = {
  'features/customers/data/customers.store.json': (store: any) => {
    store.collections.everyEntry = { ...VIEW };
  },
  'features/customers/data/kept-list.graph.json': (graph: any) => {
    graph.nodes[0].in.collection = 'everyEntry';
  },
};
/** The sign-in writing the attribute the scope reads, so the store can name where the value was decided. */
const SIGN_IN: Edits = {
  'features/access/domain/sign-in-customer.graph.json': (graph: any) => {
    for (const node of graph.nodes) if (node.in?.attributes) node.in.attributes.tenant = '{{checked.identity.name}}';
  },
};
/** The store of a scoped copy, said in full, with whatever further edits a case asks of either tree. */
const storeSaid = (edits: Edits = {}, access: Edits = {}) =>
  scopedTree(load => describeDoc(load, '@customers/data/customers.store.json'), edits, access);

describe('wilanis describe and map: the scope a store keeps its rows under', () => {
  it('prints the reads block above the collections, so no {{name}} is met before what binds it', () => {
    const lines = storeSaid().split('\n');
    expect(lines).toContain(
      '    tenant ← @customers/edge/request.resolvers.json#tenant  (request.session.attributes.tenant, required)',
    );
    expect(lines.indexOf('reads:')).toBeLessThan(lines.findIndex(line => line.startsWith('  collection entries')));
  });

  it('names the column, the read that fills it, and how many triggers guarantee that read', () => {
    // the count is what a reader measures the scope's reach by; the policies say which gates stand in the way
    expect(storeSaid()).toMatch(/ {4}scoped by {3}tenant ← \{\{tenant}} {2}\(guaranteed at \d+ trigger\(s\) by .+\)/);
  });

  it('names the policies of the reaching triggers that prove the read, by their labels', () => {
    expect(storeSaid()).toContain('Employees only');
  });

  it('says where the value a scope trusts was written, since a sign-in decided it once', () => {
    expect(storeSaid({}, SIGN_IN)).toContain(
      '                written at sign-in by @features/access/domain/sign-in-customer.graph.json#issued',
    );
  });

  it('prints no sign-in line where nothing writes the attribute, rather than an empty one', () => {
    expect(storeSaid()).not.toContain('written at sign-in by');
  });

  it("says a scoped collection's unique constraints hold within the scope", () => {
    // two tenants may record the same call: the engine puts the scope columns into every constraint
    expect(storeSaid()).toContain('    unique      [url, method]  (within the scope)');
  });

  it('leaves an unscoped store reading exactly as it did before scoping existed', () => {
    const said = describeDoc(loadTree(EXAMPLE, PLUGINS, INCLUDES), '@customers/data/customers.store.json');
    expect(said).toContain('    unique      [url, method]\n');
    expect(said).not.toContain('scoped by');
    expect(said).not.toContain('reads:');
  });

  it('says of a view whose rows it sees and the policy every trigger reaching it attaches, on one line', () => {
    expect(storeSaid(VIEWED)).toContain(
      '  collection everyEntry: view of entries, behind @access/edge/employees-only.policy.json',
    );
  });

  it('tells a reader of the resolvers document that a store binds the read, and what it scopes', () => {
    const said = scopedTree(load => describeDoc(load, '@customers/edge/request.resolvers.json'));
    expect(said).toContain(
      '        used by @features/customers/data/customers.store.json as {{tenant}}  (scopes entries)',
    );
  });

  it('prints the scope a storage node carries under it, which the graph document does not write', () => {
    const said = scopedTree(load => describeDoc(load, '@customers/data/kept-get.graph.json')).split('\n');
    const node = said.indexOf('    asked  @storage/store.port.json#get');
    expect(said[node + 1]).toBe('        scope tenant ← {{tenant}} of @features/customers/data/customers.store.json');
  });

  it('prints no scope under a newKey, whose key is global to the table whatever the scope', () => {
    const said = scopedTree(load => describeDoc(load, '@customers/data/store-and-latest.graph.json')).split('\n');
    const key = said.indexOf('    key  @storage/store.port.json#newKey');
    expect(said[key + 1]).not.toContain('scope tenant');
  });

  it('prints no scope under a node over a collection that keeps its rows for everyone', () => {
    const said = scopedTree(load => describeDoc(load, '@customers/data/store-and-latest.graph.json')).split('\n');
    const latest = said.lastIndexOf('    latest  @storage/store.port.json#put');
    expect(said[latest + 1]).not.toContain('scope tenant');
  });

  it('tells a reader of a trigger which views it reaches and that each carries the view’s policy', () => {
    const said = scopedTree(load => describeDoc(load, '@customers/edge/digest.trigger.json'), {
      ...VIEWED,
      'features/customers/edge/digest.trigger.json': (doc: any) => {
        doc.policies = ['@access/edge/employees-only.policy.json'];
      },
    });
    expect(said).toContain('reaches everyEntry (a view) behind @access/edge/employees-only.policy.json: attached');
  });

  it('says so where a trigger reaches a view and attaches no such policy, naming the rule that refuses it', () => {
    const said = scopedTree(load => describeDoc(load, '@customers/edge/digest.trigger.json'), VIEWED);
    expect(said).toContain(
      'reaches everyEntry (a view) behind @access/edge/employees-only.policy.json: not attached -- wilanis check refuses this (A008)',
    );
  });

  it('marks a scoped storage line of the map, so a reader sees whose rows a run ends at', () => {
    const lines = scopedTree(load => map(load));
    expect(lines.some(line => line.includes('entries (get), scoped by tenant'))).toBe(true);
  });

  it('marks no map line over an unscoped collection', () => {
    const lines = scopedTree(load => map(load));
    expect(lines.some(line => line.includes('latest (put), scoped by'))).toBe(false);
  });
});
