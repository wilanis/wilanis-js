/**
 * The example, loaded as the viewer loads it, for the pages that draw a scope and a view (RFC 0015). The example
 * keeps its customers per tenant: the session shape the guard's settings name carries the attribute, the
 * customers feature's resolvers read it back, and the store binds that read, scopes `customers` by it and
 * declares `everyCustomer` as a view behind the employees-only policy. A case reads the page as written, or
 * edits a copy where what an unscoped store draws is the claim.
 *
 * This is the viewer's side of `packages/runtime/test/scoping-harness.ts`, which edits the same tree for the
 * checker's rules. It is its own file rather than an import because the two packages' tests do not share a
 * directory, and because what a page needs from the tree is a loaded one rather than its refusals.
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
/** The tree the example includes, as the runtime would resolve it from the example's node_modules. */
const INCLUDES: ResolvedInclude[] = [
  {
    from: '@wilanis/access',
    dir: fileURLToPath(new URL('../../../libraries/access', import.meta.url)),
    features: ['access'],
  },
];

/** The store the local profile keeps its customers in. */
export const STORE_FILE = 'features/customers/data/customers.store.json';

/** An edit to one document of a copy of the example, by its path in the tree. */
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

/** Apply an edit to one document of a copied tree, in place. */
function editing(dir: string, file: string, edit: Edits[string]): void {
  const path = join(dir, file);
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  edit(doc);
  writeFileSync(path, JSON.stringify(doc));
}

/** The view of one document of the example as written. */
const viewed = (root: string, path: string): DocView => {
  const seen = viewOf(loadTree(root, PLUGINS, INCLUDES), path);
  if (!seen) throw new Error(`no view for ${path}`);
  return seen;
};

/**
 * The view of one document of the example, or of a copy of it with the edits a case asks for. A copy lives for
 * the length of the call and no longer.
 */
export function scopedView(path: string, edits?: Edits): DocView {
  if (!edits) return viewed(EXAMPLE, path);
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-view-scoped-'));
  try {
    cpSync(EXAMPLE, dir, { recursive: true, filter: from => !from.includes('node_modules') });
    for (const [file, edit] of Object.entries(edits)) editing(dir, file, edit);
    return viewed(dir, path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
