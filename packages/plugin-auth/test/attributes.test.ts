/**
 * What the directory says about an account beside its subject, name and groups: `verify` with a `type`, over a
 * directory connection and over the fake OIDC issuer, and without one as before; and X105, which holds a session
 * attribute some store scopes a collection by to the one write the sign-in made.
 */
import type { Server } from 'node:http';
import { conforms, type Type } from '@wilanis/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verify } from '../src/directories.js';
import { fakeIssuer, ISSUER, issuerKey, listening, sabotage, sabotageInclude } from './harness.js';

/** The shape a call site's `type` names in these tests: one required tenant, as the RFC's example declares it. */
const TENANT: Type = {
  kind: 'object',
  fields: { tenant: { type: { kind: 'string' }, required: true } },
  open: false,
};
const TENANT_REF = '@customers/domain/IdentityAttributes.shape.json';

/** The accounts the directory connection holds: one carrying a tenant, one saying nothing. */
const USERS = [
  { username: 'ana', password: 'ana-pass', name: 'Ana', groups: ['customer'], attributes: { tenant: 'acme' } },
  { username: 'bo', password: 'bo-pass', name: 'Bo', groups: ['customer'] },
  { username: 'cy', password: 'cy-pass', name: 'Cy', groups: ['customer'], attributes: { tenant: 7 } },
];

/** The environment the handler reads: the connection it names, and the shape a `type` resolves to. */
const envWith = (kind: string, settings: Record<string, unknown>) => ({
  connections: { '@connections/directory.json': { kind, settings } },
  resolveType: (ref: string) => {
    if (ref !== TENANT_REF) throw new Error(`no such shape '${ref}'`);
    return TENANT;
  },
});

/** Drive `verify` the way the kernel does: the inputs a call site gave, and the plugin's environment. */
const run = (input: Record<string, unknown>, env: Record<string, unknown>) =>
  verify({ in: input, ctx: { nodePath: [], attach: () => {}, clock: () => 0, env } } as never);

const directory = (input: Record<string, unknown>) =>
  run(
    { connection: '@connections/directory.json', ...input },
    envWith('@auth/directory.connection-kind.json', { users: USERS }),
  );

describe('verify with a type: what the directory said, judged', () => {
  it('a directory account whose attributes fit answers them under identity.attributes', async () => {
    const answer = (await directory({ username: 'ana', password: 'ana-pass', type: TENANT_REF })) as {
      status: string;
      identity: Record<string, unknown>;
    };
    expect(answer.status).toBe('verified');
    expect(answer.identity).toEqual({
      subject: 'ana',
      name: 'Ana',
      groups: ['customer'],
      attributes: { tenant: 'acme' },
    });
  });

  it('an account that says nothing fails the node: a directory the tree asks more of is misconfigured', async () => {
    await expect(directory({ username: 'bo', password: 'bo-pass', type: TENANT_REF })).rejects.toThrow(
      /the directory's attributes are not @customers\/domain\/IdentityAttributes\.shape\.json/,
    );
  });

  it("an account whose attribute is the wrong type fails the node too, with the shape's words", async () => {
    await expect(directory({ username: 'cy', password: 'cy-pass', type: TENANT_REF })).rejects.toThrow(/tenant/);
  });

  it('a bad password is still rejected, and never reaches the attributes', async () => {
    expect(await directory({ username: 'ana', password: 'nope', type: TENANT_REF })).toEqual({ status: 'rejected' });
  });

  it('without a type, verify answers what it answered before: no attributes at all', async () => {
    expect(await directory({ username: 'ana', password: 'ana-pass' })).toEqual({
      status: 'verified',
      identity: { subject: 'ana', name: 'Ana', groups: ['customer'] },
    });
    // the account that carries none verifies as it always did
    expect(await directory({ username: 'bo', password: 'bo-pass' })).toEqual({
      status: 'verified',
      identity: { subject: 'bo', name: 'Bo', groups: ['customer'] },
    });
  });
});

describe('verify with a type over an OIDC issuer: the claims the type names, and no others', () => {
  let stopIssuer: () => Promise<void>;
  let base: string;
  let oidc: Record<string, unknown>;

  beforeAll(async () => {
    base = `http://localhost:${ISSUER + 4}`;
    const key = await issuerKey();
    const server: Server = fakeIssuer(base, key);
    stopIssuer = await listening(server, ISSUER + 4);
    oidc = envWith('@auth/oidc.connection-kind.json', { issuer: base, clientId: 'customers', clientSecret: 'shh' });
  });
  afterAll(async () => {
    await stopIssuer();
  });

  const issued = (input: Record<string, unknown>) => run({ connection: '@connections/directory.json', ...input }, oidc);

  it("the identity token's claims are read under the names the type's fields give", async () => {
    // the fake issuer signs `tenant` beside name and groups, so the shape is met
    const answer = (await issued({ username: 'dee', password: 'dee-pass', type: TENANT_REF })) as {
      status: string;
      identity: Record<string, unknown>;
    };
    expect(answer.status).toBe('verified');
    expect(answer.identity.attributes).toEqual({ tenant: 'globex' });
    // nothing the type did not name comes along: the token also carries name, groups, iss, aud, sub
    expect(Object.keys(answer.identity.attributes as object)).toEqual(['tenant']);
  });

  it('without a type the issuer answers what it answered before', async () => {
    const answer = (await issued({ username: 'dee', password: 'dee-pass' })) as { identity: Record<string, unknown> };
    expect(answer.identity).toEqual({ subject: 'okta|dee', name: 'Dee', groups: ['customer', 'beta'] });
    expect(answer.identity.attributes).toBeUndefined();
  });

  it('a rejected grant never reaches the attributes', async () => {
    expect(await issued({ username: 'dee', password: 'nope', type: TENANT_REF })).toEqual({ status: 'rejected' });
  });
});

describe('the shape a type names is what judges: conforms, as a session write is judged', () => {
  it('the same judgement the handler makes, made here over the resolved shape', () => {
    expect(conforms({ tenant: 'acme' }, TENANT)).toBeNull();
    expect(conforms({}, TENANT)).toMatch(/tenant/);
    expect(conforms({ tenant: 7 }, TENANT)).toMatch(/tenant/);
  });
});

/**
 * X105 needs a store that scopes a collection by a session attribute. Step 10 of the RFC gives the example one;
 * until then each case plants it, so the rule is proved over exactly the documents it reads: the session shape
 * the guard's settings name gains the attribute, the customers feature's one edge document that reads the request gains
 * the resolver, and the store binds the read and scopes `customers` by it.
 *
 * The attribute is declared on the shape -- optional there and `required` on the resolver, as
 * `packages/runtime/test/scoping-harness.ts` declares its own -- because C012 holds a scope's read to a string
 * or a number: an attribute the shape does not declare types as unknown, and the copy would be refused before
 * X105 got a say. The sign-in graphs need no change for an optional field.
 */
const shapeOf = (attribute: string) => ({
  'features/access/domain/Session.shape.json': (doc: any) => {
    doc.fields[attribute] = { type: 'string', required: false, description: 'written at sign-in, and never again' };
  },
});

const scoping = (attribute: string) => ({
  'features/customers/edge/request.resolvers.json': (doc: any) => {
    doc.resolvers[attribute] = {
      read: `request.session.attributes.${attribute}`,
      required: true,
      description: "the caller's tenant, written into the session at sign-in",
    };
  },
  'features/customers/data/customers.store.json': (doc: any) => {
    doc.reads = { [attribute]: `@customers/edge/request.resolvers.json#${attribute}` };
    doc.collections.customers.scoped = { [attribute]: `{{${attribute}}}` };
  },
});

describe('X105: a scoped session attribute is written at sign-in and never again', () => {
  it('a set that writes the attribute a store scopes by is refused, naming the store and the collection', () => {
    // write-theme already writes `theme` through session.port.json#set; the store now scopes customers by it
    const codes = sabotageInclude(scoping('theme'), shapeOf('theme'));
    expect(codes).toContain('X105');
  });

  it('a remove that drops it is refused too', () => {
    const codes = sabotageInclude(scoping('theme'), {
      ...shapeOf('theme'),
      'features/access/data/write-theme.graph.json': (doc: any) => {
        doc.nodes[0].run = '@auth/session.port.json#remove';
        doc.nodes[0].in = { session: '{{sid}}', keys: ['theme'], type: '@access/domain/Session.shape.json' };
        doc.out = { type: '@access/domain/Session.shape.json', from: 'written' };
      },
    });
    expect(codes).toContain('X105');
  });

  it('the same through a binding delegation', () => {
    const codes = sabotageInclude(scoping('theme'), {
      ...shapeOf('theme'),
      'features/access/data/access.binding.json': (doc: any) => {
        doc.operations.savePreferences = {
          run: '@auth/session.port.json#set',
          in: { values: { theme: 'dark' }, type: '@access/domain/Session.shape.json' },
        };
      },
    });
    expect(codes).toContain('X105');
  });

  it('an attribute no store scopes by is written as freely as before', () => {
    // the store scopes customers by `tenant`, which nothing writes; the tree's one session write writes `theme`.
    // What this case proves is X105's silence: a scope earns the triggers that reach it A006 and B008 of their
    // own, which are the compiler's cases, not this rule's.
    expect(sabotageInclude(scoping('tenant'), shapeOf('tenant'))).not.toContain('X105');
  });

  it('a tree whose stores scope by nothing refuses nothing: the example as written', () => {
    expect(sabotage({})).toEqual([]);
  });
});
