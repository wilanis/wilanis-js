/**
 * The limits an http route and an http connection may declare (RFC 0012): how long a route's run may take, and how
 * much a body may weigh, in either direction. A route's own setting is its limit; the plugin's settings in
 * project.json are what a route that writes none gets; with neither there is no limit.
 */
import { type Readable, Transform } from 'node:stream';

/** The limits a route or the plugin's settings declare. */
export interface Limits {
  deadlineMs?: number;
  maxBodyBytes?: number;
}

/** A route's limits: its own where it writes one, else the plugin's, else none. */
export const limitsOf = (route: Limits, plugin: Limits): Limits => ({
  deadlineMs: route.deadlineMs ?? plugin.deadlineMs,
  maxBodyBytes: route.maxBodyBytes ?? plugin.maxBodyBytes,
});

/** Why a bounded stream stopped: it passed the most it may carry. */
export class TooLarge extends Error {
  constructor(what: string, max: number) {
    super(`${what} exceeds ${max} bytes`);
  }
}

/** A bounded stream, and why it was cut where it passed its bound; nothing where it was not. */
export interface Bounded {
  stream: Readable;
  cut(): TooLarge | undefined;
}

/** A stream that is not bounded: it is never cut. */
export const unbounded = (stream: Readable): Bounded => ({ stream, cut: () => undefined });

/** What a bound says: the most, the words its error says it in, and what becomes of the source once cut. */
export interface Bound {
  max: number;
  what: string;
  /** `drain` reads the rest and discards it, so a socket that must still answer stays readable; `drop` destroys it. */
  rest: 'drain' | 'drop';
}

/**
 * `source`, counted as it passes: once the count goes past `max`, the stream the reader holds errors with `TooLarge`
 * and nothing past the bound reaches it. Whatever reads it -- a codec parsing JSON, the registry storing a file --
 * stops there.
 */
export function bounded(source: Readable, { max, what, rest }: Bound): Bounded {
  let count = 0;
  let cut: TooLarge | undefined;
  const counting = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      count += chunk.length;
      if (count <= max) return done(null, chunk);
      cut = new TooLarge(what, max);
      source.unpipe(counting);
      if (rest === 'drain') source.resume();
      else source.destroy();
      done(cut);
    },
  });
  source.once('error', error => counting.destroy(error));
  source.pipe(counting);
  return { stream: counting, cut: () => cut };
}

/**
 * Run `fire` under a deadline: a signal that aborts `deadlineMs` after the fire begins, cleared once it answers. The
 * run is waited for either way -- the report of a cancelled run is the answer -- so the answer is sent once the last
 * handler in flight has settled. Without a deadline `fire` is handed no signal.
 */
export async function withDeadline<T>(
  deadlineMs: number | undefined,
  fire: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  if (deadlineMs === undefined) return fire();
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), deadlineMs);
  try {
    return await fire(control.signal);
  } finally {
    clearTimeout(timer);
  }
}
