/**
 * The version check RFC 0022 gives this engine: `postLoad` asks each server a connection of the kind reaches
 * for `SELECT VERSION()` and fails the start on one older than MySQL 8.0.16, which is what the kind's
 * `capabilities` are written for. The block is declared, never discovered, so this is what holds it to the
 * database actually reached.
 *
 * Reading an answer, and leaving a server that cannot be reached to fail where it is used, need no database.
 * Asking one does, so those cases are skipped without `WILANIS_TEST_MYSQL_URL` (`engine.test.ts` says how to
 * run one); the older server is the real one, its connection wrapped to lie about `SELECT VERSION()`.
 */
import { engines } from '@wilanis/plugin-storage';
import mysql from 'mysql2/promise';
import { afterEach, describe, expect, it, vi } from 'vitest';
import plugin from '../src/index.js';
import { REQUIRED, tooOld, versionAt } from '../src/version.js';

const url = process.env.WILANIS_TEST_MYSQL_URL;
const KIND = '@storage-mysql/mysql.connection-kind.json';
const CONNECTION = '@connections/records.connection.json';

/** A tree whose one connection of the kind reaches `at`. */
const treeAt = (at: string | undefined) => ({ connections: { [CONNECTION]: { kind: KIND, settings: { url: at } } } });

/** Run the plugin's postLoad over a tree, as `wilanis start` does. */
const loading = (tree: object) =>
  plugin.postLoad?.({ env: tree, settings: {}, scope: { canon: (ref: string) => ref } } as never);

/** Run the plugin's postLoad over a tree reaching `at`, and stop what it started. */
async function started(at: string | undefined): Promise<object> {
  const tree = treeAt(at);
  const down = await loading(tree);
  if (typeof down === 'function') await down();
  return tree;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('what a server answers to SELECT VERSION(), held to the kind', () => {
  const at = (answer: string) => tooOld(CONNECTION, KIND, answer);

  it('a server at 8.0.16 or later keeps the promises the block makes', () => {
    expect(REQUIRED).toBe('8.0.16');
    expect(at('8.0.16')).toBeUndefined();
    expect(at('8.0.36-0ubuntu0.22.04.1')).toBeUndefined();
    expect(at('8.0.100')).toBeUndefined();
    expect(at('8.4.2')).toBeUndefined();
    expect(at('9.1.0-commercial')).toBeUndefined();
  });

  it('an older one is refused, naming the connection, the version found and the version required', () => {
    expect(at('8.0.15')).toBe(
      `connection '${CONNECTION}' reaches MySQL 8.0.15; ${KIND} requires MySQL 8.0.16 or later`,
    );
    expect(at('5.7.44-log')).toContain('reaches MySQL 5.7.44;');
  });

  it('an answer that names no MySQL version is refused too, MariaDB among them', () => {
    expect(at('10.11.6-MariaDB-0+deb12u1')).toBe(
      `connection '${CONNECTION}' reaches a server answering '10.11.6-MariaDB-0+deb12u1', which is no MySQL version; ${KIND} requires MySQL 8.0.16 or later`,
    );
    expect(at('')).toContain('which is no MySQL version');
  });

  it('a server that cannot be reached is not refused at start: what uses the connection fails there', async () => {
    expect(await versionAt('mysql://nobody@127.0.0.1:1/none')).toBeUndefined();
    expect(await versionAt('mysql://[bad')).toBeUndefined();
    expect(engines(await started('mysql://[bad')).for(KIND)).toBeDefined();
    expect(engines(await started('mysql://nobody@127.0.0.1:1/none')).for(KIND)).toBeDefined();
    // a connection whose secret the profile never reads carries no URL at all, and is not asked
    expect(engines(await started('')).for(KIND)).toBeDefined();
  });
});

describe.skipIf(!url)('the version postLoad asks a real server for', () => {
  it('is 8.0.16 or later here, so the engine registers', async () => {
    const answer = await versionAt(url as string);
    expect(answer).toMatch(/^\d+\.\d+\.\d+/);
    expect(tooOld(CONNECTION, KIND, answer as string)).toBeUndefined();
    expect(engines(await started(url)).for(KIND)).toBeDefined();
  });

  it('fails the start on a server older than 8.0.16, with the message, and registers nothing', async () => {
    const real = mysql.PromiseConnection.prototype.query;
    vi.spyOn(mysql.PromiseConnection.prototype, 'query').mockImplementation(function (this: unknown, ...args: never[]) {
      if (String(args[0]).includes('VERSION()')) return Promise.resolve([[{ version: '8.0.15-log' }], []]) as never;
      return real.apply(this, args) as never;
    });
    const tree = treeAt(url);
    await expect(loading(tree)).rejects.toThrow(
      `connection '${CONNECTION}' reaches MySQL 8.0.15; ${KIND} requires MySQL 8.0.16 or later`,
    );
    expect(engines(tree).for(KIND)).toBeUndefined();
  });
});
