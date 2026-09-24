# @wilanis/plugin-s3

The `@s3` plugin for wilanis: the tree's blob registry kept in one bucket of an object store speaking the S3
API, so a file uploaded to one instance of a tree can be read on another. MinIO is the reference store; any
store that speaks the same API works, and nothing in the plugin names a cloud provider.

```
npm install @wilanis/plugin-s3
```

```json
{ "use": "@s3", "from": "@wilanis/plugin-s3" }
```

It grants one connection kind and no port. No graph touches bytes, so no document ever calls this plugin: the
runtime opens its store when `project.json → blobs` names a connection of its kind, and every codec and
operation that streams a blob in or out streams it to the bucket and back. Nothing under `features/` changes.

## The connection kind

`@s3/bucket.connection-kind.json`. The access key is a secret; the rest are facts about the one bucket:

```json
{
  "$schema": "@wilanis/connection.schema.json",
  "label": "Uploads bucket",
  "description": "where uploaded and generated files are kept while a run uses them",
  "kind": "@s3/bucket.connection-kind.json",
  "settings": {
    "endpoint": "http://minio.wilanis.svc:9000",
    "region": "us-east-1",
    "bucket": "customers-uploads",
    "prefix": "blobs",
    "accessKeyId": "{{secrets.s3Key}}",
    "secretAccessKey": "{{secrets.s3Secret}}"
  }
}
```

and in `project.json`:

```json
"blobs": { "connection": "@connections/uploads.connection.json" }
```

`prefix` is optional (objects sit at the root of the bucket without one). `forcePathStyle` is optional and
true by default, addressing the bucket as `<endpoint>/<bucket>`, which MinIO and most stores that are not AWS
need; set it to `false` for `<bucket>.<host>`. The plugin never creates a bucket.

A connection of this kind that `blobs.connection` does not name does nothing: the tree keeps its blobs in
files, and the bucket is never reached.

## What it does with the bytes

- **`put`** cuts the source into 5 MiB parts as it arrives and sends each before reading the next, so at
  most one part is held whatever the size of the file. A body that ends within its first part is one
  `PutObject`; anything longer is a multipart upload, aborted if the source or a part fails, so a write cut
  short leaves no parts behind. The size is counted as the bytes pass.
- **`open`** is the body stream of a `GetObject`, handed to the reader as it arrives.
- **`drop`** is a `DeleteObject`; a run's `release` deletes every object that run put.

Every object is keyed `<prefix>/<run id>/<uuid>`, and a handle's id is `<run id>/<uuid>`, so the key says which
run issued it. The store keeps no record of what it holds -- the instance that opens a handle need not be the
one that wrote it -- and `open` refuses a handle whose id is not of that form, without asking the bucket.

## Starting

When the tree's blobs are kept here, the plugin's `postLoad` puts one empty object under the prefix and deletes
it, before any startup step runs. A bucket that is missing, unreachable or not writable with the key given
fails `wilanis start` there, rather than the first upload:

```
plugin '@s3' postLoad: the blob registry's bucket 'customers-uploads' under 'blobs' cannot be written: NoSuchBucket: The specified bucket does not exist
```

The probe writes and deletes rather than asking whether the bucket exists, because those are what the store
does: a key allowed only `PutObject`, `GetObject` and `DeleteObject` under the prefix passes, and one that
may list the bucket but not write to it fails.

## The S3 API, spoken directly

The plugin sends six requests (`PutObject`, `GetObject`, `DeleteObject`, and the create, upload-part and
complete-or-abort steps of a multipart upload), each signed with Signature Version 4 over `fetch`. It carries
no SDK. Requests are not retried: a part that fails fails the upload, and the run that made it.

## Tests

The suite runs against an in-process fake that speaks the same six calls, so it needs nothing installed. One
file, `test/bucket.test.ts`, runs against a real store and is skipped without one. CI starts none, so run it
by hand before changing how the plugin speaks to a store. Any server speaking the S3 API will do;
[versitygw](https://github.com/versity/versitygw) passes it unchanged:

```
docker run -d --rm --name wilanis-s3 -p 59000:7070 \
  -e ROOT_ACCESS_KEY=wilanis -e ROOT_SECRET_KEY=wilanis-secret \
  versity/versitygw:v1.8.0 posix /tmp
WILANIS_TEST_S3_ENDPOINT=http://127.0.0.1:59000 npx vitest run packages/plugin-s3
```

Part of [wilanis](https://github.com/wilanis/wilanis-js). Apache-2.0.
