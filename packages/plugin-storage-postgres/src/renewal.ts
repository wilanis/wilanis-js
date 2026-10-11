/**
 * What keeps one delivery's lock while its run goes on. A lock is taken for one visibility window; a healthy run
 * longer than that would be handed to a second worker while it still ran, and again every window after. So every
 * half window, until the delivery is answered, its lock is pushed one window past the database's `now()`. The
 * window then bounds only how long a worker that died keeps its message.
 *
 * An extension that fails -- the database went away for a moment -- is logged and tried again at the next beat:
 * the run is not stopped for it, and a lock that lapses meanwhile is the redelivery at-least-once allows. One
 * that finds the row no longer this delivery's stops the beat, since the lock is another worker's now.
 */
import { extend, type Table, type Taken } from './queue-table.js';

/** Where a renewal extends its lock, for how long each time, and where it says that an extension failed. */
export interface Renewed {
  table: Table;
  queue: string;
  visibilityMs: number;
  log?: (line: string) => void;
}

/** One delivery's lock, pushed out every half window from when it is made until it is stopped. */
export class Renewal {
  private timer: NodeJS.Timeout | undefined;
  private extending: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly renewed: Renewed,
    private readonly taken: Taken,
  ) {
    this.beat();
  }

  /** Extend no more, and resolve once no extension is under way, so none lands after the answer it would undo. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.extending;
  }

  /** Arm the timer for the next extension, half a window from now. */
  private beat(): void {
    if (this.stopped) return;
    const every = Math.max(1, Math.floor(this.renewed.visibilityMs / 2));
    this.timer = setTimeout(() => {
      this.extending = this.once();
    }, every);
  }

  /** Extend the lock once; beat again where it is still this delivery's, or where the extension failed. */
  private async once(): Promise<void> {
    const { table, visibilityMs } = this.renewed;
    try {
      if (await extend(table, this.taken, visibilityMs)) this.beat();
    } catch (error) {
      this.failed(error);
      this.beat();
    }
  }

  /** Say that one extension failed, and that the run goes on. */
  private failed(error: unknown): void {
    const { queue, log } = this.renewed;
    const { id, attempt } = this.taken;
    const why = error instanceof Error ? error.message : String(error);
    log?.(`queue ${queue} ${id} attempt ${attempt}: the lock was not extended (${why}); the run goes on`);
  }
}
