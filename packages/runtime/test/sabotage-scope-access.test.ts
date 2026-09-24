/**
 * Sabotage: who a scope may read, and what a view is behind. A scope decides whose rows a caller sees, so
 * what fills it is what the guard established about that caller -- a header, a route parameter or a query
 * string is the caller's own word for who they are, and a store scoped by one is scoped by nothing (A007).
 * A view is the one way across a scope, and every trigger that reaches one attaches the policy the view
 * names, under each profile whose binding reaches it (A008).
 *
 * The A family's half of RFC 0015's scoping rules; the C family's -- what a scope is well-formed as -- is
 * `sabotage-scoping.test.ts` beside this, and the two are split the way the rules are: a store may scope a
 * collection by a perfectly well-formed read of the wrong thing.
 *
 * The example scopes its customers by the session's tenant and reads the view behind employees-only, so it is
 * refused nothing as written; every case here breaks one document of it (`scoping-harness.ts`).
 */
import { describe, expect, it } from 'vitest';
import {
  DIGEST_TRIGGER,
  type Edits,
  POSTGRES_STORE,
  RESOLVERS,
  STORE,
  scopedCodes,
  scopedHinting,
  scopedPointing,
  scopedSaying,
} from './scoping-harness.js';

/** The read a scope is filled from, changed to one the caller chooses rather than one the guard established. */
const reading = (read: string): Edits => ({ [RESOLVERS]: doc => (doc.resolvers.tenant.read = read) });

describe('sabotage: who a scope may read', () => {
  it('A007 a scope read from a header or a route parameter', () => {
    // each of these is the caller's own word for who they are: a store scoped by one is scoped by nothing,
    // since the value arrives with the request and the caller wrote it. The body is not among them because
    // no kind of this example hands request.body, so P002 refuses such a resolver before a store can bind it
    for (const read of ["request.headers['x-tenant']", 'request.params.id', "request.query['tenant']"])
      expect(scopedCodes(reading(read))).toContain('A007');
  });
  it('A007 names the collections the read scopes and what the caller could do', () => {
    expect(scopedSaying(reading("request.headers['x-tenant']"))).toContain(
      'A007 scopes customers, and reads request.headers.x-tenant: a caller may send any value there',
    );
  });
  it('A007 offers the roots the guard hands, and the command that lists them', () => {
    expect(scopedHinting(reading('request.params.id'))).toContain(
      'A007 a scope reads what the guard hands once it identified the caller (request.principal, request.session, request.challenge); wilanis describe @auth/plugin.json',
    );
  });
  it('A007 points at the reads entry, since that is the line an author would change', () => {
    expect(scopedPointing(reading('request.params.id'))).toContain(
      'A007 @features/customers/data/customers.store.json#reads/tenant',
    );
  });
  it('A007 a tree that scopes a store and has no guard at all', () => {
    // nothing identified the caller, so there is nobody for a scope to be the scope of: the refusal is about
    // the project rather than the read, and says to add a guarding plugin
    const broken = {
      'project.json': (project: any) => {
        project.plugins = project.plugins.filter((one: any) => one.use !== '@auth');
      },
    };
    expect(scopedCodes(broken)).toContain('A007');
    expect(scopedSaying(broken)).toContain(
      "A007 'tenant' scopes customers, but no plugin of this project identifies callers",
    );
    expect(scopedHinting(broken)).toContain(
      'A007 add a guarding plugin to project.json → plugins, such as @wilanis/plugin-auth',
    );
  });
  it('A007 says nothing of a read the guard does hand', () => {
    // request.session is a key of the guard's context, so the example's own scope is not this rule's business
    expect(scopedCodes(reading('request.principal.subject'))).not.toContain('A007');
  });
  it('A007 says nothing of a store that scopes nothing, whatever it reads', () => {
    // a reads entry no scoped column fills is P005's business, not this rule's: A007 judges what a scope
    // reads, and a store with no scope has no caller to be wrong about. Both stores read the one resolver, so
    // both are left keeping the read and scoping nothing by it
    const scopingNothing = (store: any) => {
      delete store.collections.customers.scoped;
      delete store.collections.everyCustomer;
    };
    const codes = scopedCodes({
      [STORE]: scopingNothing,
      [POSTGRES_STORE]: scopingNothing,
      ...reading("request.headers['x-tenant']"),
    });
    expect(codes).not.toContain('A007');
    expect(codes).toContain('P005');
  });
});

/** The digest with the employees-only policy dropped: nothing then opens the view its listEvery reads. */
const UNGATED: Edits = { [DIGEST_TRIGGER]: doc => (doc.policies = []) };

/**
 * The finds behind listAll pointed at the view, under the one profile whose graph a case names: local binds
 * listAll to `kept-list`, production to `kept-list-postgres` over a store of its own, and live to a REST call. So
 * editing one makes the view reachable under that profile alone -- which is what judging A008 per profile is for:
 * the walk goes through the binding, so which graph, and so which collection, is reached is the profile's answer.
 */
const viewedUnder = (graph: string): Edits => ({
  [`features/customers/data/${graph}.graph.json`]: doc => {
    doc.nodes[0].in.collection = 'everyCustomer';
  },
});

/** The A008 messages a copy answers, which each end in the profile the crossing was found under. */
const a008 = (edits: Edits) => scopedSaying(edits).filter(one => one.startsWith('A008'));

describe('sabotage: what a view is behind', () => {
  it('A008 a trigger reaching a view that attaches no such policy', () => {
    expect(scopedPointing(UNGATED)).toContain('A008 @features/customers/edge/digest.trigger.json#policies');
  });
  it('A008 names the node, the view, the collection it views and the policy', () => {
    expect(scopedSaying(UNGATED)).toContain(
      "A008 reaches @features/customers/data/kept-list-every.graph.json#customers, which reads everyCustomer, a view of customers across every scope behind @access/edge/employees-only.policy.json, and attaches no such policy (profile 'local')",
    );
  });
  it('A008 offers the policy to attach, or the scoped collection to read instead', () => {
    expect(scopedHinting(UNGATED)).toContain(
      'A008 attach "@access/edge/employees-only.policy.json" under policies, or read customers',
    );
  });
  it('A008 is judged per profile: every profile whose binding reaches a view, and no other', () => {
    // local and the two production profiles bind listEvery to a find over each store's view; live binds it to a
    // REST call that reaches no store, so the dropped policy is owed under three profiles and live is not held to it
    const said = a008(UNGATED);
    expect(said.filter(one => one.endsWith("(profile 'local')"))).toHaveLength(1);
    expect(said.filter(one => one.endsWith("(profiles 'production', 'production-scheduler')"))).toHaveLength(1);
    expect(said.some(one => one.includes("'live'"))).toBe(false);
  });
  it('A008 points at the policies of every trigger that reaches it, not of the one that names it', () => {
    // the listing and the export both reach listAll: a view is crossed by whoever reaches it
    const pointing = scopedPointing(viewedUnder('kept-list'));
    expect(pointing).toContain('A008 @features/customers/edge/list-customers.trigger.json#policies');
    expect(pointing).toContain('A008 @features/customers/edge/export-customers.trigger.json#policies');
  });
  it('A008 names the profile of the one binding that reaches the view, from either side', () => {
    // only local binds listAll to kept-list, and only the production profiles to kept-list-postgres: the same
    // crossing is owed under the profiles whose graph makes it, rather than every profile being held to a gate one needs
    for (const [graph, profiles] of [
      ['kept-list', "profile 'local'"],
      ['kept-list-postgres', "profiles 'production', 'production-scheduler'"],
    ]) {
      const said = a008(viewedUnder(graph));
      expect(said.length).toBeGreaterThan(0);
      for (const one of said) expect(one.endsWith(`(${profiles})`)).toBe(true);
    }
  });
  it('A008 is answered by attaching the policy the view names, on the trigger that attaches it', () => {
    // the gate is per trigger and not per view: the listing is answered by attaching it, and the export
    // reaching the same node is refused until it attaches it too
    const gated: Edits = {
      ...viewedUnder('kept-list'),
      'features/customers/edge/list-customers.trigger.json': doc => {
        doc.policies.push({ ...doc.policies[0], policy: '@access/edge/employees-only.policy.json' });
      },
    };
    const pointing = scopedPointing(gated);
    expect(pointing).not.toContain('A008 @features/customers/edge/list-customers.trigger.json#policies');
    expect(pointing).toContain('A008 @features/customers/edge/export-customers.trigger.json#policies');
  });
});

describe('a site over a view types as the collection it views', () => {
  it('a find over a view answers the viewed shape, and earns its policy gate and nothing else', () => {
    // the view declares no `of`, so before the port hopped one a find over it answered unknown[] and the graph
    // earned G010 against its own out. The hop is the port document's word, read through `resolves`: nothing in
    // the compiler learns what a view is. The example's listEvery graphs are that find, and are refused nothing;
    // pointing a graph whose out was typed over customers at the view earns the way across and no more
    expect([...new Set(scopedCodes(viewedUnder('kept-list')))]).toEqual(['A008']);
  });
});
