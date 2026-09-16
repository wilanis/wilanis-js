/**
 * What the example's tests run against: the tree itself, the plugins and the included access tree it loads with, and
 * the copies a sabotage test breaks one document in.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTree } from '@wilanis/compiler';
import { type LoadResult, loadTree, type PluginModule, type ResolvedInclude } from '@wilanis/core';
import auth from '@wilanis/plugin-auth';
import blobs from '@wilanis/plugin-blob';
import http from '@wilanis/plugin-http';
import otel from '@wilanis/plugin-otel';
import reload from '@wilanis/plugin-reload';
import schedule from '@wilanis/plugin-schedule';
import storage from '@wilanis/plugin-storage';
import memory from '@wilanis/plugin-storage-memory';
import postgres from '@wilanis/plugin-storage-postgres';
import { BUILTIN_PLUGINS } from '../src/index.js';

export const EXAMPLE = fileURLToPath(new URL('../../../example', import.meta.url));
export const PLUGINS = {
  ...BUILTIN_PLUGINS,
  '@http': http,
  '@blob': blobs,
  '@reload': reload,
  '@auth': auth,
  '@schedule': schedule,
  '@storage': storage,
  '@storage-memory': memory,
  '@storage-postgres': postgres,
  '@otel': otel,
};

/** The tree the example includes, as the runtime would resolve it from the example's node_modules. */
export const INCLUDES: ResolvedInclude[] = [
  {
    from: '@wilanis/access',
    dir: fileURLToPath(new URL('../../../libraries/access', import.meta.url)),
    features: ['access'],
  },
];

/** The refusal codes a tree answers with. */
export const codes = (root: string) => checkTree(loadTree(root, PLUGINS, INCLUDES)).items.map(refusal => refusal.code);

/** The refusals a tree answers with, as `code file#at`: what a case needs when where it points is the claim. */
export const refusalsAt = (root: string) =>
  checkTree(loadTree(root, PLUGINS, INCLUDES)).items.map(one => `${one.code} ${one.file}${one.at ? `#${one.at}` : ''}`);

/** The refusals a tree answers with, as `code message`: what a case needs when what it says is the claim. */
export const refusalsSaying = (root: string) =>
  checkTree(loadTree(root, PLUGINS, INCLUDES)).items.map(one => `${one.code} ${one.message}`);

/** A plugin's docs directory, written from name -> document. */
export function docsDir(docs: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-docs-'));
  for (const [name, doc] of Object.entries(docs)) writeFileSync(join(dir, name), JSON.stringify(doc));
  return dir;
}

/** A throwaway copy of the example, without what a check must not read. */
function copyOfExample(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-'));
  cpSync(EXAMPLE, dir, { recursive: true, filter: path => !path.includes('node_modules') });
  return dir;
}

/**
 * What a broken copy of the example answers, read however the case needs it; the copy does not outlive the
 * answer. `codesAfter` and its siblings are this with the reading fixed.
 */
function after(change: (dir: string) => void, read: (dir: string) => string[]): string[] {
  const dir = copyOfExample();
  change(dir);
  const out = read(dir);
  rmSync(dir, { recursive: true, force: true });
  return out;
}

/** The refusal codes a copy answers with, once it has been broken. */
const codesAfter = (change: (dir: string) => void): string[] => after(change, codes);

/** Apply an edit to one document of a copied tree, in place. */
const editing = (file: string, edit: (doc: any) => void) => (dir: string) => {
  const path = join(dir, file);
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  edit(doc);
  writeFileSync(path, JSON.stringify(doc));
};

/**
 * The example checked against a plugin one of whose shipped documents has been broken: the plugin's docs are
 * copied, one document edited, and a module handed in with the copy as its `docs`. What a plugin declares --
 * a trigger kind's context, what correlates a run with its caller's trace -- is judged nowhere else, and the
 * example is the tree that names it.
 */
export function withBrokenPluginDoc(
  plugin: PluginModule,
  doc: string,
  edit: (doc: any) => void,
): { codes: string[]; at: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-docs-'));
  cpSync(plugin.docs, dir, { recursive: true });
  editing(doc, edit)(dir);
  const plugins = { ...PLUGINS, [plugin.root]: { ...plugin, docs: dir } };
  const refusals = checkTree(loadTree(EXAMPLE, plugins, INCLUDES)).items;
  rmSync(dir, { recursive: true, force: true });
  return {
    codes: refusals.map(one => one.code),
    at: refusals.map(one => `${one.code} ${one.file}${one.at ? `#${one.at}` : ''}`),
  };
}

/** Copy the example, apply an edit to one file, answer the refusal codes. */
export function sabotage(file: string, edit: (doc: any) => void): string[] {
  return codesAfter(editing(file, edit));
}

/**
 * The same sabotage, answered as code and the place each refusal points at -- what a case needs when the
 * constraint it broke is one of several in the document, and which one was named is the claim.
 */
export function sabotagePointing(file: string, edit: (doc: any) => void): string[] {
  return after(editing(file, edit), refusalsAt);
}

/**
 * The same sabotage, answered as code and what each refusal says -- what a case needs when the message
 * itself is the claim, as it is where a refusal has to name the profiles that found the fault.
 */
export function sabotageSaying(file: string, edit: (doc: any) => void): string[] {
  return after(editing(file, edit), refusalsSaying);
}

/** Copy the example, move one document to another path, and answer the refusal codes. */
export function relocate(from: string, to: string): string[] {
  return codesAfter(dir => {
    mkdirSync(dirname(join(dir, to)), { recursive: true });
    renameSync(join(dir, from), join(dir, to));
  });
}

/** Copy the example, write raw bytes over one file, and answer the refusal codes. */
export function corrupt(file: string, bytes: string): string[] {
  return codesAfter(dir => writeFileSync(join(dir, file), bytes));
}

/** Copy the example, delete one file, and answer the refusal codes. */
export function without(file: string): string[] {
  return codesAfter(dir => rmSync(join(dir, file), { force: true }));
}

/** Copy the example, add a document at a path it does not have, and answer the refusal codes. */
export function planted(file: string, doc: unknown): string[] {
  return plantedAll({ [file]: doc });
}

/** Copy the example, add several documents at paths it does not have, and answer the refusal codes. */
export function plantedAll(docs: Record<string, unknown>): string[] {
  return codesAfter(dir => write(dir, docs));
}

/** Copy the example, add several documents, and answer each refusal as `code file#at`. */
export function plantedPointing(docs: Record<string, unknown>): string[] {
  return after(dir => write(dir, docs), refusalsAt);
}

/**
 * Copy the example, add documents, and answer the tree as loaded together with the directory it sits in --
 * what a case needs when it reads what `describe` says rather than what the checker refuses. The caller
 * removes the directory.
 */
export function loadedWith(docs: Record<string, unknown>): { load: LoadResult; dir: string } {
  const dir = copyOfExample();
  write(dir, docs);
  return { load: loadTree(dir, PLUGINS, INCLUDES), dir };
}

/**
 * Copy the example, add documents at paths it does not have and edit several it has, and answer each refusal
 * as `code message`: what a case needs when the claim is about which profiles a rule was judged under, since
 * which profiles reach a graph is written across the bindings rather than in any one of them.
 */
export function plantedEditingAllSaying(
  docs: Record<string, unknown>,
  edits: Record<string, (doc: any) => void>,
): string[] {
  return after(dir => {
    write(dir, docs);
    for (const [file, edit] of Object.entries(edits)) editing(file, edit)(dir);
  }, refusalsSaying);
}

/** The same, answered as `code file#at`: for a case whose claim is which document a refusal points at. */
export function plantedEditingAllAt(
  docs: Record<string, unknown>,
  edits: Record<string, (doc: any) => void>,
): string[] {
  return after(dir => {
    write(dir, docs);
    for (const [file, edit] of Object.entries(edits)) editing(file, edit)(dir);
  }, refusalsAt);
}

/**
 * Copy the example, edit one document it has, and answer the tree as loaded together with the directory it
 * sits in: what a case needs when it reads what `describe`, `map` or the view model says about a document
 * the example does not yet write that way. The caller removes the directory.
 */
export function loadedEditing(file: string, edit: (doc: any) => void): { load: LoadResult; dir: string } {
  const dir = copyOfExample();
  editing(file, edit)(dir);
  return { load: loadTree(dir, PLUGINS, INCLUDES), dir };
}

/**
 * Copy the example, add documents at paths it does not have and edit one it has, and answer the refusal
 * codes: what a case needs when the document it plants is only refused once another says it may be named.
 */
export function plantedEditing(docs: Record<string, unknown>, file: string, edit: (doc: any) => void): string[] {
  return codesAfter(plantingAndEditing(docs, file, edit));
}

/** The same, answered as code and what each refusal says: for a case whose claim is the message. */
export function plantedEditingSaying(docs: Record<string, unknown>, file: string, edit: (doc: any) => void): string[] {
  return after(plantingAndEditing(docs, file, edit), refusalsSaying);
}

/** Write the planted documents into a copy, then edit one it already has. */
const plantingAndEditing = (docs: Record<string, unknown>, file: string, edit: (doc: any) => void) => (dir: string) => {
  write(dir, docs);
  editing(file, edit)(dir);
};

/** Write each document into the copy, making the directories it needs. */
function write(dir: string, docs: Record<string, unknown>): void {
  for (const [file, doc] of Object.entries(docs)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), JSON.stringify(doc));
  }
}
