/**
 * What this engine alone can judge: X231 to X233, its own band. @storage judges a store against the shapes it
 * names and the contracts it holds to; what is here is narrower and is nobody else's business -- which types
 * this engine has a column for, which keys `newKey` can answer, and which names SQLite will keep apart.
 *
 * A rule here never mentions a graph, exactly as @storage's rules never mention an engine. Only the stores
 * kept over a connection of this plugin's kind are judged: the same documents over the memory engine mean
 * something this plugin has no opinion about.
 */
import { type ConnectionDoc, kept, type PluginCheckContext, type StoreDoc, type Type } from '@wilanis/core';
import { columnOf } from './columns.js';
import { folded, legal } from './names.js';
import { isIdentity, type Settings } from './settings.js';

type Scope = PluginCheckContext['scope'];
type Refuse = PluginCheckContext['refuse'];

const ROOT = '@storage-sqlite';
const KIND = `${ROOT}/sqlite.connection-kind.json`;
const HINT_KEY = "set the plugin's keyType under project.json, or key the collection by another field";

/** One collection kept over a sqlite connection, as a rule reads it. */
interface Kept {
  file: string;
  connection: string;
  name: string;
  key: string;
  shape: Type;
}

/**
 * The record type a collection declares, where the tree holds one. A rule judges what a store says against
 * the shape it names, and where that shape is not there the store itself is already refused (R001) -- so this
 * answers nothing rather than throwing. A plugin's `check` refuses; it never fails the check itself.
 */
function shapeOf(scope: Scope, ref: string): Type | undefined {
  try {
    return scope.types.spec(ref);
  } catch {
    return undefined; // R001, where the store is judged
  }
}

/** Every collection this engine would have to keep: the record-keeping ones whose store names a connection of its kind. */
function keptHere(scope: Scope): Kept[] {
  const kind = scope.canon(KIND);
  const out: Kept[] = [];
  for (const store of scope.registry.all('store')) {
    const doc = store.doc as StoreDoc;
    const connection = scope.get('connection', scope.canon(doc.connection));
    if (!connection || scope.canon((connection.doc as ConnectionDoc).kind) !== kind) continue;
    for (const [name, collection] of kept(doc)) {
      const shape = shapeOf(scope, collection.of);
      if (!shape) continue;
      out.push({ file: store.path, connection: scope.canon(doc.connection), name, key: collection.key, shape });
    }
  }
  return out;
}

/** X231: a field of a kept collection that this engine has no column for. */
function checkColumns(kept: Kept, refuse: Refuse): void {
  if (kept.shape.kind !== 'object') return;
  for (const [field, declared] of Object.entries(kept.shape.fields)) {
    if (columnOf(declared.type)) continue;
    refuse({
      code: 'X231',
      file: kept.file,
      message: `'${field}' is a blob, and this engine has no column for one: the bytes live in the blob registry`,
      at: `collections/${kept.name}/of`,
      hint: "store the handle's id as a string, and read the bytes through @blob",
    });
  }
}

/**
 * X232: a key this engine cannot key by, or one `newKey` cannot answer under the keyType it was given. `newKey`
 * answers a uuidv7 for a string key and a reserved number for a number key under `identity`, and nothing else.
 */
function checkKey(kept: Kept, identity: boolean, refuse: Refuse): void {
  if (kept.shape.kind !== 'object') return;
  const key = kept.shape.fields[kept.key]?.type;
  if (!key) return;
  const at = `collections/${kept.name}/key`;
  const say = (message: string) => refuse({ code: 'X232', file: kept.file, message, at, hint: HINT_KEY });
  if (key.kind !== 'string' && key.kind !== 'number') {
    say(`'${kept.key}' is ${key.kind}, and this engine keys by a string or a number`);
    return;
  }
  if (key.kind === 'string' && identity) say(`keyType 'identity' counts, and '${kept.key}' is a string`);
  if (key.kind === 'number' && !identity) say(`keyType 'uuidv7' answers text, and '${kept.key}' is a number`);
}

/**
 * X233: a collection name SQLite will not keep, or two of one connection it will not keep apart. SQLite
 * compares identifiers without case, so `Entries` and `entries` are one table; two collections of one
 * connection that fold together are refused here, where X206 and X207 refuse what @storage can see.
 */
function checkNames(kept: Kept[], refuse: Refuse): void {
  const seen = new Map<string, Kept>();
  for (const one of kept) {
    const at = `collections/${one.name}`;
    const say = (message: string, hint: string) => refuse({ code: 'X233', file: one.file, message, at, hint });
    if (!legal(one.name)) {
      say(
        `'${one.name}' is not a table name this engine can create: a letter or an underscore, then letters, digits or underscores, and not beginning with sqlite_, which SQLite keeps for its own`,
        'rename the collection',
      );
      continue;
    }
    const key = `${one.connection} ${folded(one.name)}`;
    const first = seen.get(key);
    if (first && first.name !== one.name)
      say(
        `'${one.name}' and '${first.name}' are one table once folded to lower case, and SQLite compares names without case`,
        'rename one of the two collections',
      );
    else if (!first) seen.set(key, one);
  }
}

/** Every X23x refusal this tree earns. */
export function check(ctx: PluginCheckContext): void {
  const kept = keptHere(ctx.scope);
  const identity = isIdentity(ctx.settings as Settings);
  for (const one of kept) {
    checkColumns(one, ctx.refuse);
    checkKey(one, identity, ctx.refuse);
  }
  checkNames(kept, ctx.refuse);
}
