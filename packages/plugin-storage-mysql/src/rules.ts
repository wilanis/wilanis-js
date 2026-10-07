/**
 * What this engine alone can judge: X241 to X243, its own band. @storage judges a store against the shapes it
 * names and the contracts it holds to; what is here is narrower and is nobody else's business -- which types
 * this engine has a column for, which keys `newKey` can answer, and which names MySQL will keep apart.
 *
 * A rule here never mentions a graph, exactly as @storage's rules never mention an engine. Only the stores
 * kept over a connection of this plugin's kind are judged: the same documents over the memory engine mean
 * something this plugin has no opinion about.
 */
import { type ConnectionDoc, kept, type PluginCheckContext, type StoreDoc, type Type } from '@wilanis/core';
import { columnTypeOf } from './columns.js';
import { folded } from './names.js';
import { isIdentity, type Settings } from './settings.js';

type Scope = PluginCheckContext['scope'];
type Refuse = PluginCheckContext['refuse'];

const ROOT = '@storage-mysql';
const KIND = `${ROOT}/mysql.connection-kind.json`;
const HINT_KEY = "set the plugin's keyType under project.json, or key the collection by another field";
/** The most characters MySQL keeps in a table name. */
const LONGEST = 64;

/** One collection kept over a mysql connection, as a rule reads it. */
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

/** X241: a field of a kept collection that this engine has no column for. */
function checkColumns(kept: Kept, refuse: Refuse): void {
  if (kept.shape.kind !== 'object') return;
  for (const [field, declared] of Object.entries(kept.shape.fields)) {
    if (columnTypeOf(declared.type)) continue;
    refuse({
      code: 'X241',
      file: kept.file,
      message: `'${field}' is a blob, and this engine has no column for one: the bytes live in the blob registry`,
      at: `collections/${kept.name}/of`,
      hint: "store the handle's id as a string, and read the bytes through @blob",
    });
  }
}

/**
 * X242: a key this engine cannot key by, or one `newKey` cannot answer under the keyType it was given, as X222
 * judges it for postgres. `newKey` answers a uuidv7 for a string key, and a number reserved from `wilanis_keys`
 * for a number key under `identity`, and nothing else.
 */
function checkKey(kept: Kept, identity: boolean, refuse: Refuse): void {
  if (kept.shape.kind !== 'object') return;
  const key = kept.shape.fields[kept.key]?.type;
  if (!key) return;
  const at = `collections/${kept.name}/key`;
  const say = (message: string) => refuse({ code: 'X242', file: kept.file, message, at, hint: HINT_KEY });
  if (key.kind !== 'string' && key.kind !== 'number') {
    say(`'${kept.key}' is ${key.kind}, and this engine keys by a string or a number`);
    return;
  }
  if (key.kind === 'string' && identity) say(`keyType 'identity' counts, and '${kept.key}' is a string`);
  if (key.kind === 'number' && !identity) say(`keyType 'uuidv7' answers text, and '${kept.key}' is a number`);
}

/**
 * Why MySQL will not keep this name as a table name, or nothing where it will. The store's schema admits a
 * collection name only as a lower-case letter, then letters, digits or underscores (D001), and MySQL creates
 * every such name; what is left for this engine to refuse is its length.
 */
function illegalBecause(name: string): string | undefined {
  if (name.length <= LONGEST) return undefined;
  return `'${name}' is ${name.length} characters, and MySQL keeps a table name of ${LONGEST} at most`;
}

/**
 * X243, for the columns: a field of a kept shape whose name MySQL will not keep as a column, or two it will not
 * keep apart. The store's schema covers table names only, and the shape's schema caps a field name at no
 * length, so a field over 64 characters passes until `CREATE TABLE`. MySQL compares column names without case
 * on every host, so `userId` and `userid` are one column. A blob field has no column, and X241 refuses it.
 */
function checkFields(kept: Kept, refuse: Refuse): void {
  if (kept.shape.kind !== 'object') return;
  const at = `collections/${kept.name}/of`;
  const say = (message: string, hint: string) => refuse({ code: 'X243', file: kept.file, message, at, hint });
  const seen = new Map<string, string>();
  for (const [field, declared] of Object.entries(kept.shape.fields)) {
    if (!columnTypeOf(declared.type)) continue;
    if (field.length > LONGEST) {
      say(
        `'${field}' is ${field.length} characters, and MySQL keeps a column name of ${LONGEST} at most`,
        `rename the field in the shape to ${LONGEST} characters or fewer`,
      );
      continue;
    }
    const first = seen.get(folded(field));
    if (first)
      say(
        `'${field}' and '${first}' are one column once folded to lower case, and MySQL compares column names without case`,
        'rename one of the two fields in the shape',
      );
    else seen.set(folded(field), field);
  }
}

/**
 * X243: a collection name MySQL will not keep, or two of one connection it will not keep apart. The store's
 * schema covers table names only; field names are `checkFields`'s. Whether MySQL compares table names with case
 * is the host's `lower_case_table_names`, so the engine assumes the strict case and `Entries` and `entries` are
 * one table; two collections of one connection that fold together are refused here, by the fold the engine
 * names tables by, where X206 and X207 refuse what @storage can see.
 */
function checkNames(kept: Kept[], refuse: Refuse): void {
  const seen = new Map<string, Kept>();
  for (const one of kept) {
    const at = `collections/${one.name}`;
    const say = (message: string, hint: string) => refuse({ code: 'X243', file: one.file, message, at, hint });
    const illegal = illegalBecause(one.name);
    if (illegal) {
      say(illegal, `rename the collection to ${LONGEST} characters or fewer`);
      continue;
    }
    const key = `${one.connection} ${folded(one.name)}`;
    const first = seen.get(key);
    if (first && first.name !== one.name)
      say(
        `'${one.name}' and '${first.name}' are one table once folded to lower case, and a host with lower_case_table_names set compares names without case`,
        'rename one of the two collections',
      );
    else if (!first) seen.set(key, one);
  }
}

/** Every X24x refusal this tree earns. */
export function check(ctx: PluginCheckContext): void {
  const kept = keptHere(ctx.scope);
  const identity = isIdentity(ctx.settings as Settings);
  for (const one of kept) {
    checkColumns(one, ctx.refuse);
    checkKey(one, identity, ctx.refuse);
    checkFields(one, ctx.refuse);
  }
  checkNames(kept, ctx.refuse);
}
