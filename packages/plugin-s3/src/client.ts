/**
 * The few calls of the S3 API this plugin makes, as signed `fetch` requests against one bucket: no SDK, since
 * what is asked of the store is six requests and a signature. A body sent is one the caller holds (a part at
 * most); a body read is handed back as the response's stream, never read whole here. An answer that is not a
 * success throws with the store's own error code, and so does the one success that can carry an error, a
 * completed multipart upload.
 */
import { Readable } from 'node:stream';
import type { ReadableStream as WebStream } from 'node:stream/web';
import { encode, type Keys, sha256, signed } from './sign.js';

/** Where a bucket is and how to sign for it. */
export interface Endpoint {
  /** The store's origin, e.g. http://minio:9000. */
  endpoint: string;
  region: string;
  bucket: string;
  keys: Keys;
  /** true: `<endpoint>/<bucket>/<key>`; false: `<bucket>.<host>/<key>`. */
  pathStyle: boolean;
}

/** One request against the bucket: the method, the object's key (empty for the bucket), the query, the body. */
export interface Call {
  method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD';
  key: string;
  query?: Record<string, string>;
  body?: Buffer;
  headers?: Record<string, string>;
}

/** An answer the store refused, with the code it refused with (NoSuchKey, AccessDenied, ...) and its HTTP status. */
export class S3Error extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'S3Error';
  }
}

/** The text of the first element named `name` in an XML answer, unescaped. */
export function element(xml: string, name: string): string | undefined {
  const found = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1];
  return found
    ?.replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

/** The URL a call is sent to: the bucket addressed as the endpoint says, the key encoded segment by segment. */
function urlOf(at: Endpoint, call: Call): URL {
  const base = new URL(at.endpoint);
  const path = call.key ? `/${call.key.split('/').map(encode).join('/')}` : '';
  const url = at.pathStyle
    ? new URL(`${base.origin}/${encode(at.bucket)}${path}`)
    : new URL(`${base.protocol}//${at.bucket}.${base.host}${path || '/'}`);
  for (const [name, value] of Object.entries(call.query ?? {})) url.searchParams.set(name, value);
  return url;
}

/** Why the store refused, read off its error document where it sent one. */
async function refusalOf(response: Response): Promise<S3Error> {
  const text = await response.text().catch(() => '');
  const code = element(text, 'Code') ?? `HTTP ${response.status}`;
  return new S3Error(code, response.status, element(text, 'Message') ?? response.statusText);
}

/** A client of one bucket: every call signed with its keys. */
export class S3Wire {
  constructor(readonly at: Endpoint) {}

  /** Send one call; answers the response when the store accepted it, and throws what it refused with otherwise. */
  async send(call: Call): Promise<Response> {
    const url = urlOf(this.at, call);
    const body = call.body ?? Buffer.alloc(0);
    const unsigned = { method: call.method, url, headers: call.headers ?? {}, payloadHash: sha256(body) };
    const headers = signed(unsigned, this.at.keys, this.at.region);
    // a PUT or POST always carries a body, if an empty one, so the store is told its length
    const carries = call.method === 'PUT' || call.method === 'POST';
    const response = await fetch(url, {
      method: call.method,
      headers,
      ...(carries ? { body: new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.length) } : {}),
    });
    if (!response.ok) throw await refusalOf(response);
    return response;
  }

  /** Send one call whose answer is an XML document; throws when that document is an error, as a completion can be. */
  async xml(call: Call): Promise<string> {
    const text = await (await this.send(call)).text();
    if (/<Error>/.test(text))
      throw new S3Error(element(text, 'Code') ?? 'Error', 200, element(text, 'Message') ?? text);
    return text;
  }

  /** The body of an object as a stream, as the store sends it. */
  async stream(key: string): Promise<Readable> {
    const response = await this.send({ method: 'GET', key });
    if (!response.body) return Readable.from([]);
    return Readable.fromWeb(response.body as WebStream);
  }
}
