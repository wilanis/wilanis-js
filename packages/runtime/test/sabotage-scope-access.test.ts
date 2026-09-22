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
 * Every case starts from the example scoped by a tenant (`scoping-harness.ts`), since the example does not
 * scope its store until RFC 0015's step 10.
 */
import { describe, expect, it } from 'vitest';
import {
  type Edits,
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
    expect(scopedCodes()).not.toContain('A007');
    expect(scopedCodes(reading('request.principal.subject'))).not.toContain('A007');
  });
  it('A007 says nothing of a store that scopes nothing, whatever it reads', () => {
    // a reads entry no scoped column fills is P005's business, not this rule's: A007 judges what a scope
    // reads, and a store with no scope has no caller to be wrong about
    const codes = scopedCodes({
      [STORE]: store => {
        delete store.collections.customers.scoped;
      },
      ...reading("request.headers['x-tenant']"),
    });
    expect(codes).not.toContain('A007');
    expect(codes).toContain('P005');
  });
});

/** A view of the scoped customers, across every tenant, behind the policy the access tree declares for employees. */
const VIEW = {
  view: 'customers',
  behind: '@access/edge/employees-only.policy.json',
  description: 'the same rows, every tenant',
};

/**
 * A copy whose `listAll` reads the view under one profile only. The local profile binds `kept-list` and
 * production binds `kept-list-postgres`, against a store of its own, so editing the first makes the view
 * reachable under local and under no other profile -- which is what judging A008 per profile is for: the
 * walk goes through the binding, so which graph, and so which collection, is reached is the profile's answer.
 */
const viewedUnder = (graph: string): Edits => ({
  [STORE]: store => {
    store.collections.everyCustomer = { ...VIEW };
  },
  [`features/customers/data/${graph}.graph.json`]: doc => {
    doc.nodes[0].in.collection = 'everyCustomer';
  },
});

describe('sabotage: what a view is behind', () => {
  it('A008 a trigger reaching a view that attaches no such policy', () => {
    const codes = scopedCodes(viewedUnder('kept-list'));
    expect(codes).toContain('A008');
  });
  it('A008 names the node, the view, the collection it views and the policy', () => {
    expect(scopedSaying(viewedUnder('kept-list'))).toContain(
      "A008 reaches @features/customers/data/kept-list.graph.json#rows, which reads everyCustomer, a view of customers across every scope behind @access/edge/employees-only.policy.json, and attaches no such policy (profile 'local')",
    );
  });
  it('A008 offers the policy to attach, or the scoped collection to read instead', () => {
    expect(scopedHinting(viewedUnder('kept-list'))).toContain(
      'A008 attach "@access/edge/employees-only.policy.json" under policies, or read customers',
    );
  });
  it('A008 points at the policies of every trigger that reaches it', () => {
    // the digest, the export and the listing all reach listAll, and the nightly digest fires it on a schedule:
    // a view is crossed by whoever reaches it, not by whoever names it
    const pointing = scopedPointing(viewedUnder('kept-list'));
    expect(pointing).toContain('A008 @features/customers/edge/digest.trigger.json#policies');
    expect(pointing).toContain('A008 @features/customers/edge/list-customers.trigger.json#policies');
    expect(pointing).toContain('A008 @features/customers/edge/nightly-digest.trigger.json#policies');
  });
  it('A008 is judged per profile: it names the profile whose binding reaches the view, and no other', () => {
    // only local binds listAll to kept-list; live and production bind it to graphs that read the scoped
    // collection of another store. So the walk finds the crossing under local alone, and the message says so
    // rather than holding every profile to a gate only one of them needs
    const said = scopedSaying(viewedUnder('kept-list')).filter(one => one.startsWith('A008'));
    expect(said.length).toBeGreaterThan(0);
    for (const one of said) {
      expect(one).toContain("(profile 'local')");
      expect(one).not.toContain("'production'");
      expect(one).not.toContain("'live'");
    }
  });
  it('A008 says nothing under a profile whose binding reaches the scoped collection', () => {
    // the postgres binding meets listAll with a graph over a store this harness does not scope: nothing it
    // reaches is a view, so production earns no A008 however the local graph is written
    const codes = scopedCodes(viewedUnder('kept-list-postgres'));
    expect(codes).not.toContain('A008');
  });
  it('A008 is answered by attaching the policy the view names, on the trigger that attaches it', () => {
    // the gate is per trigger and not per view: the digest is answered by attaching it, and the other
    // triggers reaching the same node are refused until they attach it too
    const gated: Edits = {
      ...viewedUnder('kept-list'),
      'features/customers/edge/digest.trigger.json': doc => {
        doc.policies = ['@access/edge/employees-only.policy.json'];
      },
    };
    const pointing = scopedPointing(gated);
    expect(pointing).not.toContain('A008 @features/customers/edge/digest.trigger.json#policies');
    expect(pointing).toContain('A008 @features/customers/edge/list-customers.trigger.json#policies');
  });
  it('A008 says nothing of a trigger reaching the scoped collection rather than the view', () => {
    // the view is declared and nothing reads it: declaring a way across a scope is not taking it
    expect(
      scopedCodes({
        [STORE]: store => {
          store.collections.everyCustomer = { ...VIEW };
        },
      }),
    ).not.toContain('A008');
  });
});

describe('a site over a view types as the collection it views', () => {
  it('a find over a view answers the viewed shape, so the graph it feeds is typed', () => {
    // the view declares no `of`, so before the port hopped one a find over it answered unknown[] and the
    // graph earned G010 against its own out. The hop is the port document's word, read through `resolves`:
    // nothing in the compiler learns what a view is, and the whole change is which path store.port.json writes
    expect(scopedCodes(viewedUnder('kept-list'))).not.toContain('G010');
  });
  it('a view earns its policy gate and nothing else: the typing of the site is not a refusal', () => {
    // every refusal the planted view earns is about the way across the scope -- the policy a trigger must
    // attach, and the read it must guarantee -- and none is about what the rows are
    const codes = new Set(scopedCodes(viewedUnder('kept-list')));
    expect([...codes].sort()).toEqual(['A006', 'A008']);
  });
});
