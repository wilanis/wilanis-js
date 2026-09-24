/**
 * The demo of docs/demo.md, run as a test. The prepared files under docs/demo/ are planted into a copy of the
 * example in the order the script pastes them, and what each beat points at is asserted: the codes and the
 * paths they point at, the hints the presenter reads aloud, the three branches the rehearsal settles, and
 * what the three writes and the bad CSV answer. The commands are not the claim; what they print is, so the
 * whole run is in-process -- `checkTree`, `scaffold`, `rehearse`, the embedder -- and neither the CLI nor
 * build.mjs, which writes the page, is shelled out to. A change to the script, to a prepared file or to the
 * tree that breaks a beat fails here.
 */
import { randomBytes } from 'node:crypto';
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTree } from '@wilanis/compiler';
import { type LoadResult, loadTree, type TriggerDoc } from '@wilanis/core';
import { encode } from '@wilanis/plugin-http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describe as describeDoc, embedderFor, FileBlobStore, postLoad, rehearse, scaffold } from '../src/index.js';
import { copyOfExample, INCLUDES, PLUGINS, refusalsAt, refusalsHinting, refusalsSaying } from './example-harness.js';

const DEMO = fileURLToPath(new URL('../../../docs/demo', import.meta.url));
const ROUTE = 'features/customers/edge/archive-customer.trigger.json';
const AT = `@${ROUTE}`;
const REMOVE = '@customers/domain/customer.port.json#remove';
const POLICY = '@access/edge/can-register.policy.json';
const INVARIANT = '@features/customers/domain/writes-are-for-registrars.invariant.json';
const REFUSALS = `${AT}#settings/response/refusals`;
const STORE = '@features/customers/data/customers.store.json';
const PG_STORE = '@features/customers/data/customers-postgres.store.json';
const TENANT = 'request.session.attributes.tenant';

/** One copy of the example, driven through the whole script in order; the beats below share it. */
let dir: string;
beforeAll(() => {
  dir = copyOfExample();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const load = (): LoadResult => loadTree(dir, PLUGINS, INCLUDES);
/** What `wilanis check .` prints when nothing refuses: the count is the whole of the line. */
const documents = () => load().registry.files.length;
/** Paste one prepared file of docs/demo/ over the route, as the script's `cp $DEMO/... features/...` does. */
const paste = (name: string) => copyFileSync(join(DEMO, name), join(dir, ROUTE));

describe('beat 1, the hook: the tree as it ships, and what the rule reaches', () => {
  it('checks ok at 201 documents, and describe computes the five routes the rule reaches', () => {
    expect(refusalsAt(dir)).toEqual([]);
    expect(documents()).toBe(201);
    const said = describeDoc(load(), '@customers/domain/writes-are-for-registrars.invariant.json').split('\n');
    expect(said).toContain('access: every trigger reaching these domain operations is gated');
    expect(said).toContain(`requires: attaches ${POLICY}`);
    expect(said).toContain('reached by (every one met by @features/access/edge/can-register.policy.json):');
    // five routes reach a write today, and the rule names none of them
    const reached = said.filter(line => /^ {4}@features\/customers\/edge\/.*\.trigger\.json {2}#/.test(line));
    expect(reached.map(line => line.trim().split(/ {2}/)[0])).toEqual([
      '@features/customers/edge/delete-customer.trigger.json',
      '@features/customers/edge/delete-customers.trigger.json',
      '@features/customers/edge/import-customers.trigger.json',
      '@features/customers/edge/register-customer.trigger.json',
      '@features/customers/edge/update-customer.trigger.json',
    ]);
  });
});

describe('beat 2, the new hire: the scaffolded route', () => {
  it('yields exactly the eight codes, at the paths the script quotes', () => {
    expect(
      scaffold(dir, 'trigger', 'features/customers/edge/archive-customer', {
        run: REMOVE,
        kind: '@http/http.trigger-kind.json',
      }),
    ).toEqual([ROUTE]);
    expect(refusalsAt(dir)).toEqual([
      `T002 ${AT}#in`,
      `T002 ${AT}#out`,
      `A006 ${AT}#policies`,
      `A006 ${AT}#policies`,
      `T005 ${REFUSALS}`,
      `T005 ${REFUSALS}`,
      `T005 ${REFUSALS}`,
      `I001 ${AT}#policies`,
    ]);
  });
  it('says what each refusal says: the shapes the operation takes and answers, the tenant, the three reasons, the rule', () => {
    expect(refusalsSaying(dir)).toEqual([
      `T002 '${REMOVE}' takes {id: string} but the trigger declares no in`,
      `T002 '${REMOVE}' answers @features/customers/domain/Customer.shape.json but the trigger declares no out`,
      `A006 ${STORE} reads ${TENANT} as required, but trigger kind '@http/http.trigger-kind.json' hands it only sometimes and no policy of this trigger proves it (profile 'local')`,
      `A006 ${PG_STORE} reads ${TENANT} as required, but trigger kind '@http/http.trigger-kind.json' hands it only sometimes and no policy of this trigger proves it (profile 'production')`,
      "T005 @features/customers/data/delete-row.graph.json may refuse with reason 'missing', which settings.response.refusals does not map",
      "T005 @features/customers/data/delete-row.graph.json may refuse with reason 'upstream', which settings.response.refusals does not map",
      "T005 @features/customers/data/kept-remove.graph.json may refuse with reason 'invariant', which settings.response.refusals does not map",
      `I001 trigger reaches @features/customers/domain/customer.port.json#remove, which 'Writes are for registrars' (${INVARIANT}) gates with ${POLICY}, but attaches no such policy`,
    ]);
  });
  it('ends on the hint the presenter reads aloud: the two edits that would fix it', () => {
    expect(refusalsHinting(dir).at(-1)).toBe(
      `I001 attach "${POLICY}" under policies, or take @features/customers/domain/customer.port.json#remove out of the invariant's over`,
    );
  });
});

describe('beat 3, following the hints', () => {
  it('the second step, shapes and refusals filled in, yields the three that want a policy: A006 twice and I001', () => {
    paste('archive-customer.step2.trigger.json');
    expect(refusalsAt(dir)).toEqual([`A006 ${AT}#policies`, `A006 ${AT}#policies`, `I001 ${AT}#policies`]);
  });
  it('attaching the policy without the token yields A005 and the two T005 for forbidden and anonymous', () => {
    // exactly what the I001 hint said and no more: the one line, written after `out` as build.mjs writes it
    const file = join(dir, ROUTE);
    const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const edited: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(doc)) {
      edited[key] = value;
      if (key === 'out') edited.policies = [POLICY];
    }
    writeFileSync(file, `${JSON.stringify(edited, null, 2)}\n`);

    expect(refusalsAt(dir)).toEqual([`A005 ${AT}#policies/0`, `T005 ${REFUSALS}`, `T005 ${REFUSALS}`]);
    expect(refusalsSaying(dir)).toEqual([
      "A005 policy '@features/access/edge/can-register.policy.json' reads request.principal, which the guard hands once it verified a token, but no attachment on this trigger gives one",
      "T005 @features/access/domain/require-registrar.graph.json may refuse with reason 'forbidden', which settings.response.refusals does not map",
      "T005 @features/access/domain/require-registrar.graph.json may refuse with reason 'anonymous', which settings.response.refusals does not map",
    ]);
    // the JSON in the hint is what the finished route pastes
    expect(refusalsHinting(dir)[0]).toBe(
      `A005 write { "policy": "${POLICY}", "in": { "token": "{{request.headers.authorization}}" } } -- the read is where this kind hands the credential`,
    );
  });
  it('the finished route yields ok, at 202 documents', () => {
    paste('archive-customer.step3.trigger.json');
    expect(refusalsAt(dir)).toEqual([]);
    expect(documents()).toBe(202);
  });
});

describe('beat 4, no test was written: the rehearsal', () => {
  it('settles the three branches of require-registrar, and the rule holds at six triggers', async () => {
    paste('archive-customer.step3.trigger.json');
    const run = await rehearse(load(), { seed: 1, profile: 'local' });
    const text = run.lines.join('\n');
    expect(run.ok, text).toBe(true);
    const header = run.lines.findIndex(line =>
      /^features\/access\/domain\/require-registrar {2}switch 'isRegistrar' {2}3\/3 branches/.test(line),
    );
    expect(header, text).toBeGreaterThanOrEqual(0);
    // the columns are padded for a reader; what each says is the claim
    expect(run.lines.slice(header + 1, header + 4).map(line => line.replace(/ {2,}/g, '  '))).toEqual([
      "  ok  when has(principal) && 'registrar' in principal.roles  answered from 'granted'",
      '  ok  when has(principal)  refused on purpose at \'forbidden\' as forbidden: "registering customers takes the registrar role"',
      '  ok  anything else  refused on purpose at \'anonymous\' as anonymous: "sign in first: no token was presented"',
    ]);
    expect(text).toMatch(/^every branch settled/m);
    // it was five in beat 1: the route the agent wrote is counted without anyone adding it
    expect(text).toContain('Writes are for registrars  holds at 6 trigger(s)');
  });
});

/** One answer on the wire, as the http plugin would write it: the status the route maps, and the body. */
interface Answer {
  status: number;
  body: unknown;
}

/** The context an http request reaches a graph as, built the way the plugin's server builds it. */
function requestOf(
  method: string,
  path: string,
  given: { token?: string; body?: unknown; params?: Record<string, string> } = {},
): Record<string, unknown> {
  return {
    method,
    path,
    headers: given.token ? { authorization: `Bearer ${given.token}` } : {},
    query: {},
    params: given.params ?? {},
    cookies: {},
    ...(given.body !== undefined ? { body: given.body } : {}),
  };
}

/**
 * The example's copy served under `local` through the embedder, as `wilanis start` serves it: the plugins
 * registered by `postLoad`, the store prepared by the project's first startup step, and every route fired the
 * way the http server fires one -- input built from the request, the gate run, the report encoded to a status.
 */
async function serving(env: NodeJS.ProcessEnv) {
  const loaded = load();
  expect(checkTree(loaded).items).toEqual([]);
  const emb = embedderFor(loaded, { profile: 'local', env });
  const down = await postLoad(loaded, emb, () => {});
  const blobs = emb.blobs.scope();
  const prepared = await emb.startup(
    { run: '@customers/domain/customer.port.json#prepare', label: 'Prepare' },
    { at: 0 },
  );
  expect(prepared.status).toBe('done');

  const answer = async (ref: string, request: Record<string, unknown>): Promise<Answer> => {
    const trigger = loaded.registry.get('trigger', loaded.resolve(ref))?.doc as TriggerDoc;
    const built = emb.inputFor(trigger, request);
    if ('error' in built) throw new Error(built.error);
    const report = await emb.fire(trigger, built.input, request, { blobs });
    const { status, body } = encode(trigger, report);
    return { status, body };
  };
  const stop = async () => {
    await blobs.release();
    await down();
    if (emb.blobs instanceof FileBlobStore) emb.blobs.destroy();
  };
  return { answer, blobs, stop };
}

describe('beats 4 and 5, live: the three writes, then all of it or none of it', () => {
  it('answers 401, 403 and 201, and the bad CSV 500 with the store empty after', async () => {
    paste('archive-customer.step3.trigger.json');
    const tree = await serving({
      // the one secret the demo needs from outside the tree: what the tree signs its tokens with
      CUSTOMERS_JWT_SECRET: randomBytes(32).toString('base64'),
      // until #304 lands the start reads every profile's secrets although local never reaches PostgreSQL; the
      // script exports the same placeholder. Remove this line when #304 lands, and the beat asserts the
      // one-secret start the script describes.
      CUSTOMERS_DATABASE_URL: 'postgres://unused',
    });
    try {
      const archive = (id: string, token?: string) =>
        tree.answer(
          '@customers/edge/archive-customer.trigger.json',
          requestOf('POST', `/customers/${id}/archive`, { token, params: { id } }),
        );
      const signIn = async (username: string) => {
        const signed = await tree.answer(
          '@access/edge/auth-employees.trigger.json',
          requestOf('POST', '/api/v1/auth-employees', { body: { username, password: `${username}-pass` } }),
        );
        expect(signed.status).toBe(200);
        return (signed.body as { accessToken: string }).accessToken;
      };

      // no token
      expect(await archive('x')).toEqual({
        status: 401,
        body: { reason: 'anonymous', message: 'sign in first: no token was presented' },
      });
      // cy holds the viewer group and not registrar: the rehearsal's second line, live
      expect(await archive('x', await signIn('cy'))).toEqual({
        status: 403,
        body: { reason: 'forbidden', message: 'registering customers takes the registrar role' },
      });
      // bo, a registrar: register a customer, then archive them
      const bo = await signIn('bo');
      const made = await tree.answer(
        '@customers/edge/register-customer.trigger.json',
        requestOf('POST', '/customers', {
          token: bo,
          body: { name: 'Ada Lovelace', email: 'ada@demo.example', tier: 'silver' },
        }),
      );
      expect(made.status).toBe(201);
      expect(made.body).toMatchObject({
        name: 'Ada Lovelace',
        email: 'ada@demo.example',
        tier: 'silver',
      });
      const id = (made.body as { id: string }).id;
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      const gone = await archive(id, bo);
      expect(gone.status).toBe(200);
      expect((gone.body as { id: string }).id).toBe(id);

      // beat 5: a file whose fifth row is not a customer, imported as bo
      const csv = readFileSync(join(DEMO, 'customers.bad.csv'), 'utf8');
      expect(csv.trimEnd().split('\n').at(-1)).toBe('Barbara Liskov,,silver');
      const imported = await tree.answer(
        '@customers/edge/import-customers.trigger.json',
        requestOf('POST', '/customers.csv', {
          token: bo,
          body: await tree.blobs.put(csv, { contentType: 'text/csv', filename: 'customers.bad.csv' }),
        }),
      );
      expect(imported).toEqual({
        status: 500,
        body: {
          reason: 'invariant',
          message:
            "'A customer is reachable' does not hold: len(name) > 0 && len(email) > 0 && (tier != 'gold' || has(note))",
        },
      });
      // four good rows went in before the fifth refused, and bo's tenant holds none of them
      expect(
        await tree.answer('@customers/edge/list-customers.trigger.json', requestOf('GET', '/customers', { token: bo })),
      ).toEqual({ status: 200, body: [] });
      // the one word that made it so, and nothing else: no transaction node, no begin, no commit
      const registerAll = JSON.parse(
        readFileSync(join(dir, 'features/customers/domain/register-all.graph.json'), 'utf8'),
      );
      expect(registerAll.atomic).toBe(true);
    } finally {
      await tree.stop();
    }
  });
});
