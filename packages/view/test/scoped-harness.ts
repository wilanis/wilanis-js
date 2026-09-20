/**
 * A copy of the example whose entries are kept per tenant, with a view across every tenant, for the pages that
 * draw a scope and a view (RFC 0015). The example does not scope its store yet -- that is RFC 0015's step 10 --
 * so every case here starts from a tree that does: the session shape the guard's settings name gains the
 * attribute, the monitor's one edge document that reads the request gains the resolver, and the store binds the
 * read, scopes `entries` by it and declares `everyEntry` as a view behind the employees-only policy.
 *
 * This mirrors `packages/runtime/test/scoping-harness.ts`, which plants the same tree for the checker's rules.
 * It is a copy rather than an import because the two packages' tests do not share a directory, and because what
 * a page needs from the tree is a loaded one rather than its refusals.
 *
 * The included access tree is copied too, since the session shape lives there and a scope's whole claim is about
 * what the guard hands.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTree, type PluginModule, type ResolvedInclude } from '@wilanis/core';
import auth from '@wilanis/plugin-auth';
import blob from '@wilanis/plugin-blob';
import http from '@wilanis/plugin-http';
import otel from '@wilanis/plugin-otel';
import reload from '@wilanis/plugin-reload';
import schedule from '@wilanis/plugin-schedule';
import storage from '@wilanis/plugin-storage';
import memory from '@wilanis/plugin-storage-memory';
import postgres from '@wilanis/plugin-storage-postgres';
import { BUILTIN_PLUGINS } from '@wilanis/runtime';
import { type DocView, viewOf } from '../src/index.js';

const EXAMPLE = fileURLToPath(new URL('../../../example', import.meta.url));
const ACCESS = fileURLToPath(new URL('../../../libraries/access', import.meta.url));

/** The store the monitor keeps its entries in, and the one edge document of that feature that reads the request. */
export const STORE_FILE = 'features/monitor/data/entries.store.json';
export const RESOLVERS_FILE = 'features/monitor/edge/request.resolvers.json';
/** The session shape the guard's settings.session names, in the included access tree. */
export const SESSION_FILE = 'features/access/domain/Session.shape.json';

/** Where a document being edited lives: the example itself, or the access tree it includes. */
export type Edits = Record<string, (doc: any) => void>;

/** The plugins the example names, handed in: a copy of the tree has no node_modules and resolves none of them. */
const PLUGINS: Record<string, PluginModule> = {
  ...BUILTIN_PLUGINS,
  '@http': http,
  '@blob': blob,
  '@reload': reload,
  '@auth': auth,
  '@schedule': schedule,
  '@storage': storage,
  '@storage-memory': memory,
  '@storage-postgres': postgres,
  '@otel': otel,
};

/** A view of the scoped entries, across every tenant, behind the policy the access tree declares for employees. */
export const VIEW = {
  view: 'entries',
  behind: '@access/edge/employees-only.policy.json',
  description: 'the same rows, every tenant',
};

/** Apply an edit to one document of a copied tree, in place. */
function editing(dir: string, file: string, edit: Edits[string]): void {
  const path = join(dir, file);
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  edit(doc);
  writeFileSync(path, JSON.stringify(doc));
}

/** A throwaway copy of one tree, without what a check must not read. */
function copyOf(from: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-view-scoped-'));
  cpSync(from, dir, { recursive: true, filter: path => !path.includes('node_modules') });
  return dir;
}

/**
 * What the example scopes its entries by, written into a copy: the attribute the sign-in would have put in the
 * session, the resolver that reads it back off what the guard hands, and the store binding that read and scoping
 * the collection by it. The attribute is declared optional in the shape and `required` on the resolver, so the
 * sign-in graphs of the access tree need no change and the read is still read as present.
 */
function scope(example: string, access: string): void {
  editing(access, SESSION_FILE, shape => {
    shape.fields.tenant = { type: 'string', required: false, description: 'written at sign-in, and never again' };
  });
  editing(example, RESOLVERS_FILE, doc => {
    doc.resolvers.tenant = {
      label: "The caller's tenant",
      read: 'request.session.attributes.tenant',
      required: true,
      description: 'written into the session at sign-in; every entry belongs to one',
    };
  });
  editing(example, STORE_FILE, store => {
    store.reads = { tenant: '@monitor/edge/request.resolvers.json#tenant' };
    store.collections.entries.scoped = { tenant: '{{tenant}}' };
  });
}

/**
 * The view of one document of the example scoped by a tenant, with whatever further edits a case asks for. The
 * copies live for the length of the call and no longer.
 */
export function scopedView(path: string, edits: Edits = {}, accessEdits: Edits = {}): DocView {
  const dir = copyOf(EXAMPLE);
  const access = copyOf(ACCESS);
  try {
    scope(dir, access);
    for (const [file, edit] of Object.entries(edits)) editing(dir, file, edit);
    for (const [file, edit] of Object.entries(accessEdits)) editing(access, file, edit);
    const includes: ResolvedInclude[] = [{ from: '@wilanis/access', dir: access, features: ['access'] }];
    const seen = viewOf(loadTree(dir, PLUGINS, includes), path);
    if (!seen) throw new Error(`no view for ${path}`);
    return seen;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(access, { recursive: true, force: true });
  }
}
