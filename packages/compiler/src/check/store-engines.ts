/**
 * What the engine behind a store can constrain (RFC 0022). A storage kind states in its `capabilities` which field
 * classes a `unique` may name and whether it enforces `refs`, and C008 reads that block for the kind of every
 * connection the store reaches -- the one it names, and each profile's stand-in for it -- so a declaration that asks
 * more than an engine gives is refused by `wilanis check`, not by the database.
 *
 * Beside `stores.ts`, which judges a constraint against the shape; this judges it against the engine.
 */
import {
  type Collection,
  type FieldClass,
  fieldClass,
  type ObjField,
  type StorageCapabilities,
  type StoreDoc,
} from '@wilanis/core';
import type { Judge, Refuser } from './judge.js';

/** A storage kind a store reaches, as its connection names it, with the connection that reaches it and what it states. */
export interface Engine {
  kind: string;
  connection: string;
  capabilities: StorageCapabilities;
}

/** One collection's constraints, and the engines they are asked of. */
export interface Asked {
  refuse: Refuser;
  name: string;
  collection: Collection;
  fields: Record<string, ObjField>;
  engines: Engine[];
}

/**
 * The storage kinds a store's connection reaches, each once: under every profile, the connection the profile puts
 * in its place or the one named. Nothing for a connection that is not there (R001) or a kind that reaches no engine
 * (X203); a storage kind always carries the block, since one without it does not validate when its plugin loads.
 */
export function enginesOf(judge: Judge, store: StoreDoc): Engine[] {
  const found = new Map<string, Engine>();
  for (const profile of judge.profiles()) {
    const reached = judge.scope.connectionFor(store.connection, profile);
    if (typeof reached === 'string') continue;
    const kind = judge.scope.get('connection-kind', reached.doc.kind);
    const capabilities = kind?.doc.storage ? kind.doc.capabilities : undefined;
    if (!kind || !capabilities || found.has(kind.path)) continue;
    found.set(kind.path, { kind: reached.doc.kind, connection: reached.path, capabilities });
  }
  return [...found.values()];
}

/**
 * C008, from the engine: every field a `unique` names is of a class each engine the store reaches constrains. A
 * field the shape lacks is C003's, and a blob, which has no class, is refused by type where the shape is judged.
 */
export function checkUniqueClasses(asked: Asked): void {
  const { engines, refuse } = asked;
  for (const { field, held, at } of uniqueClasses(asked)) {
    for (const { kind, connection, capabilities } of engines) {
      if (capabilities.unique.includes(held)) continue;
      const over = capabilities.unique.join(', ') || 'none';
      const message = `'${field}' is ${withArticle(held)}, and ${connection} keeps no unique constraint over one`;
      refuse('C008', message, at, `'${field}' is ${withArticle(held)}; ${kind} constrains unique over ${over}`);
    }
  }
}

/** Every field a `unique` names that has a class, with that class and where the field sits in its entry. */
function uniqueClasses(asked: Asked): { field: string; held: FieldClass; at: string }[] {
  const { collection, name, fields } = asked;
  return (collection.unique ?? []).flatMap((one, index) =>
    one.flatMap((field, position) => {
      const declared = fields[field];
      const held = declared && fieldClass(declared.type);
      return held ? [{ field, held, at: `collections/${name}/unique/${index}/${position}` }] : [];
    }),
  );
}

/** C008, from the engine: a collection declares `refs` only where each engine the store reaches enforces them. */
export function checkRefsEnforced(asked: Asked): void {
  const { collection, name, engines, refuse } = asked;
  for (const [field, ref] of Object.entries(collection.refs ?? {})) {
    const at = `collections/${name}/refs/${field}`;
    for (const { kind, connection, capabilities } of engines) {
      if (capabilities.refs) continue;
      const message = `'${field}' refers to ${ref.collection}, and ${connection} enforces no reference`;
      const hint = `${kind} does not enforce refs; check the target with a get, or move the store to a connection that does`;
      refuse('C008', message, at, hint);
    }
  }
}

/** A field class with its article, as a sentence names it. */
const withArticle = (held: FieldClass): string => `${held === 'unknown' ? 'an' : 'a'} ${held}`;
