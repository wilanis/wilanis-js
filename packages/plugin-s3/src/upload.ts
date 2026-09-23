/**
 * Streaming bytes into one object. The source is cut into parts as it yields and each part is sent before the
 * next is read, so at most one part and one chunk are held at a time, whatever the size of the body. A body
 * that ends within its first part is one `PutObject`; any longer body is a multipart upload, aborted when the
 * source or a part fails, so a write cut short leaves no parts behind to be billed for.
 */
import type { Bucket } from './bucket.js';
import { element } from './client.js';

/** One part of a body: its bytes, and whether the source ended with it. */
interface Part {
  body: Buffer;
  last: boolean;
}

/** Where one object goes: the bucket, its key, and the content type it is stored with. */
export interface Target {
  bucket: Bucket;
  key: string;
  contentType: string;
}

/** The bytes of one chunk a source yields, whether it yields bytes or text. */
const bytesOf = (chunk: unknown): Buffer => (typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));

/** Text made safe to sit inside an XML element. */
const escaped = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/**
 * The source cut into parts of `size` bytes, the last one shorter. A full part is yielded only once a byte
 * beyond it has arrived, so a part that is yielded as not last is known to have one after it.
 */
async function* partsOf(source: AsyncIterable<unknown> | Iterable<unknown>, size: number): AsyncGenerator<Part> {
  let held: Buffer[] = [];
  let length = 0;
  for await (const chunk of source) {
    const bytes = bytesOf(chunk);
    held.push(bytes);
    length += bytes.length;
    while (length > size) {
      const all = Buffer.concat(held, length);
      yield { body: all.subarray(0, size), last: false };
      held = [all.subarray(size)];
      length -= size;
    }
  }
  yield { body: Buffer.concat(held, length), last: true };
}

/** A multipart upload opened on its first part and not before, so a body that fits one part never opens one. */
class Multipart {
  private id: string | undefined;
  /** The ETag the store answered for each part sent, in part order. */
  private readonly etags: string[] = [];

  constructor(private readonly target: Target) {}

  /** Whether an upload has been opened, and so must be completed or aborted. */
  get started(): boolean {
    return this.id !== undefined;
  }

  /** The upload's id, opening it first when no part has been sent yet. */
  private async opened(): Promise<string> {
    if (this.id !== undefined) return this.id;
    const { bucket, key, contentType } = this.target;
    const answer = await bucket.wire.xml({
      method: 'POST',
      key,
      query: { uploads: '' },
      headers: { 'content-type': contentType },
    });
    const id = element(answer, 'UploadId');
    if (!id) throw new Error(`@s3: the store opened an upload for '${key}' and answered no UploadId`);
    this.id = id;
    return id;
  }

  /** Send the next part. */
  async add(body: Buffer): Promise<void> {
    const uploadId = await this.opened();
    const partNumber = String(this.etags.length + 1);
    const { bucket, key } = this.target;
    const sent = await bucket.wire.send({ method: 'PUT', key, query: { partNumber, uploadId }, body });
    this.etags.push(sent.headers.get('etag') ?? '');
  }

  /** Join the parts sent into the object. */
  async complete(): Promise<void> {
    const { bucket, key } = this.target;
    const parts = this.etags
      .map((etag, at) => `<Part><PartNumber>${at + 1}</PartNumber><ETag>${escaped(etag)}</ETag></Part>`)
      .join('');
    const body = Buffer.from(`<CompleteMultipartUpload>${parts}</CompleteMultipartUpload>`);
    await bucket.wire.xml({
      method: 'POST',
      key,
      query: { uploadId: this.id ?? '' },
      body,
      headers: { 'content-type': 'application/xml' },
    });
  }

  /** Give up on the upload and the parts already sent; a failure to abort is not the error the caller needs. */
  async abort(): Promise<void> {
    if (this.id === undefined) return;
    const { bucket, key } = this.target;
    await bucket.wire.send({ method: 'DELETE', key, query: { uploadId: this.id } }).catch(() => undefined);
  }
}

/** Stream a source into the target object, part by part; answers how many bytes passed. */
export async function upload(target: Target, source: AsyncIterable<unknown> | Iterable<unknown>): Promise<number> {
  const multipart = new Multipart(target);
  let size = 0;
  try {
    for await (const part of partsOf(source, target.bucket.partSize)) {
      size += part.body.length;
      if (part.last && !multipart.started) await putWhole(target, part.body);
      else await multipart.add(part.body);
    }
    if (multipart.started) await multipart.complete();
    return size;
  } catch (error) {
    await multipart.abort();
    throw error;
  }
}

/** A body shorter than one part, sent as the one request it fits in. */
async function putWhole({ bucket, key, contentType }: Target, body: Buffer): Promise<void> {
  await bucket.wire.send({ method: 'PUT', key, body, headers: { 'content-type': contentType } });
}
