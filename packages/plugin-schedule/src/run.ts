/**
 * scheduler.port.json#run: what keeps this tree's schedule. A project's startup list names it, as it names
 * the listener and the watcher; nothing fires on a clock of its own, so a tree that names no step is not
 * scheduled. The triggers are read from `serving` on every wake-up rather than captured once, so a reload
 * puts a new set of schedules behind a scheduler that keeps running.
 */
import type { Hold, Serving } from '@wilanis/core';
import type { Handler } from '@wilanis/engine';
import { leases } from '@wilanis/plugin-storage';
import type { Lease } from './holds.js';
import { ROOT, RUN } from './paths.js';
import { Scheduler } from './scheduler.js';

/** What a tree hands a held operation, and what this one reads of it. */
type ScheduleEnv = {
  serving?: Serving;
  hold?: Hold;
  plugins?: Record<string, Record<string, unknown>>;
  connections?: Record<string, { kind: string }>;
};

const DEFAULT_TTL = 30_000;

/** The plugin's settings as the project wrote them, with the defaults the manifest declares. */
function settingsOf(env: ScheduleEnv): { timezone: string; ttlMs: number } {
  const settings = env.plugins?.[ROOT] ?? {};
  const ttl = Number(settings.leaseTtlMs ?? DEFAULT_TTL);
  return { timezone: String(settings.timezone ?? 'UTC'), ttlMs: ttl };
}

/**
 * How a tick is held, where the step named a `lease`: the keeper the connection's kind registered. X254 has
 * held the connection to one of a kind declaring `leases`, so what is refused here is a plugin that declared
 * the marker and registered no keeper, or did not load at all.
 */
function leaseOf(env: ScheduleEnv, named: unknown, ttlMs: number): Lease | undefined {
  if (typeof named !== 'string') return undefined;
  const canon = (env as { canon?: (ref: string) => string }).canon;
  const connection = canon ? canon(named) : named;
  const kind = env.connections?.[connection]?.kind;
  if (!kind) throw new Error(`'${RUN}' was given lease '${named}', which is not a connection of this tree`);
  const keeper = leases(env as object).for(kind);
  if (!keeper)
    throw new Error(
      `'${RUN}' was given lease '${connection}', of kind '${kind}', and no plugin registered a lease keeper for that kind: the plugin granting it declares "leases" and registers one from its postLoad`,
    );
  return { keeper, connection, ttlMs };
}

/**
 * Keep this tree's schedule until the process stops. Answers once the schedule is up; the keeping itself
 * outlives the run, so the runtime holds it and stops it when the process stops -- draining whatever run is
 * in flight, as the listener drains its requests.
 */
export const run: Handler = async ({ in: input, ctx }) => {
  const env = ctx.env as ScheduleEnv;
  const serving = env.serving;
  if (!serving || !env.hold)
    throw new Error(
      `'${RUN}' keeps the schedule while the tree is served, so it runs from a project's startup list -- not from a graph`,
    );
  const { timezone, ttlMs } = settingsOf(env);
  const lease = leaseOf(env, input.lease, ttlMs);
  const scheduler = new Scheduler({ serving, lease, timezone });
  const answer = scheduler.start();
  env.hold({ label: 'schedule', stop: () => scheduler.stop() });
  return answer;
};
