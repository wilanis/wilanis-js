/**
 * The server a connection reaches, held to what the kind's `capabilities` assume (RFC 0022). The block is
 * declared by the kind, not discovered, because `wilanis check` runs with no connection open; what keeps the
 * declaration honest is this: before the engine registers, `postLoad` asks every server a connection of the
 * kind names for its version, and fails the start where one is older than PostgreSQL 12.
 *
 * A server that cannot be reached answers no version and is not refused here. `postLoad` is not told the
 * profile, so it cannot tell a connection the start will use from one it never opens -- under the laptop's
 * profile the production database's URL may be a placeholder -- and a connection that is used and cannot be
 * reached fails where it is used, as it did before the check existed. A server that answers is judged.
 */
import pg from 'pg';

/** The oldest PostgreSQL the kind's capabilities are written for. */
export const REQUIRED = 12;

/** How long the version question waits for a server before taking it as unreachable. */
const CONNECT_TIMEOUT_MS = 5000;

/** The version a `SELECT version()` answer names, "PostgreSQL 16.2 on x86_64-pc-linux-gnu, ..." → 16.2; nothing where it names none. */
export function versionIn(answer: string): { major: number; text: string } | undefined {
  const found = /^PostgreSQL (\d+)(\.\d+)?/.exec(answer.trim());
  return found ? { major: Number(found[1]), text: `${found[1]}${found[2] ?? ''}` } : undefined;
}

/**
 * Why a server answering `answer` to `SELECT version()` is too old for the kind, naming the version found and
 * the version required, or nothing where it is new enough. An answer naming no PostgreSQL version is refused
 * too: nothing then says the server keeps the promises the kind's block makes.
 */
export function tooOld(connection: string, kind: string, answer: string): string | undefined {
  const found = versionIn(answer);
  if (found && found.major >= REQUIRED) return undefined;
  const what = found ? `PostgreSQL ${found.text}` : `a server answering '${answer}', which is no PostgreSQL version`;
  return `connection '${connection}' reaches ${what}; ${kind} requires PostgreSQL ${REQUIRED} or later`;
}

/**
 * What a server answers to `SELECT version()`, on a connection of its own closed after; nothing where none is
 * reached. A URL pg cannot parse reaches nothing either: the client is made inside the `try`, since its
 * constructor throws on one.
 */
export async function versionAt(url: string): Promise<string | undefined> {
  let client: pg.Client | undefined;
  try {
    client = new pg.Client({ connectionString: url, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
    await client.connect();
  } catch {
    await client?.end().catch(() => undefined);
    return undefined;
  }
  try {
    const { rows } = await client.query<{ version: string }>('SELECT version()');
    return rows[0]?.version;
  } finally {
    await client.end().catch(() => undefined);
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
