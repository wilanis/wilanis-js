/**
 * A scoping. Who a scope may read, and what a view is behind. A store's scope says which rows a caller sees,
 * so what fills it is what the guard established about that caller and nothing the caller could send (A007);
 * and a collection that sees every scope's rows is crossed only behind the policy it names, which every
 * trigger reaching it attaches (A008).
 *
 * Split from `access.ts`, which judges a policy on its own and what gates a trigger under its kind: these two
 * are the same family asked about a store -- A007 over the document, A008 over what a trigger reaches -- and
 * the walk they need (`effectsReachable`, `collectionOf`) is not one a policy or a credential ever makes.
 */
import { type Loaded, policyPath, type StoreDoc, splitRef, type TriggerDoc } from '@wilanis/core';
import { collectionOf } from '../documents.js';
import { effectsReachable } from '../refusals.js';
import { type Judge, type JudgedResolver, type Refuser, underProfiles } from './judge.js';

const NO_GUARD_HINT = 'add a guarding plugin to project.json → plugins, such as @wilanis/plugin-auth';

/**
 * A007: every read a store's collections are scoped by reads what the guard hands. A scope decides whose rows
 * a caller sees, so the value filling it is established before any graph runs -- a header, a route parameter
 * or a query string is the caller's own word for who they are, and a store scoped by one is scoped by nothing.
 * The judgement is over the document, because after lowering a resolver read and a hand-written request read
 * are the same source and nothing downstream can tell them apart.
 */
export function checkStoreScopes(judge: Judge, store: Loaded<StoreDoc>): void {
  const scoped = scopedNames(judge, store);
  if (scoped.size === 0) return;
  const refuse = judge.refuser(store.path);
  const guard = judge.scope.guard();
  if (!guard) {
    const name = [...scoped][0];
    const message = `'${name}' scopes ${scopesOf(store, name)}, but no plugin of this project identifies callers`;
    refuse('A007', message, `reads/${name}`, NO_GUARD_HINT);
    return;
  }
  const handed = new Set(Object.keys(guard.doc.guard?.context.fields ?? {}));
  for (const name of scoped) {
    const read = resolverOf(judge, store.doc.reads?.[name]);
    if (read && !handed.has(read.path[0])) refuseNotHanded(refuse, { store, name, read, handed, guard: guard.path });
  }
}

/** The names of the store's reads some `scoped` column is filled from: what A007 is about, and nothing else. */
function scopedNames(judge: Judge, store: Loaded<StoreDoc>): Set<string> {
  const values = Object.values(store.doc.collections).flatMap(collection => Object.values(collection.scoped ?? {}));
  return new Set(judge.scope.templateReads(values).map(read => read[0]));
}

/** The collections of a store one read scopes, by name, so a refusal names what it would let across. */
function scopesOf(store: Loaded<StoreDoc>, name: string): string {
  return (
    Object.entries(store.doc.collections)
      .filter(([, one]) => Object.values(one.scoped ?? {}).includes(`{{${name}}}`))
      .map(([collection]) => collection)
      .join(', ') || 'a collection of this store'
  );
}

/** The resolver one `reads` entry names, as judged; nothing where P004 or R001 already refused the entry. */
function resolverOf(judge: Judge, ref: string | undefined): JudgedResolver | undefined {
  if (ref === undefined) return undefined;
  const { path, op: name } = splitRef(ref);
  const doc = path ? judge.scope.get('resolvers', path) : undefined;
  return doc && name ? judge.resolverReads.get(doc.path)?.[name] : undefined;
}

/** What A007 says of a scope read from somewhere the guard does not hand, and the reads that would fix it. */
function refuseNotHanded(
  refuse: Refuser,
  fault: { store: Loaded<StoreDoc>; name: string; read: JudgedResolver; handed: Set<string>; guard: string },
): void {
  const hands = [...fault.handed].map(key => `request.${key}`).join(', ');
  const message = `scopes ${scopesOf(fault.store, fault.name)}, and reads request.${fault.read.path.join('.')}: a caller may send any value there`;
  const hint = `a scope reads what the guard hands once it identified the caller (${hands}); wilanis describe ${fault.guard}`;
  refuse('A007', message, `reads/${fault.name}`, hint);
}

/**
 * A008: a trigger that reaches a view attaches the policy the view names. A view is the one way across a
 * scope, so what a store declared `behind` is a gate every trigger reaching it carries -- judged per profile,
 * since which binding meets the fired operation decides which graph, and so which collection, is reached.
 */
export function checkViewGates(judge: Judge, trigger: Loaded<TriggerDoc>): void {
  const attached = new Set((trigger.doc.policies ?? []).map(use => judge.scope.canon(policyPath(use))));
  const faults = new Map<string, ViewFault>();
  for (const profile of judge.profiles()) {
    for (const found of viewsReached(judge, trigger.doc.fire.run, profile, attached)) {
      const seen = faults.get(found.message);
      if (seen) seen.profiles.push(profile);
      else faults.set(found.message, found);
    }
  }
  const refuse = judge.refuser(trigger.path);
  for (const fault of faults.values())
    refuse('A008', `${fault.message}${underProfiles(fault.profiles)}`, 'policies', fault.hint);
}

/** One view a trigger reaches without its policy: what the refusal says, the edit that fixes it, and where it was found. */
interface ViewFault {
  message: string;
  hint: string;
  profiles: (string | undefined)[];
}

/**
 * Every view an operation reaches under one profile whose `behind` no attached policy is. The walk is
 * `effectsReachable`, which ends at the native sites a run reaches with what each was given; which of those
 * is over a view is `collectionOf`, read off the store the site names.
 */
function viewsReached(judge: Judge, run: string, profile: string | undefined, attached: Set<string>): ViewFault[] {
  const out: ViewFault[] = [];
  for (const effect of effectsReachable(judge.scope, run, profile)) {
    const site = collectionOf(judge.scope, { key: effect.key, given: effect.given });
    if (!site) continue;
    const collection = judge.scope.registry.get('store', site.store)?.doc.collections[site.collection];
    const behind = collection?.view === undefined ? undefined : collection.behind;
    if (behind === undefined || attached.has(judge.scope.canon(behind))) continue;
    const message = `reaches ${effect.file}#${effect.node}, which reads ${site.collection}, a view of ${collection?.view} across every scope behind ${behind}, and attaches no such policy`;
    out.push({ message, hint: `attach "${behind}" under policies, or read ${collection?.view}`, profiles: [profile] });
  }
  return out;
}
