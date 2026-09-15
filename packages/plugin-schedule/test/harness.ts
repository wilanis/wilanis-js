/**
 * What the scheduler is given in a test: a clock that is stepped rather than waited on, a `Serving` that
 * records what was fired, and a lease keeper kept in a Map. No test here sleeps and none reaches a tree: the
 * scheduler's business is *when*, and what it is given is exactly what the runtime would give it.
 */
import type { BlobScope, BlobStore, FireArgs, Serving, TriggerDoc } from '@wilanis/core';
import type { Report } from '@wilanis/engine';
import type { Clock } from '../src/clock.js';
import type { Leases } from '../src/leases.js';
import { KIND } from '../src/paths.js';

/** A clock a test steps: nothing waits on real time, and a wait ends when the clock passes its instant. */
export class FakeClock implements Clock {
  private at: number;
  private waiting: { until: number; done: () => void }[] = [];

  constructor(start: string | number) {
    this.at = typeof start === 'string' ? Date.parse(start) : start;
  }

  now(): number {
    return this.at;
  }

  wait(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise(done => {
      const entry = { until: this.at + ms, done };
      this.waiting.push(entry);
      signal.addEventListener('abort', () => this.wake(entry), { once: true });
    });
  }

  /** Let one wait go, whether its instant came or a stop cut it short. */
  private wake(entry: { until: number; done: () => void }): void {
    const index = this.waiting.indexOf(entry);
    if (index >= 0) {
      this.waiting.splice(index, 1);
      entry.done();
    }
  }

  /**
   * Move the clock on by `ms`, letting every wait that falls inside end at the instant it asked for and
   * letting whatever it woke run before the clock moves further. A step is the only way time passes.
   */
  async advance(ms: number): Promise<void> {
    const target = this.at + ms;
    let moved = false;
    for (;;) {
      const due = this.waiting.filter(one => one.until <= target).sort((one, other) => one.until - other.until)[0];
      if (due) {
        this.at = Math.max(this.at, due.until);
        this.wake(due);
        moved = false;
        await settle();
        continue;
      }
      // nothing falls inside the step any more: move to the end of it once, and let a wake-up that was
      // registered on the way see the time that passed before the step is called done
      if (moved) break;
      this.at = target;
      moved = true;
      await settle();
    }
    await settle();
  }
}

/** Let every promise already queued run, so what a wake-up started has happened before the test looks. */
export const settle = async () => {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
  await new Promise(done => setImmediate(done));
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
};

/** One tick as a test reads it: what was fired, for when, and what the graph was told. */
export interface Fired {
  run: string;
  scheduled: string;
  fired: string;
  missed: number;
}

/** What a fake run answers, and how long it takes to answer it. */
export interface Answering {
  /** resolve the run when this is called; absent: the run answers at once */
  hold?: boolean;
  report?: Partial<Report>;
  error?: string;
}

/** What the blob registry was asked for, so a test can say a tick opened one scope and released it. */
export interface Counted {
  scopes: number;
  released: number;
}

/** A blob scope that records its release, since a tick opens one and releases it once the run has answered. */
function blobs(counts: Counted): BlobStore {
  const store = {
    put: async () => ({ id: 'x', contentType: 'text/plain' }) as never,
    open: () => undefined as never,
    drop: async () => {},
    scope(): BlobScope {
      counts.scopes++;
      return {
        ...store,
        release: async () => {
          counts.released++;
        },
      } as unknown as BlobScope;
    },
  };
  return store as unknown as BlobStore;
}

/** What a test hands the scheduler in place of the runtime: the triggers it serves and what a fire answers. */
export function serving(triggers: TriggerDoc[], answering: () => Answering = () => ({})) {
  const fired: Fired[] = [];
  const logs: string[] = [];
  const open: (() => void)[] = [];
  let set = triggers;
  const counts: Counted = { scopes: 0, released: 0 };
  const store = blobs(counts);
  const serving: Serving = {
    triggers: kind => (kind === KIND ? set : []),
    fire: async ({ trigger, request }: FireArgs) => {
      const context = request as unknown as Fired;
      fired.push({
        run: trigger.fire.run,
        scheduled: context.scheduled,
        fired: context.fired,
        missed: context.missed,
      });
      const answer = answering();
      if (answer.error) throw new Error(answer.error);
      if (answer.hold) await new Promise<void>(done => open.push(done));
      return {
        graph: trigger.fire.run,
        status: 'done',
        output: { ok: true },
        nodes: {},
        startedAt: 0,
        endedAt: 0,
        ...answer.report,
      } as Report;
    },
    types: () => ({}),
    inputFor: () => ({ input: undefined }),
    codecs: () => ({}),
    blobs: store,
    log: line => logs.push(line),
    reload: async () => ({ ok: true, documents: 0 }),
    root: '/nowhere',
  };
  return {
    serving,
    fired,
    logs,
    blobs: counts,
    /** Let the run that is being held answer. */
    release: () => open.shift()?.(),
    /** Put a new set of triggers behind the same serving, as a reload does. */
    reloadWith: (next: TriggerDoc[]) => {
      set = next;
    },
  };
}

/** A scheduled trigger, as a document: the settings a test varies, and an operation to fire. */
export function trigger(
  settings: Record<string, unknown>,
  run = '@monitor/domain/monitor.port.json#digest',
): TriggerDoc {
  return {
    $schema: '@wilanis/trigger.schema.json',
    description: 'a scheduled trigger, for a test',
    kind: KIND,
    settings,
    fire: { run },
  } as TriggerDoc;
}

/** One record of a fake lease keeper: who holds a name, until when, and what was last fired under it. */
interface Held {
  holder?: string;
  until?: number;
  lastFired?: string;
}

/**
 * A lease keeper in a Map, answering exactly as the contract says a real one must: a hold is granted only
 * when nobody else's is unexpired and no tick at or after the one asked for has been marked fired.
 */
export class FakeLeases implements Leases {
  readonly held = new Map<string, Held>();
  readonly acquires: { holder: string; name: string; scheduled: string; granted: boolean }[] = [];

  constructor(
    private readonly clock: { now(): number },
    readonly holder = 'one',
  ) {}

  /** A second keeper over the same records, so two schedulers can ask for one tick. */
  as(holder: string): FakeLeases {
    const other = new FakeLeases(this.clock, holder);
    Object.defineProperty(other, 'held', { value: this.held });
    Object.defineProperty(other, 'acquires', { value: this.acquires });
    return other;
  }

  private at(name: string): Held {
    let record = this.held.get(name);
    if (!record) {
      record = {};
      this.held.set(name, record);
    }
    return record;
  }

  async acquire(_connection: string, name: string, scheduled: string, ttlMs: number): Promise<boolean> {
    const record = this.at(name);
    const free = record.until === undefined || record.until <= this.clock.now() || record.holder === this.holder;
    const done = record.lastFired !== undefined && record.lastFired >= scheduled;
    const granted = free && !done;
    if (granted) {
      record.holder = this.holder;
      record.until = this.clock.now() + ttlMs;
    }
    this.acquires.push({ holder: this.holder, name, scheduled, granted });
    return granted;
  }

  async release(_connection: string, name: string): Promise<void> {
    const record = this.at(name);
    if (record.holder === this.holder) record.until = this.clock.now();
  }

  async lastFired(_connection: string, name: string): Promise<string | undefined> {
    return this.at(name).lastFired;
  }

  async markFired(_connection: string, name: string, scheduled: string): Promise<void> {
    const record = this.at(name);
    if (record.lastFired === undefined || record.lastFired < scheduled) record.lastFired = scheduled;
  }
}
