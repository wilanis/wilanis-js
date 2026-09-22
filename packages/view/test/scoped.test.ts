/**
 * What a scope and a view are drawn as (RFC 0015). A store's collection says which of its rows a caller may
 * see, and the compiler carries that scope to every operation over it -- so a reader meets it on a node no
 * document could have written it on, and on the store page that declares it. A view of a scoped collection is
 * the one way across, and it is a document: the page links the collection it crosses and the policy it is
 * behind, and the trigger that reaches it marks that policy as one it could not have dropped.
 *
 * The example keeps its customers per tenant and declares the view the digest reads, so every case reads it as
 * written, and the one about a store that scopes nothing edits a copy (`scoped-harness.ts`). Split from
 * `view.test.ts` because it is a family of its own with a fixture of its own, and that file is at the length
 * the house rules allow.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STORE_FILE, scopedView } from './scoped-harness.js';

const PAGE = fileURLToPath(new URL('../client/index.html', import.meta.url));
const STORE = '@features/customers/data/customers.store.json';
const REQUEST_DOC = '@features/customers/edge/request.resolvers.json';
const EMPLOYEES_ONLY = '@features/access/edge/employees-only.policy.json';

describe('a scope, and the view across it', () => {
  it('a storage node over a scoped collection carries a scope badge naming the column and linking the store', () => {
    const seen = scopedView('@features/customers/data/kept-get.graph.json');
    const asked = seen.graph?.nodes.find(node => node.id === 'asked');
    // the node names the store and the collection, as before; what is new is the scope the compiler put there
    expect(asked?.keeps).toMatchObject({ store: STORE, collection: 'customers', op: 'get' });
    expect(asked?.keeps?.scope).toEqual({
      // the badge links the store page, since the store is whose word the scope is
      store: STORE,
      by: [
        {
          column: 'tenant',
          // the local name the store reads by, as `scoped` writes it, and where that read lands in the request
          read: 'tenant',
          opens: REQUEST_DOC,
          from: 'session.attributes.tenant',
        },
      ],
    });
  });

  it('no node wrote the scope: it is absent over an unscoped collection and over newKey, which takes none', () => {
    const nodes = scopedView('@features/customers/data/store-and-latest.graph.json').graph?.nodes ?? [];
    const keeping = nodes.filter(node => node.keeps);
    // the put over the scoped collection carries one; the put over `latest`, which declares no scope, does not
    expect(keeping.find(node => node.id === 'stored')?.keeps?.scope?.by[0].column).toBe('tenant');
    expect(keeping.find(node => node.id === 'latest')?.keeps?.scope).toBeUndefined();
    // and newKey declares no `scope` input at all, because a key is global to the table whatever the scope
    expect(keeping.find(node => node.id === 'key')?.keeps).toMatchObject({ op: 'newKey', collection: 'customers' });
    expect(keeping.find(node => node.id === 'key')?.keeps?.scope).toBeUndefined();
  });

  it('the store page draws its reads as a request node, one port per name, opening the document that declares it', () => {
    const store = scopedView(STORE).store;
    expect(store?.request).toMatchObject({ id: 'request', kind: 'request', label: 'Request' });
    expect(store?.request?.outputs).toEqual([
      {
        name: 'session.attributes.tenant',
        depth: 2,
        // the name the store reads it by, not the resolver's own label, as a graph's request node does it
        label: 'tenant',
        opens: REQUEST_DOC,
        description:
          "The caller's tenant. Written into the session at sign-in from what the directory said about the account; every customer kept in a store belongs to one",
      },
    ]);
  });

  it('the store page marks a scoped column with the read that fills it, and leaves an unscoped one unmarked', () => {
    const store = scopedView(STORE).store;
    expect(store?.scoped).toEqual({
      customers: [{ column: 'tenant', read: 'tenant', opens: REQUEST_DOC, from: 'session.attributes.tenant' }],
    });
    // `latest` declares no scope, so the page marks nothing on it
    expect(store?.scoped?.latest).toBeUndefined();
  });

  it('the store page draws a view, linking the viewed collection and the policy it is behind', () => {
    const store = scopedView(STORE).store;
    expect(store?.views).toEqual({
      everyCustomer: { of: 'customers', behind: EMPLOYEES_ONLY, behindLabel: 'Employees only' },
    });
    // a view has no key of its own: it has the viewed collection's, so the key types say nothing about it
    expect(store?.keyTypes.everyCustomer).toBeUndefined();
  });

  it('a store that scopes nothing carries no reads, no scope and no view', () => {
    const store = scopedView(STORE, {
      [STORE_FILE]: doc => {
        doc.reads = undefined;
        doc.collections.customers.scoped = undefined;
        doc.collections.everyCustomer = undefined;
      },
    }).store;
    // absent, not empty: an empty map would draw a heading with nothing under it
    expect(Object.keys(store ?? {})).not.toContain('request');
    expect(Object.keys(store ?? {})).not.toContain('scoped');
    expect(Object.keys(store ?? {})).not.toContain('views');
  });

  it("the trigger page's Gated by marks the policy a view it reaches requires", () => {
    // the digest reads every tenant's customers through the view, and attaches the policy it is behind
    const seen = scopedView('@features/customers/edge/digest.trigger.json');
    expect(seen.policies).toEqual([
      {
        path: EMPLOYEES_ONLY,
        label: 'Employees only',
        decide: '@access/domain/access.port.json#requireEmployee',
        gives: { token: '{{request.flags.token}}' },
        // the one attachment the author could not have dropped: A008 would refuse the trigger without it, under
        // each profile whose store's view the digest reads
        required: [
          { store: STORE, storeLabel: 'Customers', view: 'everyCustomer', of: 'customers' },
          {
            store: '@features/customers/data/customers-postgres.store.json',
            storeLabel: 'Customers in PostgreSQL',
            view: 'everyCustomer',
            of: 'customers',
          },
        ],
      },
    ]);
  });

  it('marks no policy where the trigger reaches the scoped collection rather than a view', () => {
    // the view is declared and this trigger writes the scoped collection: attaching a policy is still a choice
    const seen = scopedView('@features/customers/edge/register-customer.trigger.json');
    expect(seen.policies?.map(policy => policy.path)).toEqual([
      EMPLOYEES_ONLY,
      '@features/access/edge/can-register.policy.json',
    ]);
    for (const policy of seen.policies ?? []) expect(Object.keys(policy)).not.toContain('required');
  });

  // the page is one static file with no build step, so what it draws is read from its own source
  it('the page draws all three: the node badge, the store page and the mark on Gated by', async () => {
    const page = await readFile(PAGE, 'utf8');
    // the node's badge, under the records block, opening the store that declares the scope
    expect(page).toContain('if (k.scope) scopeEl(box, k.scope)');
    expect(page).toMatch(/badge scope', 'scoped by ' \+ s\.by\.map/);
    // the store page: the request node, the scoped column in the collections table, and the views below it
    expect(page).toContain('if (s.request) storeReadsEl(page, s.request)');
    expect(page).toContain("'scoped by'");
    expect(page).toContain('if (s.views) storeViewsEl(page, s.views, d.collections)');
    expect(page).toContain('Views across the scope');
    // and the mark on one of a trigger's policies
    expect(page).toContain('if (pol.required) vv.appendChild(requiredEl(pol.required))');
    expect(page).toContain('A view is the one way across a scope, and this is the policy it is behind.');
  });
});
