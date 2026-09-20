/**
 * What `wilanis describe` says about the reads a document takes from the request, read from both ends: a data
 * graph's or a binding's `reads` block above the nodes or the operations it stands over, and, on the resolvers
 * document itself, every graph and binding that names one of its resolvers.
 *
 * A read is the one thing in a tree whose value comes from outside it, and RFC 0029 made each one a path a
 * reader can open. `describe` closes the loop: the block says what `{{name}}` is before the reader meets it,
 * with the `request.*` path the resolver declares and whether a trigger must prove it; and a resolvers
 * document, which until now said only what it read, says who reads it and under which local name. Nothing is
 * inferred -- the map is the read set, so both directions are that map, read forwards and backwards.
 */
import {
  type BindingDoc,
  type GraphDoc,
  type Loaded,
  type LoadResult,
  type ResolversDoc,
  type StoreDoc,
  splitRef,
} from '@wilanis/core';

/** What reading a `reads` entry needs of the tree: the document one reference names, whatever its kind. */
export interface Reader {
  any(ref: string): Loaded | undefined;
}

/** The resolver one `@path#name` names, where the document is there and declares it; nothing where it is not. */
function resolverAt(ref: string, scope: Reader): { read: string; required?: boolean } | undefined {
  const { path, op: name } = splitRef(ref);
  const doc = path ? scope.any(path) : undefined;
  if (doc?.kind !== 'resolvers') return undefined;
  return (doc.doc as ResolversDoc).resolvers[name];
}

/** One read as a reader meets it: the local name, the resolver it is bound to, and what that resolver reads. */
function readLine(name: string, ref: string, scope: Reader): string {
  const found = resolverAt(ref, scope);
  const said = found ? `  (${found.read}${found.required ? ', required' : ''})` : '';
  return `    ${name} ← ${ref}${said}`;
}

/**
 * The reads a data graph or a binding takes, above what it stands over. The block is one more block among the
 * ones already there, so a document that takes none prints none rather than an empty heading.
 */
export function readsLines(reads: Record<string, string> | undefined, scope: Reader): string[] {
  const entries = Object.entries(reads ?? {});
  if (!entries.length) return [];
  return ['reads:', ...entries.map(([name, ref]) => readLine(name, ref, scope))];
}

/**
 * Every document that binds a resolver of one resolvers document, by resolver name, as path and local name.
 * A store binds one the way a graph does, and says beside it which collections the read scopes: a reader of
 * the resolver is then told not only who reads it but what it decides, which for a scope is whose rows leave.
 */
function usersOf(path: string, load: LoadResult): Map<string, string[]> {
  const users = new Map<string, string[]>();
  const bound = [...load.registry.all('graph'), ...load.registry.all('binding'), ...load.registry.all('store')];
  for (const doc of bound)
    for (const use of usesIn(doc, path, load)) users.set(use.name, [...(users.get(use.name) ?? []), use.said]);
  return users;
}

/** One document's uses of the resolvers document at `path`: the resolver each names, and how it reads. */
function usesIn(doc: Loaded, path: string, load: LoadResult): { name: string; said: string }[] {
  const reads = (doc.doc as GraphDoc | BindingDoc | StoreDoc).reads ?? {};
  const out: { name: string; said: string }[] = [];
  for (const [local, ref] of Object.entries(reads)) {
    const { path: at, op: name } = splitRef(ref);
    if (!at || load.resolve(at) !== path) continue;
    const scopes = doc.kind === 'store' ? scopesSaid(doc.doc as StoreDoc, local) : '';
    out.push({ name, said: `used by ${doc.path} as {{${local}}}${scopes}` });
  }
  return out;
}

/** Which collections of one store a read scopes, said for a reader; nothing where it scopes none. */
function scopesSaid(store: StoreDoc, local: string): string {
  const scoped = Object.entries(store.collections)
    .filter(([, collection]) => Object.values(collection.scoped ?? {}).includes(`{{${local}}}`))
    .map(([name]) => name);
  return scoped.length ? `  (scopes ${scoped.join(', ')})` : '';
}

/**
 * The users of each resolver of one document, by resolver name. A resolver nothing binds answers an empty
 * list, so its line can say so: a read declared and never bound is worth a reader seeing.
 */
export function readersOf(path: string, load: LoadResult): (name: string) => string[] {
  const users = usersOf(path, load);
  return name => users.get(name) ?? [];
}
