/**
 * How a store scopes its rows, and what a view of a scoped collection crosses (RFC 0015). A collection names the
 * columns it keeps beside the record and the read that fills each; the store binds those reads as a data graph
 * binds one, so `reads.ts` answers where each lands in the request. Nothing here is written at a call site: the
 * compiler puts the scope on every operation over the collection and no document may write one (X203), so a node
 * badge and the store page are the only places a reader meets it -- and both ask this module, so neither can
 * name a column the other does not.
 */
import { collectionOf, effectsReachable } from '@wilanis/compiler';
import type { Loaded, Scope, StoreCollection, StoreDoc, TriggerDoc, Values } from '@wilanis/core';
import { readsOf } from './reads.js';
import type { VRequiredBy, VScope, VScopedColumn, VStoreViewOf } from './types.js';
import { labelOf } from './types.js';

/** Exactly `{{name}}`, the one form a scope's value may take: a whole read of a name the store binds (C005). */
const WHOLE_READ = /^\{\{\s*([^{}]+?)\s*\}\}$/;

/**
 * The columns one collection is scoped by, each with the read that fills it and the document declaring that
 * read. Empty for a collection with no `scoped`, so a caller spreads the result and a page shows nothing.
 */
export function scopedColumns(scope: Scope, store: Loaded<StoreDoc>, collection: StoreCollection): VScopedColumn[] {
  const reads = readsOf(scope, store.doc.reads);
  return Object.entries(collection.scoped ?? {}).map(([column, value]) => {
    const name = WHOLE_READ.exec(value)?.[1] ?? value;
    const read = reads.get(name);
    return {
      column,
      read: name,
      ...(read ? { opens: read.opens, from: read.path.join('.') } : {}),
    };
  });
}

/** What one call site is over, for the scope it carries: the store it named and the collection within it. */
export interface Over {
  store: Loaded<StoreDoc> | undefined;
  collection: string | undefined;
  /** The `path#operation` the site runs, so the port's own word decides whether it carries a scope at all. */
  run: string;
}

/**
 * The scope one call site carries, or nothing where it carries none: read off the store the site names, never
 * off the node, since a node that wrote one would be refused (X203). Which operations carry one is the port's
 * word, read off the `scope` input it declares -- `newKey` declares none, because a key is global to the table
 * whatever the scope -- so this says what the lowering put there and not what a collection happens to declare.
 */
export function scopeOf(scope: Scope, over: Over): VScope | undefined {
  const declared = over.collection === undefined ? undefined : over.store?.doc.collections[over.collection];
  if (!over.store || !declared?.scoped || !takesScope(scope, over.run)) return undefined;
  const by = scopedColumns(scope, over.store, declared);
  return by.length ? { store: over.store.path, by } : undefined;
}

/** Whether the operation a site names carries a scope at all: the port says so by declaring the input. */
function takesScope(scope: Scope, run: string): boolean {
  const hit = scope.op(run);
  return typeof hit !== 'string' && Boolean(hit.port.native) && Boolean(hit.op.accepts?.scope);
}

/**
 * The views one trigger reaches, grouped by the policy each is behind: the walk A008 makes, under every profile,
 * so the *Gated by* list can say which of a trigger's policies it could not have dropped. The canonical policy
 * path is the key, since that is what an attachment is compared against.
 */
export function viewsRequiredBy(scope: Scope, trigger: TriggerDoc): Map<string, VRequiredBy[]> {
  const out = new Map<string, VRequiredBy[]>();
  for (const profile of profilesOf(scope))
    for (const effect of effectsReachable(scope, trigger.fire.run, profile)) {
      const found = viewReached(scope, effect);
      if (found) remember(out, found.behind, found.required);
    }
  return out;
}

/** The profiles a walk from a trigger is made under: each declared one, or the one unnamed default. */
const profilesOf = (scope: Scope): (string | undefined)[] => (scope.profiles().length ? scope.profiles() : [undefined]);

/** One view a native call site is over, with the policy it is behind; nothing where the site is over no view. */
function viewReached(scope: Scope, effect: { key: string; given: Values | undefined }) {
  const site = collectionOf(scope, { key: effect.key, given: effect.given });
  const store = site && scope.registry.get('store', site.store);
  const collection = site && store?.doc.collections[site.collection];
  if (!site || !store || collection?.view === undefined || collection.behind === undefined) return undefined;
  const required: VRequiredBy = {
    store: store.path,
    storeLabel: labelOf(store),
    view: site.collection,
    of: collection.view,
  };
  return { behind: scope.canon(collection.behind), required };
}

/** One view under the policy it is behind, named once however many profiles or sites reached it. */
function remember(into: Map<string, VRequiredBy[]>, behind: string, one: VRequiredBy): void {
  const seen = into.get(behind) ?? [];
  if (!seen.some(other => other.store === one.store && other.view === one.view)) seen.push(one);
  into.set(behind, seen);
}

/** Each collection of a store that is a view, by name: what it sees every scope of, and the policy it is behind. */
export function viewsOf(scope: Scope, store: StoreDoc): Record<string, VStoreViewOf> {
  const out: Record<string, VStoreViewOf> = {};
  for (const [name, collection] of Object.entries(store.collections)) {
    if (collection.view === undefined || collection.behind === undefined) continue;
    const policy = scope.get('policy', collection.behind);
    out[name] = {
      of: collection.view,
      behind: policy?.path ?? scope.canon(collection.behind),
      behindLabel: labelOf(policy),
    };
  }
  return out;
}
