import { existsSync, readdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import { readAll, type Type, TypeResolver } from '@wilanis/core';
import { FileBlobStore } from '@wilanis/runtime';
import { afterAll, describe, expect, it } from 'vitest';
import plugin, { CsvRows } from '../src/index.js';

const store = new FileBlobStore(process.cwd());
afterAll(() => store.destroy());
const types = new TypeResolver(() => undefined);
const ROW: Type = types.inline({
  fields: {
    url: { type: 'string' },
    method: { type: 'string', enum: ['GET', 'POST'] },
    hits: { type: 'number', required: false },
    ok: { type: 'boolean', required: false },
  },
});
const env = { blobs: store, resolveType: (ref: string) => (ref === 'Row' ? ROW : types.ref(ref)) };
const ctx = { env, nodePath: [], attach: () => {} } as never;
const run = (op: string, inputs: Record<string, unknown>) => plugin.handlers[`@blob/${op}`]({ in: inputs, ctx });
const text = async (stream: Readable) => (await readAll(stream)).toString('utf8');

describe('the file store', () => {
  it('streams bytes in, counts them, hands a handle; streams them back out; drops them', async () => {
    const handle = await store.put(Readable.from([Buffer.from('ab'), Buffer.from('cde')]), {
      contentType: 'text/plain',
      filename: 'x.txt',
    });
    expect(handle).toMatchObject({ contentType: 'text/plain', filename: 'x.txt', size: 5 });
    expect(existsSync(`${store.dir}/${handle.id}`)).toBe(true);
    expect(await text(store.open(handle))).toBe('abcde');
    await store.drop(handle);
    expect(existsSync(`${store.dir}/${handle.id}`)).toBe(false);
    expect(() => store.open(handle)).toThrow('no blob');
  });
  it('opens nothing it does not hold: a handle written by hand is refused, whatever its id says', () => {
    expect(() => store.open({ id: '../../etc/passwd', contentType: 'text/plain', size: 1 })).toThrow('no blob');
    expect(() =>
      store.open({ id: '00000000-0000-4000-8000-000000000000', contentType: 'text/plain', size: 1 }),
    ).toThrow('no blob');
  });
  it('a scope releases what was put through it, and only that', async () => {
    const kept = await store.put('kept', { contentType: 'text/plain' });
    const scope = store.scope();
    const mine = await scope.put('mine', { contentType: 'text/plain' });
    expect(await text(scope.open(kept))).toBe('kept'); // a scope reads the whole store
    await scope.release();
    expect(() => store.open(mine)).toThrow('no blob');
    expect(await text(store.open(kept))).toBe('kept');
    await store.drop(kept);
    expect(readdirSync(store.dir)).toEqual([]);
  });
});

describe('CSV rows, fed in pieces', () => {
  const rows = (pieces: string[]) => {
    const parser = new CsvRows();
    const out = pieces.flatMap(piece => parser.feed(piece));
    return [...out, ...parser.end()];
  };
  it('splits fields and lines, CRLF or LF, and keeps the last line without a newline', () => {
    expect(rows(['a,b\r\n1,2\n3,4'])).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });
  it('quotes: a comma, a newline and a doubled quote inside a quoted field are text', () => {
    expect(rows(['"x,y","line\nbreak","say ""hi"""\n'])).toEqual([['x,y', 'line\nbreak', 'say "hi"']]);
  });
  it('a chunk boundary anywhere -- inside a field, a quote, or a CRLF -- changes nothing', () => {
    const whole = 'a,"b,c"\r\n"d""e",f\r\n';
    const one = rows([whole]);
    for (let at = 1; at < whole.length; at++)
      expect(rows([whole.slice(0, at), whole.slice(at)]), `split at ${at}`).toEqual(one);
  });
  it('an empty trailing field and an empty file', () => {
    expect(rows(['a,\n'])).toEqual([['a', '']]);
    expect(rows([''])).toEqual([]);
  });
});

describe('csv.port.json', () => {
  it('parse: rows of the declared shape, numbers and booleans from text, empty optional cells absent', async () => {
    const file = await store.put('url,method,hits,ok\nhttps://a/,GET,3,true\n"https://b/?x=1,2",POST,,\n', {
      contentType: 'text/csv',
    });
    expect(await run('csv.port.json#parse', { file, type: 'Row' })).toEqual([
      { url: 'https://a/', method: 'GET', hits: 3, ok: true },
      { url: 'https://b/?x=1,2', method: 'POST' },
    ]);
  });
  it('parse: a row that does not fit the shape fails with its line', async () => {
    const file = await store.put('url,method\nhttps://a/,PATCH\n', { contentType: 'text/csv' });
    await expect(run('csv.port.json#parse', { file, type: 'Row' })).rejects.toThrow('row 2.method: "PATCH" not in');
  });
  it('parse: once the signal aborts it stops between rows, reads no further chunk and closes the stream', async () => {
    const file = await store.put('', { contentType: 'text/csv' });
    const control = new AbortController();
    const pulled: number[] = [];
    let closed = false;
    const chunk = (at: number) => {
      pulled.push(at);
      if (at === 3) control.abort(); // the run is cancelled while the file is still arriving
      return Buffer.from(at === 1 ? 'url,method\n' : `https://a/${at},GET\nhttps://b/${at},POST\n`);
    };
    async function* chunks() {
      try {
        for (let at = 1; at <= 100; at++) yield chunk(at);
      } finally {
        closed = true;
      }
    }
    const blobs = { open: () => Readable.from(chunks()) };
    const aborting = { env: { ...env, blobs }, nodePath: [], attach: () => {}, signal: control.signal } as never;
    const parse = plugin.handlers['@blob/csv.port.json#parse'];
    await expect(parse({ in: { file, type: 'Row' }, ctx: aborting })).rejects.toThrow('This operation was aborted');
    expect(pulled).toEqual([1, 2, 3]);
    expect(closed).toBe(true);
  });
  it('parse: a signal already aborted opens nothing', async () => {
    const file = await store.put('url,method\nhttps://a/,GET\n', { contentType: 'text/csv' });
    let opened = false;
    const blobs = {
      open: () => {
        opened = true;
        return store.open(file);
      },
    };
    const aborted = { env: { ...env, blobs }, nodePath: [], attach: () => {}, signal: AbortSignal.abort() } as never;
    const parse = plugin.handlers['@blob/csv.port.json#parse'];
    await expect(parse({ in: { file, type: 'Row' }, ctx: aborted })).rejects.toThrow('This operation was aborted');
    expect(opened).toBe(false);
  });
  it('parse: a signal that never aborts changes nothing', async () => {
    const file = await store.put('url,method\nhttps://a/,GET\n', { contentType: 'text/csv' });
    const listening = { env, nodePath: [], attach: () => {}, signal: new AbortController().signal } as never;
    const parse = plugin.handlers['@blob/csv.port.json#parse'];
    expect(await parse({ in: { file, type: 'Row' }, ctx: listening })).toEqual([{ url: 'https://a/', method: 'GET' }]);
  });
  it("write: the shape's columns in order, quoting what needs it; the handle carries the filename; parse reads it back", async () => {
    const written = (await run('csv.port.json#write', {
      rows: [
        { url: 'https://a/', method: 'GET', hits: 1 },
        { method: 'POST', url: 'https://b/,c', ok: false },
      ],
      type: 'Row',
      filename: 'out.csv',
    })) as { id: string; contentType: string; size: number };
    expect(written).toMatchObject({ contentType: 'text/csv; charset=utf-8', filename: 'out.csv' });
    expect(await text(store.open(written))).toBe(
      'url,method,hits,ok\r\nhttps://a/,GET,1,\r\n"https://b/,c",POST,,false\r\n',
    );
    expect(await run('csv.port.json#parse', { file: written, type: 'Row' })).toEqual([
      { url: 'https://a/', method: 'GET', hits: 1 },
      { url: 'https://b/,c', method: 'POST', ok: false },
    ]);
  });
});

describe('csv.port.json: columns, a header name read into a field of another name', () => {
  const Pair: Type = types.inline({
    fields: { entity: { type: 'string' }, degree: { type: 'number' }, averageRevs: { type: 'number' } },
  });
  const pairs = { ...env, resolveType: (ref: string) => (ref === 'Pair' ? Pair : env.resolveType(ref)) };
  const pairCtx = { env: pairs, nodePath: [], attach: () => {} } as never;
  const onPairs = (op: string, inputs: Record<string, unknown>) =>
    plugin.handlers[`@blob/${op}`]({ in: inputs, ctx: pairCtx });
  const csv = (body: string) => store.put(body, { contentType: 'text/csv' });

  it('parse: the mapped column is read into its field and coerced by its type', async () => {
    const file = await csv('url,method,hit-count\nhttps://a/,GET,3\n');
    expect(await run('csv.port.json#parse', { file, type: 'Row', columns: { 'hit-count': 'hits' } })).toEqual([
      { url: 'https://a/', method: 'GET', hits: 3 },
    ]);
  });
  it('parse: mapped and unmapped columns mixed in one header, each into its field', async () => {
    const file = await csv('entity,average-revs,degree\na.ts,4.5,80\n');
    const columns = { 'average-revs': 'averageRevs' };
    expect(await onPairs('csv.port.json#parse', { file, type: 'Pair', columns })).toEqual([
      { entity: 'a.ts', degree: 80, averageRevs: 4.5 },
    ]);
  });
  it('parse: a key no header writes changes nothing, and a required field it was meant for fails the first row', async () => {
    const plain = await csv('url,method\nhttps://a/,GET\n');
    expect(await run('csv.port.json#parse', { file: plain, type: 'Row', columns: { 'hit-count': 'hits' } })).toEqual([
      { url: 'https://a/', method: 'GET' },
    ]);
    const file = await csv('entity,degree\na.ts,80\n');
    const columns = { 'average-revs': 'averageRevs' };
    await expect(onPairs('csv.port.json#parse', { file, type: 'Pair', columns })).rejects.toThrow(
      'row 2.averageRevs: required',
    );
  });
  it('write: the mapped field under its header, in the shape order; parse with the same map gives the rows back', async () => {
    const rows = [
      { url: 'https://a/', method: 'GET', hits: 2, ok: true },
      { url: 'https://b/', method: 'POST' },
    ];
    const columns = { 'hit-count': 'hits' };
    const file = await run('csv.port.json#write', { rows, type: 'Row', columns });
    expect(await text(store.open(file as never))).toBe(
      'url,method,hit-count,ok\r\nhttps://a/,GET,2,true\r\nhttps://b/,POST,,\r\n',
    );
    expect(await run('csv.port.json#parse', { file, type: 'Row', columns })).toEqual(rows);
  });

  const fails = async (columns: Record<string, unknown>, message: string) => {
    const file = await csv(''); // an empty file: the map is judged before anything is read
    await expect(onPairs('csv.port.json#parse', { file, type: 'Pair', columns })).rejects.toThrow(message);
    await expect(onPairs('csv.port.json#write', { rows: [], type: 'Pair', columns })).rejects.toThrow(message);
  };
  it('a map value that is not a field fails parse and write before a byte is read or written', async () => {
    await fails(
      { 'average-revs': 'avgRevs' },
      "csv columns: 'average-revs' maps to 'avgRevs', which is not a field of Pair (fields: entity, degree, averageRevs)",
    );
  });
  it('two keys that map to one field fail both operations', async () => {
    await fails(
      { 'average-revs': 'averageRevs', avg: 'averageRevs' },
      "csv columns: 'average-revs' and 'avg' both map to 'averageRevs'",
    );
  });
  it("a key that is another field's own header fails both operations", async () => {
    await fails(
      { degree: 'averageRevs' },
      "csv columns: 'degree' maps to 'averageRevs', and 'degree' is also the header of the field 'degree'",
    );
  });
  it('a key with spaces around it fails both operations, since a header cell is read trimmed', async () => {
    await fails(
      { ' average-revs': 'averageRevs' },
      "csv columns: ' average-revs' has spaces around it, and a header cell is read trimmed, so it never matches; write 'average-revs'",
    );
  });
  it('a swap and an identity are maps like any other, and give the file back', async () => {
    for (const columns of [{ degree: 'averageRevs', averageRevs: 'degree' }, { degree: 'degree' }]) {
      const rows = [{ entity: 'a.ts', degree: 80, averageRevs: 4.5 }];
      const file = await onPairs('csv.port.json#write', { rows, type: 'Pair', columns });
      expect(await onPairs('csv.port.json#parse', { file, type: 'Pair', columns })).toEqual(rows);
    }
    const swapped = await onPairs('csv.port.json#write', {
      rows: [{ entity: 'a.ts', degree: 80, averageRevs: 4.5 }],
      type: 'Pair',
      columns: { degree: 'averageRevs', averageRevs: 'degree' },
    });
    expect(await text(store.open(swapped as never))).toBe('entity,averageRevs,degree\r\na.ts,80,4.5\r\n');
  });
});

describe('text.port.json', () => {
  it('write then read, round trip, with the content type given or the default', async () => {
    const written = await run('text.port.json#write', {
      text: 'héllo',
      contentType: 'text/markdown',
      filename: 'a.md',
    });
    expect(written).toMatchObject({ contentType: 'text/markdown', filename: 'a.md', size: 6 });
    expect(await run('text.port.json#read', { file: written })).toBe('héllo');
    expect(await run('text.port.json#write', { text: 'x' })).toMatchObject({
      contentType: 'text/plain; charset=utf-8',
    });
  });
  it('read refuses a value that is not a blob', async () => {
    await expect(run('text.port.json#read', { file: 'not a handle' })).rejects.toThrow('file: not a blob');
  });
});
