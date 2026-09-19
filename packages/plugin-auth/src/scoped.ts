/**
 * X105: a session attribute some store scopes a collection by is written at sign-in and never again. Only @auth
 * knows that `session.port.json#set` and `#remove` write the attributes the guard hands back as
 * request.session.attributes, so only @auth can refuse a graph that writes one over again. What it reads is two
 * core kinds -- every `store`, for the collections it keeps and the reads they are scoped by, and the `resolvers`
 * documents those reads name -- and nothing of what a scope means to a statement, which is the storage plugin's.
 */
import { kept, type ResolversDoc, type Scope, type StoreDoc, splitPath, splitRef, WHOLE_TEMPLATE } from '@wilanis/core';

/** One session attribute a store scopes by: the attribute's name, and the store and collection that read it. */
export interface ScopedAttribute {
  store: string;
  collection: string;
}

/** The session attribute a resolver reads, where it reads exactly one: request.session.attributes.<key>. */
function attributeOf(scope: Scope, ref: string): string | undefined {
  const { path, op: name } = splitRef(ref);
  const doc = scope.get('resolvers', path)?.doc as ResolversDoc | undefined;
  const read = name ? doc?.resolvers[name]?.read : undefined;
  if (!read) return undefined;
  const segments = splitPath(read);
  const reads = segments.length === 4 && segments[0] === 'request' && segments[1] === 'session';
  return reads && segments[2] === 'attributes' ? segments[3] : undefined;
}

/** The name a scope's value reads, where it is exactly one whole read: `{{tenant}}` -> tenant. */
function nameRead(value: string): string | undefined {
  const whole = WHOLE_TEMPLATE.exec(value);
  const path = whole ? splitPath(whole[1]) : [];
  return path.length === 1 ? path[0] : undefined;
}

/** The session attribute one scope's value ends at: the read it names, the store's binding, the resolver. */
function scopedBy(scope: Scope, doc: StoreDoc, value: string): string | undefined {
  const name = nameRead(value);
  if (!name) return undefined;
  const ref = doc.reads?.[name];
  return ref ? attributeOf(scope, ref) : undefined;
}

/** Every session attribute one store scopes a collection by, into the map. */
function fromStore(scope: Scope, path: string, doc: StoreDoc, found: Map<string, ScopedAttribute>) {
  for (const [collection, keeping] of kept(doc))
    for (const value of Object.values(keeping.scoped ?? {})) {
      const attribute = scopedBy(scope, doc, value);
      if (attribute && !found.has(attribute)) found.set(attribute, { store: path, collection });
    }
}

/**
 * Every session attribute some store of this tree scopes a collection by, to the first store and collection
 * that read it -- what X105 holds a session write to. A tree with no scoped store answers an empty map, and
 * the rule then refuses nothing.
 */
export function scopedAttributes(scope: Scope): Map<string, ScopedAttribute> {
  const found = new Map<string, ScopedAttribute>();
  for (const store of scope.registry.all('store')) fromStore(scope, store.path, store.doc as StoreDoc, found);
  return found;
}
