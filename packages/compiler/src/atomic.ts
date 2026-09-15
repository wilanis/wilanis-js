/**
 * The scope one atomic graph's run carries, as `env.atomic`. It is a run scope, the third of the shape
 * `env.blobs` and `env.hold` already have: the compiler puts it on the environment at a graph's boundary,
 * only the handlers that care read it, and it settles when the boundary closes.
 *
 * Nothing here knows what a transaction is made of. The first transactional operation to run opens one
 * through `join` and hands back what can commit or roll it back; the scope keeps it, hands it to every later
 * operation on the same connection, and settles it once.
 */
import type { Atomic, Participant } from '@wilanis/core';
import type { Report } from '@wilanis/engine';

/** The transaction one atomic graph's run opens, at most one, on the one connection its effects fall on. */
export class AtomicScope implements Atomic {
  /** The connection the transaction was opened on, so a second one can be told from the same one again. */
  private connection?: string;
  /**
   * The promise of the participant, never its resolved value: `Run.execute` starts every ready node in the
   * same tick, so memoising the value would let the second node open a second transaction while the first is
   * still opening. Awaiting the same promise is what makes two nodes share one transaction.
   */
  private opening?: Promise<Participant>;

  /**
   * The transaction on that connection: opened on the first call, and the same one on every later call. A
   * join on a second connection is a fault -- the checker has already refused it, so reaching here means the
   * tree was not the one that was checked, and being wrong quietly is worse than failing.
   */
  async join<T extends Participant>(connection: string, open: () => Promise<T>): Promise<T> {
    if (this.opening === undefined) {
      this.connection = connection;
      this.opening = open();
    } else if (this.connection !== connection) {
      throw new Error(
        `an atomic graph reached two connections: ${this.connection} and ${connection}. One transaction is one connection.`,
      );
    }
    return this.opening as Promise<T>;
  }

  /**
   * End the transaction, if one was opened: commit when the run answered, roll back otherwise. A graph that
   * reached no transactional effect opened nothing, so there is nothing to settle and no session was ever
   * taken from the pool.
   */
  async settle(commit: boolean): Promise<void> {
    if (this.opening === undefined) return;
    const participant = await this.opening;
    await (commit ? participant.commit() : participant.rollback());
  }
}

/**
 * Run one atomic graph's nested run inside a scope, and settle it. An atomic graph reached from inside an
 * atomic scope joins the outer one rather than opening its own: a nested refusal is the calling node's
 * failure, so the outer run ends anyway and a separate transaction would have nothing to preserve.
 *
 * `Kernel.run` resolves at quiescence, so no handler is in flight when the scope commits or rolls back. A
 * commit that throws fails the calling node, the way a nested run's failure is reported today.
 */
export async function inScope(
  env: Record<string, unknown>,
  run: (env: Record<string, unknown>) => Promise<Report>,
): Promise<Report> {
  const outer = env.atomic as Atomic | undefined;
  if (outer) return run(env);
  const scope = new AtomicScope();
  const report = await run({ ...env, atomic: scope });
  await scope.settle(report.status === 'done');
  return report;
}
