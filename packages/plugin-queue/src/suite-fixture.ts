/**
 * What the broker suite is written against: the subject a broker's tests hand it, the queue a case keeps its
 * messages on, and the helpers a case consumes and waits through. It holds no case of its own -- those are
 * `suite.ts` -- so a broker is judged by one fixture however many cases there come to be.
 */
import { strict as assert } from 'node:assert';
import type { Answer, Broker, Delivery } from './brokers.js';

/** What a broker's own tests hand the suite: the broker, a connection registered for it, and what it parked. */
export interface Subject {
  broker: Broker;
  /** The canonical path of a connection of the broker's kind, as the worker would name it. */
  connection: string;
  /** The messages the broker parked as dead on a queue of that connection, by id, so a case can see one was. */
  parked(queue: string): Promise<{ id: string; body: unknown }[]>;
}

/** One thing every broker must do, by the name it is done under. */
export interface Case {
  name: string;
  run(subject: Subject): Promise<void>;
}

/**
 * A queue of its own for one case, named so a broker that really keeps its queues can run the suite again
 * against the same store without a case meeting what an earlier run left behind.
 */
export const queueFor = (name: string) =>
  `suite_${name}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** One delivery as a case reads it back: what arrived, and when. */
export interface Seen extends Delivery {
  at: number;
}

/** A pause of real time, for a case that must show something did *not* happen within it. */
export const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

/** Wait until a condition holds, looking every few milliseconds, and fail the case naming what never came. */
export async function until(ok: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`waited ${ms}ms for ${what}`);
    await pause(5);
  }
}

/** What a case consumes a queue with: the deliveries seen, how to stop, and the answer each delivery gets. */
export interface Consuming {
  seen: Seen[];
  stop: () => Promise<void>;
}

/** Consume one queue, recording every delivery and answering it as `answer` says. */
export async function consuming(
  subject: Subject,
  queue: string,
  answer: (delivery: Delivery) => Answer | Promise<Answer>,
  concurrency = 1,
): Promise<Consuming> {
  const seen: Seen[] = [];
  const handle = async (delivery: Delivery) => {
    seen.push({ ...delivery, at: Date.now() });
    return answer(delivery);
  };
  const stop = await subject.broker.consume(subject.connection, queue, handle, { concurrency });
  return { seen, stop };
}

/** A gate a case holds deliveries at, so it can look at what is in flight before letting them answer. */
export class Gate {
  private waiting: (() => void)[] = [];
  inFlight = 0;
  most = 0;

  /** Hold one delivery until it is let go, counting it as in flight while it waits. */
  async hold(): Promise<void> {
    this.inFlight++;
    this.most = Math.max(this.most, this.inFlight);
    await new Promise<void>(done => this.waiting.push(done));
    this.inFlight--;
  }

  /** Let every delivery that is being held answer. */
  release(): void {
    for (const done of this.waiting.splice(0)) done();
  }

  /** How many deliveries are held right now. */
  get held(): number {
    return this.waiting.length;
  }
}
