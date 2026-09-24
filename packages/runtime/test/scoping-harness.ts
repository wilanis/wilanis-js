/**
 * The example and the access tree it includes, copied together, for the rules that judge how a store is scoped.
 * The example keeps its customers per tenant (RFC 0015 step 10): the session shape the guard's settings name
 * carries the attribute, the sign-in graphs write it, the customers feature's resolvers read it back off what the
 * guard hands, and both stores bind that read, scope `customers` by it and declare `everyCustomer` as the one way
 * across. A case breaks one of those and reads what the tree answers; with no edits it answers nothing.
 *
 * The included access tree is copied too, since the session shape and the sign-in live there and a scope's whole
 * claim is about what the guard hands: `example-harness` edits the example alone, and this is the one thing these
 * cases need that it cannot do.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { type LoadResult, loadTree, type ResolvedInclude } from '@wilanis/core';
import { EXAMPLE, INCLUDES, PLUGINS } from './example-harness.js';

/** Where a document being edited lives: the example itself, or the access tree it includes. */
export type Edits = Record<string, (doc: any) => void>;

/** The store the local profile keeps its customers in, and the one edge document of that feature that reads the request. */
export const STORE = 'features/customers/data/customers.store.json';
export const RESOLVERS = 'features/customers/edge/request.resolvers.json';
/** The store the production profile keeps the same customers in, scoped the same way. */
export const POSTGRES_STORE = 'features/customers/data/customers-postgres.store.json';
/** The session shape the guard's settings.session names, in the included access tree. */
export const SESSION = 'features/access/domain/Session.shape.json';
/** The data graphs over the collection: one read by key, one find, the find over the view, and the one that mints a key. */
export const GET = 'features/customers/data/kept-get.graph.json';
export const LIST = 'features/customers/data/kept-list.graph.json';
export const LIST_EVERY = 'features/customers/data/kept-list-every.graph.json';
export const NEXT_ID = 'features/customers/data/next-id.graph.json';
/** The two triggers whose policies prove the scope's read and open the view: one per rule a policy answers. */
export const GET_TRIGGER = 'features/customers/edge/get-customer.trigger.json';
export const DIGEST_TRIGGER = 'features/customers/edge/digest.trigger.json';

/** A store as it read before scoping existed: no read bound, no column kept beside the records, no view across. */
const unscope = (store: any): void => {
  delete store.reads;
  delete store.collections.customers.scoped;
  delete store.collections.everyCustomer;
};

/** Both stores unscoped: the tree a case compares the example with, where what did not change is the claim. */
export const UNSCOPED: Edits = { [STORE]: unscope, [POSTGRES_STORE]: unscope };

/** Apply an edit to one document of a copied tree, in place. */
function editing(dir: string, file: string, edit: (doc: any) => void): void {
  const path = join(dir, file);
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  edit(doc);
  writeFileSync(path, JSON.stringify(doc));
}

/** A throwaway copy of one tree, without what a check must not read. */
function copyOf(from: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-scoped-'));
  cpSync(from, dir, { recursive: true, filter: path => !path.includes('node_modules') });
  return dir;
}

/** Both copies, with whatever edits a case asks for, and the include that reaches the second. */
function edited(edits: Edits, accessEdits: Edits): { dir: string; access: string; includes: ResolvedInclude[] } {
  const dir = copyOf(EXAMPLE);
  const access = copyOf(INCLUDES[0].dir);
  for (const [file, edit] of Object.entries(edits)) editing(dir, file, edit);
  for (const [file, edit] of Object.entries(accessEdits)) editing(access, file, edit);
  return { dir, access, includes: [{ ...INCLUDES[0], dir: access }] };
}

/** Read the refusals of an edited copy however a case needs them; the copies do not outlive the answer. */
function answered(edits: Edits, accessEdits: Edits, read: (one: Refusal) => string): string[] {
  return scopedTree(load => checkTree(load).items.map(read), edits, accessEdits);
}

/** One refusal, as much of it as a case reads. */
interface Refusal {
  code: string;
  file: string;
  at?: string;
  message: string;
  hint?: string;
}

/** The example, with the edits a case asks of it and of the access tree, answered as refusal codes. */
export const scopedCodes = (edits: Edits = {}, accessEdits: Edits = {}): string[] =>
  answered(edits, accessEdits, one => one.code);

/** The same, as `code file#at`: for a case whose claim is which entry of the store a refusal points at. */
export const scopedPointing = (edits: Edits = {}, accessEdits: Edits = {}): string[] =>
  answered(edits, accessEdits, one => `${one.code} ${one.file}${one.at ? `#${one.at}` : ''}`);

/** The same, as `code message`: for a case whose claim is what the refusal says. */
export const scopedSaying = (edits: Edits = {}, accessEdits: Edits = {}): string[] =>
  answered(edits, accessEdits, one => `${one.code} ${one.message}`);

/** The same, as `code hint`: for a case whose claim is the edit the refusal offers. */
export const scopedHinting = (edits: Edits = {}, accessEdits: Edits = {}): string[] =>
  answered(edits, accessEdits, one => `${one.code} ${one.hint}`);

/**
 * The edited copy loaded, for a case whose claim is not a refusal but what the tree compiles to or says: the
 * lowering fills a scope from documents alone, so it needs the tree open rather than its refusals. The copies
 * live for the length of the call and no longer, as they do for a case that only reads what was refused.
 */
export function scopedTree<T>(read: (load: LoadResult) => T, edits: Edits = {}, accessEdits: Edits = {}): T {
  const { dir, access, includes } = edited(edits, accessEdits);
  try {
    return read(loadTree(dir, PLUGINS, includes));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(access, { recursive: true, force: true });
  }
}
