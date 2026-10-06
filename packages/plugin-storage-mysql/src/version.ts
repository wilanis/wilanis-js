/**
 * The server a connection reaches, held to what the kind's `capabilities` assume (RFC 0022). The block is
 * declared by the kind, not discovered, because `wilanis check` runs with no connection open; what keeps the
 * declaration honest is this: before the engine registers, `postLoad` asks every server a connection of the
 * kind names for `SELECT VERSION()`, and fails the start where one is older than MySQL 8.0.16 -- the first to
 * enforce a `CHECK`, after functional indexes (8.0.13) and `SKIP LOCKED` (8.0.1).
 *
 * A server answering MariaDB's version is refused too. MariaDB numbers its releases 10 and 11, which would
 * pass a comparison with 8.0.16 and say nothing: its `JSON` is another type under the same name, and nothing
 * then says the server keeps the promises the block makes.
 *
 * A server that cannot be reached answers no version and is not refused here, as postgres's check does not
 * refuse one: `postLoad` is not told the profile, so it cannot tell a connection the start will use from one it
 * never opens, and a connection that is used and cannot be reached fails where it is used.
 */
import mysql from 'mysql2/promise';

/** The oldest MySQL the kind's capabilities are written for. */
export const REQUIRED = '8.0.16';

/** How long the version question waits for a server before taking it as unreachable. */
const CONNECT_TIMEOUT_MS = 5000;

/** A version as three numbers, so 8.0.100 compares above 8.0.16 rather than below it. */
const partsOf = (version: string): number[] => version.split('.').map(Number);

/** Whether one version, as three numbers, is at least another. */
function atLeast(found: number[], required: number[]): boolean {
  for (let at = 0; at < required.length; at += 1) {
    if (found[at] !== required[at]) return found[at] > required[at];
  }
  return true;
}

/** The MySQL version a `SELECT VERSION()` answer names, "8.0.36-0ubuntu0.22.04.1" → 8.0.36; nothing where it names none. */
export function versionIn(answer: string): string | undefined {
  if (/mariadb/i.test(answer)) return undefined;
  return /^(\d+\.\d+\.\d+)/.exec(answer.trim())?.[1];
}

/**
 * Why a server answering `answer` to `SELECT VERSION()` is too old for the kind, naming the version found and
 * the version required, or nothing where it is new enough. An answer naming no MySQL version is refused too.
 */
export function tooOld(connection: string, kind: string, answer: string): string | undefined {
  const found = versionIn(answer);
  if (found && atLeast(partsOf(found), partsOf(REQUIRED))) return undefined;
  const what = found ? `MySQL ${found}` : `a server answering '${answer}', which is no MySQL version`;
  return `connection '${connection}' reaches ${what}; ${kind} requires MySQL ${REQUIRED} or later`;
}

/**
 * What a server answers to `SELECT VERSION()`, on a connection of its own closed after; nothing where none is
 * reached, a URL mysql2 cannot read among them.
 */
export async function versionAt(url: string): Promise<string | undefined> {
  let connection: mysql.Connection;
  try {
    connection = await mysql.createConnection({ uri: url, connectTimeout: CONNECT_TIMEOUT_MS });
  } catch {
    return undefined;
  }
  try {
    const [rows] = await connection.query('SELECT VERSION() AS version');
    return String((rows as { version?: unknown }[])[0]?.version ?? '');
  } finally {
    await connection.end().catch(() => undefined);
  }
}

/** The connection documents of the kind with a URL, one per URL: a database two connections share is asked once. */
function connectionsOf(env: Record<string, unknown>, kind: string): Map<string, string> {
  const connections = (env.connections ?? {}) as Record<string, { kind: string; settings: { url?: unknown } }>;
  const byUrl = new Map<string, string>();
  for (const [path, conn] of Object.entries(connections)) {
    const url = conn.settings?.url;
    if (conn.kind === kind && typeof url === 'string' && url && !byUrl.has(url)) byUrl.set(url, path);
  }
  return byUrl;
}

/**
 * Ask every server a connection of the kind reaches for its version, and throw the first refusal where one is
 * older than the kind's block assumes. `kind` is the canonical path connections name it by, `named` the path
 * the message says.
 */
export async function holdVersions(env: Record<string, unknown>, kind: string, named: string): Promise<void> {
  const asked = [...connectionsOf(env, kind)].map(async ([url, connection]) => {
    const answer = await versionAt(url);
    return answer === undefined ? undefined : tooOld(connection, named, answer);
  });
  const refused = (await Promise.all(asked)).find(reason => reason !== undefined);
  if (refused) throw new Error(refused);
}
