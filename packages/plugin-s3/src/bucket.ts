/**
 * What a connection of `@s3/bucket.connection-kind.json` opens: a client of the bucket it names, signing with
 * its access key, and the prefix every key starts with. The settings arrive judged against the kind and with
 * their secrets substituted, so what is read here is only what the kind declared.
 */
import { S3Wire } from './client.js';

/** The smallest part the S3 API accepts for any but the last part of a multipart upload: 5 MiB. */
export const PART_SIZE = 5 * 1024 * 1024;

/** One bucket, reached: the client, the bucket's name, the prefix of every key, and the size a part is cut at. */
export interface Bucket {
  wire: S3Wire;
  name: string;
  /** The prefix without a slash at either end; empty when the connection names none. */
  prefix: string;
  partSize: number;
}

/** A setting the kind declares as a string, or the reason it cannot be read as one. */
function text(settings: Record<string, unknown>, name: string): string {
  const value = settings[name];
  if (typeof value !== 'string' || value === '')
    throw new Error(`@s3: the bucket connection's '${name}' is not set; the connection kind requires it`);
  return value;
}

/** The bucket a connection's settings name, with its client made and nothing sent yet. */
export function bucketOf(settings: Record<string, unknown>, partSize = PART_SIZE): Bucket {
  const prefix = typeof settings.prefix === 'string' ? settings.prefix.replace(/^\/+|\/+$/g, '') : '';
  const name = text(settings, 'bucket');
  const wire = new S3Wire({
    endpoint: text(settings, 'endpoint'),
    region: text(settings, 'region'),
    bucket: name,
    keys: { accessKeyId: text(settings, 'accessKeyId'), secretAccessKey: text(settings, 'secretAccessKey') },
    pathStyle: settings.forcePathStyle !== false,
  });
  return { wire, name, prefix, partSize };
}

/** The key an object is kept at: the prefix, then the handle's id, which is `<run id>/<uuid>`. */
export const keyOf = (bucket: Bucket, id: string): string => (bucket.prefix ? `${bucket.prefix}/${id}` : id);
