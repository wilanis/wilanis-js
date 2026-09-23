/**
 * Signature Version 4, the way every store speaking the S3 API authenticates a request: a canonical form of the
 * request hashed, then signed with a key derived from the secret, the day, the region and the service. Only
 * what this plugin sends is covered -- a path, a query, a few headers and a body it holds whole (one part at
 * most) -- so the payload is always hashed rather than sent unsigned.
 */
import { createHash, createHmac } from 'node:crypto';

/** The two halves of an access key: the id sent in the clear and the secret the signature is keyed on. */
export interface Keys {
  accessKeyId: string;
  secretAccessKey: string;
}

/** What is signed: the method, the URL, the headers that must be covered, and the hash of the body. */
export interface Unsigned {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
}

/** The hex sha-256 of some bytes. */
export const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data).digest();

/** A string percent-encoded the way SigV4 wants it: every byte but the unreserved ones. */
export const encode = (value: string): string =>
  encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/** The query, each key and value encoded, sorted by key: a key with no value is written `key=`. */
function canonicalQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .map(([key, value]) => [encode(key), encode(value)])
    .sort(([one], [other]) => (one < other ? -1 : Number(one > other)))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

/** The request in canonical form, and the names of the headers it covers. */
function canonicalOf(request: Unsigned): { canonical: string; signed: string } {
  const names = Object.keys(request.headers)
    .map(name => name.toLowerCase())
    .sort();
  const lowered = Object.fromEntries(
    Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const headers = names.map(name => `${name}:${lowered[name].trim()}\n`).join('');
  const signed = names.join(';');
  const canonical = [
    request.method,
    request.url.pathname,
    canonicalQuery(request.url),
    headers,
    signed,
    request.payloadHash,
  ].join('\n');
  return { canonical, signed };
}

/** `YYYYMMDDTHHMMSSZ`, the instant a signature is taken at. */
const stampOf = (at: Date): string =>
  at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

/**
 * The headers to send: the ones given, with `host`, `x-amz-date` and `x-amz-content-sha256` added and the
 * `authorization` that signs them all for `region` at `at`.
 */
export function signed(request: Unsigned, keys: Keys, region: string, at = new Date()): Record<string, string> {
  const stamp = stampOf(at);
  const day = stamp.slice(0, 8);
  const headers = {
    ...request.headers,
    host: request.url.host,
    'x-amz-content-sha256': request.payloadHash,
    'x-amz-date': stamp,
  };
  const { canonical, signed: names } = canonicalOf({ ...request, headers });
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n');
  const key = ['s3', 'aws4_request'].reduce(hmac, hmac(hmac(`AWS4${keys.secretAccessKey}`, day), region));
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${keys.accessKeyId}/${scope}, SignedHeaders=${names}, Signature=${signature}`;
  return { ...headers, authorization };
}
