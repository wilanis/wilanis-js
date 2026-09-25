/**
 * What every @auth test runs against: a copy of the example whose API points at a fake upstream, a fake OIDC issuer,
 * and the calls a test makes over them. The tests own the lifecycle; this module only says how each piece is built.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTree } from '@wilanis/compiler';
import { loadTree, type PluginModule, type ResolvedInclude } from '@wilanis/core';
import blobs from '@wilanis/plugin-blob';
import http from '@wilanis/plugin-http';
import otel from '@wilanis/plugin-otel';
import queue from '@wilanis/plugin-queue';
import queueMemory from '@wilanis/plugin-queue-memory';
import reload from '@wilanis/plugin-reload';
import s3 from '@wilanis/plugin-s3';
import schedule from '@wilanis/plugin-schedule';
import storage from '@wilanis/plugin-storage';
import memory from '@wilanis/plugin-storage-memory';
import postgres from '@wilanis/plugin-storage-postgres';
import { BUILTIN_PLUGINS } from '@wilanis/runtime';
import { exportJWK, generateKeyPair, type KeyLike, SignJWT } from 'jose';
import auth from '../src/index.js';

export const EXAMPLE = fileURLToPath(new URL('../../../example', import.meta.url));
export const PLUGINS: Record<string, PluginModule> = {
  ...BUILTIN_PLUGINS,
  '@http': http,
  '@blob': blobs,
  '@reload': reload,
  '@auth': auth,
  '@schedule': schedule,
  '@queue': queue,
  '@queue-memory': queueMemory,
  '@storage': storage,
  '@storage-memory': memory,
  '@storage-postgres': postgres,
  '@otel': otel,
  '@s3': s3,
};

/** The tree the example includes, as the runtime would resolve it from the example's node_modules. */
export const INCLUDES: ResolvedInclude[] = [
  {
    from: '@wilanis/access',
    dir: fileURLToPath(new URL('../../../libraries/access', import.meta.url)),
    features: ['access'],
  },
];

/**
 * The ports these tests listen on, spaced apart per vitest worker. Vitest runs test files in parallel workers,
 * so two files that bind the same fixed port race: whichever listens second answers EADDRINUSE, the `beforeAll`
 * that was starting a fake issuer never finishes, and the run fails with a hook timeout and a `stop` that was
 * never assigned. Which file loses is a matter of scheduling, so it fails on CI and not on a developer's
 * machine. `VITEST_POOL_ID` is the worker's own number, so a band per worker is a band nothing else binds --
 * the ports stay readable and fixed within a run, and no two workers ever ask for the same one. The harnesses'
 * bands overlap as ranges; what keeps them apart is that each base sits on its own residue mod 16 (8093 here is
 * 13 against 8300's 12 in `unique-violated`; 54325 and 54326 are 5 and 6 against the http upstream's 54900 at 4),
 * so a new base goes on a residue nothing else uses.
 */
const BAND = Number(process.env.VITEST_POOL_ID ?? 0) * 16;

export const PORT = 8093 + BAND;
export const UPSTREAM = 54325 + BAND;
export const ISSUER = 54326 + BAND;
export const SECRET = 'a-secret-of-thirty-two-bytes-or-more!';

export type Edit = (doc: any) => void;

/** The example, its API pointed at a fake upstream, its server on a port of its own, with any further edits. */
export function localCopy(edits: Record<string, Edit> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-auth-'));
  cpSync(EXAMPLE, dir, {
    recursive: true,
    filter: path => !path.includes('node_modules') && !path.includes('.wilanis'),
  });
  const edit = (relative: string, change: Edit) => {
    const path = join(dir, relative);
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    change(doc);
    writeFileSync(path, JSON.stringify(doc));
  };
  edit('connections/customers-api.connection.json', connection => {
    connection.settings.baseUrl = `http://localhost:${UPSTREAM}/api/v1`;
  });
  edit('project.json', project => {
    project.plugins.find((plugin: any) => plugin.use === '@http').settings.port = PORT;
  });
  for (const [relative, change] of Object.entries(edits)) edit(relative, change);
  return dir;
}

/** The refusal codes a tree answers with. */
export const codes = (dir: string) => checkTree(loadTree(dir, PLUGINS, INCLUDES)).items.map(refusal => refusal.code);

/** Copy the example, apply edits, answer the refusal codes. */
export function sabotage(edits: Record<string, Edit>): string[] {
  const dir = localCopy(edits);
  try {
    return codes(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The same, for an edit that has to reach a document of the included access tree rather than the example's own:
 * the include is copied too and handed in at its copy, so a sabotage of `features/access/...` is the tree the
 * checker reads. Paths under `include` are relative to the access tree's root.
 */
export function sabotageInclude(edits: Record<string, Edit>, include: Record<string, Edit>): string[] {
  const dir = localCopy(edits);
  const copy = mkdtempSync(join(tmpdir(), 'wilanis-access-'));
  cpSync(INCLUDES[0].dir, copy, {
    recursive: true,
    filter: path => !path.includes('node_modules') && !path.includes('.wilanis') && !path.includes('/test'),
  });
  for (const [relative, change] of Object.entries(include)) {
    const path = join(copy, relative);
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    change(doc);
    writeFileSync(path, JSON.stringify(doc));
  }
  const included: ResolvedInclude[] = [{ ...INCLUDES[0], dir: copy }];
  try {
    return checkTree(loadTree(dir, PLUGINS, included)).items.map(refusal => refusal.code);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(copy, { recursive: true, force: true });
  }
}

/** A response, as a test reads it. */
export const json = async (answer: Response) => ({
  status: answer.status,
  body: (await answer.json().catch(() => undefined)) as any,
  headers: answer.headers,
});

/** A call to the tree's own server, with a token or a cookie when the test presents one. */
export const call = (path: string, init: RequestInit & { token?: string; cookie?: string } = {}) => {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.cookie) headers.cookie = init.cookie;
  return fetch(`http://localhost:${PORT}${path}`, { ...init, headers }).then(json);
};

/** Sign in over one of the tree's sign-in routes. */
export const signIn = (route: string, username: string, password: string) =>
  call(`/api/v1/${route}`, { method: 'POST', body: JSON.stringify({ username, password }) });

/** Reads a request's whole body, which both fakes do before answering. */
async function bodyOf(request: { [Symbol.asyncIterator](): AsyncIterableIterator<unknown> }) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body;
}

/** A mockapi-shaped upstream for the registry's writes; it keeps the rows it was given. */
export function fakeUpstream(rows: Record<string, unknown>[]): Server {
  return createServer(async (request, response) => {
    const body = await bodyOf(request);
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (request.method === 'POST') {
      const row = {
        createdAt: 'now',
        ipv4: '127.0.0.1',
        mac: '00',
        reponseStatus: 200,
        ...JSON.parse(body),
        id: String(rows.length + 1),
      };
      rows.push(row);
      return send(201, row);
    }
    return send(200, rows);
  });
}

/** The key a fake issuer signs its identity tokens with, and the public half it publishes. */
export async function issuerKey() {
  const pair = await generateKeyPair('RS256');
  return {
    privateKey: pair.privateKey,
    jwk: { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' },
  };
}

/**
 * An identity token for the one user the fake issuer knows. `tenant` rides beside the rest because an OIDC
 * directory says what it says as claims: a `verify` given a `type` reads the ones its fields name.
 */
function identityToken(base: string, privateKey: KeyLike) {
  return new SignJWT({ name: 'Dee', groups: ['customer', 'beta'], tenant: 'globex' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setSubject('okta|dee')
    .setIssuer(base)
    .setAudience('customers')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

/** What the fake issuer's token endpoint answers to one password grant. */
async function grantAnswer(base: string, privateKey: KeyLike, body: string) {
  const form = new URLSearchParams(body);
  if (form.get('client_id') !== 'customers' || form.get('client_secret') !== 'shh')
    return { status: 401, value: { error: 'invalid_client' } };
  if (form.get('username') !== 'dee' || form.get('password') !== 'dee-pass')
    return { status: 400, value: { error: 'invalid_grant' } };
  return {
    status: 200,
    value: { id_token: await identityToken(base, privateKey), access_token: 'opaque', token_type: 'Bearer' },
  };
}

/** An OIDC issuer: discovery, a password grant that knows one user, and the keys its identity tokens are signed with. */
export function fakeIssuer(base: string, key: { privateKey: KeyLike; jwk: Record<string, unknown> }): Server {
  const routes: Record<string, (body: string) => Promise<{ status: number; value: unknown }>> = {
    '/.well-known/openid-configuration': async () => ({
      status: 200,
      value: { issuer: base, token_endpoint: `${base}/token`, jwks_uri: `${base}/keys` },
    }),
    '/keys': async () => ({ status: 200, value: { keys: [key.jwk] } }),
    '/token': body => grantAnswer(base, key.privateKey, body),
  };
  return createServer(async (request, response) => {
    const body = await bodyOf(request);
    const route = routes[request.url ?? ''];
    const { status, value } = route ? await route(body) : { status: 404, value: {} };
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  });
}

/** Listen, and answer how to stop. */
export const listening = async (server: Server, port: number) => {
  await new Promise<void>(done => server.listen(port, done));
  return () => new Promise<void>(done => server.close(() => done()));
};
