/**
 * Sabotage: what a tree earns for how a store is scoped. A store binds the reads its collections are scoped
 * by the way a data graph binds one (P004, P005, R001, L005); a `scoped` column is a column the store keeps
 * and exactly one of those reads, required and holding one value (C012); a view sees every row of one scoped
 * collection of this store, behind a policy (C013, R001). And once a collection is scoped, the rules that
 * already judge a read judge this one: A006 holds every trigger reaching the collection to guaranteeing the
 * read, and B008 refuses a startup step that reaches it at all. What a document may say about a scope is
 * @storage's: X214 refuses a site that writes one, and X208 already refuses a `where` naming the column,
 * since a scope is a column the store keeps and not a field of the shape.
 *
 * Who a scope may read and what a view is behind are the A family's, and are `sabotage-scope-access.test.ts`
 * beside this: the same split the rules themselves take, since a scope that is well-formed and reads a header
 * is a well-formed store that scopes by nothing.
 *
 * Every case starts from the example scoped by a tenant (`scoping-harness.ts`), since the example does not
 * scope its store until RFC 0015's step 10.
 */
import { describe, expect, it } from 'vitest';
import {
  GET,
  LIST,
  RESOLVERS,
  SESSION,
  STORE,
  scopedCodes,
  scopedHinting,
  scopedPointing,
  scopedSaying,
  WRITE,
} from './scoping-harness.js';

describe('sabotage: how a store is scoped', () => {
  it('A006 every trigger reaching the scoped collection, and B008 the startup step that reads it', () => {
    // the scope edge is the whole of step 2: no document of the example names the request here, and the read
    // reaches these triggers because the compiler carries the store's read to every site over the collection
    const codes = scopedCodes();
    expect(new Set(codes)).toEqual(new Set(['A006', 'B008']));
    expect(scopedSaying()).toContain(
      "A006 @features/customers/data/customers.store.json reads request.session.attributes.tenant as required, but trigger kind '@http/http.trigger-kind.json' hands it only sometimes and no policy of this trigger proves it (profile 'local')",
    );
    expect(scopedPointing()).toContain('A006 @features/customers/edge/get-customer.trigger.json#policies');
  });
  it('A006 names the read the store made, and offers the policy that would prove it', () => {
    expect(scopedHinting()).toContain(
      'A006 gate this trigger with a policy whose proves lists "request.session.attributes.tenant", or drop required from the resolver and route around its absence',
    );
  });
  it('B008 points at the startup step that reaches the scoped collection', () => {
    // step 2 is listAll, bound to the graph that finds over customers: a startup step runs before anything is
    // received, so a scoped collection is unreachable from it by construction
    expect(scopedPointing()).toContain('B008 @project.json#startup/2/run');
    expect(scopedSaying()).toContain(
      "B008 startup step 2: @features/customers/data/customers.store.json reads request.session.attributes.tenant, but a startup step runs before anything is received (profile 'local')",
    );
  });
  it('C012 a scope that is a literal, an interpolation, or a field of a read', () => {
    for (const value of ['acme', '{{tenant}}-eu', 'in {{tenant}}', '{{tenant.id}}', '{{in.tenant}}'])
      expect(scopedCodes({ [STORE]: store => (store.collections.customers.scoped.tenant = value) })).toContain('C012');
  });
  it('C012 says a literal is not a read, and writes the two entries that would make one', () => {
    expect(scopedSaying({ [STORE]: store => (store.collections.customers.scoped.tenant = 'acme') })).toContain(
      "C012 'acme' is not a read; a scope is exactly one resolver the store binds under reads",
    );
    expect(scopedHinting({ [STORE]: store => (store.collections.customers.scoped.tenant = 'acme') })).toContain(
      'C012 write "scoped": { "tenant": "{{tenant}}" } and bind tenant: "reads": { "tenant": "@<feature>/edge/<file>.resolvers.json#tenant" }',
    );
  });
  it('C012 a scope reading a name the store does not bind', () => {
    expect(scopedPointing({ [STORE]: store => (store.collections.customers.scoped.tenant = '{{agent}}') })).toContain(
      'C012 @features/customers/data/customers.store.json#collections/customers/scoped/tenant',
    );
    expect(scopedSaying({ [STORE]: store => (store.collections.customers.scoped.tenant = '{{agent}}') })).toContain(
      "C012 'agent' is not a read this store binds (reads: tenant)",
    );
  });
  it('C012 a scope naming a field of the collection shape', () => {
    // email is a field of Customer: a scope is a column the store keeps beside the record, never the record's own,
    // since a field is written by whatever made it and could have come from the caller
    expect(
      scopedSaying({
        [STORE]: store => {
          store.collections.customers.scoped = { email: '{{tenant}}' };
        },
      }),
    ).toContain(
      "C012 'email' is a field of @customers/domain/Customer.shape.json, and a scope is a column the store keeps beside the record",
    );
  });
  it('C012 a scope whose resolver is not required', () => {
    expect(scopedSaying({ [RESOLVERS]: doc => delete doc.resolvers.tenant.required })).toContain(
      "C012 the read '{{tenant}}' is not declared required, and a scope is read as present",
    );
  });
  it('C012 a scope reading a list, and one reading an open object, which types unknown', () => {
    expect(scopedSaying({ [RESOLVERS]: doc => (doc.resolvers.tenant.read = 'request.principal.roles') })).toContain(
      "C012 the read '{{tenant}}' is request.principal.roles, which is string[], and a column holds a string or a number",
    );
    expect(
      scopedCodes({ [RESOLVERS]: doc => (doc.resolvers.tenant.read = 'request.principal.claims.tenant') }),
    ).toContain('C012');
  });
  it('C012 a session attribute of a tree whose guard names no session shape reads unknown', () => {
    // the attribute is typed by the shape settings.session binds to $Session; without one it is unknown, and
    // a column holds one value it can name the type of
    const codes = scopedCodes({
      'project.json': project => {
        const auth = project.plugins.find((one: any) => one.use === '@auth');
        delete auth.settings.session;
      },
    });
    expect(codes).toContain('C012');
  });
  it('C012 points at the column, so an author is answered about the one they wrote', () => {
    expect(
      scopedPointing({
        [STORE]: store => {
          store.reads.owner = '@customers/edge/request.resolvers.json#agent';
          store.collections.customers.scoped.owner = '{{owner}}';
        },
      }),
    ).toContain('C012 @features/customers/data/customers.store.json#collections/customers/scoped/owner');
  });
  it('P004 a reads entry naming no resolver of the document it names', () => {
    expect(
      scopedCodes({ [STORE]: store => (store.reads.tenant = '@customers/edge/request.resolvers.json#nope') }),
    ).toContain('P004');
  });
  it('R001 a reads entry naming a resolvers document the tree does not have', () => {
    expect(
      scopedCodes({ [STORE]: store => (store.reads.tenant = '@customers/edge/nope.resolvers.json#tenant') }),
    ).toContain('R001');
  });
  it('P005 a reads entry no scoped collection of the store reads', () => {
    // reads is exactly what this document reads, on a store as on a graph and a binding (RFC 0029)
    const broken = { [STORE]: (store: any) => (store.reads.agent = '@customers/edge/request.resolvers.json#agent') };
    expect(scopedCodes(broken)).toContain('P005');
    expect(scopedSaying(broken)).toContain("P005 'agent' is read by no scoped collection of this store");
    expect(
      scopedHinting({ [STORE]: store => (store.reads.agent = '@customers/edge/request.resolvers.json#agent') }),
    ).toContain(
      'P005 scope a collection by it as "scoped": { "<column>": "{{agent}}" }, or drop the entry: reads is exactly what this document reads',
    );
  });
  it('P005 points at the entry nothing reads, not at the collection', () => {
    expect(
      scopedPointing({ [STORE]: store => (store.reads.agent = '@customers/edge/request.resolvers.json#agent') }),
    ).toContain('P005 @features/customers/data/customers.store.json#reads/agent');
  });
  it('C013 a view of a collection this store does not declare', () => {
    const broken = {
      [STORE]: (store: any) => {
        store.collections.everyCustomer = { view: 'nope', behind: '@access/edge/employees-only.policy.json' };
      },
    };
    expect(scopedCodes(broken)).toContain('C013');
    expect(scopedSaying(broken)).toContain(
      "C013 'nope' is not a collection of this store (collections: customers, latest, everyCustomer)",
    );
    expect(scopedPointing(broken)).toContain(
      'C013 @features/customers/data/customers.store.json#collections/everyCustomer/view',
    );
  });
  it('C013 a view of a view', () => {
    const broken = {
      [STORE]: (store: any) => {
        store.collections.everyCustomer = { view: 'customers', behind: '@access/edge/employees-only.policy.json' };
        store.collections.everyCustomerToo = {
          view: 'everyCustomer',
          behind: '@access/edge/employees-only.policy.json',
        };
      },
    };
    expect(scopedCodes(broken)).toContain('C013');
    expect(scopedSaying(broken)).toContain(
      "C013 'everyCustomer' is itself a view of 'customers', and a view sees a collection of records",
    );
  });
  it('C013 a view of a collection that declares no scope', () => {
    // latest keeps records and is not scoped: there is no scope to cross, so a view of it sees nothing more
    const broken = {
      [STORE]: (store: any) => {
        store.collections.everyLatest = { view: 'latest', behind: '@access/edge/employees-only.policy.json' };
      },
    };
    expect(scopedCodes(broken)).toContain('C013');
    expect(scopedSaying(broken)).toContain(
      "C013 'latest' declares no scoped columns, so every row of it is seen already",
    );
    expect(scopedHinting(broken)).toContain(
      'C013 scope the collection this views, or read it directly: a view is the way across a scope',
    );
  });
  it('R001 a view behind a policy the tree does not have', () => {
    expect(
      scopedPointing({
        [STORE]: store => {
          store.collections.everyCustomer = { view: 'customers', behind: '@access/edge/nope.policy.json' };
        },
      }),
    ).toContain('R001 @features/customers/data/customers.store.json#collections/everyCustomer/behind');
  });
  it('a view of a scoped collection, behind a policy, is refused nothing of its own', () => {
    // nothing here reads it yet -- A0n2 is step 3's -- so what a well-formed view earns is A006 and B008 and
    // no more: the view declares no scope, and the collection it views is scoped as before
    const codes = scopedCodes({
      [STORE]: store => {
        store.collections.everyCustomer = {
          view: 'customers',
          behind: '@access/edge/employees-only.policy.json',
          description: 'the same rows, every tenant',
        };
      },
    });
    expect(new Set(codes)).toEqual(new Set(['A006', 'B008']));
  });
  it('X214 a scope written by hand on the site the compiler fills: the M12 demo, refused', () => {
    // "the agent added the filter by hand" is the one thing a scope makes unwriteable: the store says how
    // customers are scoped, the compiler carries it to every site, and a document that repeats it is refused
    const broken = {
      [GET]: (graph: any) => {
        graph.nodes[0].in.scope = { tenant: '{{in.id}}' };
      },
    };
    expect(scopedCodes(broken)).toContain('X214');
    expect(scopedPointing(broken)).toContain('X214 @features/customers/data/kept-get.graph.json#nodes/asked/in/scope');
    expect(scopedSaying(broken)).toContain(
      "X214 scope is the store's: 'customers' is scoped by tenant ← {{tenant}} of @customers/data/customers.store.json, and the compiler puts it here",
    );
    expect(scopedHinting(broken)).toContain(
      'X214 drop "scope": to change how \'customers\' is scoped, change @customers/data/customers.store.json',
    );
  });
  it('X214 a scope on the find over a view, which sees every row whatever a site says', () => {
    const broken = {
      [STORE]: (store: any) => {
        store.collections.everyCustomer = { view: 'customers', behind: '@access/edge/employees-only.policy.json' };
      },
      [LIST]: (graph: any) => {
        graph.nodes[0].in.collection = 'everyCustomer';
        graph.nodes[0].in.scope = { tenant: 'acme' };
      },
    };
    expect(scopedCodes(broken)).toContain('X214');
    expect(scopedSaying(broken)).toContain("X214 'everyCustomer' is a view of 'customers', and a view sees every row");
    expect(scopedHinting(broken)).toContain('X214 drop "scope": read \'customers\' where a scope is meant');
  });
  it('X214 a scope on newKey, which mints a key across every scope and takes none', () => {
    // a key is global: one tenant is never handed a key another already holds, so there is no scope to mint
    // one under, and the port declares no `scope` on the operation at all
    const broken = {
      [WRITE]: (graph: any) => {
        graph.nodes[0].in.scope = { tenant: 'acme' };
      },
    };
    expect(scopedCodes(broken)).toContain('X214');
    expect(scopedPointing(broken)).toContain(
      'X214 @features/customers/data/store-and-latest.graph.json#nodes/key/in/scope',
    );
  });
  it("X208 a where naming the scope column: a scope is the store's column, never a field to filter on", () => {
    // the column is not a field of Customer, so the filter names something the shape does not have -- which is
    // what X208 already says, and is why a scope needs no filter rule of its own
    const broken = {
      [LIST]: (graph: any) => {
        graph.nodes[0].in.where = { tenant: 'acme' };
      },
    };
    expect(scopedCodes(broken)).toContain('X208');
    expect(scopedPointing(broken)).toContain(
      'X208 @features/customers/data/kept-list.graph.json#nodes/rows/in/where/tenant',
    );
  });
  it('the scope edge follows the store and not the shape: the session attribute is the one carrier', () => {
    // drop the attribute from the session shape and the read types unknown, which C012 refuses -- the store
    // names the resolver, the resolver names the guard's context, and nothing in between invents the value
    expect(scopedCodes({}, { [SESSION]: shape => delete shape.fields.tenant })).toContain('C012');
  });
});
