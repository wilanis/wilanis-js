/**
 * RFC 0004's atomic suite against a SQLite file: the tree's graphs run through the `Embedder` the way a trigger
 * fires them, and what is read back is the file itself, through a handle of the test's own. It needs nothing but
 * a temporary directory, so it runs in every CI job, unconditionally.
 *
 * Two of its cases are this engine's own. Two atomic graphs fired at once serialise at the file: the second
 * waits for the first to commit, then runs, and neither fails. And a write outside any transaction waits for the
 * atomic graph that holds the file, rather than failing. The driver is synchronous, so SQLite's busy handler
 * cannot wait for a lock this process holds: it would freeze the event loop the holder needs to commit, then
 * fail. The engine therefore makes a writer of this process wait its turn before it reaches the file, up to
 * `busyTimeoutMs`. Both cases prove the order of events, never a duration; the bound is proved apart.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { checkTree, runGraph } from '@wilanis/compiler';
import { loadTree, type PluginModule, TypeResolver } from '@wilanis/core';
import { outcomeOf, refusalOf } from '@wilanis/engine';
import storage, { type At, engines } from '@wilanis/plugin-storage';
import { BUILTIN_PLUGINS, embedderFor, FileBlobStore, postLoad } from '@wilanis/runtime';
import Database from 'better-sqlite3';
import { sql } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';
import sqlite, { Handles, SqliteEngine } from '../src/index.js';
import { BUSY_TIMEOUT_MS, FILE, PORT, treeKeeping } from './atomic-tree.js';

const PLUGINS: Record<string, PluginModule> = { ...BUILTIN_PLUGINS, '@storage': storage, '@storage-sqlite': sqlite };
const CONNECTION = '@connections/entries.connection.json';
const ENTRY = new TypeResolver(() => undefined).inline({ fields: { id: { type: 'string' }, url: { type: 'string' } } });

/** One entry, its url made from its key unless one is given. */
const entry = (id: string, url = `https://${id}.example`) => ({ id, url });

/** Every table of the file and every row of each, read through a handle of the test's own. */
function snapshot(file: string): Record<string, unknown[]> {
  const db = new Database(file, { readonly: true });
  try {
    const tables = db
      .prepare("select name from sqlite_schema where type = 'table' and name not like 'sqlite_%' order by name")
      .all() as { name: string }[];
    return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`select * from "${name}" order by 1`).all()]));
  } finally {
    db.close();
  }
}

/** The tree served, fresh for each case, with its `entries` table made and its `notes` table left unmade. */
async function serving() {
  const dir = treeKeeping();
  const tree = loadTree(dir, PLUGINS);
  expect(checkTree(tree).format()).toBe('');
  const emb = embedderFor(tree);
  const down = await postLoad(tree, emb, () => {});
  const blobs = emb.blobs.scope();
  const path = tree.resolve(CONNECTION);
  const conn = (emb.env.connections as Record<string, { kind: string; settings: Record<string, unknown> }>)[path];
  const at: At = {
    connection: path,
    kind: conn.kind,
    settings: conn.settings,
    name: 'entries',
    shape: ENTRY,
    key: 'id',
    unique: [['url']],
    refs: [],
    referenced: [],
    defaults: {},
  };
  await engines(emb.env).for(conn.kind)?.ensure([at]);

  /** Fire one operation of the port, under a signal where one is given, and answer the whole report. */
  const run = (op: string, input: unknown = {}, signal?: AbortSignal) =>
    runGraph(emb.operation(`${PORT}#${op}`), { initial: { in: input }, env: emb.envFor(blobs), signal });
  const stop = async () => {
    await blobs.release();
    await down();
    if (emb.blobs instanceof FileBlobStore) emb.blobs.destroy();
    rmSync(dir, { recursive: true, force: true });
  };
  return { run, stop, file: join(dir, FILE) };
}

/** The keys of the entries the file holds. */
const kept = (file: string) => (snapshot(file).entries as { id: string }[]).map(one => one.id).sort();

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await close?.();
  close = undefined;
});

/** A tree served for one case, stopped after it. */
async function served() {
  const tree = await serving();
  close = tree.stop;
  return tree;
}

describe('an atomic graph over a SQLite file', () => {
  it('keeps both writes when it answers', async () => {
    const tree = await served();
    const written = await tree.run('pair', { first: entry('a'), second: entry('b') });
    expect(written.status).toBe('done');
    expect(written.output).toEqual(entry('b'));
    expect(kept(tree.file)).toEqual(['a', 'b']);
  });

  it('leaves the file as it was when its second write is refused, and the report carries the refusal', async () => {
    const tree = await served();
    expect((await tree.run('keep', entry('x', 'https://held'))).status).toBe('done');
    const before = snapshot(tree.file);
    const written = await tree.run('pair', { first: entry('a'), second: entry('b', 'https://held') });
    expect(written.status).toBe('failed');
    expect(refusalOf(written)?.reason).toBe('conflict');
    expect(snapshot(tree.file)).toEqual(before);
  });

  it('leaves the file as it was when its second write faults', async () => {
    const tree = await served();
    const before = snapshot(tree.file);
    const written = await tree.run('pairNoted', { first: entry('a'), second: entry('b') });
    expect(written.status).toBe('failed');
    const ended = outcomeOf(written);
    expect(ended.kind).toBe('faulted');
    expect(ended.kind === 'faulted' && ended.error).toMatch(/no such table: notes/);
    expect(snapshot(tree.file)).toEqual(before);
  });

  it('keeps all of a batch of five that answers, and none of one whose fourth entry is refused', async () => {
    const tree = await served();
    const five = ['a', 'b', 'c', 'd', 'e'].map(id => entry(id));
    expect((await tree.run('keepAll', { entries: five })).status).toBe('done');
    expect(kept(tree.file)).toEqual(['a', 'b', 'c', 'd', 'e']);
    const before = snapshot(tree.file);
    const repeating = [entry('f'), entry('g'), entry('h'), entry('i', 'https://f.example'), entry('j')];
    const batch = await tree.run('keepAll', { entries: repeating });
    expect(batch.status).toBe('failed');
    expect(refusalOf(batch)?.reason).toBe('conflict');
    expect(snapshot(tree.file)).toEqual(before);
  });

  it('leaves the file as it was when its run is cancelled after the first write', async () => {
    const tree = await served();
    const control = new AbortController();
    const put = SqliteEngine.prototype.put;
    vi.spyOn(SqliteEngine.prototype, 'put').mockImplementation(async function (this: SqliteEngine, ...args) {
      const written = await put.apply(this, args);
      control.abort();
      return written;
    });
    const before = snapshot(tree.file);
    const written = await tree.run('pair', { first: entry('a'), second: entry('b') }, control.signal);
    expect(written.status).toBe('cancelled');
    expect(snapshot(tree.file)).toEqual(before);
  });
});

/**
 * What happens on the file, in order: each transaction asked for, begun and told to commit, and each write
 * asked of the engine and landed. A transaction is named by the order `begin` was asked for it, and a write by
 * the key it wrote. `firstWrite` parks the write of that key, once it has landed, until the case opens `gate`,
 * so its transaction stays open while the case looks. A commit is logged as it is asked for: the turn on the
 * file is handed on only after it, so nothing that waited for the turn can be logged before it.
 */
function watching(firstWrite: string) {
  const log: string[] = [];
  const begin = SqliteEngine.prototype.begin;
  const put = SqliteEngine.prototype.put;
  let opened = () => {};
  const gate = new Promise<void>(resolve => {
    opened = resolve;
  });
  let parked = () => {};
  const reached = new Promise<void>(resolve => {
    parked = resolve;
  });
  vi.spyOn(SqliteEngine.prototype, 'begin').mockImplementation(async function (this: SqliteEngine, at) {
    const name = `trx${log.filter(line => /^trx\d+ asked$/.test(line)).length + 1}`;
    log.push(`${name} asked`);
    const trx = await begin.call(this, at);
    log.push(`${name} begun`);
    return {
      ...trx,
      commit: () => {
        log.push(`${name} commits`);
        return trx.commit();
      },
    };
  });
  vi.spyOn(SqliteEngine.prototype, 'put').mockImplementation(async function (this: SqliteEngine, ...args) {
    const id = (args[1] as { id: string }).id;
    log.push(`write ${id}`);
    const written = await put.apply(this, args);
    log.push(`put ${id}`);
    if (id === firstWrite) {
      parked();
      await gate;
    }
    return written;
  });
  return { log, reached, open: opened };
}

/** Until `test` holds, giving the event loop a turn between looks: what a case waits on before it asserts. */
async function until(test: () => boolean): Promise<void> {
  while (!test()) await new Promise(resolve => setImmediate(resolve));
}

describe('two atomic graphs at once', () => {
  it('serialise at the file: the second begins once the first has committed, and neither fails', async () => {
    const tree = await served();
    const watch = watching('a');
    const first = tree.run('pair', { first: entry('a'), second: entry('b') });
    await watch.reached;
    const second = tree.run('pair', { first: entry('c'), second: entry('d') });
    await until(() => watch.log.includes('trx2 asked'));
    // the first holds the file, parked after its first write; the second has asked and waits its turn
    expect(watch.log).toEqual(['trx1 asked', 'trx1 begun', 'write a', 'put a', 'trx2 asked']);
    watch.open();
    const [one, other] = await Promise.all([first, second]);
    expect([one.status, other.status]).toEqual(['done', 'done']);
    expect(watch.log.slice(5)).toEqual([
      'write b',
      'put b',
      'trx1 commits',
      'trx2 begun',
      'write c',
      'put c',
      'write d',
      'put d',
      'trx2 commits',
    ]);
    expect(kept(tree.file)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('one refusing leaves the other whole', async () => {
    const tree = await served();
    const good = tree.run('pair', { first: entry('a'), second: entry('b') });
    const bad = tree.run('pair', { first: entry('z'), second: entry('y', 'https://z.example') });
    const [one, other] = await Promise.all([good, bad]);
    expect([one.status, other.status]).toEqual(['done', 'failed']);
    expect(kept(tree.file)).toEqual(['a', 'b']);
  });
});

describe('a write outside any transaction', () => {
  it('waits for the atomic graph that holds the file, then lands, rather than failing', async () => {
    const tree = await served();
    const watch = watching('a');
    const atomic = tree.run('pair', { first: entry('a'), second: entry('b') });
    await watch.reached;
    const single = tree.run('keep', entry('s'));
    await until(() => watch.log.includes('write s'));
    // the atomic graph holds the file, parked after its first write; the write outside it has reached the
    // engine and waits its turn
    expect(watch.log).toEqual(['trx1 asked', 'trx1 begun', 'write a', 'put a', 'write s']);
    watch.open();
    const [one, other] = await Promise.all([atomic, single]);
    expect([one.status, other.status]).toEqual(['done', 'done']);
    expect(watch.log.slice(5)).toEqual(['write b', 'put b', 'trx1 commits', 'put s']);
    expect(kept(tree.file)).toEqual(['a', 'b', 's']);
  });
});

describe("a transaction's handle", () => {
  it('waits for the turn up to busyTimeoutMs, then fails with the lock message, and the next one begins', async () => {
    const tree = await served();
    const handles = new Handles(join(tree.file, '..', '..'), { busyTimeoutMs: 50 });
    const on = { connection: CONNECTION, kind: '', settings: { file: FILE } };
    try {
      const held = await handles.transaction(on);
      await expect(handles.transaction(on)).rejects.toThrow(/database is locked/);
      await expect(
        handles
          .for(on)
          .selectFrom('entries' as never)
          .selectAll()
          .execute(),
      ).rejects.toThrow(/database is locked/);
      await handles.end(held, 'rollback');
      await handles.end(await handles.transaction(on), 'rollback');
      expect(
        await handles
          .for(on)
          .selectFrom('entries' as never)
          .selectAll()
          .execute(),
      ).toEqual([]);
    } finally {
      await handles.close();
    }
  });

  it('lets go of the file when its commit fails, so the next transaction begins', async () => {
    const tree = await served();
    const handles = new Handles(join(tree.file, '..', '..'), { busyTimeoutMs: BUSY_TIMEOUT_MS });
    const on = { connection: CONNECTION, kind: '', settings: { file: FILE } };
    try {
      const trx = await handles.transaction(on);
      // ended behind the engine's back, so the engine's commit finds no transaction and fails
      await sql`rollback`.execute(trx);
      await expect(handles.end(trx, 'commit')).rejects.toThrow(/no transaction is active/);
      const next = await handles.transaction(on);
      await handles.end(next, 'rollback');
    } finally {
      await handles.close();
    }
  });
});
