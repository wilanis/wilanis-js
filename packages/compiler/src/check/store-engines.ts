/**
 * What the engine behind a store can constrain (RFC 0022). A storage kind states in its `capabilities` which field
 * classes a `unique` may name and whether it enforces `refs`, and C008 reads that block for the kind of the
 * connection the store names, so a declaration that asks more than the engine gives is refused by `wilanis check`,
 * not by the database. A profile's stand-in for that connection is of the same kind (C018), so it asks nothing more.
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
  type Type,
} from '@wilanis/core';
import type { Judge, Refuser } from './judge.js';

/** The storage kind a store's connection is of, as the connection names it, with the connection and what it states. */
export interface Engine {
  kind: string;
  connection: string;
  capabilities: StorageCapabilities;
}

/** One collection's constraints, and the engine they are asked of. */
export interface Asked {
  refuse: Refuser;
  name: string;
  collection: Collection;
  fields: Record<string, ObjField>;
  engine: Engine | undefined;
}

/** Whether an engine holds no single value of a field: bytes live in the blob registry, and neither a shape nor a list is one value to refer by. */
export const unholdable = (type: Type): boolean =>
  type.kind === 'blob' || type.kind === 'object' || type.kind === 'list';

/**
 * The storage kind behind the connection a store names. Nothing for a connection that is not there (R001) or a
 * kind that reaches no engine (X203); a storage kind always carries the block, since one without it does not
 * validate when its plugin loads.
 */
export function engineOf(judge: Judge, store: StoreDoc): Engine | undefined {
  const connection = judge.scope.get('connection', store.connection);
  const kind = connection && judge.scope.get('connection-kind', connection.doc.kind);
  const capabilities = kind?.doc.storage ? kind.doc.capabilities : undefined;
  if (!connection || !capabilities) return undefined;
  return { kind: connection.doc.kind, connection: connection.path, capabilities };
}

/**
 * C008, from the engine: every field a `unique` names is of a class the store's engine constrains. A field the
 * shape lacks is C003's, and a blob, which has no class, is refused by type where the shape is judged.
 */
export function checkUniqueClasses(asked: Asked): void {
  const { engine, refuse } = asked;
  if (!engine) return;
  const { kind, connection, capabilities } = engine;
  const over = capabilities.unique.join(', ') || 'none';
  for (const { field, held, at } of uniqueClasses(asked)) {
    if (capabilities.unique.includes(held)) continue;
    const message = `'${field}' is ${withArticle(held)}, and ${connection} keeps no unique constraint over one`;
    refuse('C008', message, at, `'${field}' is ${withArticle(held)}; ${kind} constrains unique over ${over}`);
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

/**
 * C008, from the engine: a collection declares `refs` only where the store's engine enforces them. A field the
 * shape lacks (C003) or one C008 refused by its type already answers one refusal, not a second.
 */
export function checkRefsEnforced(asked: Asked): void {
  const { collection, name, fields, engine, refuse } = asked;
  if (!engine || engine.capabilities.refs) return;
  const hint = `${engine.kind} does not enforce refs; check the target with a get, or move the store to a connection that does`;
  for (const [field, ref] of Object.entries(collection.refs ?? {})) {
    const declared = fields[field];
    if (!declared || unholdable(declared.type)) continue;
    const message = `'${field}' refers to ${ref.collection}, and ${engine.connection} enforces no reference`;
    refuse('C008', message, `collections/${name}/refs/${field}`, hint);
  }
}

/** A field class with its article, as a sentence names it. */
const withArticle = (held: FieldClass): string => `${held === 'unknown' ? 'an' : 'a'} ${held}`;
