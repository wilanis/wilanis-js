/**
 * The one place in this plugin that waits on time. The scheduler takes a Clock rather than calling
 * `Date.now` and `setTimeout` itself, so every test hands a fake and steps it, and no test sleeps.
 */

/** What the scheduler asks of time: what it is now, and a wait that a stop can cut short. */
export interface Clock {
  now(): number;
  /** Resolve after `ms`, or as soon as the signal aborts -- never rejecting, since a stop is not a failure. */
  wait(ms: number, signal: AbortSignal): Promise<void>;
}

/** The real clock: the process's own, which is what a tree that is running is scheduled by. */
export const systemClock: Clock = {
  now: () => Date.now(),
  wait: (ms, signal) =>
    new Promise(done => {
      if (signal.aborted) return done();
      const timer = setTimeout(finish, ms);
      function finish() {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        done();
      }
      signal.addEventListener('abort', finish, { once: true });
    }),
};
