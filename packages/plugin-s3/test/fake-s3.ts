/**
 * An object store in this process, speaking the handful of S3 calls the store makes -- put, get, delete, and the
 * three steps of a multipart upload -- over HTTP, path-style, so the real client talks to it on the wire. It
 * checks no signature. It records what arrived, request by request, so a test can say what the store sent and
 * when; and it can be told to refuse a part, to show that an upload cut short leaves nothing behind.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One request as the fake saw it: the method, the operation it was, the key, and how many bytes its body held. */
export interface Seen {
  method: string;
  op: string;
  key: string;
  bytes: number;
}

/** What a test starts: the endpoint, what is kept and seen, what to refuse, and the way to stop it. */
export interface FakeS3 {
  endpoint: string;
  bucket: string;
  objects: Map<string, { body: Buffer; contentType: string }>;
  /** Multipart uploads opened and not yet completed or aborted, by upload id. */
  uploads: Map<string, { key: string; contentType: string; parts: Map<number, Buffer> }>;
  seen: Seen[];
  /** Every byte of every request body received so far, counted as each body ends. */
  received: () => number;
  /** A part number to answer with AccessDenied, for the upload that must be aborted. */
  refusePart?: number;
  close: () => Promise<void>;
}

/** What one operation is answered from: the key, the query, the body, and the content type it was sent with. */
interface Request {
  key: string;
  query: URLSearchParams;
  body: Buffer;
  contentType: string;
}

/** How the fake answers one operation. */
type Answer = (fake: FakeS3, at: Request, response: ServerResponse) => void;

/** The body of a request, whole: this is the store's side of the wire, not the code under test. */
async function bodyOf(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** An S3 error document with its status. */
function fail(response: ServerResponse, status: number, code: string) {
  response.writeHead(status, { 'content-type': 'application/xml' });
  response.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`);
}

/** An XML answer. */
function xml(response: ServerResponse, body: string) {
  response.writeHead(200, { 'content-type': 'application/xml' });
  response.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`);
}

/** The operation a request names, read the way S3 reads it: the method and the query. */
function opOf(method: string, query: URLSearchParams): string {
  if (method === 'POST' && query.has('uploads')) return 'createMultipartUpload';
  if (method === 'PUT' && query.has('partNumber')) return 'uploadPart';
  if (method === 'POST' && query.has('uploadId')) return 'completeMultipartUpload';
  if (method === 'DELETE' && query.has('uploadId')) return 'abortMultipartUpload';
  return { PUT: 'putObject', GET: 'getObject', DELETE: 'deleteObject', HEAD: 'headObject' }[method] ?? method;
}

/** The upload a request names by its `uploadId`, if the fake has it open. */
const uploadOf = (fake: FakeS3, at: Request) => fake.uploads.get(at.query.get('uploadId') ?? '');

/** The multipart steps: open an upload, take a part, join the parts, or give up. */
const MULTIPART: Record<string, Answer> = {
  createMultipartUpload(fake, { key, contentType }, response) {
    const id = randomUUID();
    fake.uploads.set(id, { key, contentType, parts: new Map() });
    xml(
      response,
      `<InitiateMultipartUploadResult><Bucket>${fake.bucket}</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
    );
  },
  uploadPart(fake, at, response) {
    const upload = uploadOf(fake, at);
    const number = Number(at.query.get('partNumber'));
    if (!upload) return fail(response, 404, 'NoSuchUpload');
    if (number === fake.refusePart) return fail(response, 403, 'AccessDenied');
    upload.parts.set(number, at.body);
    response.writeHead(200, { etag: `"part-${number}"` }).end();
  },
  completeMultipartUpload(fake, at, response) {
    const upload = uploadOf(fake, at);
    if (!upload) return fail(response, 404, 'NoSuchUpload');
    const parts = [...upload.parts.entries()].sort(([one], [other]) => one - other).map(([, part]) => part);
    fake.objects.set(at.key, { body: Buffer.concat(parts), contentType: upload.contentType });
    fake.uploads.delete(at.query.get('uploadId') ?? '');
    xml(
      response,
      `<CompleteMultipartUploadResult><Bucket>${fake.bucket}</Bucket><Key>${at.key}</Key><ETag>"whole"</ETag></CompleteMultipartUploadResult>`,
    );
  },
  abortMultipartUpload(fake, at, response) {
    fake.uploads.delete(at.query.get('uploadId') ?? '');
    response.writeHead(204).end();
  },
};

/** The object calls: put one whole, read one, delete one. */
const OBJECTS: Record<string, Answer> = {
  putObject(fake, { key, body, contentType }, response) {
    fake.objects.set(key, { body, contentType });
    response.writeHead(200, { etag: `"${randomUUID()}"` }).end();
  },
  getObject(fake, { key }, response) {
    const found = fake.objects.get(key);
    if (!found) return fail(response, 404, 'NoSuchKey');
    response.writeHead(200, { 'content-type': found.contentType, 'content-length': found.body.length });
    response.end(found.body);
  },
  deleteObject(fake, { key }, response) {
    fake.objects.delete(key);
    response.writeHead(204).end();
  },
};

/** Answer one operation against the fake's state; one it does not speak is NotImplemented. */
function answer(fake: FakeS3, op: string, at: Request, response: ServerResponse) {
  const handler = MULTIPART[op] ?? OBJECTS[op];
  if (handler) handler(fake, at, response);
  else fail(response, 501, 'NotImplemented');
}

/** Start the fake on a free port of this machine, keeping one bucket. */
export async function startFakeS3(bucket = 'uploads'): Promise<FakeS3> {
  let received = 0;
  const fake = {
    bucket,
    objects: new Map(),
    uploads: new Map(),
    seen: [] as Seen[],
    received: () => received,
  } as unknown as FakeS3;
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake');
    const [, name, ...rest] = decodeURIComponent(url.pathname).split('/');
    const body = await bodyOf(request);
    received += body.length;
    const op = opOf(request.method ?? 'GET', url.searchParams);
    const key = rest.join('/');
    fake.seen.push({ method: request.method ?? 'GET', op, key, bytes: body.length });
    if (name !== bucket) return fail(response, 404, 'NoSuchBucket');
    const contentType = request.headers['content-type'] ?? '';
    answer(fake, op, { key, query: url.searchParams, body, contentType }, response);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  fake.endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () =>
    new Promise<void>(done => {
      server.closeAllConnections();
      server.close(() => done());
    });
  return fake;
}

/** The settings of a bucket connection to the fake, as a connection document would write them once substituted. */
export const settingsOf = (fake: FakeS3, extra: Record<string, unknown> = {}) => ({
  endpoint: fake.endpoint,
  region: 'us-east-1',
  bucket: fake.bucket,
  accessKeyId: 'fake',
  secretAccessKey: 'fake',
  ...extra,
});
