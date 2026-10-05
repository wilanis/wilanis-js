/**
 * A write a constraint may refuse, run so that the refusal leaves the transaction usable. PostgreSQL aborts a
 * transaction on any error inside it, so a `violated` this engine answers from 23505 or 23503 would otherwise
 * leave every later statement of the atomic graph failing with "current transaction is aborted" and its
 * commit a rollback -- where the memory engine answers the same `violated` and goes on (#785). A savepoint
 * around the one statement is what makes the two alike: rolled back to on the error, released otherwise.
 *
 * The three statements hold the transaction's one session between them. An atomic graph runs its nodes
 * concurrently on that session, and a statement of another node that slipped in after the refused write and
 * before the rollback would find the transaction aborted; holding the session is what keeps it waiting its
 * turn. Outside a transaction a statement is its own transaction, so it needs neither.
 */
import { type Compilable, CompiledQuery, type Kysely } from 'kysely';

/** The savepoint's name; one write holds the session at a time, so one name is enough. */
const SAVEPOINT = 'wilanis_write';

/**
 * The rows the write answers, run on its own outside a transaction and under a savepoint inside one, so a
 * constraint it breaks throws as it always did and the transaction is still there for the next statement.
 */
export async function writing(db: Kysely<never>, query: Compilable, inTransaction: boolean): Promise<unknown[]> {
  if (!inTransaction) return (await db.executeQuery(query.compile())).rows;
  return db.getExecutor().provideConnection(async held => {
    await held.executeQuery(CompiledQuery.raw(`savepoint ${SAVEPOINT}`));
    try {
      const { rows } = await held.executeQuery(query.compile());
      await held.executeQuery(CompiledQuery.raw(`release savepoint ${SAVEPOINT}`));
      return rows;
    } catch (error) {
      // a rollback that fails too leaves the session broken; the write's own error is the one worth saying
      await held.executeQuery(CompiledQuery.raw(`rollback to savepoint ${SAVEPOINT}`)).catch(() => undefined);
      throw error;
    }
  });
}
