import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTree, type PluginModule, type Trace } from '@wilanis/core';
import type { NodeReport, Report } from '@wilanis/engine';
import auth from '@wilanis/plugin-auth';
import http, { encode } from '@wilanis/plugin-http';
import {
  BUILTIN_PLUGINS,
  embedderFor,
  fuzz,
  type Ran,
  RECORDED,
  regress,
  rehearse,
  Served,
  traceOf,
} from '@wilanis/runtime';
import { describe, expect, it } from 'vitest';

/**
 * What a sign-in and a refresh leave behind. Neither the password nor a token leaves the run in clear: not in the
 * report of any node the run reached, nor in the full trace an exporter is handed. The tokens are marked secret
 * where this tree declares them (Tokens, TokensView) and where @auth does (its Tokens), so every report says them
 * as the marker, while the caller -- the http answer, its cookie -- is handed the tokens themselves. The path is
 * this tree's own -- the route, access.binding.json meeting access.port.json with the business graph, and that
 * graph's call of identity.port.json -- so it is held here, with the development binding meeting
 * identity.port.json through @auth's operations as a host would.
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
 * Every place a report shows one of `values` in clear: each node's in and out, the output of a nested run hung
 * on it or on an attempt, and a map's elements, by the path of node ids that leads there. The run's own output is
 * what the caller is handed, so it is not a place a report shows.
 */
function clearIn(report: Report, values: string[], at = ''): string[] {
  const shows = (said: unknown) => values.some(value => JSON.stringify(said ?? null).includes(value));
  return Object.entries(report.nodes).flatMap(([id, node]) => clearInNode(node, `${at}${id}`, values, shows));
}

/** The places one node's report shows a value in clear, and the nested runs below it. */
function clearInNode(node: NodeReport, at: string, values: string[], shows: (said: unknown) => boolean): string[] {
  const nested = [node.sub, ...(node.attempts ?? []).map(one => one.sub)].filter(sub => sub !== undefined);
  return [
    ...(shows(node.in) ? [`${at}.in`] : []),
    ...(shows(node.out) ? [`${at}.out`] : []),
    ...nested.flatMap(sub => [...(shows(sub.output) ? [`${at}.sub.output`] : []), ...clearIn(sub, values, `${at}/`)]),
    ...(node.items ?? []).flatMap((item, index) => clearInNode(item, `${at}.${index}`, values, shows)),
  ];
}

/** Every span of a full trace whose attributes show one of `values` in clear, by the span's name and the attribute. */
function clearInTrace(trace: Trace, values: string[]): string[] {
  const here = Object.entries(trace.attributes)
    .filter(([, said]) => values.some(value => String(said).includes(value)))
    .map(([name]) => `${trace.name} [${name}]`);
  return [...here, ...trace.children.flatMap(child => clearInTrace(child, values))];
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

  for (const [route, credential] of realms)
    it(`shows neither token in clear in any report or in the full trace: ${route}`, async () => {
      const { report, trace } = await fire(route, credential);
      const tokens = report.output as Tokens;
      const values = [tokens.accessToken, tokens.refreshToken];
      expect(clearIn(report, values)).toEqual([]);
      expect(clearInTrace(trace, values)).toEqual([]);
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

  it('shows no token in clear in any report or in the full trace', async () => {
    const signedIn = await fire('@access/edge/auth-customers.trigger.json', { username: 'ana', password: 'ana-pass' });
    const old = signedIn.report.output as Tokens;
    const { report, trace } = await fire('@access/edge/refresh.trigger.json', { refreshToken: old.refreshToken });
    const renewed = report.output as Tokens;
    const values = [old.refreshToken, renewed.accessToken, renewed.refreshToken];
    expect(clearIn(report, values)).toEqual([]);
    expect(clearInTrace(trace, values)).toEqual([]);
  });
});

describe('what fuzz records of a sign-in and of a code', () => {
  it("records the answer as the trigger's out shape marks it, and replays the same", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wilanis-access-fuzz-'));
    cpSync(TREE, dir, { recursive: true, filter: path => !/node_modules|\.wilanis|\/test|\/scenarios/.test(path) });
    try {
      // sixty seeds: under stubbed effects a sign-in, a refresh and a code each answer in only a few of them
      const { ok, written, lines } = await fuzz(loadTree(dir, PLUGINS), { runs: 60 });
      expect(ok, lines.join('\n')).toBe(true);
      const recorded = (name: string) =>
        written
          .filter(file => file.includes(`/${name}.`))
          .map(file => JSON.parse(readFileSync(file, 'utf8')).expect)
          .filter(expected => expected.status === 'done')
          .map(expected => expected.output);
      // TokensView marks both tokens and IssuedCodeView the code: the stubbed values never reach a scenario
      const tokens = [...recorded('auth-customers'), ...recorded('refresh')];
      expect(tokens.length).toBeGreaterThan(1);
      for (const output of tokens)
        expect(output).toEqual({
          accessToken: SECRET,
          refreshToken: SECRET,
          tokenType: 'Bearer',
          expiresIn: expect.any(Number),
        });
      const issued = recorded('issue-otp');
      expect(issued.length).toBeGreaterThan(0);
      for (const output of issued)
        expect(output).toEqual({ id: expect.any(String), code: SECRET, expiresAt: expect.any(String) });
      const replayed = await regress(loadTree(dir, PLUGINS));
      expect(replayed.ok, replayed.lines.join('\n')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('what rehearse --record records of a sign-in', () => {
  it("records each realm's issued tokens as the trigger's out shape marks them, and replays the same", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wilanis-access-record-'));
    cpSync(TREE, dir, { recursive: true, filter: path => !/node_modules|\.wilanis|\/test|\/scenarios/.test(path) });
    try {
      const { ok, lines, recorded } = await rehearse(loadTree(dir, PLUGINS), { record: RECORDED });
      expect(ok, lines.join('\n')).toBe(true);
      // the branch each realm's sign-in answers on: TokensView marks both tokens, so the stubbed ones never reach it
      const issued = [
        `${RECORDED}/auth-customers/access.sign-in-customer.verdict.issued.scenario.json`,
        `${RECORDED}/auth-employees/access.sign-in-employee.verdict.issued.scenario.json`,
      ];
      expect(recorded?.written).toEqual(expect.arrayContaining(issued));
      for (const file of issued)
        expect(JSON.parse(readFileSync(join(dir, file), 'utf8')).expect).toMatchObject({
          status: 'done',
          output: { accessToken: SECRET, refreshToken: SECRET, tokenType: 'Bearer', expiresIn: expect.any(Number) },
        });
      const replayed = await regress(loadTree(dir, PLUGINS));
      expect(replayed.ok, replayed.lines.join('\n')).toBe(true);
      expect(replayed.results).toHaveLength(recorded?.files ?? -1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
