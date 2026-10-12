/**
 * @wilanis/plugin-blob, the @blob plugin: operations over stored files. A blob value is a handle; the bytes
 * live in the tree's registry (env.blobs) and are streamed here, never held whole beside it. CSV rows and
 * text are values; the file is not.
 */

import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import type { BlobStore, PluginModule } from '@wilanis/core';
import { conforms, isBlobHandle, readAll, show, type Type } from '@wilanis/core';
import type { Handler } from '@wilanis/engine';
import { CsvRows } from './csv.js';

export { CsvRows } from './csv.js';

const ROOT = '@blob';
/** The path of a document this plugin ships. */
const shipped = (name: string) => `${ROOT}/${name}`;
const DOCS = fileURLToPath(new URL('../docs', import.meta.url));

type Env = { blobs?: BlobStore; resolveType?: (ref: string) => Type };
type Row = Record<string, unknown>;

const storeOf = (env: Record<string, unknown>): BlobStore => {
  const blobs = (env as Env).blobs;
  if (!blobs) throw new Error('no blob registry in this environment');
  return blobs;
};
const handleOf = (value: unknown, name: string) => {
  if (!isBlobHandle(value)) throw new Error(`${name}: not a blob`);
  return value;
};
const rowType = (env: Record<string, unknown>, ref: unknown): Type | undefined => {
  const resolve = (env as Env).resolveType;
  return resolve && typeof ref === 'string' ? resolve(ref) : undefined;
};

// ---- the header of each field ----------------------------------------------------------------------------

const isRecord = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The field one entry of `columns` reads its header into; throws where the entry cannot mean one. */
function fieldOfEntry(key: string, value: unknown, fields: string[], ref: unknown): string {
  if (key !== key.trim())
    throw new Error(
      `csv columns: '${key}' has spaces around it, and a header cell is read trimmed, so it never matches; write '${key.trim()}'`,
    );
  if (typeof value !== 'string' || !fields.includes(value))
    throw new Error(
      `csv columns: '${key}' maps to '${String(value)}', which is not a field of ${String(ref)} (fields: ${fields.join(', ')})`,
    );
  return value;
}

/**
 * The header each field of the shape is read from and written under: the `columns` key that maps to it, else its
 * own name. Throws, and so fails the node before a byte is read or written, where the map names no field, gives two
 * fields one header, or writes a key with spaces around it.
 */
function headersOf(columns: unknown, type: Type | undefined, ref: unknown): Map<string, string> {
  const fields = type?.kind === 'object' ? Object.keys(type.fields) : [];
  const keyOf = new Map<string, string>();
  for (const [key, value] of Object.entries(isRecord(columns) ? columns : {})) {
    const field = fieldOfEntry(key, value, fields, ref);
    const other = keyOf.get(field);
    if (other !== undefined) throw new Error(`csv columns: '${other}' and '${key}' both map to '${field}'`);
    keyOf.set(field, key);
  }
  const headers = new Map(fields.map(field => [field, keyOf.get(field) ?? field]));
  for (const [field, key] of keyOf)
    if (key !== field && headers.get(key) === key)
      throw new Error(
        `csv columns: '${key}' maps to '${field}', and '${key}' is also the header of the field '${key}'`,
      );
  return headers;
}

// ---- CSV as rows of a shape ----------------------------------------------------------------------------

/** One text cell as a value of the field's type: numbers and booleans from their spelling, an empty optional cell absent. */
function cell(text: string, type: Type, required: boolean): unknown {
  if (text === '' && !required) return undefined;
  if (type.kind === 'number' && text.trim() !== '' && !Number.isNaN(Number(text))) return Number(text);
  if (type.kind === 'boolean' && (text === 'true' || text === 'false')) return text === 'true';
  return text;
}

/** One CSV row as an object of the row type, cells typed by the fields the header names. */
function rowOf(header: string[], cells: string[], type: Type): Row {
  const row: Row = {};
  for (const [index, name] of header.entries()) {
    const field = type.kind === 'object' ? type.fields[name] : undefined;
    const value = field ? cell(cells[index] ?? '', field.type, field.required) : (cells[index] ?? '');
    if (value !== undefined) row[name] = value;
  }
  return row;
}

/**
 * Rows of a shape, read from a CSV blob as it streams: the first line names the columns, each read into the field
 * whose header it is, else the field of its own name. Between one row and the
 * next it asks the run's signal, and once that has aborted it rejects as an aborted call does, so a cancelled
 * import reads no further into the file.
 */
class RowReader {
  private header: string[] | undefined;
  private line = 0;
  readonly rows: Row[] = [];

  private readonly fieldOf: Map<string, string>;

  constructor(
    private readonly type: Type,
    headers: Map<string, string>,
    private readonly signal: AbortSignal | undefined,
  ) {
    this.fieldOf = new Map([...headers].map(([field, header]) => [header, field]));
  }

  take(rows: string[][]): void {
    for (const cells of rows) {
      this.signal?.throwIfAborted();
      this.line++;
      if (!this.header) {
        this.header = cells.map(name => this.fieldOf.get(name.trim()) ?? name.trim());
        continue;
      }
      if (cells.length === 1 && cells[0] === '') continue; // a blank line
      const row = rowOf(this.header, cells, this.type);
      const bad = conforms(row, this.type, `row ${this.line}`);
      if (bad) throw new Error(`csv does not fit ${show(this.type)}: ${bad}`);
      this.rows.push(row);
    }
  }
}

/** The rows of a CSV blob, streamed; stops between rows, the stream closed, once the signal has aborted. */
async function parse(
  blobs: BlobStore,
  file: unknown,
  type: Type | undefined,
  { headers, signal }: { headers: Map<string, string>; signal?: AbortSignal },
): Promise<unknown[]> {
  if (!type) throw new Error("parse: 'type' must name the row shape");
  signal?.throwIfAborted();
  const decoder = new StringDecoder('utf8');
  const csv = new CsvRows();
  const reader = new RowReader(type, headers, signal);
  for await (const chunk of blobs.open(handleOf(file, 'file'))) reader.take(csv.feed(decoder.write(chunk as Buffer)));
  reader.take(csv.feed(decoder.end()));
  reader.take(csv.end());
  return reader.rows;
}

const quote = (value: unknown) => {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** The columns a CSV is written with: the shape's fields in order, else the first row's keys. */
function columnsOf(rows: unknown[], type: Type | undefined): string[] {
  if (type?.kind === 'object' && Object.keys(type.fields).length) return Object.keys(type.fields);
  return Object.keys((rows[0] ?? {}) as Row);
}

/** The lines of a CSV file: a header row, each column under the header `headers` gives it, else its own name; then the rows. */
function* lines(rows: unknown[], type: Type | undefined, headers: Map<string, string>): Iterable<string> {
  const columns = columnsOf(rows, type);
  yield `${columns.map(column => quote(headers.get(column) ?? column)).join(',')}\r\n`;
  for (const row of rows) yield `${columns.map(column => quote((row as Row)[column])).join(',')}\r\n`;
}

// ---- the operations ------------------------------------------------------------------------------------

const csvParse: Handler = async ({ in: input, ctx }) => {
  const type = rowType(ctx.env, input.type);
  const headers = headersOf(input.columns, type, input.type);
  return parse(storeOf(ctx.env), input.file, type, { headers, signal: ctx.signal });
};

const csvWrite: Handler = async ({ in: input, ctx }) => {
  const type = rowType(ctx.env, input.type);
  const headers = headersOf(input.columns, type, input.type);
  if (!Array.isArray(input.rows)) throw new Error('write: rows is not a list');
  return storeOf(ctx.env).put(Readable.from(lines(input.rows, type, headers)), {
    contentType: 'text/csv; charset=utf-8',
    filename: typeof input.filename === 'string' ? input.filename : undefined,
  });
};

const textRead: Handler = async ({ in: input, ctx }) =>
  (await readAll(storeOf(ctx.env).open(handleOf(input.file, 'file')))).toString('utf8');

const textWrite: Handler = async ({ in: input, ctx }) =>
  storeOf(ctx.env).put(String(input.text ?? ''), {
    contentType: typeof input.contentType === 'string' ? input.contentType : 'text/plain; charset=utf-8',
    filename: typeof input.filename === 'string' ? input.filename : undefined,
  });

const handlers: Record<string, Handler> = {
  [shipped('csv.port.json#parse')]: csvParse,
  [shipped('csv.port.json#write')]: csvWrite,
  [shipped('text.port.json#read')]: textRead,
  [shipped('text.port.json#write')]: textWrite,
};

const plugin: PluginModule = { root: ROOT, docs: DOCS, handlers };
export default plugin;
