/**
 * The multipart parser on its own: no server, no tree. A part arrives in whatever pieces the socket hands
 * over, so the cases feed the same body split at every offset and expect one answer.
 */
import type { Readable } from 'node:stream';
import type { BlobStore } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { MultipartParts } from '../src/multipart.js';

describe('multipart parts, fed in pieces', () => {
  const Boundary = 'X-BOUND';
  const Body = Buffer.from(
    `--${Boundary}\r\ncontent-disposition: form-data; name="note"\r\n\r\nhello world\r\n` +
      `--${Boundary}\r\ncontent-disposition: form-data; name="file"; filename="a.txt"\r\ncontent-type: text/plain\r\n\r\nFILE-CONTENTS-HERE\r\n` +
      `--${Boundary}--\r\n`,
  );
  /** A registry that keeps what it was streamed, so a test can read the part back. */
  const registry = () =>
    ({
      put: (stream: Readable, meta: Record<string, unknown>) =>
        new Promise(done => {
          const chunks: Buffer[] = [];
          stream.on('data', chunk => chunks.push(chunk as Buffer));
          stream.on('end', () => done({ text: Buffer.concat(chunks).toString('utf8'), ...meta }));
        }),
    }) as unknown as BlobStore;
  const parse = async (pieces: Buffer[]) => {
    const parts = new MultipartParts(Boundary, registry());
    for (const piece of pieces) parts.feed(piece);
    return parts.end();
  };

  it('a text part is a string and a file part is streamed to the registry with its filename and type', async () => {
    expect(await parse([Body])).toEqual({
      note: 'hello world',
      file: { text: 'FILE-CONTENTS-HERE', contentType: 'text/plain', filename: 'a.txt' },
    });
  });

  it('a chunk boundary anywhere -- inside a part, its headers, or the delimiter -- changes nothing', async () => {
    const whole = await parse([Body]);
    for (let at = 1; at < Body.length; at++)
      expect(await parse([Body.subarray(0, at), Body.subarray(at)]), `split at ${at}`).toEqual(whole);
  });
});
