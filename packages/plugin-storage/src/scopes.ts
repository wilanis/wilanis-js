/**
 * X214: what a document may say about a scope, which is nothing. A scope is the store's own word about who
 * is calling -- a column the collection declares `scoped`, filled from a read the store binds -- and the
 * compiler puts it on every site over such a collection. So there is no document in which to forget one, and
 * the one that remembers is refused here: over a scoped collection it would overwrite what the store bound,
 * over an unscoped one or a view it names a column nothing keeps, and on `newKey` it asks for a scope the
 * port does not declare, since a key is unique across every scope of the collection.
 *
 * It lives beside `filters.ts` rather than in `rules.ts` for the reason that file splits at all: a `scope` is
 * a judgement about one input of one call site, as a `where` is, and the two read the same `Call`.
 */
import type { PluginCheckContext, StoreCollection } from '@wilanis/core';
import { type Call, SCOPE } from './calls.js';

type Scope = PluginCheckContext['scope'];
type Refuse = PluginCheckContext['refuse'];

/**
 * What a site's `scope` would be over, in the store's own words: the collection the call names, as the store
 * declares it, or nothing where the call names no collection this tree holds (X204 refuses that).
 */
function scopedAt(call: Call, scope: Scope): { name: string; collection: StoreCollection } | undefined {
  const named = call.given?.store;
  const collection = call.given?.collection;
  if (typeof named !== 'string' || typeof collection !== 'string') return undefined;
  const declared = scope.get('store', named)?.doc.collections[collection];
  return declared ? { name: collection, collection: declared } : undefined;
}

/** What X214 says about the one collection a written `scope` was written over, and the edit that drops it. */
function scopeWords(call: Call, scope: Scope): { message: string; hint: string } {
  const over = scopedAt(call, scope);
  const store = String(call.given?.store);
  if (over?.collection.view !== undefined)
    return {
      message: `'${over.name}' is a view of '${over.collection.view}', and a view sees every row`,
      hint: `drop "scope": read '${over.collection.view}' where a scope is meant`,
    };
  const scoped = over?.collection.scoped;
  if (!scoped)
    return {
      message: over
        ? `'${over.name}' of ${store} declares no scoped columns, so it keeps no scope`
        : `${store} keeps no scope for this collection`,
      hint: 'drop "scope": this collection keeps no scope',
    };
  const by = Object.entries(scoped)
    .map(([column, read]) => `${column} ← ${read}`)
    .join(', ');
  return {
    message: `scope is the store's: '${over?.name}' is scoped by ${by} of ${store}, and the compiler puts it here`,
    hint: `drop "scope": to change how '${over?.name}' is scoped, change ${store}`,
  };
}

/**
 * X214: a scope is what the store says about who is calling, carried to every site over a scoped collection
 * by the compiler and written by no document. A site that gives one has said what only the store may say --
 * over a scoped collection it would overwrite the read the store bound, over an unscoped one or a view it
 * names a column nothing keeps -- so every one of them is refused, whichever operation it was given to.
 */
export function checkScope(call: Call, scope: Scope, refuse: Refuse): void {
  if (call.given?.[SCOPE] === undefined) return;
  const { message, hint } = scopeWords(call, scope);
  refuse({ code: 'X214', file: call.file, message, at: `${call.at}/${SCOPE}`, hint });
}
