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

/**
 * One tree's export: traces arrive from the runtime's observer, spans leave in batches. It is deliberately
 * the only thing here that keeps state, so that what a trace means (`spans.ts`) and what a level allows
 * (`level.ts`) stay pure and testable without it.
 */
export class Exporter {
  private waiting: Span[] = [];
  private timer?: NodeJS.Timeout;
  private stopped = false;
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
    await new Promise<void>(done =>
      this.opts.sends.export(going, result => {
        if (result.code !== 0)
          this.opts.log(`otel: ${going.length} span(s) not exported (${reasonOf(result.error ?? 'refused')})`);
        done();
      }),
    );
  }

  /** Send what is left and close the collector, so a process that stops takes its last traces with it. */
  async stop(): Promise<void> {
    this.stopped = true;
    try {
      await this.flush();
      await this.opts.sends.shutdown();
    } catch (error) {
      this.opts.log(`otel: the exporter did not stop cleanly (${reasonOf(error)})`);
    }
  }
}
