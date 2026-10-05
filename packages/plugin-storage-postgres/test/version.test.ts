/**
 * The version check RFC 0022 gives this engine, retroactively: `postLoad` asks each server a connection of the
 * kind reaches for its version and fails the start on one older than PostgreSQL 12, which is what the kind's
 * `capabilities` are written for. The block is declared, never discovered, so this is what holds it to the
 * database actually reached.
 *
 * Reading an answer, and leaving a server that cannot be reached to fail where it is used, need no database.
 * Asking one does, so those cases are skipped without `WILANIS_TEST_POSTGRES_URL` (`engine.test.ts` says how
 * to run one); the older server is the real one made to lie about `SELECT version()`.
 */
import { engines } from '@wilanis/plugin-storage';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import plugin from '../src/index.js';
import { REQUIRED, tooOld, versionAt } from '../src/version.js';

const url = process.env.WILANIS_TEST_POSTGRES_URL;
const KIND = '@storage-postgres/postgres.connection-kind.json';
const CONNECTION = '@connections/records.connection.json';

/** Run the plugin's postLoad over a tree whose one connection of the kind reaches `at`, and stop what it started. */
async function started(at: string | undefined): Promise<object> {
  const tree = { connections: { [CONNECTION]: { kind: KIND, settings: { url: at } } } };
  const down = await plugin.postLoad?.({ env: tree, settings: {}, scope: { canon: (ref: string) => ref } } as never);
  if (typeof down === 'function') await down();
  return tree;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('what a server answers to SELECT version(), held to the kind', () => {
  const at = (answer: string) => tooOld(CONNECTION, KIND, answer);

  it('a server at 12 or later keeps the promises the block makes', () => {
    expect(REQUIRED).toBe(12);
    expect(at('PostgreSQL 12.0 on x86_64-pc-linux-gnu, compiled by gcc, 64-bit')).toBeUndefined();
    expect(at('PostgreSQL 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1) on x86_64-pc-linux-gnu')).toBeUndefined();
    expect(at('PostgreSQL 18beta1 on aarch64-apple-darwin')).toBeUndefined();
  });

  it('an older one is refused, naming the connection, the version found and the version required', () => {
    expect(at('PostgreSQL 11.22 on x86_64-pc-linux-gnu, compiled by gcc, 64-bit')).toBe(
      `connection '${CONNECTION}' reaches PostgreSQL 11.22; ${KIND} requires PostgreSQL 12 or later`,
    );
    expect(at('PostgreSQL 9.6.24 on x86_64-pc-linux-gnu')).toContain('reaches PostgreSQL 9.6;');
  });

  it('an answer that names no PostgreSQL version is refused too: nothing says the block holds there', () => {
    expect(at('CockroachDB CCL v23.1.11')).toBe(
      `connection '${CONNECTION}' reaches a server answering 'CockroachDB CCL v23.1.11', which is no PostgreSQL version; ${KIND} requires PostgreSQL 12 or later`,
    );
  });

  it('a server that cannot be reached is not refused at start: what uses the connection fails, as before', async () => {
    expect(await versionAt('postgres://wilanis@127.0.0.1:1/none')).toBeUndefined();
    // a URL pg cannot even parse reaches nothing too, rather than throwing out of postLoad
    expect(await versionAt('postgres://[bad')).toBeUndefined();
    expect(engines(await started('postgres://[bad')).for(KIND)).toBeDefined();
    expect(engines(await started('postgres://wilanis@127.0.0.1:1/none')).for(KIND)).toBeDefined();
    // a connection whose secret the profile never reads carries no URL at all, and is not asked
    expect(engines(await started('')).for(KIND)).toBeDefined();
  });
});

describe.skipIf(!url)('the version postLoad asks a real server for', () => {
  it('is 12 or later here, so the engine registers', async () => {
    const answer = await versionAt(url as string);
    expect(answer).toMatch(/^PostgreSQL \d+/);
    expect(tooOld(CONNECTION, KIND, answer as string)).toBeUndefined();
    expect(engines(await started(url)).for(KIND)).toBeDefined();
  });

  it('fails the start on a server older than 12, with the message, and registers nothing', async () => {
    const lie = 'PostgreSQL 11.22 on x86_64-pc-linux-gnu, compiled by gcc (GCC) 8.5.0, 64-bit';
    vi.spyOn(pg.Client.prototype, 'query').mockImplementation((async () => ({ rows: [{ version: lie }] })) as never);
    const tree = { connections: { [CONNECTION]: { kind: KIND, settings: { url } } } };
    await expect(
      plugin.postLoad?.({ env: tree, settings: {}, scope: { canon: (ref: string) => ref } } as never),
    ).rejects.toThrow(`connection '${CONNECTION}' reaches PostgreSQL 11.22; ${KIND} requires PostgreSQL 12 or later`);
    expect(engines(tree).for(KIND)).toBeUndefined();
  });
});
