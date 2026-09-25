/**
 * How a consumer hears that its queue changed without asking: one session per connection that `LISTEN`s on the
 * queue channel, shared by every consumer of that connection in this broker. A publish or a retry notifies with
 * the schema and queue it touched, and the consumers of that queue look again at once.
 *
 * A session on its own, outside the pool, because a listening session is held for as long as anything consumes
 * -- a pool would count it as busy forever -- and because a pooled session is handed to whoever asks next, who
 * would inherit the `LISTEN`. It is closed when the last consumer of the connection stops.
 *
 * A notification is a hint, never the only way a message is found: one raised while the session was down is
 * lost, so a session that fails is opened again after a pause and every consumer looks once it is back, finding
 * whatever was published meanwhile.
 */
import pg from 'pg';
import { CHANNEL } from './queue-table.js';

/** The pause before a listening session that failed is opened again. */
const REOPEN_MS = 1000;

/**
 * TCP keepalive on the listening session, probing after ten seconds idle. A session left half-open -- a peer
 * gone without a FIN, a NAT that forgot it -- raises neither `error` nor `end` of its own, and a consumer over an
 * empty queue arms no timer, so without the probe it would wait for a notification that can never come. With
 * it the drop surfaces as `error`, and the session is reopened and every consumer woken. A delay of 0 would
 * leave the operating system's default, two hours.
 */
export const KEEP_ALIVE = { keepAlive: true, keepAliveInitialDelayMillis: 10_000 };

/** What wakes a consumer: called with nothing, whenever its queue may have something for it. */
export type Wake = () => void;

/** One connection's listening session and the consumers it wakes, by the payload each listens for. */
class Listening {
  private client: pg.Client | undefined;
  private readonly wakers = new Map<string, Set<Wake>>();
  private opening: Promise<void> | undefined;
  private reopen: NodeJS.Timeout | undefined;

  constructor(private readonly url: string) {}

  /** Whether any consumer still listens here. */
  get empty(): boolean {
    return this.wakers.size === 0;
  }

  /** Wake `wake` on every notification carrying `payload`, the session opened first if it is not yet. */
  async add(payload: string, wake: Wake): Promise<void> {
    let set = this.wakers.get(payload);
    if (!set) {
      set = new Set();
      this.wakers.set(payload, set);
    }
    set.add(wake);
    this.opening ??= this.open();
    await this.opening;
  }

  /** Stop waking `wake`; the session stays open while any other consumer listens. */
  remove(payload: string, wake: Wake): void {
    const set = this.wakers.get(payload);
    set?.delete(wake);
    if (set && !set.size) this.wakers.delete(payload);
  }

  /** Close the session and forget every consumer. */
  async close(): Promise<void> {
    this.wakers.clear();
    clearTimeout(this.reopen);
    const client = this.client;
    this.client = undefined;
    this.opening = undefined;
    await client?.end().catch(() => undefined);
  }

  /** Connect and `LISTEN`; a failure later reopens the session and wakes everyone once it is back. */
  private async open(): Promise<void> {
    const client = new pg.Client({ connectionString: this.url, ...KEEP_ALIVE });
    client.on('notification', note => this.wakeFor(note.payload ?? ''));
    client.on('error', () => this.lost(client));
    client.on('end', () => this.lost(client));
    try {
      await client.connect();
      await client.query(`listen ${CHANNEL}`);
    } catch (error) {
      this.opening = undefined;
      await client.end().catch(() => undefined);
      throw error;
    }
    this.client = client;
  }

  /** The session ended under the consumers: open it again after a pause. */
  private lost(client: pg.Client): void {
    if (this.client !== client) return;
    this.client = undefined;
    this.later();
  }

  /** Open the session again after a pause, while anyone still listens. */
  private later(): void {
    this.opening = undefined;
    clearTimeout(this.reopen);
    this.reopen = setTimeout(() => this.again(), REOPEN_MS);
  }

  /** Reopen the session and wake every consumer, since what was notified while it was down was not heard. */
  private again(): void {
    if (this.empty) return;
    this.opening = this.open();
    this.opening.then(
      () => this.wakeAll(),
      () => this.later(),
    );
  }

  /** Wake the consumers of one queue. */
  private wakeFor(payload: string): void {
    for (const wake of this.wakers.get(payload) ?? []) wake();
  }

  /** Wake every consumer of the connection. */
  private wakeAll(): void {
    for (const set of this.wakers.values()) for (const wake of set) wake();
  }
}

/** Every listening session one broker keeps, one per connection it consumes. */
export class Listeners {
  private readonly byConnection = new Map<string, Listening>();

  /** Wake `wake` whenever `payload` is notified on the connection; answers the way to stop. */
  async listen(connection: string, url: string, payload: string, wake: Wake): Promise<() => Promise<void>> {
    let listening = this.byConnection.get(connection);
    if (!listening) {
      listening = new Listening(url);
      this.byConnection.set(connection, listening);
    }
    const kept = listening;
    try {
      await kept.add(payload, wake);
    } catch (error) {
      await this.unlisten(connection, kept, payload, wake);
      throw error;
    }
    return () => this.unlisten(connection, kept, payload, wake);
  }

  /** Close every session, as the plugin's teardown does. */
  async close(): Promise<void> {
    const all = [...this.byConnection.values()];
    this.byConnection.clear();
    await Promise.all(all.map(one => one.close()));
  }

  /** Stop waking one consumer, and close the connection's session once none listens. */
  private async unlisten(connection: string, listening: Listening, payload: string, wake: Wake): Promise<void> {
    listening.remove(payload, wake);
    if (!listening.empty) return;
    if (this.byConnection.get(connection) === listening) this.byConnection.delete(connection);
    await listening.close();
  }
}
