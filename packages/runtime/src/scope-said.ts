/**
 * What a reader is told about a scope: which read fills a store's column, how many triggers guarantee that
 * read and by which policies, where the value was written at sign-in, and which triggers reach a view and
 * whether each attaches the policy it is behind.
 *
 * None of it is in the store document. The read is one hop into the resolvers document that declares it; the
 * triggers are elsewhere in the tree and reached through their bindings; the sign-in write is a node of a
 * graph in another feature entirely. A reader who has only the JSON sees a column and a `{{name}}` and cannot
 * tell whose rows those are, which is what `describe` exists to fix.
 *
 * Nothing here judges. `checkStoreScopes` and `checkViewGates` in `check/scope-access.ts` have already refused
 * a store scoped by what a caller sends (A007) and a trigger reaching a view without its policy (A008); this
 * asks the same questions with the same walks -- `viewsReachedBy` in the compiler's `scope-said.ts` is the one
 * A008 filters, and `takesScope` the one `lowerScope` reads -- so what a reader is shown and what the tree was
 * held to cannot drift apart.
 */
import { collectionOf, effectsReachable, profilesWalking, takesScope, viewsReachedBy } from '@wilanis/compiler';
import {
  type GraphDoc,
  type Loaded,
  type LoadResult,
  type PolicyDoc,
  policyPath,
  type ResolversDoc,
  Scope,
  type StoreCollection,
  type StoreDoc,
  splitPath,
  splitRef,
  type TriggerDoc,
  type Values,
} from '@wilanis/core';

/** Is a dotted path the prefix itself, or below it? What a policy proving `request.session` proves. */
const atOrBelow = (path: string, prefix: string): boolean => path === prefix || path.startsWith(`${prefix}.`);

/** The `request.*` path one of a store's reads resolves to, or nothing where the resolver cannot be read. */
export function readPathOf(store: StoreDoc, name: string, scope: Scope): string | undefined {
  const ref = store.reads?.[name];
  if (!ref) return undefined;
  const { path, op } = splitRef(ref);
  const doc = path ? scope.get('resolvers', path) : undefined;
  const read = doc && op ? (doc.doc as ResolversDoc).resolvers[op]?.read : undefined;
  return read ? splitPath(read).slice(1).join('.') : undefined;
}

/** One trigger that reaches a collection of a store, and the policies of it that prove the scope's read. */
interface Reaching {
  trigger: string;
  /** The attached policies whose `proves` covers the read, by path; empty where the kind hands it always. */
  proving: string[];
}

/** Every trigger of the tree that reaches one collection of one store, under any profile that serves it. */
function reaching(store: string, collection: string, load: LoadResult, scope: Scope): Loaded<TriggerDoc>[] {
  return load.registry.all('trigger').filter(trigger => reaches(trigger, store, collection, scope));
}

/**
 * Whether one trigger's fired operation ends at a site over this collection, under some profile that serves it
 * (`profilesWalking`, the list A006 judges the trigger under): a route does not reach a store under a profile
 * that never listens, whatever that profile binds.
 */
function reaches(trigger: Loaded<TriggerDoc>, store: string, collection: string, scope: Scope): boolean {
  for (const profile of profilesWalking(scope, trigger.doc)) {
    for (const effect of effectsReachable(scope, trigger.doc.fire.run, profile)) {
      const site = collectionOf(scope, { key: effect.key, given: effect.given });
      if (site && site.store === store && site.collection === collection) return true;
    }
  }
  return false;
}

/** The policies one trigger attaches, as documents, skipping any the tree does not have. */
function policiesOf(trigger: Loaded<TriggerDoc>, scope: Scope): Loaded<PolicyDoc>[] {
  return (trigger.doc.policies ?? [])
    .map(use => scope.get('policy', policyPath(use)))
    .filter((policy): policy is Loaded<PolicyDoc> => Boolean(policy));
}

/**
 * Every trigger reaching a scoped collection, and which of its policies guarantee the read the scope is
 * filled from. A policy guarantees it by `proves` naming the read's path or a prefix of it, which is how
 * A006 reads the same list -- a policy that proves `request.session` proves every attribute of it.
 */
export function guaranteedBy(
  store: Loaded<StoreDoc>,
  collection: string,
  read: string | undefined,
  load: LoadResult,
): Reaching[] {
  const scope = new Scope(load.registry, load.resolve);
  return reaching(store.path, collection, load, scope).map(trigger => ({
    trigger: trigger.path,
    proving: read === undefined ? [] : provingPolicies(trigger, read, scope),
  }));
}

/** The attached policies of one trigger whose `proves` covers one `request.*` path. */
function provingPolicies(trigger: Loaded<TriggerDoc>, read: string, scope: Scope): string[] {
  return policiesOf(trigger, scope)
    .filter(policy => (policy.doc.proves ?? []).some(proof => atOrBelow(read, splitPath(proof).slice(1).join('.'))))
    .map(policy => policy.doc.label ?? policy.path);
}

/** One site that wrote a scope's value at sign-in: the graph it is a node of, and the node. */
export interface WrittenAt {
  file: string;
  node: string;
}

/**
 * Every call site that opens a session with the attribute a scope reads: a node whose `attributes` input
 * names the key. A scope trusts a value the sign-in decided once, so a reader of the store is shown where
 * that decision was made rather than left to find it in another feature's graphs.
 *
 * The site is read off what the document writes, as `describe` reads every site: a node giving `attributes`
 * an object with the key is the one that wrote it, whichever port the sign-in names, so a tree that meets
 * the guard's token port through a domain port of its own is read the same as one that names it directly.
 */
export function writtenAtSignIn(key: string, load: LoadResult): WrittenAt[] {
  const out: WrittenAt[] = [];
  for (const graph of load.registry.all('graph'))
    for (const node of (graph.doc as GraphDoc).nodes) {
      if (!('run' in node) || !writesAttribute(node.in, key)) continue;
      out.push({ file: graph.path, node: node.id });
    }
  return out;
}

/** Whether one node's inputs open a session with this attribute: an `attributes` object naming the key. */
function writesAttribute(given: unknown, key: string): boolean {
  if (!given || typeof given !== 'object') return false;
  const attributes = (given as Record<string, unknown>).attributes;
  return Boolean(attributes) && typeof attributes === 'object' && key in (attributes as Record<string, unknown>);
}

/** One view a trigger reaches: the collection, the policy it is behind, and whether the trigger attaches it. */
export interface ViewReached {
  collection: string;
  behind: string;
  attached: boolean;
}

/**
 * Every view one trigger reaches, with whether it attaches the policy the view names. A view is the one way
 * across a scope, so a reader of the trigger sees which crossings it makes and that each is gated -- the
 * same pair A008 refuses on, said rather than refused, under the same profiles: those that serve the trigger.
 */
export function viewsOfTrigger(trigger: Loaded<TriggerDoc>, scope: Scope): ViewReached[] {
  const attached = new Set((trigger.doc.policies ?? []).map(use => scope.canon(policyPath(use))));
  const out = new Map<string, ViewReached>();
  for (const profile of profilesWalking(scope, trigger.doc))
    for (const found of viewsReachedBy(scope, trigger.doc.fire.run, profile))
      out.set(found.collection, {
        collection: found.collection,
        behind: found.behind,
        attached: attached.has(scope.canon(found.behind)),
      });
  return [...out.values()];
}

/** The scope one collection is under, or nothing where it keeps its rows for everyone. */
export function scopedOf(collection: StoreCollection): Record<string, string> | undefined {
  const scoped = collection.scoped;
  return scoped && Object.keys(scoped).length ? scoped : undefined;
}

/** What a site carries as its scope: the store that decided it, and the column → read the compiler fills. */
interface Carried {
  store: string;
  scoped: Record<string, string>;
}

/**
 * The scope one call site actually carries: the collection it is over, where that collection has one and the
 * operation takes one. Which operations take a scope is the port's own word, read off the `scope` input it
 * declares, exactly as `lowerScope` reads it -- `newKey` declares none, because a key is global to the table
 * whatever the scope, and a line printed there would name a filter no statement carries.
 */
function carriedScope(run: string, given: Values | undefined, scope: Scope): Carried | undefined {
  if (!takesScope(scope, run)) return undefined;
  const over = collectionOf(scope, { key: run, given });
  const store = over && scope.registry.get('store', over.store);
  const scoped = store && over && scopedOf(store.doc.collections[over.collection] ?? {});
  return store && scoped ? { store: store.path, scoped } : undefined;
}

/**
 * What one node of the map says about its scope: the columns the site it names carries, where it carries any.
 * `wilanis map` ends a storage line at the records; a reader of that line is owed the fact that those records
 * are one caller's and not the table's, which is one word beside the operation.
 */
export function scopeTail(run: string, given: Values | undefined, scope: Scope): string {
  const carried = carriedScope(run, given, scope);
  return carried ? `, scoped by ${Object.keys(carried.scoped).join(', ')}` : '';
}

/**
 * The scope a storage node carries, which its document does not write. The compiler puts the store's read on
 * every site over a scoped collection (RFC 0015), so a reader of the graph would otherwise meet a node that
 * reads one caller's rows and see nothing saying so; the line names the column, the read and the store that
 * decided both, so where to change it is one hop away.
 */
export function scopeLine(node: { run?: string; in?: Values }, scope: Scope): string[] {
  if (node.run === undefined) return [];
  const carried = carriedScope(node.run, node.in, scope);
  if (!carried) return [];
  return Object.entries(carried.scoped).map(
    ([column, read]) => `        scope ${column} ← ${read} of ${carried.store}`,
  );
}

/**
 * One mark of a collection, as `lines.ts` prints one: the family it is filed under and what that family says
 * here. Nothing here indents -- how a mark is laid out is one decision and `lines.ts` holds it -- so a scope
 * reads as one more of the marks beside it however that decision changes.
 */
export interface ScopeMark {
  family: string;
  said: string;
}

/**
 * What one scoped column says: the column, the read that fills it, how many triggers reach the collection and
 * which of their policies guarantee that read. The count is the reader's measure of how far the scope reaches,
 * and the policies are named because a reader asking whose rows these are is asking exactly which gates stand
 * between a caller and them -- one of the RFC's two open questions, answered by naming both.
 */
function scopedMark(
  column: string,
  read: string,
  store: Loaded<StoreDoc>,
  at: { collection: string; load: LoadResult },
): ScopeMark {
  const name = read.replace(/^\{\{|\}\}$/g, '');
  const path = readPathOf(store.doc, name, new Scope(at.load.registry, at.load.resolve));
  const found = guaranteedBy(store, at.collection, path, at.load);
  const policies = [...new Set(found.flatMap(one => one.proving))];
  const by = policies.length ? ` by ${policies.join(', ')}` : '';
  return { family: 'scoped by', said: `${column} ← ${read}  (guaranteed at ${found.length} trigger(s)${by})` };
}

/** Where the value one scoped column trusts was decided: every sign-in node that opened a session with it. */
function signInMark(column: string, load: LoadResult): ScopeMark[] {
  const sites = writtenAtSignIn(column, load);
  if (!sites.length) return [];
  const said = sites.map(site => `${site.file}#${site.node}`).join(', ');
  return [{ family: '', said: `written at sign-in by ${said}` }];
}

/**
 * Every scope of one collection, each with where its value was written. A collection under no scope says
 * nothing, so a store that keeps its rows for everyone reads exactly as it did before scoping existed.
 */
export function scopeLines(
  name: string,
  collection: StoreCollection,
  store: Loaded<StoreDoc>,
  load: LoadResult,
): ScopeMark[] {
  const scoped = scopedOf(collection);
  if (!scoped) return [];
  return Object.entries(scoped).flatMap(([column, read]) => [
    scopedMark(column, read, store, { collection: name, load }),
    ...signInMark(column, load),
  ]);
}
