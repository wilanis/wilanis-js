/**
 * What `wilanis describe` and `wilanis map` say about a scope: the read a store's column is filled from, how
 * far that scope reaches, where the value it trusts was decided, and which crossings of it a trigger makes.
 *
 * None of it is a judgement. `sabotage-scope-access.test.ts` beside this holds the rules that refuse a bad
 * scope (A007, A008); these cases hold what a reader is told about a good one, which is the other half of the
 * same promise: a rule the checker enforces and no command shows is a rule an author meets only as a refusal.
 *
 * Split from `tools.test.ts`, which holds the commands themselves: these are one family over one fixture, and
 * the file they came from is at the length the house rules allow. The example keeps its customers per tenant,
 * so every case reads it as written; the ones about what an unscoped store, an ungated view or a sign-in that
 * writes nothing reads as edit a copy (`scoping-harness.ts`).
 */
import { loadTree } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { describe as describeDoc, map } from '../src/index.js';
import { EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';
import { DIGEST_TRIGGER, type Edits, scopedTree, UNSCOPED } from './scoping-harness.js';

/** The example as written, loaded once: every case that edits nothing reads this. */
const EXAMPLE_TREE = loadTree(EXAMPLE, PLUGINS, INCLUDES);
/** The sign-ins with the attribute the scope reads left unwritten, so the store has no sign-in to name. */
const UNWRITTEN: Edits = Object.fromEntries(
  ['customer', 'employee'].map(realm => [
    `features/access/domain/sign-in-${realm}.graph.json`,
    (graph: any) => {
      for (const node of graph.nodes) if (node.in?.attributes) delete node.in.attributes.tenant;
    },
  ]),
);
/** The store said in full: of the example as written, or of a copy with whatever edits a case asks of either tree. */
const storeSaid = (edits?: Edits, access?: Edits) =>
  edits || access
    ? scopedTree(load => describeDoc(load, '@customers/data/customers.store.json'), edits, access)
    : describeDoc(EXAMPLE_TREE, '@customers/data/customers.store.json');
/** One document of the example as written, said in full and split into its lines. */
const linesOf = (path: string) => describeDoc(EXAMPLE_TREE, path).split('\n');

describe('wilanis describe and map: the scope a store keeps its rows under', () => {
  it('prints the reads block above the collections, so no {{name}} is met before what binds it', () => {
    const lines = storeSaid().split('\n');
    expect(lines).toContain(
      '    tenant ← @customers/edge/request.resolvers.json#tenant  (request.session.attributes.tenant, required)',
    );
    expect(lines.indexOf('reads:')).toBeLessThan(lines.findIndex(line => line.startsWith('  collection customers')));
  });

  it('names the column, the read that fills it, and how many triggers guarantee that read', () => {
    // the count is what a reader measures the scope's reach by; the policies say which gates stand in the way
    expect(storeSaid()).toMatch(/ {4}scoped by {3}tenant ← \{\{tenant}} {2}\(guaranteed at \d+ trigger\(s\) by .+\)/);
  });

  it('names the policies of the reaching triggers that prove the read, by their labels', () => {
    // signed-in gates the reads a customer makes, employees-only the writes and the digest
    expect(storeSaid()).toContain('Signed in');
    expect(storeSaid()).toContain('Employees only');
  });

  it('says where the value a scope trusts was written, since a sign-in decided it once', () => {
    // both sign-ins write it: a customer's from the directory, an employee's as the operator's own
    expect(storeSaid()).toContain(
      '                written at sign-in by @features/access/domain/sign-in-customer.graph.json#issued, @features/access/domain/sign-in-employee.graph.json#issued',
    );
  });

  it('prints no sign-in line where nothing writes the attribute, rather than an empty one', () => {
    expect(storeSaid({}, UNWRITTEN)).not.toContain('written at sign-in by');
  });

  it("says a scoped collection's unique constraints hold within the scope", () => {
    // two tenants may record the same call: the engine puts the scope columns into every constraint
    expect(storeSaid()).toContain('    unique      [email]  (within the scope)');
  });

  it('leaves an unscoped store reading exactly as it did before scoping existed', () => {
    const said = storeSaid(UNSCOPED);
    expect(said).toContain('    unique      [email]\n');
    expect(said).not.toContain('scoped by');
    expect(said).not.toContain('reads:');
  });

  it('says of a view whose rows it sees and the policy every trigger reaching it attaches, on one line', () => {
    expect(storeSaid()).toContain(
      '  collection everyCustomer: view of customers, behind @access/edge/employees-only.policy.json',
    );
  });

  it('tells a reader of the resolvers document that a store binds the read, and what it scopes', () => {
    const said = describeDoc(EXAMPLE_TREE, '@customers/edge/request.resolvers.json');
    expect(said).toContain(
      '        used by @features/customers/data/customers.store.json as {{tenant}}  (scopes customers)',
    );
  });

  it('prints the scope a storage node carries under it, which the graph document does not write', () => {
    const said = linesOf('@customers/data/kept-get.graph.json');
    const node = said.indexOf('    storedCustomer  @storage/store.port.json#get');
    expect(said[node + 1]).toBe('        scope tenant ← {{tenant}} of @features/customers/data/customers.store.json');
  });

  it('prints no scope under a newKey, whose key is global to the table whatever the scope', () => {
    const said = linesOf('@customers/data/store-and-latest.graph.json');
    const key = said.indexOf('    key  @storage/store.port.json#newKey');
    expect(said[key + 1]).not.toContain('scope tenant');
  });

  it('prints no scope under a node over a collection that keeps its rows for everyone', () => {
    const said = linesOf('@customers/data/store-and-latest.graph.json');
    const latest = said.lastIndexOf('    latest  @storage/store.port.json#put');
    expect(said[latest + 1]).not.toContain('scope tenant');
  });

  it('tells a reader of a trigger which views it reaches and that each carries the view’s policy', () => {
    // the digest reads every tenant's customers through the view, and attaches employees-only to do so
    const said = describeDoc(EXAMPLE_TREE, '@customers/edge/digest.trigger.json');
    expect(said).toContain('reaches everyCustomer (a view) behind @access/edge/employees-only.policy.json: attached');
  });

  it('says so where a trigger reaches a view and attaches no such policy, naming the rule that refuses it', () => {
    const said = scopedTree(load => describeDoc(load, '@customers/edge/digest.trigger.json'), {
      [DIGEST_TRIGGER]: (doc: any) => (doc.policies = []),
    });
    expect(said).toContain(
      'reaches everyCustomer (a view) behind @access/edge/employees-only.policy.json: not attached -- wilanis check refuses this (A008)',
    );
  });

  it('marks a scoped storage line of the map, so a reader sees whose rows a run ends at', () => {
    const lines = map(EXAMPLE_TREE);
    expect(lines.some(line => line.includes('customers (get), scoped by tenant'))).toBe(true);
  });

  it('marks no map line over an unscoped collection', () => {
    const lines = map(EXAMPLE_TREE);
    expect(lines.some(line => line.includes('latest (put), scoped by'))).toBe(false);
  });
});
