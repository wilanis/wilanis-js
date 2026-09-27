/**
 * What the @http tests run against: a copy of the example pointed at a fake mockapi, the fake itself, and the calls a
 * test makes over the tree's own server. The tests own the lifecycle; this module says how each piece is built.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResolvedInclude } from '@wilanis/core';

export const EXAMPLE = fileURLToPath(new URL('../../../example', import.meta.url));

/** The tree the example includes, as the runtime would resolve it from the example's node_modules. */
export const INCLUDES: ResolvedInclude[] = [
  {
    from: '@wilanis/access',
    dir: fileURLToPath(new URL('../../../libraries/access', import.meta.url)),
    features: ['access'],
  },
];

export const SECRET = 'secret-secret-secret-secret-secret-1';
const SCHEMAS = 'https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/';

/** The row the fake upstream starts with. */
export const firstRow = (): Record<string, unknown> => ({
  id: '1',
  name: 'Ada',
  email: 'ada@a.example',
  tier: 'bronze',
  active: true,
  registrar: 'curl/8',
  createdAt: '2026-09-07',
});

/** A multipart upload beside the raw one: the file is one part of a form, a note another. */
function writeUploadForm(dir: string) {
  writeFileSync(
    join(dir, 'features/customers/edge/UploadForm.shape.json'),
    JSON.stringify({
      $schema: `${SCHEMAS}shape.schema.json`,
      description: 'a form with a file and a note',
      layer: 'edge',
      fields: { file: { type: 'blob' }, note: { type: 'string' } },
    }),
  );
  writeFileSync(
    join(dir, 'features/customers/edge/upload-form.trigger.json'),
    JSON.stringify({
      $schema: `${SCHEMAS}trigger.schema.json`,
      description: 'POST /customers/upload as a form',
      kind: '@http/http.trigger-kind.json',
      settings: {
        route: '/customers/upload',
        method: 'POST',
        consumes: 'multipart/form-data',
        produces: 'application/json',
        body: '@features/customers/edge/UploadForm.shape.json',
        response: {
          status: { default: 201 },
          // `invariant` is the guard the compiler lowers where a field invariant could not be proved: this
          // route reaches one, so it maps the word like every other reason it can be answered with (T005)
          refusals: {
            upstream: 502,
            conflict: 409,
            anonymous: 401,
            invalid_credential: 401,
            forbidden: 403,
            invariant: 500,
          },
        },
      },
      in: '@features/customers/edge/CsvUpload.shape.json',
      out: '@features/customers/edge/CustomerView.shape.json[]',
      // this route reaches customer.import, so the writes invariant holds it to the registrar gate like every
      // other write: a planted trigger is not exempt from a rule the tree states once
      policies: [
        {
          policy: '@access/edge/employees-only.policy.json',
          in: { token: ['{{context.headers.authorization}}', '{{context.cookies.session}}'] },
        },
        '@access/edge/can-register.policy.json',
      ],
      fire: { run: '@features/customers/domain/customer.port.json#import', in: { file: '{{context.body.file}}' } },
    }),
  );
}

/** What a copy is pointed at: the port a fake upstream was given, and any further edits. */
export interface CopyOptions {
  /** Where the customer API is served; absent, the connection keeps the example's, for a copy that reaches none. */
  upstream?: number;
  more?: (edit: Edit) => void;
}

/**
 * The example, pointed at a fake mockapi on localhost, its server on whatever port the system gives (`listenedOn`
 * reads it back once it is started). Its write routes are gated by the access feature's policies, so the tests sign
 * in as bo -- an employee holding the registrar role -- through the example's own route and present our token;
 * nothing about access is edited.
 */
export function localCopy({ upstream, more }: CopyOptions = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-http-'));
  cpSync(EXAMPLE, dir, { recursive: true, filter: path => !path.includes('node_modules') });
  const edit: Edit = (relative, change) => {
    const path = join(dir, relative);
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    change(doc);
    writeFileSync(path, JSON.stringify(doc));
  };
  edit('connections/customers-api.connection.json', connection => {
    if (upstream !== undefined) connection.settings.baseUrl = `http://localhost:${upstream}/api/v1`;
    connection.settings.throttle = { concurrency: 2 };
  });
  edit('project.json', project => {
    const settings = httpSettings(project);
    settings.port = 0;
    (settings.codecs as Record<string, string>)['multipart/form-data'] = '@http/codecs/multipart.codec.json';
  });
  writeUploadForm(dir);
  more?.(edit);
  return dir;
}

/**
 * The port a started tree's server was given, read off the line `listen` logs as it opens it
 * (`http: listening on <host>:<port> -- <routes>`): a copy asks for 0, so the system chooses.
 */
export function listenedOn(lines: string[]): number {
  const said = lines.map(line => /^http: listening on .*:(\d+) -- /.exec(line)).find(found => found !== null);
  if (!said) throw new Error(`the tree logged no 'http: listening on' line:\n${lines.join('\n')}`);
  return Number(said[1]);
}

/** Rewrite one document of a copy, by its path under the tree. */
export type Edit = (relative: string, change: (doc: any) => void) => void;

/** The @http plugin's settings in a copy's project.json, to edit in place. */
export const httpSettings = (project: any): Record<string, unknown> =>
  project.plugins.find((plugin: any) => plugin.use === '@http').settings;

/** How many DELETEs the upstream is serving right now, and the most it ever served at once. */
export interface InFlight {
  now: number;
  peak: number;
}

/** The rows a POST adds, with the fields the upstream fills in. */
function newRow(body: string, rows: Record<string, unknown>[]) {
  return {
    createdAt: 'now',
    active: true,
    ...JSON.parse(body),
    id: String(rows.length + 1),
  };
}

/** The collection: POST adds a row, GET answers them all, filtered by ?tier= when asked. */
function collection(
  request: IncomingMessage,
  url: URL,
  body: string,
  rows: Record<string, unknown>[],
): { status: number; value: unknown } {
  if (request.method === 'POST') {
    const row = newRow(body, rows);
    rows.push(row);
    return { status: 201, value: row };
  }
  const tier = url.searchParams.get('tier');
  return { status: 200, value: tier ? rows.filter(row => row.tier === tier) : rows };
}

/** One row: a DELETE removes it, slowly enough that concurrent deletes overlap so a throttle's ceiling shows. */
async function one(
  request: IncomingMessage,
  id: string,
  rows: Record<string, unknown>[],
  inFlight: InFlight,
): Promise<{ status: number; value: unknown }> {
  const row = rows.find(each => each.id === id);
  if (!row) return { status: 404, value: 'Not found' };
  if (request.method !== 'DELETE') return { status: 200, value: row };
  inFlight.now++;
  inFlight.peak = Math.max(inFlight.peak, inFlight.now);
  await new Promise(done => setTimeout(done, 40));
  inFlight.now--;
  rows.splice(rows.indexOf(row), 1);
  return { status: 200, value: row };
}

/** What the fake upstream holds: the rows it serves, how many deletes are in flight, and whether it answers at all. */
export interface Upstream {
  rows: Record<string, unknown>[];
  inFlight: InFlight;
  /** Hold every request open and never answer it, the way an upstream that has stopped answering does. */
  hold?: boolean;
}

/** What the fake answers: the collection, one row, or nothing it knows. */
async function answerFor(
  incoming: { request: IncomingMessage; url: URL; body: string; route: RegExpExecArray | null },
  upstream: Upstream,
): Promise<{ status: number; value: unknown }> {
  const { request, url, body, route } = incoming;
  if (!route) return { status: 404, value: 'Not found' };
  if (route[1]) return one(request, route[1], upstream.rows, upstream.inFlight);
  return collection(request, url, body, upstream.rows);
}

/** A fake mockapi: rows under /api/v1/customer, and "Not found" for anything else. */
export function fakeUpstream(upstream: Upstream): Server {
  return createServer(async (request: IncomingMessage, response: ServerResponse) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    if (upstream.hold) return;
    const url = new URL(request.url ?? '/', 'http://local');
    const route = /^\/api\/v1\/customer(?:\/([^/]+))?$/.exec(url.pathname);
    const answer = await answerFor({ request, url, body, route }, upstream);
    response.writeHead(answer.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(answer.value));
  });
}

/**
 * Listen on a port the system gives, and answer it with how to stop. A fixed port is one another test file, or
 * any socket on the machine, may hold first; this rejects where the server cannot listen, so a failure says why
 * rather than running out the timeout of the hook that was starting it.
 */
export async function listening(server: Server): Promise<{ port: number; stop: () => Promise<void> }> {
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(0, () => {
      server.off('error', fail);
      ok();
    });
  });
  const { port } = server.address() as AddressInfo;
  return { port, stop: () => new Promise<void>(done => server.close(() => done())) };
}

/** Sign in as bo, an employee holding the registrar role, on the tree served at `port`, and answer the token. */
export async function signInAsRegistrar(port: number): Promise<string> {
  const answer = await fetch(`http://localhost:${port}/api/v1/auth-employees`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'bo', password: 'bo-pass' }),
  });
  if (answer.status !== 200) throw new Error(`signing in answered ${answer.status}`);
  return ((await answer.json()) as { accessToken: string }).accessToken;
}

/** A call to the tree's own server, on the port it was given, with the token when the test presents one. */
export const caller =
  (token: () => string, port: () => number) =>
  async (method: string, path: string, body?: unknown, authorized = false) => {
    const answer = await fetch(`http://localhost:${port()}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(authorized ? { authorization: `Bearer ${token()}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: answer.status, body: (await answer.json().catch(() => undefined)) as any };
  };
