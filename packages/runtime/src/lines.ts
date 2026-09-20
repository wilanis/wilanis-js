/**
 * How one document's contract reads: a type as a reader sees it, one field of a shape or a settings block, and
 * one operation of a port with the inputs it accepts -- and, for a store, the engine behind it, the marks each
 * collection holds its records to, and the graphs that run against it. `wilanis describe` prints these; where a
 * type variable comes from is among them, since a contract that resolves a type says so and no caller repeats it.
 * A mark saying a name changed (`renamed`, `was`) is the tree's word and not a database's: nothing here opens a
 * connection, so each says only that `wilanis migrate` has yet to carry it everywhere.
 */
import {
  type Collection,
  keeps,
  type Loaded,
  type LoadResult,
  type PortDoc,
  type Scope,
  type StoreCollection,
  type StoreDoc,
  show,
} from '@wilanis/core';
import { readsLines } from './reads-said.js';
import { scopedOf, scopeLines } from './scope-said.js';
import { callsAgainst, engineOf, keyTypeOf } from './stores.js';

/** A spec as one reader sees it, or the spec itself when it does not resolve. */
export function shower(scope: Scope) {
  return (spec: unknown) => {
    try {
      return show(scope.types.spec(spec as string));
    } catch {
      return JSON.stringify(spec);
    }
  };
}

/** Where the variables one field binds come from: its own literal, or the path its `resolves` reads. */
function bindsOf(field: { binds?: string; resolves?: Record<string, string> }): string {
  const named = field.binds ? [`binds ${field.binds}`] : [];
  const resolved = Object.entries(field.resolves ?? {}).map(([variable, path]) => `binds ${variable} from ${path}`);
  const both = [...named, ...resolved];
  return both.length ? ` ${both.join(', ')}` : '';
}

/** One input one port's operation accepts: one type parameter is shown as `type`, and one static one says so. */
function acceptsLine(
  name: string,
  field: {
    type: unknown;
    required?: boolean;
    enum?: string[];
    binds?: string;
    static?: boolean;
    resolves?: Record<string, string>;
    description?: string;
  },
  showType: (spec: unknown) => string,
): string {
  const optional = field.required === false ? '?' : '';
  const type = field.type === 'type' ? 'type' : showType(field.type);
  const isStatic = field.static || field.type === 'type' ? '  (static)' : '';
  const allowed = field.enum ? ` ∈ ${field.enum.join('|')}` : '';
  const says = field.description ? `  -- ${field.description}` : '';
  return `    in  ${name}${optional}: ${type}${isStatic}${bindsOf(field)}${allowed}${says}`;
}

/**
 * What an operation says about itself: whether it is pure, may refuse, may take part in a transaction, or
 * holds something until stopped.
 */
function operationLine(
  name: string,
  op: { pure?: boolean; refuses?: unknown; transactional?: boolean; holds?: boolean; description?: string },
) {
  const pure = op.pure ? '  (pure)' : '';
  const refuses = op.refuses ? '  (refuses on purpose)' : '';
  const transactional = op.transactional ? '  (transactional)' : '';
  const holds = op.holds ? '  (holds until stopped)' : '';
  return `#${name}${pure}${refuses}${transactional}${holds}: ${op.description}`;
}

/**
 * The shape a port mostly works in: the document most of its operations answer in, counting a list of it as
 * the same shape. Naming it once and saying `returns it` below spares a reader the same path ten times over.
 *
 * Only a shape the tree has a document for is hoisted. A structural type is already the reader's answer --
 * `{record?: $T}` says what it is where it stands, and `works in {record?: $T}` above `returns it` would
 * make a port harder to read, not easier. A port whose operations do not mostly agree names each.
 */
function shapeOfPort(port: PortDoc, showType: (spec: unknown) => string): string | undefined {
  const counted = new Map<string, number>();
  let answering = 0;
  for (const op of Object.values(port.operations)) {
    if (!op.returns) continue;
    answering += 1;
    const bare = showType(op.returns).replace(/\[\]$/, '');
    if (bare.startsWith('@')) counted.set(bare, (counted.get(bare) ?? 0) + 1);
  }
  const [best, most] = [...counted].sort(([, one], [, other]) => other - one)[0] ?? [];
  // a strict majority, not merely the commonest: a port answering A, A, B, C, D, E does not work in A, and
  // hoisting it there would leave five operations naming their own beneath a line claiming to cover them
  return most * 2 > answering ? best : undefined;
}

/** What one operation answers, said against the shape the port works in where every operation shares it. */
const returnsLine = (shown: string, shape: string | undefined): string =>
  shape && (shown === shape || shown === `${shape}[]`)
    ? `    returns ${shown === shape ? 'it' : 'a list of them'}`
    : `    returns ${shown}`;

/**
 * A port: the shape its operations work in where they agree on one, then every operation, what it accepts and
 * what it answers. A port answering the same shape ten times said its path ten times; naming it once above
 * and then `returns it` says the same thing, and a port whose operations disagree still names each.
 */
export function portLines(doc: Loaded, showType: (spec: unknown) => string): string[] {
  const port = doc.doc as PortDoc;
  const shape = shapeOfPort(port, showType);
  const lines = shape ? [`works in  ${shape}`, ''] : [];
  for (const [name, op] of Object.entries(port.operations)) {
    lines.push(operationLine(name, op));
    for (const [field, accepts] of Object.entries(op.accepts ?? {})) lines.push(acceptsLine(field, accepts, showType));
    if (op.returns) lines.push(returnsLine(showType(op.returns), shape));
  }
  return lines;
}

/** What one field says about itself: optional, its type, the values it allows, what it binds, and its description. */
export function fieldLine(
  name: string,
  field: { type: unknown; required?: boolean; enum?: string[]; binds?: string; description?: string },
  showType: (spec: unknown) => string,
): string {
  const optional = field.required === false ? '?' : '';
  const type = typeof field.type === 'string' ? field.type : showType(field.type);
  const allowed = field.enum ? ` ∈ ${field.enum.join('|')}` : '';
  const binds = field.binds ? ` binds ${field.binds}` : '';
  const says = field.description ? `  -- ${field.description}` : '';
  return `    ${name}${optional}: ${type}${allowed}${binds}${says}`;
}

/** One mark of a collection, as its line reads: the family, and what that family says here. */
const markLine = (family: string, said: string) => `    ${family.padEnd(10)}  ${said}`;

/**
 * Every unique constraint, each composite in the order it was declared, so several read as several. A scoped
 * collection's constraints hold within the scope -- the engine adds the scope columns to each -- so the line
 * says so rather than letting a reader think two tenants cannot record the same call.
 */
function uniqueMark(collection: Collection): string[] {
  const constraints = collection.unique ?? [];
  if (!constraints.length) return [];
  const within = scopedOf(collection) ? '  (within the scope)' : '';
  return [markLine('unique', `${constraints.map(fields => `[${fields.join(', ')}]`).join(', ')}${within}`)];
}

/** Every reference, as the field, the records it names and what removing one of those does. */
function refsMark(collection: Collection, store: StoreDoc): string[] {
  const refs = Object.entries(collection.refs ?? {});
  if (!refs.length) return [];
  const said = refs.map(([field, ref]) => {
    const key = store.collections[ref.collection]?.key ?? '?';
    return `${field} → ${ref.collection}.${key}${ref.onRemove ? ` (${ref.onRemove} on remove)` : ''}`;
  });
  return [markLine('refs', said.join(', '))];
}

/** Every default, as the field and the literal an existing record receives when the column arrives. */
function defaultsMark(collection: Collection): string[] {
  const defaults = Object.entries(collection.defaults ?? {});
  if (!defaults.length) return [];
  return [markLine('default', defaults.map(([field, value]) => `${field} = ${JSON.stringify(value)}`).join(', '))];
}

/**
 * What a mark the database has not caught up with says under itself. `describe` reads the tree and opens no
 * connection, so it says which database still holds the old name for none of them: that is `--history`'s.
 */
const UNTIL_APPLIED = markLine('', 'until wilanis migrate has applied it everywhere');

/** Every renamed field, as the name now and the name before, since the database may still hold the old one. */
function renamedMark(collection: Collection): string[] {
  const renamed = Object.entries(collection.renamed ?? {});
  if (!renamed.length) return [];
  return [markLine('renamed', renamed.map(([now, before]) => `${now} ← ${before}`).join(', ')), UNTIL_APPLIED];
}

/** The name the collection had before this one, since the database may still keep its records under it. */
function wasMark(collection: Collection): string[] {
  if (!collection.was) return [];
  return [markLine('was', collection.was), UNTIL_APPLIED];
}

/** The key of a collection, with its type where the shape it names declares the field. */
function keyMark(collection: Collection, scope: Scope): string {
  const type = keyTypeOf(collection.of, collection.key, scope);
  return markLine('key', type ? `${collection.key}: ${type}` : collection.key);
}

/** What a collection's lines are read against: the store they belong to, the tree, and the types in it. */
interface Within {
  store: Loaded<StoreDoc>;
  load: LoadResult;
  scope: Scope;
}

/**
 * One collection that keeps records: the shape it holds, what identifies a record, every mark it declares, and
 * the scope it is under. The scope stands with the marks because it is one: a column the store keeps beside
 * the record, which the shape does not declare and no graph writes.
 */
function keepsLines(name: string, collection: Collection, within: Within): string[] {
  return [
    `  collection ${name}: ${collection.of}`,
    keyMark(collection, within.scope),
    ...uniqueMark(collection),
    ...scopeLines(name, collection, within.store, within.load).map(mark => markLine(mark.family, mark.said)),
    ...refsMark(collection, within.store.doc),
    ...defaultsMark(collection),
    ...renamedMark(collection),
    ...wasMark(collection),
    ...(collection.description ? [markLine('holds', collection.description)] : []),
  ];
}

/**
 * One collection that views another: whose rows it sees, and the policy every trigger reaching it attaches.
 * Both are on the heading, since what a reader wants of a view is the pair -- which scope it crosses and
 * behind what -- and a view has no marks of its own to put the second among.
 */
function viewLines(name: string, collection: StoreCollection): string[] {
  const behind = collection.behind ? `, behind ${collection.behind}` : '';
  return [
    `  collection ${name}: view of ${collection.view}${behind}`,
    ...(collection.description ? [markLine('holds', collection.description)] : []),
  ];
}

/** One collection, in whichever of the two shapes it was written: a view says what it views, and nothing more. */
function collectionLines(name: string, collection: StoreCollection, within: Within): string[] {
  return keeps(collection) ? keepsLines(name, collection, within) : viewLines(name, collection);
}

/**
 * Which engine keeps these records: the connection, and the plugin whose connection kind it is. Who implements
 * a thing is never a code detail, so a store says the package as a native port does.
 */
function engineLines(store: StoreDoc, scope: Scope): string[] {
  const engine = engineOf(store, scope);
  const lines = [`connection  ${engine.connection}`];
  if (!engine.kind) return lines;
  const granted = engine.plugin ? `  granted by ${engine.plugin}${engine.from ? ` (${engine.from})` : ''}` : '';
  return [...lines, `engine      ${engine.kind}${granted}`];
}

/** Every call site that runs an operation of the store port against this store, and which collection each names. */
function runLines(path: string, load: LoadResult, scope: Scope): string[] {
  const calls = callsAgainst(path, load, scope);
  if (!calls.length) return ['run against by  nothing yet -- no graph names this store'];
  return [
    'run against by (the operation each runs):',
    ...calls.map(call => `    ${call.file}#${call.where}  ${call.op}${call.collection ? ` (${call.collection})` : ''}`),
  ];
}

/**
 * A store: the engine its records live behind, the reads its scopes are filled from, every collection with
 * what it holds its records to, and the graphs that run an operation against it. A mark family with nothing
 * to say prints no line, so a collection that declares nothing reads as one.
 *
 * The reads stand above the collections, as a graph's stand above its nodes: every `{{name}}` in a `scoped`
 * below them is one of them, and a reader should not meet the use before the binding.
 */
export function storeLines(doc: Loaded, load: LoadResult, scope: Scope): string[] {
  const store = doc as Loaded<StoreDoc>;
  const within: Within = { store, load, scope };
  return [
    ...engineLines(store.doc, scope),
    ...readsLines(store.doc.reads, scope),
    ...Object.entries(store.doc.collections).flatMap(([name, collection]) => collectionLines(name, collection, within)),
    ...runLines(doc.path, load, scope),
  ];
}
