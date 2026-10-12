/**
 * A store another tree keeps (RFC 0042). `keptBy` names the tree that writes the records and runs `wilanis
 * migrate` over them, and this tree only reads them. `migrate` leaves such a connection to that tree; these
 * rules hold the promise from the other side, so the checker and the planner agree on what this tree keeps.
 *
 * X215 no call writes through a kept store, makes a key for one, or prepares one.
 * X216 every store over one connection, under the unnamed profile and every declared one, says the same keptBy.
 * X217 keptBy names another tree: this tree keeps its own stores.
 *
 * Which store a call names is read off the same call sites `rules.ts` reads (`calls.ts`); which connection a
 * store reaches under a profile is `scope.connectionFor`, the connection the planner gathers by.
 */
import type { Loaded, PluginCheckContext, StoreDoc } from '@wilanis/core';
import { bindingCalls, type Call, ENGINE_PORT, graphCalls, STORE_PORT } from './calls.js';

type Scope = PluginCheckContext['scope'];
type Refuse = PluginCheckContext['refuse'];

/** Each operation that writes through a store, or prepares one, with what a refusal says it does. */
const WRITES: Record<string, (what: string) => string> = {
  [`${STORE_PORT}#put`]: what => `puts into ${what}`,
  [`${STORE_PORT}#patch`]: what => `patches ${what}`,
  [`${STORE_PORT}#remove`]: what => `removes from ${what}`,
  [`${STORE_PORT}#newKey`]: what => `makes a key for ${what}`,
  [`${ENGINE_PORT}#ensure`]: what => `prepares ${what}`,
};

/** X215: a call that writes through a store another tree keeps, or prepares one. */
function checkWrite(call: Call, scope: Scope, refuse: Refuse): void {
  const says = WRITES[call.run];
  const named = call.given?.store;
  if (!says || typeof named !== 'string') return;
  const store = scope.get('store', named);
  const tree = store?.doc.keptBy;
  if (!store || !tree) return; // R001 where it names no store
  const collection = call.given?.collection;
  const what = typeof collection === 'string' ? `${collection} of ${store.path}` : store.path;
  refuse({
    code: 'X215',
    file: call.file,
    message: `this ${says(what)}, which the ${tree} tree keeps (keptBy)`,
    at: call.at,
    hint: `a kept store is read only: ask the ${tree} tree for the change through a port it exposes, or remove keptBy if this tree keeps the collection`,
  });
}

/** What a store says about who keeps it, as a refusal reads it. */
const said = (store: Loaded<StoreDoc>) => (store.doc.keptBy ? `says keptBy ${store.doc.keptBy}` : 'says no keptBy');

/** Every store of the tree grouped by the connection it reaches under one profile; a store reaching none is R001's. */
function byConnection(scope: Scope, profile: string | undefined): Map<string, Loaded<StoreDoc>[]> {
  const groups = new Map<string, Loaded<StoreDoc>[]>();
  for (const store of scope.registry.all('store')) {
    const reached = scope.connectionFor(store.doc.connection, profile);
    if (typeof reached === 'string') continue;
    groups.set(reached.path, [...(groups.get(reached.path) ?? []), store]);
  }
  return groups;
}

/** One store over a connection another store over it disagrees with: where, under which profile, and with whom. */
interface Disagreeing {
  store: Loaded<StoreDoc>;
  other: Loaded<StoreDoc>;
  connection: string;
  profile: string | undefined;
}

/** X216: the store that disagrees, at its keptBy, or at its connection where it says none. */
function refuseDisagreeing({ store, other, connection, profile }: Disagreeing, refuse: Refuse): void {
  const under = profile ? ` under profile ${profile}` : '';
  refuse({
    code: 'X216',
    file: store.path,
    message: `this store ${said(store)}, and ${other.path} over the same connection ${connection}${under} ${said(other)}`,
    at: store.doc.keptBy ? 'keptBy' : 'connection',
    hint: `one tree migrates a connection: give every store over ${connection} the same keptBy, or move this store to a connection of its own`,
  });
}

/** X216 over one connection under one profile: each store a store beside it disagrees with, not refused yet. */
function checkGroup(stores: Loaded<StoreDoc>[], at: Omit<Disagreeing, 'store' | 'other'>, judged: Judged): void {
  for (const store of stores) {
    const other = stores.find(one => one.doc.keptBy !== store.doc.keptBy);
    if (!other || judged.refused.has(store.path)) continue;
    judged.refused.add(store.path);
    refuseDisagreeing({ store, other, ...at }, judged.refuse);
  }
}

/** The stores X216 has refused so far, so each is refused once, and the way to refuse. */
interface Judged {
  refused: Set<string>;
  refuse: Refuse;
}

/**
 * X216: one tree migrates a connection, so every store over it says the same keptBy or none says it. Each store
 * is refused once, under the first profile that brings it beside a store that disagrees.
 */
function checkAgreement(scope: Scope, refuse: Refuse): void {
  const judged: Judged = { refused: new Set(), refuse };
  for (const profile of [undefined, ...scope.profiles()])
    for (const [connection, stores] of byConnection(scope, profile))
      checkGroup(stores, { connection, profile }, judged);
}

/** X217: keptBy names another tree; the name it is compared with is the one the record writes (`treeOf`). */
function checkOwnName(store: Loaded<StoreDoc>, scope: Scope, refuse: Refuse): void {
  const tree = scope.project?.name;
  if (!tree || store.doc.keptBy !== tree) return;
  refuse({
    code: 'X217',
    file: store.path,
    message: `keptBy names ${tree}, which is this tree's own project.json → name`,
    at: 'keptBy',
    hint: 'keptBy names another tree; this tree keeps its own stores, so remove keptBy',
  });
}

/** What a kept store promises: X215 over every call that writes, X216 over each connection, X217 over each store. */
export function checkKept({ scope, refuse }: PluginCheckContext): void {
  for (const call of [...graphCalls(scope), ...bindingCalls(scope)]) checkWrite(call, scope, refuse);
  checkAgreement(scope, refuse);
  for (const store of scope.registry.all('store')) checkOwnName(store, scope, refuse);
}
