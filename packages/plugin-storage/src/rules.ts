/**
 * What only @storage can judge about what a store declares, before anything runs. A store says which shapes
 * it keeps, under which collection names, over which connection; a call says which store and which collection
 * it means. The compiler has judged both generically by now -- the documents resolve (R001), the constraints
 * name fields the shape has (C003 to C008), the call gives what the contract accepts (G005, G006) -- and what
 * is left is what needs the port to be understood.
 *
 * X201 a collection keeps a core shape, or one a plugin grants: the world's shape is not what a tree keeps.
 * X202 a key identifies, so it is a field of that shape and a required one.
 * X203 a store's connection reaches a storage engine, which its kind says and nothing else can.
 * X204 a call names a store this tree holds, and a collection that store declares.
 * X207 two collections of one connection are one collection, so they may not declare different shapes.
 * X211 a patch changes fields the shape has, and never the key.
 * X212 ensure is reached by a startup step, and never run by a graph.
 * X213 a feature keeps its own records: it never names another feature's store.
 *
 * The filter a call gives -- X208, X209, X210 -- is judged in `filters.ts`, and where a call is written is
 * `calls.ts`. Two rows of RFC 0002's table are in neither, because the tree already answers them and a rule
 * lives in one place: an input an operation does not accept is G006, which names the inputs it does accept;
 * a collection name that is not an identifier is D001, from `propertyNames` on the store schema.
 */
import {
  assignable,
  type Collection,
  conforms,
  keeps,
  kept,
  type Loaded,
  type ObjField,
  type PluginCheckContext,
  type StoreDoc,
  show,
  type Type,
} from '@wilanis/core';
import { bindingCalls, type Call, collectionOf, graphCalls, operationOf } from './calls.js';
import { checkFilter } from './filters.js';

type Scope = PluginCheckContext['scope'];
type Refuse = PluginCheckContext['refuse'];

/** One collection under judgement: where it is written, and what it says. */
interface Kept {
  store: Loaded<StoreDoc>;
  name: string;
  collection: Collection;
}

/**
 * Every record-keeping collection of every store, so a rule over one reads the same thing a rule over all of
 * them does. A view keeps nothing, so there is no shape or key here to hold it to; its own rules are RFC 0015's.
 */
function every(scope: Scope): Kept[] {
  return scope.registry
    .all('store')
    .flatMap(store => kept(store.doc).map(([name, collection]) => ({ store, name, collection })));
}

/** X201, X202: what a collection keeps, and what identifies one record of it. */
function checkCollection(kept: Kept, scope: Scope, refuse: Refuse): void {
  const { store, name, collection } = kept;
  const at = `collections/${name}`;
  const shape = scope.get('shape', collection.of);
  if (!shape) return; // R001, where the store is judged
  if (!shape.native && shape.doc.layer !== 'core')
    refuse({
      code: 'X201',
      file: store.path,
      message: `'${collection.of}' is an edge shape, and the world's shape is not what a tree keeps`,
      at: `${at}/of`,
      hint: 'wilanis ls shape',
    });
  const field = shape.doc.fields[collection.key];
  if (!field) {
    const has = Object.keys(shape.doc.fields).join(', ') || 'none';
    refuse({
      code: 'X202',
      file: store.path,
      message: `'${collection.key}' is not a field of ${collection.of} (fields: ${has})`,
      at: `${at}/key`,
      hint: 'name a required field of the shape',
    });
    return;
  }
  if (field.required === false)
    refuse({
      code: 'X202',
      file: store.path,
      message: `'${collection.key}' is optional in ${collection.of}, and a key identifies every record`,
      at: `${at}/key`,
      hint: 'name a required field of the shape',
    });
}

/** X203: the connection a store sits on reaches an engine, which only its kind document says. */
function checkConnection(store: Loaded<StoreDoc>, scope: Scope, refuse: Refuse): void {
  const connection = scope.get('connection', store.doc.connection);
  if (!connection) return; // R001, where the store is judged
  const kind = scope.get('connection-kind', connection.doc.kind);
  const hint = `add the engine's plugin to project.json → plugins; wilanis ls connection`;
  const said = kind
    ? `is of kind '${connection.doc.kind}', which does not say "storage": true, so it reaches no engine`
    : `is of kind '${connection.doc.kind}', which no loaded plugin grants`;
  if (kind?.doc.storage !== true)
    refuse({ code: 'X203', file: store.path, message: `'${store.doc.connection}' ${said}`, at: 'connection', hint });
}

/** X207: a collection is the pair of its connection and its name, so one pair is one shape. */
function checkCollisions(scope: Scope, refuse: Refuse): void {
  const seen = new Map<string, { of: string; store: string }>();
  for (const { store, name, collection } of every(scope)) {
    const where = `${scope.canon(store.doc.connection)}/${name}`;
    const of = scope.canon(collection.of);
    const first = seen.get(where);
    if (!first) {
      seen.set(where, { of, store: store.path });
      continue;
    }
    if (first.of === of) continue;
    refuse({
      code: 'X207',
      file: store.path,
      message: `'${name}' over this connection already keeps ${first.of}, declared by ${first.store}, and here it keeps ${collection.of}`,
      at: `collections/${name}/of`,
      hint: 'rename one, or give both the same shape if the collection is meant to be shared',
    });
  }
}

/** X204: the store a call names is one this tree holds, and the collection is one that store declares. */
function checkCall(call: Call, scope: Scope, refuse: Refuse): void {
  const named = call.given?.store;
  if (typeof named !== 'string') return; // P001, where the call site is judged
  const store = scope.get('store', named);
  if (!store) {
    refuse({
      code: 'X204',
      file: call.file,
      message: `'${named}' is not a store of this tree`,
      at: `${call.at}/store`,
      hint: 'wilanis ls store',
    });
    return;
  }
  const collection = call.given?.collection;
  if (typeof collection !== 'string' || store.doc.collections[collection]) return;
  const has = Object.keys(store.doc.collections).join(', ');
  refuse({
    code: 'X204',
    file: call.file,
    message: `'${named}' declares no collection '${collection}' (collections: ${has})`,
    at: `${call.at}/collection`,
    hint: `wilanis describe ${named}`,
  });
}

/** The collection a call names, as the store declares it: the key and the shape, or nothing. */
function declaredOf(call: Call, scope: Scope): Collection | undefined {
  const named = call.given?.store;
  const collection = call.given?.collection;
  if (typeof named !== 'string' || typeof collection !== 'string') return undefined;
  const declared = scope.get('store', named)?.doc.collections[collection];
  return declared && keeps(declared) ? declared : undefined;
}

/** X211: one field of a literal `changes`, against the shape the collection keeps. */
function checkChange(call: Call, field: string, value: unknown, kept: Change): void {
  const { key, fields, refuse } = kept;
  if (field === key) {
    refuse({
      code: 'X211',
      file: call.file,
      message: `'${key}' identifies the record, and a patch never changes it`,
      at: `${call.at}/changes/${field}`,
      hint: 'a key identifies; it is never patched',
    });
    return;
  }
  const declared = fields[field];
  if (!declared) {
    refuse({
      code: 'X211',
      file: call.file,
      message: `'${field}' is not a field of ${kept.of} (fields: ${Object.keys(fields).join(', ') || 'none'})`,
      at: `${call.at}/changes/${field}`,
      hint: `wilanis describe ${call.given?.store}`,
    });
    return;
  }
  if (!kept.scope.literal(value)) return; // a read, typed where X209 types one
  const bad = conforms(value, declared.type, field);
  if (!bad) return;
  refuse({
    code: 'X211',
    file: call.file,
    message: `where a patch changes '${field}', ${bad}`,
    at: `${call.at}/changes/${field}`,
    hint: `${field} is ${show(declared.type)}`,
  });
}

/** What one `changes` is judged against: the collection's key, its fields, and the way to refuse. */
interface Change {
  key: string;
  of: string;
  fields: Record<string, ObjField>;
  scope: Scope;
  refuse: Refuse;
}

/**
 * X211: a `patch` changes fields the shape has, never the key, with values the fields would accept. A
 * `changes` that is one read is judged as an object against the shape with every field optional, since a
 * patch is exactly the partial write that shape describes.
 */
function checkChanges(call: Call, scope: Scope, refuse: Refuse): void {
  if (operationOf(call) !== 'patch') return;
  const declared = declaredOf(call, scope);
  const collection = collectionOf(call, scope);
  if (!declared || !collection) return; // X204, or R001 where the store is judged
  const changes = call.given?.changes;
  if (changes === undefined) return; // G006, where the call site is judged
  if (typeof changes === 'string') {
    checkWholeChange(call, changes, collection.shape, refuse);
    return;
  }
  if (typeof changes !== 'object' || changes === null || Array.isArray(changes)) return;
  const kept: Change = { key: declared.key, of: declared.of, fields: collection.fields, scope, refuse };
  for (const [field, value] of Object.entries(changes)) checkChange(call, field, value, kept);
}

/** X211: a `changes` that is one read, judged against the shape with every field optional. */
function checkWholeChange(call: Call, read: string, shape: Type, refuse: Refuse): void {
  if (!read.includes('{{')) return; // a literal string where an object belongs is G006's
  const want = partial(shape);
  const got = typeOfRead(read, call.reads);
  if (!got || assignable(got, want)) return;
  refuse({
    code: 'X211',
    file: call.file,
    message: `this reads ${show(got)}, and a patch changes ${show(want)}`,
    at: `${call.at}/changes`,
    hint: `wilanis describe ${call.given?.store}`,
  });
}

/** The shape a patch may write: every field of the record, each one optional. */
function partial(shape: Type): Type {
  if (shape.kind !== 'object') return shape;
  const fields: Record<string, ObjField> = {};
  for (const [name, field] of Object.entries(shape.fields)) fields[name] = { ...field, required: false };
  return { ...shape, fields };
}

/** The type a `{{in.*}}` read carries, where this plugin can see one. */
function typeOfRead(read: string, reads: Type | undefined): Type | undefined {
  const path = read
    .trim()
    .replace(/^\{\{|\}\}$/g, '')
    .trim();
  if (!path.startsWith('in.') || !reads || reads.kind !== 'object') return undefined;
  let at: Type | undefined = reads;
  for (const step of path.slice(3).split('.')) {
    if (at?.kind !== 'object') return undefined;
    at = at.fields[step]?.type;
  }
  return at;
}

/**
 * X212: `ensure` prepares the engine once, before the port opens, so a startup step reaches it and a graph
 * never runs it. What a tree prepares is what its project.json says it prepares.
 */
function checkEnsure(call: Call, scope: Scope, refuse: Refuse): void {
  if (operationOf(call) !== 'ensure') return;
  if (call.file.endsWith('.graph.json')) {
    refuse({
      code: 'X212',
      file: call.file,
      message: 'ensure prepares the engine once, before the port opens, and a graph never runs it',
      at: call.at,
      hint: 'name the domain operation in project.json → startup; ensure runs once, before the port opens',
    });
    return;
  }
  if (reachedByStartup(call, scope)) return;
  refuse({
    code: 'X212',
    file: call.file,
    message: 'this delegates to ensure, and no startup step reaches it under any profile',
    at: call.at,
    hint: 'name the domain operation in project.json → startup; ensure runs once, before the port opens',
  });
}

/** Whether any profile binds this port to the binding the call is written in. */
function bindsHere(port: string, file: string, scope: Scope): boolean {
  for (const profile of [undefined, ...scope.profiles()]) {
    const bound = scope.bindingFor(scope.canon(port), profile);
    if (typeof bound !== 'string' && bound.path === file) return true;
  }
  return false;
}

/** Whether a startup step reaches this binding operation, under any profile the project declares. */
function reachedByStartup(call: Call, scope: Scope): boolean {
  const operation = call.at.split('/')[1] ?? '';
  return (scope.project?.startup ?? []).some(step => {
    const [port, named] = String(step.run).split('#');
    return named === operation && bindsHere(port, call.file, scope);
  });
}

/** The feature a canonical path sits in: `@features/<name>/...` -> name; nothing for a native document. */
function featureAt(path: string): string | undefined {
  return /^@features\/([^/]+)\//.exec(path)?.[1];
}

/**
 * X213: a feature keeps its own records. A collection is an implementation detail of the feature that
 * declares it, and another feature asks that feature's domain port rather than its store.
 */
function checkOwnStore(call: Call, scope: Scope, refuse: Refuse): void {
  const named = call.given?.store;
  if (typeof named !== 'string') return; // P001, where the call site is judged
  const store = scope.get('store', named);
  if (!store) return; // X204
  const mine = featureAt(call.file);
  const theirs = featureAt(store.path);
  if (!mine || !theirs || mine === theirs) return;
  refuse({
    code: 'X213',
    file: call.file,
    message: `'${store.path}' is ${theirs}'s store, and this is ${mine}`,
    at: `${call.at}/store`,
    hint: "reach another feature's records through its domain port",
  });
}

/**
 * What only @storage can judge: X201, X202, X203, X204, X207 over what a store declares, X211 over what a
 * patch changes, X212 over where ensure is reached from, X213 over whose records a feature keeps -- and,
 * through `filters.ts`, X208 to X210 over what a call asks of the records.
 */
export function check({ scope, refuse }: PluginCheckContext): void {
  for (const kept of every(scope)) checkCollection(kept, scope, refuse);
  for (const store of scope.registry.all('store')) checkConnection(store, scope, refuse);
  checkCollisions(scope, refuse);
  for (const call of [...graphCalls(scope), ...bindingCalls(scope)]) {
    checkCall(call, scope, refuse);
    checkFilter(call, scope, refuse);
    checkChanges(call, scope, refuse);
    checkEnsure(call, scope, refuse);
    checkOwnStore(call, scope, refuse);
  }
}
