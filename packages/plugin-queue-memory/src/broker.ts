/**
 * The memory broker: @queue's `Broker`, answered with arrays that live as long as the broker does. A queue is
 * the pair of its connection and its name, so the same queue name on two connections is two queues, as it would
 * be on two databases. The broker is made per environment by the plugin's `postLoad`, so a second load of a
 * tree starts with no message queued.
 *
 * It delivers at least once, as its kind declares, and it can be told to prove it: `dropAcks` loses the next
 * acknowledgements the way a worker that died between its run and its ack loses one, and the message is handed
 * out again. What a test reads back -- what waits, what was parked -- is here too, since a broker kept in memory
 * has no table an operator could query instead.
 */
import { randomUUID } from 'node:crypto';
import type { Broker, Delivery, Handle, Message } from '@wilanis/plugin-queue';
import { Consumer } from './consumer.js';
import { MemoryQueue, type Parked } from './queue.js';

/** A broker whose queues are arrays of this instance: what a connection of the memory kind is kept by. */
export class MemoryBroker implements Broker {
  private readonly queues = new Map<string, MemoryQueue>();
  private acksToDrop = 0;

  /** There is nothing to prepare: a queue exists as soon as a message is published to it or it is consumed. */
  async ensure(_connection: string): Promise<void> {}

  /** Keep one message on the queue, its body encoded as JSON, answering the id every delivery of it carries. */
  async publish(connection: string, queue: string, message: Message): Promise<{ id: string }> {
    const id = randomUUID();
    this.queueOf(connection, queue).put({
      id,
      attempt: 1,
      headers: { ...message.headers },
      body: JSON.stringify(message.body) ?? 'null',
      availableAt: Date.now() + (message.delayMs ?? 0),
    });
    return { id };
  }

  /** Hand the queue's messages to `handle`, at most `concurrency` at once; answers the way to stop and drain. */
  async consume(
    connection: string,
    queue: string,
    handle: Handle,
    opts: { concurrency: number },
  ): Promise<() => Promise<void>> {
    const consumer = new Consumer(this.queueOf(connection, queue), handle, opts.concurrency, () => this.dropsAck());
    return () => consumer.stop();
  }

  /**
   * Lose the next `count` acknowledgements, as a worker that dies after its run and before its ack loses one:
   * each message acknowledged is delivered again, one attempt higher, which is what at-least-once means.
   */
  dropAcks(count = 1): void {
    this.acksToDrop += count;
  }

  /** What waits on a queue to be handed out, due or not; a message in flight is in no list. */
  waiting(connection: string, queue: string): Delivery[] {
    return this.queueOf(connection, queue).queued();
  }

  /** What was parked as dead on a queue, in the order it was parked. */
  parked(connection: string, queue: string): Parked[] {
    return this.queueOf(connection, queue).parked();
  }

  /** Whether the acknowledgement being made now is one `dropAcks` said to lose. */
  private dropsAck(): boolean {
    if (!this.acksToDrop) return false;
    this.acksToDrop--;
    return true;
  }

  /** One queue of one connection, made the first time either is asked for. */
  private queueOf(connection: string, queue: string): MemoryQueue {
    const key = `${connection}\n${queue}`;
    let found = this.queues.get(key);
    if (!found) {
      found = new MemoryQueue();
      this.queues.set(key, found);
    }
    return found;
  }
}
