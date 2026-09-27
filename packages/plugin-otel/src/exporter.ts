/**
 * What holds the collector: spans go in, batches go out, and nothing a run does waits on either.
 *
 * Every method here answers rather than throws. A collector is a service over a network, and a service over a
 * network has bad moments; an observer that threw would be handed back to the runtime, which says it and
 * steps over it, but the trace would be lost either way and the tree would have paid for it. So a batch that
 * cannot be sent is said once and dropped: observing a tree must never be able to change what the tree does.
 */
import type { Trace } from '@wilanis/core';
import type { Configured } from './settings.js';
import { type Scope, type Span, spansOf } from './spans.js';

/** What sends a batch of spans; the OTLP exporter is one, and a test's collector is another. */
export interface Sends {
  export(spans: Span[], done: (result: { code: number; error?: Error }) => void): void;
  shutdown(): Promise<void>;
}

/** What the sender is given besides where it sends: how to batch, and somewhere to say what went wrong. */
export interface ExporterOptions {
  sends: Sends;
  configured: Configured;
  log: (line: string) => void;
  /** how long a span waits for others to join its batch, in milliseconds */
  everyMs?: number;
  /** how many spans go in one batch before it is sent without waiting */
  batch?: number;
}

const EVERY_MS = 2000;
const BATCH = 512;
/** Beyond this many spans waiting, the collector is not keeping up and the oldest are dropped rather than the process. */
const CEILING = 8192;

/**
 * What went wrong, in one line a log can carry, whatever was thrown: its message, else its code, else the first
 * reason among the errors it gathers. Node answers a refused connection with an `AggregateError` -- one attempt
 * per address -- whose message is empty and whose code is `ECONNREFUSED`, so a log that read only the message
 * said `()`. Nothing readable at all is that same refusal from a transport that kept even the code to itself.
 */
export function reasonOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return String(error);
  const { message, code, errors } = error as { message?: unknown; code?: unknown; errors?: unknown };
  if (typeof message === 'string' && message) return message;
  if (typeof code === 'string' && code) return code;
  const inner = Array.isArray(errors)
    ? errors.map(reasonOf).find(reason => reason !== 'connection refused')
    : undefined;
  return inner ?? 'connection refused';
}

/** Whether `work` settled within `ms`: false when the deadline came first. The timer never outlives the answer. */
async function settledWithin(work: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<boolean>(done => {
    timer = setTimeout(() => done(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** What a stop that missed its deadline says: the spans it left unsent, or, with none, that the sender would not close. */
const lateLine = (unsent: number, ms: number) =>
  unsent
    ? `otel: ${unsent} span(s) not exported (the collector did not take them within ${ms}ms of the stop)`
    : `otel: the exporter did not close within ${ms}ms of the stop; going on without it`;

/**
 * One tree's export: traces arrive from the runtime's observer, spans leave in batches. It is deliberately
 * the only thing here that keeps state, so that what a trace means (`spans.ts`) and what a level allows
 * (`level.ts`) stay pure and testable without it.
 */
export class Exporter {
  private waiting: Span[] = [];
  /** How many spans have been handed to the sender and not yet answered for. */
  private sending = 0;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  /** Set once a stop has given up on the sender: what it answers afterwards has already been said. */
  private leftBehind = false;
  private readonly scope: Scope;

  constructor(private readonly opts: ExporterOptions) {
    this.scope = { service: opts.configured.service, name: '@wilanis/plugin-otel', version: '0.1.0' };
  }

  /**
   * Take one run's trace. It returns at once: the spans are built and queued, and the sending happens on a
   * timer, so the request whose trace this is has already been answered by the time anything leaves.
   */
  take(trace: Trace): void {
    if (this.stopped) return;
    this.waiting.push(...spansOf(trace, this.scope));
    if (this.waiting.length > CEILING) {
      const dropped = this.waiting.length - CEILING;
      this.waiting = this.waiting.slice(dropped);
      this.opts.log(`otel: the collector is not keeping up; ${dropped} span(s) dropped`);
    }
    if (this.waiting.length >= (this.opts.batch ?? BATCH)) void this.flush();
    else this.arm();
  }

  /** Let a batch gather for a moment before it is sent, so one request's spans leave together. */
  private arm(): void {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.opts.everyMs ?? EVERY_MS);
    this.timer.unref?.(); // a pending batch must not be what keeps the process alive
  }

  /** Send what is waiting, and answer once the collector has taken it or refused it. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const going = this.waiting;
    if (!going.length) return;
    this.waiting = [];
    this.sending += going.length;
    await new Promise<void>(done =>
      this.opts.sends.export(going, result => {
        this.sending -= going.length;
        if (result.code !== 0)
          this.say(`otel: ${going.length} span(s) not exported (${reasonOf(result.error ?? 'refused')})`);
        done();
      }),
    );
  }

  /**
   * Send what is left and close the collector, so a process that stops takes its last traces with it -- waiting
   * no longer than `flushDeadlineMs` for that. The sender retries a collector it cannot reach for seconds, and a
   * container is killed when its grace after SIGTERM runs out, so a stop that waited on every retry could be cut
   * off before the rest of the teardown ran. Past the deadline, what is still unsent is said in one line and
   * left behind, and the stop answers so the teardown goes on.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    const ms = this.opts.configured.flushDeadlineMs;
    if (await settledWithin(this.close(), ms)) return;
    this.say(lateLine(this.sending, ms));
    this.leftBehind = true;
  }

  /** The flush and the shutdown a stop waits on, saying rather than throwing where the sender would not close. */
  private async close(): Promise<void> {
    try {
      await this.flush();
      await this.opts.sends.shutdown();
    } catch (error) {
      this.say(`otel: the exporter did not stop cleanly (${reasonOf(error)})`);
    }
  }

  /** Log a line, unless a stop has already said what became of everything still in flight. */
  private say(line: string): void {
    if (!this.leftBehind) this.opts.log(line);
  }
}
