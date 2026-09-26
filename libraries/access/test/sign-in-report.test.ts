import { fileURLToPath } from 'node:url';
import { loadTree, type PluginModule } from '@wilanis/core';
import type { Report } from '@wilanis/engine';
import auth from '@wilanis/plugin-auth';
import http, { encode } from '@wilanis/plugin-http';
import { BUILTIN_PLUGINS, embedderFor, type Ran, Served, traceOf } from '@wilanis/runtime';
import { describe, expect, it } from 'vitest';

/**
 * What a sign-in and a refresh leave behind. The password never leaves the run in clear: not in the report of any
 * node the run reached, nor in the full trace an exporter is handed. The tokens this tree answers with are marked
 * secret where it declares them (Tokens, TokensView), so every report of this tree's own operations says them as
 * the marker, while the caller -- the http answer, its cookie -- is handed the tokens themselves. The path is this
 * tree's own -- the route, access.binding.json meeting access.port.json with the business graph, and that graph's
 * call of identity.port.json -- so it is held here, with the development binding meeting identity.port.json as a
 * host would.
 */
const TREE = fileURLToPath(new URL('..', import.meta.url));
const PLUGINS: Record<string, PluginModule> = { ...BUILTIN_PLUGINS, '@http': http, '@auth': auth };
const SECRET = '«secret»';

type Tokens = { accessToken: string; refreshToken: string; tokenType: string; expiresIn: number };

/** One fire of a route, heard as the server hears it: the report, its full trace, and what the http kind answers. */
async function fire(route: string, body: Record<string, string>) {
  // the @auth settings read the signing secret from the environment, so it is set before the tree is loaded
  process.env.CUSTOMERS_JWT_SECRET ??= 'a-secret-of-thirty-two-bytes-or-more!';
  const load = loadTree(TREE, PLUGINS);
  const emb = embedderFor(load);
  const heard: Ran[] = [];
  emb.serve(Object.assign(new Served({ load, emb }, () => {}), { ran: (what: Ran) => heard.push(what) }));
  const trigger = load.registry.get('trigger', load.resolve(route));
  const report = await emb.fire(trigger?.doc as never, body, { body, headers: {} });
  const answer = encode(trigger?.doc as never, report);
  return { report, trace: traceOf(heard[0], emb.scope, { level: 'full' }), answer };
}

/** The nested run hung on a node, which the case expects to be there. */
function subOf(report: Report, id: string): Report {
  const sub = report.nodes[id]?.sub;
  if (!sub) throw new Error(`no nested run under '${id}'`);
  return sub;
}

/**
 * A token pair as a report of this tree's operations says it: both tokens as the marker, the rest as they are, and
 * the session it opened, which the answer leaves out (TokensView declares no sessionId) and a report keeps.
 */
const said = (tokens: Tokens) => ({
  ...tokens,
  accessToken: SECRET,
  refreshToken: SECRET,
  sessionId: expect.any(String),
});

/** The http answer: the tokens themselves in the body, and the access token as the session cookie. */
function expectAnswered(answer: ReturnType<typeof encode>, tokens: Tokens): void {
  expect(answer.status).toBe(200);
  expect(answer.body).toEqual({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenType: 'Bearer',
    expiresIn: tokens.expiresIn,
  });
  expect(answer.cookies?.[0]).toMatch(new RegExp(`^session=${tokens.accessToken};`));
}

describe('a sign-in, as its report and its trace say it', () => {
  const realms = [
    ['@access/edge/auth-customers.trigger.json', { username: 'ana', password: 'ana-pass' }],
    ['@access/edge/auth-employees.trigger.json', { username: 'bo', password: 'bo-pass' }],
  ] as const;

  for (const [route, credential] of realms)
    it(`never shows the password: ${route}`, async () => {
      const { report, trace } = await fire(route, credential);
      expect(report.status).toBe('done');
      // the binding's call of the business graph takes the credential, and says it redacted
      expect(report.nodes.op.in).toEqual({ username: credential.username, password: SECRET });
      expect(JSON.stringify(report)).not.toContain(credential.password);
      expect(JSON.stringify(trace)).not.toContain(credential.password);
    });

  for (const [route, credential] of realms)
    it(`says the tokens as the marker in this tree's reports, and answers them in clear: ${route}`, async () => {
      const { report, answer } = await fire(route, credential);
      const tokens = report.output as Tokens;
      expectAnswered(answer, tokens);
      // access.port.json's operation, met by the business graph, and the nested run hung on it
      expect(report.nodes.op.out).toEqual(said(tokens));
      expect(subOf(report, 'op').output).toEqual(said(tokens));
      // the business graph's call of identity.port.json#issue, and the binding's run beneath it
      const graph = subOf(report, 'op');
      expect(graph.nodes.issued.out).toEqual(said(tokens));
      expect(subOf(graph, 'issued').output).toEqual(said(tokens));
    });
});

describe('a refresh, as its report says it', () => {
  it("says the old and the new tokens as the marker in this tree's reports, and answers the new pair in clear", async () => {
    const signedIn = await fire('@access/edge/auth-customers.trigger.json', { username: 'ana', password: 'ana-pass' });
    const old = signedIn.report.output as Tokens;
    const { report, answer } = await fire('@access/edge/refresh.trigger.json', { refreshToken: old.refreshToken });
    expect(report.status).toBe('done');
    const renewed = report.output as Tokens;
    expect(renewed.refreshToken).not.toBe(old.refreshToken);
    expectAnswered(answer, renewed);
    // the refresh token presented is an input this tree marks, the pair it trades it for an answer it marks
    expect(report.nodes.op.in).toEqual({ refreshToken: SECRET });
    expect(report.nodes.op.out).toEqual(said(renewed));
    const graph = subOf(report, 'op');
    expect(graph.nodes.traded.in).toEqual({ refreshToken: SECRET });
    expect(graph.nodes.traded.out).toEqual({ refreshed: true, tokens: said(renewed) });
    expect(graph.nodes.renewed.in?.value).toEqual(said(renewed));
    expect(graph.nodes.renewed.out).toEqual(said(renewed));
  });
});
