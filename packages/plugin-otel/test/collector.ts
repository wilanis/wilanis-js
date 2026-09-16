/**
 * A collector in this process: an http server that answers the OTLP/JSON endpoint and keeps what it was sent.
 * It is the real wire -- the exporter POSTs to it over a socket and it reads the bytes back as OTLP -- so a
 * test here says what a collector would really receive, and not what this plugin believes it sent.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One span as OTLP/JSON spells it, in the few fields a test reads back. */
export interface Received {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status: { code?: number; message?: string };
  attributes: { key: string; value: Record<string, unknown> }[];
}

/** A collector a test can start, read and stop. */
export interface Collector {
  url: string;
  /** Every span it has been sent, in the order the batches arrived. */
  spans(): Received[];
  /** The service.name each batch carried, one entry per batch. */
  services(): string[];
  /** The headers of the last batch, so a test can say a collector's key was sent. */
  headers(): Record<string, string | string[] | undefined>;
  /** How many batches have arrived, so a test can wait for one rather than sleep. */
  batches(): number;
  stop(): Promise<void>;
}

/** One span's attributes as a plain table, so a test reads `wilanis.connection` rather than a list entry. */
export function attributesOf(span: Received): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const one of span.attributes ?? []) out[one.key] = Object.values(one.value)[0];
  return out;
}

/** The value OTLP wrapped in a resource attribute, which is where service.name rides. */
function serviceOf(batch: Record<string, unknown>): string {
  const resource = (batch.resource ?? {}) as { attributes?: { key: string; value: Record<string, unknown> }[] };
  const found = (resource.attributes ?? []).find(one => one.key === 'service.name');
  return found ? String(Object.values(found.value)[0]) : '';
}

/** What one POSTed body says: the spans it carried, and the service each batch was sent under. */
function read(body: string): { spans: Received[]; services: string[] } {
  const out: { spans: Received[]; services: string[] } = { spans: [], services: [] };
  let sent: { resourceSpans?: Record<string, unknown>[] };
  try {
    sent = JSON.parse(body);
  } catch {
    return out; // a body that is not OTLP carries nothing; a test that expected a span fails on the count
  }
  for (const batch of sent.resourceSpans ?? []) {
    out.services.push(serviceOf(batch));
    for (const scope of (batch.scopeSpans ?? []) as { spans?: Received[] }[]) out.spans.push(...(scope.spans ?? []));
  }
  return out;
}

/**
 * Start a collector on a port the operating system picks, so tests never collide. It answers every POST with
 * `{}` and a 200, which is what a real collector answers when it has taken a batch.
 */
export async function collector(): Promise<Collector> {
  const received: Received[] = [];
  const services: string[] = [];
  let headers: Record<string, string | string[] | undefined> = {};
  let batches = 0;

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      headers = req.headers;
      batches++;
      const sent = read(body);
      received.push(...sent.spans);
      services.push(...sent.services);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });

  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/v1/traces`,
    spans: () => received,
    services: () => services,
    headers: () => headers,
    batches: () => batches,
    stop: () => new Promise<void>(done => server.close(() => done())),
  };
}

/** Wait for something a batch settles into, rather than a fixed sleep. */
export async function until(ok: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise(done => setTimeout(done, 10));
  return ok();
}
