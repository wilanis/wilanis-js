/**
 * What the engine behind a connection can do, as its kind document says (RFC 0022). An engine never reports
 * its capabilities: the plugin that grants the kind writes them into the kind, where `wilanis check` and a
 * reader can see them with no connection open, and the engine's `postLoad` holds the server reached to them.
 *
 * The migration planner is the reader here; no handler of the store port asks, since a capability never
 * changes what `get`, `put` or `find` mean. The checker and `describe` read the same block off the loaded
 * kind document, never through this export.
 */
import type { ConnectionKindDoc, Resolves, StorageCapabilities } from '@wilanis/core';

/** The environment this reads: the tree's connections under the profile, and the documents the tree holds. */
interface Env {
  canon?: (ref: string) => string;
  connections?: Record<string, { kind: string }>;
  resolving?: Resolves;
}

/**
 * The kind a connection names under this environment's profile -- a stand-in's where one stands in, since
 * that is the engine the connection reaches -- by its canonical path.
 */
function kindOf(env: Env, connection: string): string {
  const path = (env.canon ?? ((ref: string) => ref))(connection);
  const conn = env.connections?.[path];
  if (!conn) throw new Error(`unknown connection '${connection}'`);
  return conn.kind;
}

/**
 * The capabilities of the engine a connection reaches: the `capabilities` block of the kind the connection
 * names, read from the tree's documents. It throws naming the kind where that kind is not a storage kind,
 * since such a connection reaches no engine and so has nothing an engine can do.
 */
export function capabilitiesOf(env: object, connection: string): StorageCapabilities {
  const tree = env as Env;
  if (!tree.resolving) throw new Error('no tree in this environment to read a connection kind from');
  const kind = kindOf(tree, connection);
  const doc = tree.resolving.document(kind) as ConnectionKindDoc | undefined;
  if (doc?.storage !== true)
    throw new Error(
      `connection '${connection}' is of kind '${kind}', which does not say "storage": true, so it reaches no engine`,
    );
  if (!doc.capabilities) throw new Error(`storage kind '${kind}' declares no capabilities; its plugin is broken`);
  return doc.capabilities;
}
