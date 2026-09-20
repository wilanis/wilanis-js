/**
 * How a store scopes its rows, and what a view of a scoped collection crosses (RFC 0015). A collection names the
 * columns it keeps beside the record and the read that fills each; the store binds those reads as a data graph
 * binds one, so `reads.ts` answers where each lands in the request. Nothing here is written at a call site: the
 * compiler puts the scope on every operation over the collection and no document may write one, so a node badge
 * and the store page are the only places a reader meets it -- and both ask this module, so neither can name a
 * column the other does not. Nothing here walks: whether an operation carries a scope (`takesScope`) and which
 * views a run reaches (`viewsReachedBy`) are the compiler's, where the rules that refuse on them live, so the
 * page cannot say a crossing A008 does not.
 */
import { profilesOf, takesScope, type ViewReachedBy, viewsReachedBy } from '@wilanis/compiler';
import type { Loaded, Scope, StoreCollection, StoreDoc, TriggerDoc } from '@wilanis/core';
import { readsOf } from './reads.js';
import type { VRequiredBy, VScope, VScopedColumn, VStoreViewOf } from './types.js';
import { labelOf } from './types.js';

/** Exactly `{{name}}`, the one form a scope's value may take: a whole read of a name the store binds (C012). */
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
 * off the node, since a node that wrote one would be refused. Which operations carry one is the port's
 * word, read off the `scope` input it declares -- `newKey` declares none, because a key is global to the table
 * whatever the scope -- so this says what the lowering put there and not what a collection happens to declare.
 */
export function scopeOf(scope: Scope, over: Over): VScope | undefined {
  const declared = over.collection === undefined ? undefined : over.store?.doc.collections[over.collection];
  if (!over.store || !declared?.scoped || !takesScope(scope, over.run)) return undefined;
  const by = scopedColumns(scope, over.store, declared);
  return by.length ? { store: over.store.path, by } : undefined;
}

/**
 * The views one trigger reaches, grouped by the policy each is behind: the walk A008 makes, under every profile,
 * so the *Gated by* list can say which of a trigger's policies it could not have dropped. The walk itself is
 * `viewsReachedBy`, which the rule reads too, so the page and the refusal cannot name different crossings; all
 * this adds is the grouping. The canonical policy path is the key, since that is what an attachment is
 * compared against.
 */
export function viewsRequiredBy(scope: Scope, trigger: TriggerDoc): Map<string, VRequiredBy[]> {
  const out = new Map<string, VRequiredBy[]>();
  for (const profile of profilesOf(scope))
    for (const found of viewsReachedBy(scope, trigger.fire.run, profile))
      remember(out, scope.canon(found.behind), requiredOf(scope, found));
  return out;
}

/** One view a run reaches, as the *Gated by* list names it: the store that declares it, labelled, and the pair. */
function requiredOf(scope: Scope, found: ViewReachedBy): VRequiredBy {
  return {
    store: found.store,
    storeLabel: labelOf(scope.registry.get('store', found.store)),
    view: found.collection,
    of: found.view,
  };
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
