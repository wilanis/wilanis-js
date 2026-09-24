/**
 * A broker kept in a Map, for these tests alone: the memory broker is its own package (RFC 0009's step 4), and
 * @queue's tests must not wait on it. It answers exactly what `Broker` says a broker must -- which is what
 * `suite.test.ts` proves by running the shared suite over it -- and keeps what a test wants to look at: every
 * message still queued, every one parked as dead, and every connection ensured.
 *
 * It polls its own arrays every few milliseconds, as a broker that polls a table would; nothing waits on a
 * clock of its own beyond that.
 */
import type { Atomic, Participant } from '@wilanis/core';
import type { Answer, Broker, Delivery, Handle, Message } from '../src/brokers.js';

/** One message as the fake keeps it: what a delivery carries, and when it may next be handed out. */
interface Kept extends Delivery {
  availableAt: number;
}

/** The fake's side of one transaction: the messages published inside it, kept on commit and forgotten on rollback. */
class Staged implements Participant {
  readonly pending: (() => void)[] = [];

  async commit(): Promise<void> {
    for (const keep of this.pending.splice(0)) keep();
  }

  async rollback(): Promise<void> {
    this.pending.length = 0;
  }
}

const POLL_MS = 5;

export class FakeBroker implements Broker {
  readonly queued = new Map<string, Kept[]>();
  readonly dead = new Map<string, { id: string; body: unknown }[]>();
  readonly ensured: string[] = [];
  /** Every answer the fake was given, in order, so a test can say what the worker decided. */
  readonly answers: (Answer & { id: string; attempt: number })[] = [];
  /** The transaction every publish was handed, in order: undefined outside an atomic graph. */
  readonly transactions: (Atomic | undefined)[] = [];
  private made = 0;

  private listOf<T>(table: Map<string, T[]>, connection: string, queue: string): T[] {
    const key = `${connection} ${queue}`;
    let list = table.get(key);
    if (!list) {
      list = [];
      table.set(key, list);
    }
    return list;
  }

  async ensure(connection: string): Promise<void> {
    this.ensured.push(connection);
  }

  /**
   * Keep the message at once, or -- handed an atomic graph's transaction -- once the transaction commits, and
   * never if it rolls back, as a broker whose queue is a table in the store would. The transaction is recorded
   * in `transactions` whichever way it came, so a test can say what the handler handed over.
   */
  async publish(connection: string, queue: string, message: Message, atomic?: Atomic): Promise<{ id: string }> {
    this.transactions.push(atomic);
    this.made++;
    const id = `m${this.made}`;
    const kept: Kept = {
      id,
      attempt: 1,
      headers: message.headers,
      body: message.body,
      availableAt: Date.now() + (message.delayMs ?? 0),
    };
    const keep = () => this.listOf(this.queued, connection, queue).push(kept);
    if (!atomic) keep();
    else (await atomic.join(connection, async () => new Staged())).pending.push(keep);
    return { id };
  }

  /** What is still queued on one queue, delivered or not. */
  waiting(connection: string, queue: string): Kept[] {
    return this.listOf(this.queued, connection, queue);
  }

  /** What was parked as dead on one queue. */
  parked(connection: string, queue: string): { id: string; body: unknown }[] {
    return this.listOf(this.dead, connection, queue);
  }

  /** Take the first message of a queue that may be handed out now, removing it while it is in flight. */
  private take(connection: string, queue: string): Kept | undefined {
    const list = this.listOf(this.queued, connection, queue);
    const index = list.findIndex(one => one.availableAt <= Date.now());
    return index < 0 ? undefined : list.splice(index, 1)[0];
  }

  /** Hand one message to the handle and do what its answer says; a handle that throws is a retry. */
  private async handOut(connection: string, queue: string, kept: Kept, handle: Handle): Promise<void> {
    const { availableAt: _, ...delivery } = kept;
    let answer: Answer;
    try {
      answer = await handle(delivery);
    } catch {
      answer = { outcome: 'retry' };
    }
    this.answers.push({ ...answer, id: kept.id, attempt: kept.attempt });
    if (answer.outcome === 'retry')
      this.listOf(this.queued, connection, queue).push({
        ...kept,
        attempt: kept.attempt + 1,
        availableAt: Date.now() + (answer.backoffMs ?? 0),
      });
    if (answer.outcome === 'dead') this.listOf(this.dead, connection, queue).push({ id: kept.id, body: kept.body });
  }

  async consume(connection: string, queue: string, handle: Handle, opts: { concurrency: number }) {
    const inFlight = new Set<Promise<void>>();
    let stopping = false;
    let timer: NodeJS.Timeout | undefined;
    const tick = () => {
      if (stopping) return;
      while (inFlight.size < opts.concurrency) {
        const due = this.take(connection, queue);
        if (!due) break;
        const running: Promise<void> = this.handOut(connection, queue, due, handle).finally(() =>
          inFlight.delete(running),
        );
        inFlight.add(running);
      }
      timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return async () => {
      stopping = true;
      clearTimeout(timer);
      await Promise.all([...inFlight]);
    };
  }
}
