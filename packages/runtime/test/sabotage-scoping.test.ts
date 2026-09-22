/**
 * Sabotage: what a tree earns for how a store is scoped. A store binds the reads its collections are scoped
 * by the way a data graph binds one (P004, P005, R001, L005); a `scoped` column is a column the store keeps
 * and exactly one of those reads, required and holding one value (C012); a view sees every row of one scoped
 * collection of this store, behind a policy (C013, R001). And once a collection is scoped, the rules that
 * already judge a read judge this one: A006 holds every trigger reaching the collection to guaranteeing the
 * read, and B008 refuses a startup step that reaches it at all. What a document may say about a scope is
 * @storage's: X214 refuses a site that writes one, and X208 already refuses a `where` naming the column,
 * since a scope is a column the store keeps and not a field of the shape. What may write the value a scope
 * trusts is @auth's: X105 refuses a session write of the attribute after the sign-in that wrote it.
 *
 * Who a scope may read and what a view is behind are the A family's, and are `sabotage-scope-access.test.ts`
 * beside this: the same split the rules themselves take, since a scope that is well-formed and reads a header
 * is a well-formed store that scopes by nothing.
 *
 * The example keeps its customers per tenant in both its stores, so it is refused nothing as written, and every
 * case here breaks one document of it (or of the access tree it includes, through `scoping-harness.ts`).
 */
import { describe, expect, it } from 'vitest';
import { codes, EXAMPLE } from './example-harness.js';
import {
  GET,
  GET_TRIGGER,
  LIST,
  LIST_EVERY,
  RESOLVERS,
  SESSION,
  STORE,
  scopedCodes,
  scopedHinting,
  scopedPointing,
  scopedSaying,
  WRITE,
} from './scoping-harness.js';

/** get-customer with the signed-in policy dropped: nothing then proves the session the store's scope reads. */
const UNGATED = { [GET_TRIGGER]: (doc: any) => (doc.policies = []) };
/** The startup step that reads every tenant's customers, pointed at the operation that reads one tenant's. */
const SCOPED_STEP = {
  'project.json': (project: any) => (project.startup[2].run = '@customers/domain/customer.port.json#listAll'),
};

describe('sabotage: how a store is scoped', () => {
  it('the example as written is refused nothing: both stores scoped, the view declared, every gate attached', () => {
    // get-customer, list-customers and export-customers attach signed-in, which proves the session the scope
    // reads; the digest attaches employees-only, which the view it reads is behind; and the startup step reads
    // the view, since a step has no tenant to read (B008)
    expect(codes(EXAMPLE)).toEqual([]);
    // and the copy both trees are edited in is the same tree, so every case below breaks exactly what it says
    expect(scopedCodes()).toEqual([]);
  });
  it('A006 a trigger reaching the scoped collection that attaches no policy proving the read', () => {
    // no document of get-customer names the session: the read reaches it because the compiler carries the
    // store's read to every site over the collection, under each profile whose store scopes it
    expect(scopedSaying(UNGATED)).toContain(
      "A006 @features/customers/data/customers.store.json reads request.session.attributes.tenant as required, but trigger kind '@http/http.trigger-kind.json' hands it only sometimes and no policy of this trigger proves it (profile 'local')",
    );
    expect(scopedSaying(UNGATED)).toContain(
      "A006 @features/customers/data/customers-postgres.store.json reads request.session.attributes.tenant as required, but trigger kind '@http/http.trigger-kind.json' hands it only sometimes and no policy of this trigger proves it (profile 'production')",
    );
    expect(scopedPointing(UNGATED)).toContain('A006 @features/customers/edge/get-customer.trigger.json#policies');
  });
  it('A006 names the read the store made, and offers the policy that would prove it', () => {
    expect(scopedHinting(UNGATED)).toContain(
      'A006 gate this trigger with a policy whose proves lists "request.session.attributes.tenant", or drop required from the resolver and route around its absence',
    );
  });
  it('B008 a startup step that reaches the scoped collection rather than the view', () => {
    // listAll is bound to the finds over customers: a startup step runs before anything is received, so a
    // scoped collection is unreachable from it by construction, and the example's step reads listEvery instead
    expect(scopedPointing(SCOPED_STEP)).toContain('B008 @project.json#startup/2/run');
    expect(scopedSaying(SCOPED_STEP)).toContain(
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
    const broken = { [STORE]: (store: any) => (store.collections.everyCustomer.view = 'nope') };
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
        store.collections.everyCustomerToo = {
          view: 'everyCustomer',
          behind: '@access/edge/employees-only.policy.json',
        };
      },
    };
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
    expect(scopedSaying(broken)).toContain(
      "C013 'latest' declares no scoped columns, so every row of it is seen already",
    );
    expect(scopedHinting(broken)).toContain(
      'C013 scope the collection this views, or read it directly: a view is the way across a scope',
    );
  });
  it('D001 a view that names a shape beside the collection it views, whose shape it already has', () => {
    expect(
      scopedCodes({ [STORE]: store => (store.collections.everyCustomer.of = '@customers/domain/Customer.shape.json') }),
    ).toContain('D001');
  });
  it('R001 a view behind a policy the tree does not have', () => {
    expect(
      scopedPointing({ [STORE]: store => (store.collections.everyCustomer.behind = '@access/edge/nope.policy.json') }),
    ).toContain('R001 @features/customers/data/customers.store.json#collections/everyCustomer/behind');
  });
  it('X214 a scope written by hand on the site the compiler fills: the M12 demo, refused', () => {
    // "the agent added the filter by hand" is the one thing a scope makes unwriteable: the store says how
    // customers are scoped, the compiler carries it to every site, and a document that repeats it is refused
    const broken = { [GET]: (graph: any) => (graph.nodes[0].in.scope = { tenant: '{{in.id}}' }) };
    expect(scopedPointing(broken)).toContain('X214 @features/customers/data/kept-get.graph.json#nodes/asked/in/scope');
    expect(scopedSaying(broken)).toContain(
      "X214 scope is the store's: 'customers' is scoped by tenant ← {{tenant}} of @customers/data/customers.store.json, and the compiler puts it here",
    );
    expect(scopedHinting(broken)).toContain(
      'X214 drop "scope": to change how \'customers\' is scoped, change @customers/data/customers.store.json',
    );
  });
  it('X214 a scope on the find over a view, which sees every row whatever a site says', () => {
    // the digest's find, which reads every tenant's customers for an employee
    const broken = { [LIST_EVERY]: (graph: any) => (graph.nodes[0].in.scope = { tenant: 'acme' }) };
    expect(scopedSaying(broken)).toContain("X214 'everyCustomer' is a view of 'customers', and a view sees every row");
    expect(scopedHinting(broken)).toContain('X214 drop "scope": read \'customers\' where a scope is meant');
  });
  it('X214 a scope on newKey, which mints a key across every scope and takes none', () => {
    // a key is global: one tenant is never handed a key another already holds, so there is no scope to mint
    // one under, and the port declares no `scope` on the operation at all
    const broken = { [WRITE]: (graph: any) => (graph.nodes[0].in.scope = { tenant: 'acme' }) };
    expect(scopedPointing(broken)).toContain(
      'X214 @features/customers/data/store-and-latest.graph.json#nodes/key/in/scope',
    );
  });
  it("X208 a where naming the scope column: a scope is the store's column, never a field to filter on", () => {
    // the column is not a field of Customer, so the filter names something the shape does not have -- which is
    // what X208 already says, and is why a scope needs no filter rule of its own
    const broken = { [LIST]: (graph: any) => (graph.nodes[0].in.where = { tenant: 'acme' }) };
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

/** The access tree's one session write, which writes the theme and could as well write anything the shape declares. */
const THEME = 'features/access/data/write-theme.graph.json';
/** What X105 says of a write to the attribute the stores scope customers by, whichever store it names. */
const X105 =
  /^X105 (set writes|remove drops) 'tenant', which @features\/customers\/data\/customers(-postgres)?\.store\.json scopes customers by; a scope is written at sign-in and never again$/;

describe('sabotage: the attribute a scope reads is written at sign-in and never again', () => {
  // X105 is @auth's, since only the guard's plugin knows what session.port.json writes; the example's scope is
  // what gives it a word to hold: `tenant`, which both sign-in graphs write and nothing after them may
  it('X105 a set that writes the tenant, naming the store that scopes customers by it', () => {
    const broken = { [THEME]: (graph: any) => (graph.nodes[0].in.values.tenant = 'globex') };
    expect(scopedSaying({}, broken).filter(one => X105.test(one))).toHaveLength(1);
    expect(scopedPointing({}, broken)).toContain(
      'X105 @features/access/data/write-theme.graph.json#nodes/written/in/values/tenant',
    );
  });
  it('X105 a remove whose keys name it', () => {
    const broken = {
      [THEME]: (graph: any) => {
        graph.nodes[0].run = '@auth/session.port.json#remove';
        graph.nodes[0].in = { session: '{{sid}}', keys: ['tenant'], type: '@access/domain/Session.shape.json' };
      },
    };
    expect(scopedSaying({}, broken).filter(one => X105.test(one))).toHaveLength(1);
    expect(scopedPointing({}, broken)).toContain(
      'X105 @features/access/data/write-theme.graph.json#nodes/written/in/keys',
    );
  });
  it('X105 the same write through a binding delegation, which is a site like any other', () => {
    const broken = {
      'features/access/data/access.binding.json': (doc: any) => {
        doc.operations.savePreferences = {
          run: '@auth/session.port.json#set',
          in: { values: { tenant: 'globex' }, type: '@access/domain/Session.shape.json' },
        };
      },
    };
    expect(scopedPointing({}, broken)).toContain(
      'X105 @features/access/data/access.binding.json#operations/savePreferences/in/values/tenant',
    );
  });
});
