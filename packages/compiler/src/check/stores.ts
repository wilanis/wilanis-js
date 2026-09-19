/**
 * Stores. A store's connection and the shape of every collection resolve and are visible to it (R001, L005);
 * what it holds its records to -- unique, refs and defaults -- names fields that shape has and values it would
 * accept (C003 to C008); and the marks that say what a field or the collection was called before name
 * something a rename could have come from (C010, C011).
 *
 * Split from `contracts.ts` when the store rules passed the house limit: a shape, a port and a connection say
 * what they are, and a store says what it keeps and what it once called it.
 */
import {
  type Collection,
  conforms,
  keeps,
  kept,
  type Loaded,
  type ObjField,
  type StoreDoc,
  show,
  type Type,
} from '@wilanis/core';
import type { Judge, Refuser } from './judge.js';

/**
 * The refusals for a store: the connection it names and every collection's shape exist (R001) and are
 * visible to it (L005), what each collection holds its records to is judged against that shape (C003 to
 * C008), and its rename marks name something to rename (C010, C011). Nothing here judges what a store
 * *means* -- that a connection reaches an engine and that a key is a required field of its shape are
 * `@storage`'s (X202, X203), since only the plugin granting the port knows them. Nor does it judge whether a
 * rename *applies* to a database: the checker reads documents, and only the planner has the record.
 */
export function checkStore(judge: Judge, store: Loaded<StoreDoc>): void {
  const refuse = judge.refuser(store.path);
  const connection = judge.scope.get('connection', store.doc.connection);
  if (connection) judge.visible(store, connection, 'connection');
  else refuse('R001', `unknown connection '${store.doc.connection}'`, 'connection', 'wilanis ls connection');
  const keeping = kept(store.doc);
  const keptNames = keeping.map(([name]) => name);
  for (const [name, collection] of keeping) {
    const at = `collections/${name}/of`;
    const shape = judge.scope.get('shape', collection.of);
    if (!shape) {
      refuse('R001', `unknown shape '${collection.of}'`, at, 'wilanis ls shape');
      continue;
    }
    judge.visible(store, shape, at);
    const type = judge.type(collection.of, store.path, at);
    if (type) checkConstraints({ judge, refuse, store, name, collection, fields: fieldsOf(type), keptNames });
  }
  checkWas(judge, store);
}

/** What one collection's constraints are judged against, and where a refusal about them points. */
interface Kept {
  judge: Judge;
  refuse: Refuser;
  store: Loaded<StoreDoc>;
  name: string;
  collection: Collection;
  fields: Record<string, ObjField>;
  /** the collections of this store a reference may name: the ones that keep records. */
  keptNames: string[];
}

const fieldsOf = (type: Type): Record<string, ObjField> => (type.kind === 'object' ? type.fields : {});

/** Whether an engine holds no single value of a field: bytes live in the blob registry, and neither a shape nor a list is one value to index. */
const unholdable = (type: Type): boolean => type.kind === 'blob' || type.kind === 'object' || type.kind === 'list';

/** What every constraint of a collection is held to, each rule reading the shape the collection declares. */
function checkConstraints(kept: Kept): void {
  checkNames(kept);
  checkUnique(kept);
  checkRefs(kept);
  checkDefaults(kept);
  checkRenamed(kept);
}

/** Every field a constraint names, with the constraint it was named by and where that sits in the document. */
function named(kept: Kept): { field: string; at: string; constraint: 'unique' | 'refs' | 'defaults' }[] {
  const { collection, name } = kept;
  const where = `collections/${name}`;
  return [
    ...(collection.unique ?? []).flatMap((one, index) =>
      one.map(field => ({ field, at: `${where}/unique/${index}`, constraint: 'unique' as const })),
    ),
    ...Object.keys(collection.refs ?? {}).map(field => ({
      field,
      at: `${where}/refs/${field}`,
      constraint: 'refs' as const,
    })),
    ...Object.keys(collection.defaults ?? {}).map(field => ({
      field,
      at: `${where}/defaults/${field}`,
      constraint: 'defaults' as const,
    })),
  ];
}

/**
 * C003: a constraint names a field of the shape. C008: and one an engine can hold a value of -- bytes live in
 * the blob registry and a shape or a list is a value an engine indexes nothing of, so neither is constrained.
 */
function checkNames(kept: Kept): void {
  const { fields, refuse, collection } = kept;
  const has = Object.keys(fields).join(', ') || 'none';
  for (const { field, at, constraint } of named(kept)) {
    const declared = fields[field];
    if (!declared) {
      refuse(
        'C003',
        `'${field}' is not a field of ${collection.of} (fields: ${has})`,
        at,
        `wilanis describe ${collection.of}`,
      );
      continue;
    }
    if (constraint === 'defaults') continue;
    if (unholdable(declared.type))
      refuse(
        'C008',
        `'${field}' is ${show(declared.type)}, and a constraint names a value an engine can hold: a string, a number or a boolean`,
        at,
        `wilanis describe ${kept.store.doc.connection}`,
      );
  }
}

/**
 * C007: the key is unique already, so no constraint repeats it. That a constraint names each field once is
 * the schema's, through `uniqueItems` on the list (RFC 0003), and a rule lives in one place.
 */
function checkUnique(kept: Kept): void {
  const { collection, name, refuse } = kept;
  for (const [index, one] of (collection.unique ?? []).entries()) {
    if (!one.includes(collection.key)) continue;
    const at = `collections/${name}/unique/${index}`;
    refuse('C007', `'${collection.key}' keys this collection, so it is unique already`, at, HINT_ONCE);
  }
}

const HINT_ONCE = 'a key is unique already; a constraint names each field once';

/** C005, C006, C007: a reference stays within the store, is not the key, and is of the key's type. */
function checkRefs(kept: Kept): void {
  const { collection, name, refuse, store } = kept;
  for (const [field, ref] of Object.entries(collection.refs ?? {})) {
    const at = `collections/${name}/refs/${field}`;
    if (field === collection.key)
      refuse('C007', `'${field}' keys this collection, so it identifies rather than refers`, at, HINT_ONCE);
    const target = store.doc.collections[ref.collection];
    if (!target || !keeps(target)) {
      const has = kept.keptNames.join(', ');
      const hint = 'a reference stays within one store; declare the collection here, or read it by a second get';
      const why = target
        ? `views '${target.view}' and keeps no records of its own`
        : 'is not a collection of this store';
      refuse('C005', `'${ref.collection}' ${why} (collections: ${has})`, at, hint);
      continue;
    }
    checkRefType(kept, field, at, target);
  }
}

/**
 * C006: what a reference holds is what the collection it names is keyed by. A field C008 already refused
 * holds no value to compare, and the target's shape is looked up quietly -- an unknown one is refused once,
 * where the collection declaring it is judged.
 */
function checkRefType(kept: Kept, field: string, at: string, target: Collection): void {
  const { judge, refuse, fields } = kept;
  const held = fields[field];
  if (held && unholdable(held.type)) return;
  const targetType = judge.quiet(target.of);
  const key = targetType && fieldsOf(targetType)[target.key];
  if (!held || !key) return;
  if (show(held.type) === show(key.type)) return;
  refuse(
    'C006',
    `'${field}' is ${show(held.type)}, and it refers to records keyed by ${show(key.type)}`,
    at,
    `${field} is ${show(held.type)}; ${target.of} is keyed by ${show(key.type)}`,
  );
}

/** C004: a default is a value the field would accept, and a key is never defaulted. */
function checkDefaults(kept: Kept): void {
  const { collection, name, fields, refuse } = kept;
  for (const [field, value] of Object.entries(collection.defaults ?? {})) {
    const at = `collections/${name}/defaults/${field}`;
    const declared = fields[field];
    if (field === collection.key) {
      refuse('C004', `'${field}' keys this collection, and a key is never defaulted`, at, HINT_DEFAULT(declared));
      continue;
    }
    if (!declared) continue;
    const bad = conforms(value, declared.type, field);
    if (bad) refuse('C004', bad, at, HINT_DEFAULT(declared));
  }
}

const HINT_DEFAULT = (declared: ObjField | undefined) =>
  `write a literal of type ${declared ? show(declared.type) : "the field's"}; a key is never defaulted`;

/**
 * C010: `renamed` is keyed by the field's name now and holds its name before, so a key names a field the
 * shape has, a value names one it no longer has, and no two keys claim the same column. One entry answers one
 * refusal: a key the shape lacks has nothing to rename to, and what it once was called says nothing further.
 * A key named by `renamed` may be the collection's own key: a key is a column like any other, and renaming it
 * loses nothing.
 */
function checkRenamed(kept: Kept): void {
  const { collection, name, refuse } = kept;
  const hint = `renamed is keyed by the field's name now and holds its name before: wilanis describe ${collection.of}`;
  const taken = new Map<string, string>();
  for (const [field, before] of Object.entries(collection.renamed ?? {})) {
    const wrong = wrongRename(kept, field, before, taken);
    if (wrong) refuse('C010', wrong, `collections/${name}/renamed/${field}`, hint);
    else taken.set(before, field);
  }
}

/** What is wrong with one entry of `renamed`, or nothing: the key, the name it held, or a name claimed twice. */
function wrongRename(kept: Kept, field: string, before: string, taken: Map<string, string>): string | undefined {
  const { collection, fields } = kept;
  if (!fields[field]) {
    const has = Object.keys(fields).join(', ') || 'none';
    return `'${field}' is not a field of ${collection.of} (fields: ${has})`;
  }
  if (fields[before]) return `'${before}' is a field of ${collection.of} still, so nothing was renamed to '${field}'`;
  const already = taken.get(before);
  if (already) return `'${before}' is already what '${already}' was called: one column cannot become two`;
  return undefined;
}

/**
 * C011: `was` is the collection's previous name on this connection, so nothing is named that now -- not the
 * collection itself, not another collection of this store, and not a collection of another store on the same
 * connection, since the pair (connection, name) names a table (RFC 0002).
 */
function checkWas(judge: Judge, store: Loaded<StoreDoc>): void {
  const refuse = judge.refuser(store.path);
  const hint = "was is the collection's previous name on this connection, and no collection is named that now";
  const connection = judge.scope.canon(store.doc.connection);
  const onConnection = namesOn(judge, connection);
  for (const [name, collection] of Object.entries(store.doc.collections)) {
    const was = collection.was;
    if (was === undefined) continue;
    const at = `collections/${name}/was`;
    if (was === name) {
      refuse('C011', `'${name}' is what this collection is called now, so it was never renamed`, at, hint);
      continue;
    }
    const where = onConnection.get(was);
    if (where) refuse('C011', `'${was}' names ${where} on this connection already`, at, hint);
  }
}

/** Every collection name taken on one connection, each saying which store declares it, for C011's message. */
function namesOn(judge: Judge, connection: string): Map<string, string> {
  const taken = new Map<string, string>();
  for (const other of judge.scope.registry.all('store')) {
    if (judge.scope.canon(other.doc.connection) !== connection) continue;
    for (const name of Object.keys(other.doc.collections)) {
      if (!taken.has(name)) taken.set(name, `a collection of ${other.path}`);
    }
  }
  return taken;
}
