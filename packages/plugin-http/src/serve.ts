/**
 * server.port.json#listen: the socket this tree answers its http triggers on. The routes are read from `serving` on
 * every request rather than captured once, so a reload can put a new tree behind a socket that stays open.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { BlobStore, Codec, Hold, Serving, TriggerDoc } from '@wilanis/core';
import type { Handler, Report } from '@wilanis/engine';
import { compileRoute, encode, fault, type HttpSettings, parseCookies } from './answer.js';
import { json, mediaType } from './codecs.js';
import { type Bounded, bounded, type Limits, limitsOf, TooLarge, unbounded, withDeadline } from './limit.js';
import { doc, ROOT } from './paths.js';
import { type Heard, hear, heardIn, lineOf, outcomeWords } from './said.js';

/** What a tree hands a held operation. */
type ServeEnv = { serving?: Serving; hold?: Hold; plugins?: Record<string, Record<string, unknown>> };

/** A route that may answer: its trigger, what the trigger declares, and the pattern its path must match. */
interface Route {
  trigger: TriggerDoc;
  settings: HttpSettings;
  re: RegExp;
  keys: string[];
}

/**
 * How an answer is written: the codec table to encode with, the scope a blob answer streams from, and the limits the
 * plugin's settings give every route that declares none of its own.
 */
interface Writer {
  serving: Serving;
  scope?: BlobStore;
  defaults: Limits;
}

/** What an answer says. */
interface Answer {
  status: number;
  body?: unknown;
  produces?: string;
  cookies?: string[];
}

/** A blob answer is piped from the registry to the socket; a value is encoded and sent whole. */
/** What the codec wrote, as an answer's body. */
type Written = { body: Buffer | Readable; contentType: string; length?: number; headers?: Record<string, string> };

/** The headers one answer goes out with. */
function headersFor(written: Written, cookies: string[] | undefined) {
  const length = written.length ?? (written.body instanceof Readable ? undefined : written.body.length);
  return {
    'content-type': written.contentType,
    ...(length !== undefined ? { 'content-length': length } : {}),
    ...(written.headers ?? {}),
    ...(cookies?.length ? { 'set-cookie': cookies } : {}),
  };
}

/** A blob answer is piped from the registry to the socket; a value is encoded and sent whole. */
async function write(response: ServerResponse, { serving, scope }: Writer, answer: Answer) {
  const produces = answer.produces ?? 'application/json';
  const codec = serving.codecs(ROOT)[produces.toLowerCase()] ?? json;
  const written: Written =
    answer.body === undefined
      ? { body: Buffer.alloc(0), contentType: produces, length: 0 }
      : ((await codec.encode(answer.body, undefined, scope ?? serving.blobs)) as Written);
  response.writeHead(answer.status, headersFor(written, answer.cookies));
  if (written.body instanceof Readable) await pipeline(written.body, response);
  else response.end(written.body);
}

/** Every route this tree answers, read afresh so a reload is seen. */
const routesOf = (serving: Serving): Route[] =>
  serving.triggers(doc('http.trigger-kind.json')).map(trigger => ({
    trigger,
    settings: trigger.settings as unknown as HttpSettings,
    ...compileRoute((trigger.settings as unknown as HttpSettings).route),
  }));

/** The request's headers, lowercased, as a graph reads them. */
function headersOf(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers))
    if (typeof value === 'string') headers[name.toLowerCase()] = value;
  return headers;
}

/** The parts the route captured from the path. */
function paramsOf(route: Route, pathname: string): Record<string, string> {
  const found = route.re.exec(pathname);
  const params: Record<string, string> = {};
  if (!found) return params;
  route.keys.forEach((key, index) => {
    params[key] = decodeURIComponent(found[index + 1] ?? '');
  });
  return params;
}

/** The query, by name. */
function queryOf(url: URL): Record<string, string> {
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, name) => {
    query[name] = value;
  });
  return query;
}

/** Whether the request carries a body at all. */
const hasBody = (headers: Record<string, string>) =>
  Number(headers['content-length'] ?? 0) > 0 || (headers['transfer-encoding'] ?? '').includes('chunked');

/** The request stream a codec reads: counted against the route's bound when it has one, and carrying its headers. */
function bodyOf(request: IncomingMessage, max: number | undefined): Bounded {
  if (max === undefined) return unbounded(request);
  const body = bounded(request, { max, what: 'body', rest: 'drain' });
  // the blob codec reads a filename off the stream's headers, as it would off the request itself
  Object.assign(body.stream, { headers: request.headers });
  return body;
}

/** The answer to a body past the route's bound. */
const tooLarge = (cut: TooLarge): { refuse: Answer } => ({ refuse: { status: 413, body: { error: cut.message } } });

/** Whether the sender says the body weighs more than the bound, so it is refused unread. */
const saysTooLarge = (headers: Record<string, string>, max: number | undefined): max is number =>
  max !== undefined && Number(headers['content-length'] ?? 0) > max;

/** The codec a body is read with and the content type it is read as, or the 415 of a body the route cannot read. */
function codecFor(
  settings: HttpSettings,
  headers: Record<string, string>,
  serving: Serving,
): { codec: Codec; contentType: string } | { refuse: Answer } {
  // a route that declares what it consumes takes nothing else; without a declaration the sender's content type decides
  const sent = headers['content-type'] ? mediaType(headers['content-type']) : undefined;
  if (settings.consumes && sent && sent !== mediaType(settings.consumes))
    return { refuse: { status: 415, body: { error: `this route consumes ${settings.consumes}, not ${sent}` } } };
  const contentType = settings.consumes ?? headers['content-type'] ?? 'application/json';
  const codec = serving.codecs(ROOT)[mediaType(contentType)];
  if (!codec) return { refuse: { status: 415, body: { error: `no codec for '${mediaType(contentType)}'` } } };
  return { codec, contentType };
}

/** The body the route's codec reads from the request stream, or why it could not be read. */
async function readBody(
  request: IncomingMessage,
  route: Route,
  headers: Record<string, string>,
  { serving, scope, defaults }: Writer & { scope: BlobStore },
): Promise<{ body: unknown } | { refuse: Answer }> {
  const settings = route.settings;
  const chosen = codecFor(settings, headers, serving);
  if ('refuse' in chosen) return chosen;
  const { codec, contentType } = chosen;
  // a body that says it is past the bound is refused unread; one that does not say so is cut once it passes it
  const max = limitsOf(settings, defaults).maxBodyBytes;
  if (saysTooLarge(headers, max)) return tooLarge(new TooLarge('body', max));
  // settings.body names the body's edge shape; without it the body IS the input. Either way the
  // declared shape judges what arrives, so a closed shape still refuses an undeclared field.
  const declared = settings.body === route.trigger.in || !settings.body ? serving.types(route.trigger).in : undefined;
  // the request stream itself goes to the codec: a blob body is written to the registry as it arrives
  const body = bodyOf(request, max);
  try {
    return { body: await codec.decode(body.stream, headers['content-type'] ?? contentType, declared, scope) };
  } catch (error) {
    const cut = body.cut();
    if (cut) return tooLarge(cut);
    return { refuse: { status: 400, body: { error: (error as Error).message } } };
  }
}

/** The request a graph reads, or why this one cannot be answered. */
async function requestOf(
  incoming: IncomingMessage,
  url: URL,
  route: Route,
  writer: Writer & { scope: BlobStore },
): Promise<{ request: Record<string, unknown> } | { refuse: Answer }> {
  const headers = headersOf(incoming);
  const carries = hasBody(headers);
  if (route.settings.body && !carries) return { refuse: { status: 400, body: { error: 'a body is required' } } };
  let body: unknown;
  if (carries) {
    const read = await readBody(incoming, route, headers, writer);
    if ('refuse' in read) return read;
    body = read.body;
  }
  return {
    request: {
      method: incoming.method,
      path: url.pathname,
      headers,
      query: queryOf(url),
      params: paramsOf(route, url.pathname),
      cookies: parseCookies(headers.cookie),
      ...(body !== undefined ? { body } : {}),
    },
  };
}

/** An answer of the edge's own, before any run: what the caller can fix, said on the log line as it was answered. */
const edge = (answer: Answer): Answer & { why: string } => ({
  ...answer,
  why: String((answer.body as { error?: unknown } | undefined)?.error ?? answer.status),
});

/** The answer of a run the route fired, and the line's words for it: the outcome, and the run a fault names. */
function answerOfRun(route: Route, report: Report, heard: Heard): Answer & { why: string; run?: string } {
  const encoded = encode(route.trigger, report, heard.run);
  const mapped = (reason: string) => route.settings.response?.refusals?.[reason] !== undefined;
  const faulted = (encoded.body as { error?: unknown } | undefined)?.error === 'fault';
  return {
    ...encoded,
    produces: route.settings.produces ?? 'application/json',
    why: `${route.trigger.fire.run} ${outcomeWords(report, heard, mapped)}`,
    ...(faulted && heard.run ? { run: heard.run } : {}),
  };
}

/** What one request is answered with: the route fires, gated by the runtime, and its report is encoded. */
async function answerFor(
  incoming: IncomingMessage,
  writer: Writer & { scope: BlobStore },
  heard: Heard,
): Promise<Answer & { why: string; run?: string }> {
  const url = new URL(incoming.url ?? '/', 'http://local');
  const route = routesOf(writer.serving).find(
    one => one.settings.method === incoming.method && one.re.test(url.pathname),
  );
  if (!route)
    return { status: 404, body: { error: `no trigger for ${incoming.method} ${url.pathname}` }, why: 'no trigger' };
  const produces = route.settings.produces ?? 'application/json';
  const read = await requestOf(incoming, url, route, writer);
  if ('refuse' in read) return edge({ ...read.refuse, produces });
  const built = writer.serving.inputFor(route.trigger, read.request);
  if ('error' in built)
    return edge({ status: 400, body: { error: `input does not conform: ${built.error}` }, produces });
  // the runtime gates the run: the guard identifies the caller and the trigger's policies decide before the operation
  // fires. The deadline counts from here, once the body is read and judged: a slow upload is the body's bound, not the run's
  const { deadlineMs } = limitsOf(route.settings, writer.defaults);
  const fire = { trigger: route.trigger, input: built.input, request: read.request, blobs: writer.scope };
  const report = await heardIn(heard, () =>
    withDeadline(deadlineMs, signal => writer.serving.fire(signal ? { ...fire, signal } : fire)),
  );
  return answerOfRun(route, report, heard);
}

/**
 * Answer one request and say it on one line. The runtime itself throwing inside a request -- a codec's `encode`
 * breaking, a blob gone from the registry while the answer streams -- is answered as a fault of the run, and its
 * message goes to the line, never to the caller.
 */
async function answerRequest(incoming: IncomingMessage, response: ServerResponse, { serving, defaults }: Writer) {
  const started = Date.now();
  const asked = `${incoming.method} ${new URL(incoming.url ?? '/', 'http://local').pathname}`;
  // one blob scope per request: what the body's codec and the graph store through it is released once answered
  const scope = serving.blobs.scope();
  const writer = { serving, scope, defaults };
  const heard: Heard = {};
  try {
    const answer = await answerFor(incoming, writer, heard);
    serving.log(lineOf(asked, answer.status, Date.now() - started, answer));
    await write(response, writer, answer);
  } catch (error) {
    const why = `error: ${(error as Error).message}`;
    serving.log(lineOf(asked, 500, Date.now() - started, { why, run: heard.run }));
    if (!response.headersSent) await write(response, writer, fault(heard.run));
    else response.destroy();
  } finally {
    await scope.release();
  }
}

/**
 * Open the port and answer this tree's http triggers until the process stops. A project's startup list names
 * it; nothing here starts on its own.
 */
export const listen: Handler = async ({ in: input, ctx }) => {
  const env = ctx.env as ServeEnv;
  const serving = env.serving;
  if (!serving || !env.hold)
    throw new Error(
      `'${doc('server.port.json')}#listen' starts a server, so it runs from a project's startup list -- not from a graph`,
    );
  const { log } = serving;
  const settings = env.plugins?.[ROOT] ?? {};
  const port = Number(input.port ?? settings.port ?? 8080);

  // the limits every route that declares none of its own is held to; X004 has judged them whole numbers of 1 or more
  const defaults: Limits = {
    deadlineMs: settings.deadlineMs as number | undefined,
    maxBodyBytes: settings.maxBodyBytes as number | undefined,
  };
  const server = createServer((incoming, response) => answerRequest(incoming, response, { serving, defaults }));

  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(port, () => {
      server.off('error', fail);
      ok();
    });
  });
  // every fire tells its observers which run it was; the request that fired it is told, so a fault can name it
  const unhear = hear(serving);
  const routes = routesOf(serving);
  log(
    `http: listening on :${port} -- ${routes.map(one => `${one.settings.method} ${one.settings.route} → ${one.trigger.fire.run}`).join(', ')}`,
  );
  env.hold({
    label: `http :${port}`,
    stop: () =>
      new Promise<void>(ok =>
        server.close(() => {
          unhear();
          ok();
        }),
      ),
  });
  return { port, routes: routes.length };
};
