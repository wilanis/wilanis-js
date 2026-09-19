/**
 * C scoping. What a store says about whose rows a caller sees: which columns it keeps beside a collection's
 * records and the read that fills each (C012), and which collections see another's rows across every scope
 * (C013). Both are judged once the resolvers documents are read, since a scope's whole claim is about the
 * resolver it names -- that the store binds it, that it is read as present, and that what it reads is a value
 * a column can hold -- and `checkResolversDoc` is what has judged those.
 *
 * Split from `stores.ts` for the same reason that was split from `contracts.ts`: a store says what it keeps
 * and what it once called it, and this says who may see it. P005 is here too, because what makes a `reads`
 * entry used on a store is a `scoped` column reading it, which is this file's word.
 */
import { type Loaded, type StoreDoc, show, WHOLE_TEMPLATE } from '@wilanis/core';
import type { Judge, JudgedResolver, Refuser } from './judge.js';
import { resolversFor } from './resolvers.js';

/**
 * Every refusal about how a store is scoped: each `reads` entry names a resolver of a document the store may
 * see (P004, R001, L005), each `scoped` column is filled by exactly one of them (C012), each `reads` entry is
 * read by some column (P005), and each view names a scoped collection of this store behind a policy (C013).
 */
export function checkStoreScoping(judge: Judge, store: Loaded<StoreDoc>): void {
  const refuse = judge.refuser(store.path);
  const resolvers = resolversFor(judge, store.doc.reads, store, true);
  const read = new Set<string>();
  for (const [name, collection] of Object.entries(store.doc.collections)) {
    for (const [column, value] of Object.entries(collection.scoped ?? {}))
      checkColumn({ judge, refuse, store, resolvers }, { name, column, value, read });
    checkView(judge, refuse, store, name);
  }
  checkReadsUsed(refuse, resolvers, read);
}

/** What one scoped column is judged against: the tree, the store, and the reads the store bound. */
interface Scoping {
  judge: Judge;
  refuse: Refuser;
  store: Loaded<StoreDoc>;
  resolvers: Record<string, JudgedResolver>;
}

/** One scoped column as written: which collection declares it, the column, the value, and the names read so far. */
interface Column {
  name: string;
  column: string;
  value: string;
  read: Set<string>;
}

const HINT_ONE_READ = (column: string, name: string) =>
  `write "scoped": { "${column}": "{{${name}}}" } and bind ${name}: "reads": { "${name}": "@<feature>/edge/<file>.resolvers.json#${name}" }`;

/**
 * C012: a scope is a column the store keeps beside the record, filled by exactly one read the store binds.
 * The judgement is made here, over the document, because after lowering a resolver read and a hand-written
 * `{{request.session.attributes.tenant}}` are the same source and nothing downstream can tell them apart.
 */
function checkColumn(scoping: Scoping, column: Column): void {
  const at = `collections/${column.name}/scoped/${column.column}`;
  const name = wholeRead(column.value);
  if (!name) {
    const message = `'${column.value}' is not a read; a scope is exactly one resolver the store binds under reads`;
    scoping.refuse('C012', message, at, HINT_ONE_READ(column.column, column.column));
    return;
  }
  column.read.add(name);
  checkNotAField(scoping, column, at);
  const resolver = scoping.resolvers[name];
  if (!resolver) {
    const bound = Object.keys(scoping.store.doc.reads ?? {}).join(', ') || 'none';
    const message = `'${name}' is not a read this store binds (reads: ${bound})`;
    scoping.refuse('C012', message, at, HINT_ONE_READ(column.column, name));
    return;
  }
  checkResolver(scoping, column, at, resolver);
}

/**
 * The one name a value reads whole, or nothing: a scope is `{{name}}` and nothing else -- no literal, no
 * interpolation around it, and no field of the read, since a path of more than one segment reads into what
 * the resolver answered rather than being it.
 */
function wholeRead(value: string): string | undefined {
  const match = WHOLE_TEMPLATE.exec(value);
  const path = match?.[1].split('.');
  return path?.length === 1 ? path[0] : undefined;
}

/**
 * C012: a scope is a column the store keeps, never a field of the record. A field the shape declares is the
 * record's own, written by whatever made it, so a store scoped by one would hold the record to a value the
 * caller could have sent -- exactly the provenance the rule exists to refuse.
 */
function checkNotAField(scoping: Scoping, column: Column, at: string): void {
  const collection = scoping.store.doc.collections[column.name];
  const type = collection.of === undefined ? undefined : scoping.judge.quiet(collection.of);
  if (type?.kind !== 'object' || !(column.column in type.fields)) return;
  const message = `'${column.column}' is a field of ${collection.of}, and a scope is a column the store keeps beside the record`;
  scoping.refuse('C012', message, at, 'a scope is a column the store keeps, not a field of the shape: rename one');
}

/**
 * C012: what the bound resolver must be. Required, so the read is present wherever the collection is reached
 * and A006 holds every trigger reaching it to a policy that proves it; and a string or a number, since a
 * column holds one value -- a read that types `unknown`, as a claim of the open `request.principal.claims`
 * does and as a session attribute does in a tree whose guard names no session shape, is refused here.
 */
function checkResolver(scoping: Scoping, column: Column, at: string, resolver: JudgedResolver): void {
  if (!resolver.required) {
    const message = `the read '${column.value}' is not declared required, and a scope is read as present`;
    scoping.refuse('C012', message, at, 'declare the resolver required: a scope is read as present');
  }
  const kind = resolver.read.type.kind;
  if (kind === 'string' || kind === 'number') return;
  const read = `request.${resolver.path.join('.')}`;
  const message = `the read '${column.value}' is ${read}, which is ${show(resolver.read.type)}, and a column holds a string or a number`;
  const hint = 'a scope is a string or a number: declare the attribute in the shape the guard’s settings.session names';
  scoping.refuse('C012', message, at, hint);
}

/**
 * C013: a view sees every row of one scoped collection of this store. The schema keeps a view's shape apart
 * from a kept collection's, so what is left here is what it cannot say: which collection `view` names, and
 * whether that one keeps records and is scoped at all.
 */
function checkView(judge: Judge, refuse: Refuser, store: Loaded<StoreDoc>, name: string): void {
  const viewed = store.doc.collections[name].view;
  if (viewed === undefined) return;
  const at = `collections/${name}/view`;
  const hint = 'a view sees every row of one scoped collection of this store';
  const target = store.doc.collections[viewed];
  if (!target) {
    const has = Object.keys(store.doc.collections).join(', ');
    refuse('C013', `'${viewed}' is not a collection of this store (collections: ${has})`, at, hint);
  } else if (target.view !== undefined) {
    const why = `'${viewed}' is itself a view of '${target.view}', and a view sees a collection of records`;
    refuse('C013', why, at, hint);
  } else if (!target.scoped) {
    const why = `'${viewed}' declares no scoped columns, so every row of it is seen already`;
    refuse('C013', why, at, 'scope the collection this views, or read it directly: a view is the way across a scope');
  }
  checkBehind(judge, refuse, store, name);
}

/** R001, L005: `behind` names a policy document this store may see -- the one every trigger reaching the view attaches. */
function checkBehind(judge: Judge, refuse: Refuser, store: Loaded<StoreDoc>, name: string): void {
  const behind = store.doc.collections[name].behind;
  if (behind === undefined) return; // the schema requires it beside a view
  const at = `collections/${name}/behind`;
  const policy = judge.scope.get('policy', behind);
  if (!policy) {
    refuse('R001', `unknown policy '${behind}'`, at, 'wilanis ls policy');
    return;
  }
  judge.visible(store, policy, at);
}

/**
 * P005: `reads` is exactly what this store reads, so an entry no `scoped` column fills from is refused as an
 * unused import is -- the same rule a graph and a binding are held to, over the one thing a store reads with.
 */
function checkReadsUsed(refuse: Refuser, resolvers: Record<string, JudgedResolver>, read: Set<string>): void {
  for (const name of Object.keys(resolvers)) {
    if (read.has(name)) continue;
    const hint = `scope a collection by it as "scoped": { "<column>": "{{${name}}}" }, or drop the entry: reads is exactly what this document reads`;
    refuse('P005', `'${name}' is read by no scoped collection of this store`, `reads/${name}`, hint);
  }
}
