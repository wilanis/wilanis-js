/**
 * What a lease keeper is, and how @schedule finds one. @schedule speaks no store's language: a keeper is the
 * plugin that granted a connection kind declaring `leases`, filling one contract for the connections of that
 * kind. It depends on this package for the contract while this package depends on no keeper -- the arrow
 * points the way every other arrow in the workspace does.
 *
 * The seam is the hook plugins already have: a keeper's `postLoad` registers itself, under the connection
 * kind it grants, in a table the environment carries. The table is created on first use by whichever side
 * reaches it first, so nothing has to be said in `project.json` about the order the plugins are named in.
 */

/**
 * What a lease keeper does for the scheduler on one connection of the kind it registered; the connection is
 * the canonical path, and the name is the trigger's.
 */
export interface Leases {
  /**
   * Try to hold `name` for the tick `scheduled` until now + ttlMs: true when this process holds it, freshly or
   * renewed (same holder, same tick); false when another holder's hold has not expired, or when a tick at or
   * after `scheduled` has already been marked fired -- a tick is taken once, whichever process's clock reaches
   * it first.
   */
  acquire(connection: string, name: string, scheduled: string, ttlMs: number): Promise<boolean>;
  /** Let go of the hold on `name`, so another process may take the next tick without waiting it out. */
  release(connection: string, name: string): Promise<void>;
  /** The tick last recorded as fired for `name`, ISO 8601, or nothing. */
  lastFired(connection: string, name: string): Promise<string | undefined>;
  /** Record that `scheduled` was fired for `name`, whatever the run's status: a tick is not refired for a refusal. */
  markFired(connection: string, name: string, scheduled: string): Promise<void>;
}

/** The lease keepers registered under one environment, by the connection kind each was registered for. */
export class Keepers {
  private readonly byKind = new Map<string, Leases>();

  /** Take a keeper in, under the canonical path of the connection kind its plugin grants. */
  register(kind: string, keeper: Leases): void {
    this.byKind.set(kind, keeper);
  }

  /** The keeper registered for a connection kind, or nothing where no plugin registered one. */
  for(kind: string): Leases | undefined {
    return this.byKind.get(kind);
  }

  /** Every kind a keeper registered for, so a message can say what this tree can reach. */
  get kinds(): string[] {
    return [...this.byKind.keys()];
  }
}

/** Every table in play, one per environment, so nothing is global and a reload starts clean. */
const tables = new WeakMap<object, Keepers>();

/**
 * What one environment is keyed by. The embedder hands a handler `{ ...env, blobs }` whenever a run carries a
 * blob scope, so the object a handler is given is not the object a keeper registered on. `connections` is
 * built once for the tree by `buildEnv` and carried by every copy, so it names the environment where the copy
 * does not. An environment without one is keyed by itself.
 */
function keyOf(env: object): object {
  const connections = (env as { connections?: unknown }).connections;
  return connections && typeof connections === 'object' ? connections : env;
}

/**
 * The lease keepers of one environment, created on first use by whichever side reaches it first. @schedule
 * builds nothing in a `postLoad` of its own, so a keeper that registers before @schedule is loaded finds no
 * emptier a table than one that registers after.
 */
export function leases(env: object): Keepers {
  const key = keyOf(env);
  let table = tables.get(key);
  if (!table) {
    table = new Keepers();
    tables.set(key, table);
  }
  return table;
}
