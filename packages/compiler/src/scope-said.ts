/**
 * What a reader is told about the views a run reaches: every view one operation ends at under one profile, the
 * collection it is over, the scoped collection it sees across, and the policy it is behind. `checkViewGates`
 * refuses on this walk (A008), and `wilanis describe`, `wilanis map` and the viewer say it, so all of them ask
 * one function and none of them re-derives it.
 *
 * Nothing here judges. The walk is `effectsReachable`, which ends at the native sites a run reaches with what
 * each was given; which of those is over a view is `collectionOf`, read off the store the site names. A008 is
 * that walk with the trigger's attached policies filtered out; a reader is shown every crossing the run makes
 * and whether each is gated, which is the same pair said rather than refused.
 */
import type { Scope, StoreCollection } from '@wilanis/core';
import { collectionOf } from './documents.js';
import { effectsReachable, type ReachedEffect } from './refusals.js';

/** One view a run reaches: the site that reaches it, the collection it is over, and what it crosses behind. */
export interface ViewReachedBy {
  /** The native site the walk ended at: the file and node that name it, and what it was given. */
  effect: ReachedEffect;
  /** The canonical path of the store document the site names. */
  store: string;
  /** The name of the view collection, as the store declares it. */
  collection: string;
  /** The scoped collection of that store whose rows the view sees, every scope's. */
  view: string;
  /** The policy every trigger reaching this view must attach, by path. */
  behind: string;
}

/**
 * Every view one operation reaches under one profile, in the order the walk finds them. A view is the one way
 * across a scope, so this is what a run crosses; a collection that views nothing, or that declares no policy
 * to be behind, is not one and is skipped -- A008 has nothing to hold such a site to, and a reader shown it
 * would be shown a crossing that is not gated because there is no gate to name.
 */
export function viewsReachedBy(scope: Scope, run: string, profile: string | undefined): ViewReachedBy[] {
  const out: ViewReachedBy[] = [];
  for (const effect of effectsReachable(scope, run, profile)) {
    const found = viewAt(scope, effect);
    if (found) out.push(found);
  }
  return out;
}

/** The view one native site is over, where it is over one that declares a policy; nothing where it is not. */
function viewAt(scope: Scope, effect: ReachedEffect): ViewReachedBy | undefined {
  const site = collectionOf(scope, { key: effect.key, given: effect.given });
  if (!site) return undefined;
  const collection: StoreCollection | undefined = scope.registry.get('store', site.store)?.doc.collections[
    site.collection
  ];
  if (collection?.view === undefined || collection.behind === undefined) return undefined;
  return { effect, store: site.store, collection: site.collection, view: collection.view, behind: collection.behind };
}
