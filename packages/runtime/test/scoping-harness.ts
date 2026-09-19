/**
 * A copy of the example whose entries are kept per tenant, for the rules that judge how a store is scoped.
 * The example does not scope its store yet -- that is RFC 0015's step 10 -- so every case here starts from a
 * tree that does: the session shape the guard's settings name gains the attribute, the monitor's one edge
 * document that reads the request gains the resolver, and the store binds the read and scopes `entries` by it.
 * A case then breaks one of those three and reads what the tree answers.
 *
 * The included access tree is copied too, since the session shape lives there and a scope's whole claim is
 * about what the guard hands: `example-harness` edits the example alone, and this is the one thing step 2's
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

/** The store the monitor keeps its entries in, and the one edge document of that feature that reads the request. */
export const STORE = 'features/monitor/data/entries.store.json';
export const RESOLVERS = 'features/monitor/edge/request.resolvers.json';
/** The session shape the guard's settings.session names, in the included access tree. */
export const SESSION = 'features/access/domain/Session.shape.json';

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

/**
 * What the example scopes its entries by, written into a copy: the attribute the sign-in would have put in
 * the session, the resolver that reads it back off what the guard hands, and the store binding that read and
 * scoping the collection by it. The attribute is declared optional in the shape and `required` on the
 * resolver, so the sign-in graphs of the access tree need no change and the read is still read as present.
 */
function scope(example: string, access: string): void {
  editing(access, SESSION, shape => {
    shape.fields.tenant = { type: 'string', required: false, description: 'written at sign-in, and never again' };
  });
  editing(example, RESOLVERS, doc => {
    doc.resolvers.tenant = {
      read: 'request.session.attributes.tenant',
      required: true,
      description: "the caller's tenant, written into the session at sign-in",
    };
  });
  editing(example, STORE, store => {
    store.reads = { tenant: '@monitor/edge/request.resolvers.json#tenant' };
    store.collections.entries.scoped = { tenant: '{{tenant}}' };
  });
}

/** Both copies, scoped, with whatever further edits a case asks for, and the include that reaches the second. */
function scoped(edits: Edits, accessEdits: Edits): { dir: string; access: string; includes: ResolvedInclude[] } {
  const dir = copyOf(EXAMPLE);
  const access = copyOf(INCLUDES[0].dir);
  scope(dir, access);
  for (const [file, edit] of Object.entries(edits)) editing(dir, file, edit);
  for (const [file, edit] of Object.entries(accessEdits)) editing(access, file, edit);
  return { dir, access, includes: [{ ...INCLUDES[0], dir: access }] };
}

/** Read the refusals of a scoped copy however a case needs them; the copies do not outlive the answer. */
function answered(edits: Edits, accessEdits: Edits, read: (one: Refusal) => string): string[] {
  const { dir, access, includes } = scoped(edits, accessEdits);
  const out = checkTree(loadTree(dir, PLUGINS, includes)).items.map(read);
  rmSync(dir, { recursive: true, force: true });
  rmSync(access, { recursive: true, force: true });
  return out;
}

/** One refusal, as much of it as a case reads. */
interface Refusal {
  code: string;
  file: string;
  at?: string;
  message: string;
  hint?: string;
}

/**
 * The example scoped by a tenant, with the edits a case asks for, answered as refusal codes. With no edits it
 * is the tree RFC 0015 step 10 will write, minus the policies its triggers gain: A006 and B008 are what a
 * scope earns a trigger and a startup step that do not guarantee the read, and are cases of their own.
 */
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
 * The scoped copy loaded, for a case whose claim is not a refusal but what the tree compiles to: the lowering
 * fills a scope from documents alone, so it needs the tree open rather than its refusals. The copies live for
 * the length of the call and no longer, as they do for a case that only reads what was refused.
 */
export function scopedTree<T>(read: (load: LoadResult) => T, edits: Edits = {}, accessEdits: Edits = {}): T {
  const { dir, access, includes } = scoped(edits, accessEdits);
  try {
    return read(loadTree(dir, PLUGINS, includes));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(access, { recursive: true, force: true });
  }
}
