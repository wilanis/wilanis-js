/**
 * This engine keeps a scope (RFC 0015) as the memory, postgres and sqlite engines do, judged first by the same
 * shared cases: a row belongs to the scope it was written under, no key crosses one, a key is still global, a
 * `unique` holds within a scope, and a read with no scope -- a view -- sees every row.
 *
 * Then what a scope costs the table, which no shared case can see: the column, `NOT NULL` and typed by the
 * value; the uniques made again with the scope in front, their strings narrowed to fit InnoDB's 3072 bytes; the
 * index over the scope that tells a later `ensure` which columns are the scope; `drift` on a table with rows;
 * first scoped writes at once, all landing with the column added once; and a transaction, whose statements are
 * narrowed as every other, while the table is changed on the pool, since MySQL commits before DDL.
 *
 * It needs a database, so it is skipped without `WILANIS_TEST_MYSQL_URL` (`engine.test.ts` says how to run one).
 */
import type { At, Record_ } from '@wilanis/plugin-storage';
import { SHAPE, scopeCases } from '@wilanis/plugin-storage/suite';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeMysqlEngine, Pools } from '../src/index.js';

const url = process.env.WILANIS_TEST_MYSQL_URL;
const KIND = '@storage-mysql/mysql.connection-kind.json';
const CONNECTION = '@connections/records.connection.json';

describe.skipIf(!url)('what an engine that keeps scopes answers', () => {
  const made = makeMysqlEngine({ settings: {} });
  const subject = { engine: made.engine, connection: { connection: CONNECTION, kind: KIND, settings: { url } } };
  // a shared case's table is a scope_ one, dropped before they run so a second run starts from none: a case that
  // widens a scope needs a table that does not keep the wider one already
  beforeAll(async () => {
    const pools = new Pools({});
    const db = pools.for(at('any'));
    const tables = await sql<{ name: string }>`select TABLE_NAME as name from information_schema.TABLES
      where TABLE_SCHEMA = database() and TABLE_NAME like 'scope\\_%'`.execute(db);
    for (const { name } of tables.rows) await sql`drop table ${sql.id(name)}`.execute(db);
    await pools.close();
  });
  afterAll(() => made.close());
  for (const one of scopeCases) it(one.name, () => one.run(subject));
});

/** A collection of the suite's shape, with the uniques and the references it declares. */
const at = (name: string, unique: string[][] = [], refs: At['refs'] = []): At => ({
  connection: '@connections/costs.connection.json',
  kind: KIND,
  settings: { url },
  name,
  shape: SHAPE,
  key: 'id',
  unique,
  refs,
  referenced: [],
  defaults: {},
});

/** One record of the suite's shape, its url given so a case can make two collide under a unique. */
const one = (id: string, address = `https://one.example/${id}`): Record_ => ({
  id,
  url: address,
  method: 'GET',
  hits: 1,
  ok: true,
});

describe.skipIf(!url)('what a scope costs the table', () => {
  const made = makeMysqlEngine({ settings: {} });
  const { engine } = made;
  const pools = new Pools({});
  const db = () => pools.for(at('any'));

  // every table these cases inspect is a c_scope_ one, dropped before they run so a second run starts from none
  beforeAll(async () => {
    const tables = await sql<{ name: string }>`select TABLE_NAME as name from information_schema.TABLES
      where TABLE_SCHEMA = database() and TABLE_NAME like 'c\\_scope%'`.execute(db());
    await db()
      .connection()
      .execute(async session => {
        await sql`set foreign_key_checks = 0`.execute(session);
        for (const { name } of tables.rows) await sql`drop table ${sql.id(name)}`.execute(session);
        await sql`set foreign_key_checks = 1`.execute(session);
      });
  });
  afterAll(async () => {
    await made.close();
    await pools.close();
  });

  /** What the database says about a table: each column's type and nullability, and each index's columns. */
  async function catalogOf(table: string) {
    const columns = await sql<{ name: string; type: string; nullable: string }>`
      select COLUMN_NAME as name, COLUMN_TYPE as type, IS_NULLABLE as nullable from information_schema.COLUMNS
      where TABLE_SCHEMA = database() and TABLE_NAME = ${table} order by ORDINAL_POSITION`.execute(db());
    const stats = await sql<{ index: string; unique: number; name: string }>`
      select INDEX_NAME as \`index\`, NON_UNIQUE = 0 as \`unique\`, COLUMN_NAME as name
      from information_schema.STATISTICS where TABLE_SCHEMA = database() and TABLE_NAME = ${table}
      and INDEX_NAME <> 'PRIMARY' order by INDEX_NAME, SEQ_IN_INDEX`.execute(db());
    const indexes = new Map<string, { unique: boolean; over: string[] }>();
    for (const row of stats.rows) {
      const index = indexes.get(row.index) ?? { unique: Number(row.unique) === 1, over: [] };
      index.over.push(row.name);
      indexes.set(row.index, index);
    }
    return {
      types: Object.fromEntries(columns.rows.map(row => [row.name, `${row.type} ${row.nullable}`])),
      indexes: [...indexes.values()],
    };
  }

  it('adds the column NOT NULL, the uniques within the scope, narrowed to fit, and the scope index', async () => {
    const collection = at('c_scope', [['url', 'method']]);
    await engine.ensure([collection]);
    await engine.put(collection, one('1'), { replace: true, scope: { tenant: 'acme' } });
    const { types, indexes } = await catalogOf('c_scope');
    // three strings share the unique's 3072 bytes: 256 characters each, at four bytes a character
    expect(types).toMatchObject({ tenant: 'varchar(256) NO', url: 'varchar(256) NO', method: 'varchar(256) NO' });
    expect(types.id).toBe('varchar(768) NO');
    expect(indexes).toContainEqual({ unique: true, over: ['tenant', 'url', 'method'] });
    expect(indexes).toContainEqual({ unique: false, over: ['tenant'] });
    expect(indexes).not.toContainEqual({ unique: true, over: ['url', 'method'] });
  });

  it('a patch that repeats a scoped unique answers violated in the store words, without the scope', async () => {
    const collection = at('c_scope', [['url', 'method']]);
    await engine.put(collection, one('2', 'https://two.example'), { replace: true, scope: { tenant: 'acme' } });
    const answer = await engine.patch(collection, '2', { url: 'https://one.example/1' }, { scope: { tenant: 'acme' } });
    expect(answer).toEqual({ violated: 'unique [url, method]' });
    const beta = await engine.patch(collection, '2', { url: 'https://one.example/1' }, { scope: { tenant: 'beta' } });
    expect(beta).toEqual({});
  });

  it('a number scope is kept as DOUBLE, as a number field of a shape is', async () => {
    const collection = at('c_scope_num');
    await engine.ensure([collection]);
    await engine.put(collection, one('1'), { replace: true, scope: { owner: 7 } });
    expect((await catalogOf('c_scope_num')).types.owner).toBe('double NO');
    expect(await engine.count(collection, undefined, { owner: 7 })).toBe(1);
    expect(await engine.count(collection, undefined, { owner: 8 })).toBe(0);
  });

  it('refuses drift where the table holds rows and no scope column, and adds nothing', async () => {
    const collection = at('c_scope_rows');
    await engine.ensure([collection]);
    await engine.put(collection, one('1'), { replace: true });
    await expect(engine.put(collection, one('2'), { replace: true, scope: { tenant: 'acme' } })).rejects.toThrow(
      /drift: c_scope_rows holds 1 row\(s\) and no 'tenant' column/,
    );
    expect(Object.keys((await catalogOf('c_scope_rows')).types)).not.toContain('tenant');
  });

  it('a later ensure over a scoped table is content: a scope column is not a column the shape lost', async () => {
    const collection = at('c_scope_again', [['url']]);
    await engine.ensure([collection]);
    await engine.put(collection, one('1'), { replace: true, scope: { tenant: 'acme' } });
    expect(await engine.ensure([collection])).toEqual({ collections: 0, columns: 0, constraints: 0 });
    // the unique is still the scoped one: a second ensure must not put the unscoped spelling back beside it
    const uniques = (await catalogOf('c_scope_again')).indexes.filter(index => index.unique);
    expect(uniques).toEqual([{ unique: true, over: ['tenant', 'url'] }]);
  });

  it('a unique declared after the table is scoped holds within one scope, and not across them', async () => {
    const before = at('c_scope_late_num');
    await engine.ensure([before]);
    await engine.put(before, one('1'), { replace: true, scope: { owner: 1 } });

    const after = at('c_scope_late_num', [['hits']]);
    expect((await engine.ensure([after])).constraints).toBe(1);
    expect((await catalogOf('c_scope_late_num')).indexes).toContainEqual({ unique: true, over: ['owner', 'hits'] });
    const two = await engine.put(after, { ...one('2'), hits: 5 }, { replace: true, scope: { owner: 2 } });
    expect(two.violated).toBeUndefined();
    const again = await engine.put(after, { ...one('3'), hits: 1 }, { replace: true, scope: { owner: 1 } });
    expect(again.violated).toBe('unique [hits]');
  });

  it('a unique declared later that leaves a string scope less room is drift, and changes nothing', async () => {
    const before = at('c_scope_late');
    await engine.ensure([before]);
    await engine.put(before, one('1'), { replace: true, scope: { tenant: 'acme' } });
    expect((await catalogOf('c_scope_late')).types.tenant).toBe('varchar(768) NO');
    await expect(engine.ensure([at('c_scope_late', [['hits']])])).rejects.toThrow(
      /drift: c_scope_late\.tenant is varchar\(768\), and the scope's share of the indexes that hold it says varchar\(766\)/,
    );
    expect((await catalogOf('c_scope_late')).indexes).toEqual([{ unique: false, over: ['tenant'] }]);
  });

  it('a collection that gains a second scope column holds its uniques within both, and drops the narrower', async () => {
    const collection = at('c_scope_wider', [['url']]);
    await engine.ensure([collection]);
    await engine.find(collection, { scope: { tenant: 'acme' } });
    await engine.find(collection, { scope: { tenant: 'acme', owner: 'ada' } });
    const { types, indexes } = await catalogOf('c_scope_wider');
    expect(indexes.filter(index => index.unique)).toEqual([{ unique: true, over: ['tenant', 'owner', 'url'] }]);
    expect(indexes).toContainEqual({ unique: false, over: ['tenant', 'owner'] });
    expect(types).toMatchObject({ tenant: 'varchar(256) NO', owner: 'varchar(256) NO', url: 'varchar(256) NO' });
    const ada = { tenant: 'acme', owner: 'ada' };
    const grace = { tenant: 'acme', owner: 'grace' };
    await engine.put(collection, one('1', 'https://same'), { replace: true, scope: ada });
    const other = await engine.put(collection, one('2', 'https://same'), { replace: true, scope: grace });
    expect(other.violated).toBeUndefined();
    expect(await engine.ensure([collection])).toEqual({ collections: 0, columns: 0, constraints: 0 });
  });

  it('a unique that starts with a refs field is scoped, and the reference still holds', async () => {
    const parent = at('c_scope_parent');
    const refs = [{ from: 'c_scope_child', field: 'url', to: 'c_scope_parent' }];
    const child = at('c_scope_child', [['url', 'method']], refs);
    await engine.ensure([parent, child]);
    await engine.put(parent, one('https://p'), { replace: true });
    const acme = { tenant: 'acme' };
    expect((await engine.put(child, one('1', 'https://p'), { replace: true, scope: acme })).violated).toBeUndefined();
    expect((await engine.put(child, one('2', 'https://none'), { replace: true, scope: acme })).violated).toBe(
      'refs c_scope_child.url -> c_scope_parent',
    );
    const { indexes } = await catalogOf('c_scope_child');
    expect(indexes.filter(index => index.unique)).toEqual([{ unique: true, over: ['tenant', 'url', 'method'] }]);
    // the foreign key led with url through the unscoped unique; the ALTER gave url an index of its own first
    expect(indexes).toContainEqual({ unique: false, over: ['url'] });
    expect(await engine.ensure([parent, child])).toEqual({ collections: 0, columns: 0, constraints: 0 });
  });

  it('first scoped writes at once all land, and the column is added once', async () => {
    const collection = at('c_scope_race', [['url']]);
    await engine.ensure([collection]);
    const written = await Promise.all(
      ['1', '2', '3', '4'].map(id => engine.put(collection, one(id), { replace: true, scope: { tenant: `t${id}` } })),
    );
    expect(written.every(answer => answer.violated === undefined && !answer.conflict)).toBe(true);
    expect(await engine.count(collection, undefined, { tenant: 't1' })).toBe(1);
    expect(await engine.count(collection, undefined, undefined)).toBe(4);
  });

  it('inside a transaction every operation is narrowed to its scope', async () => {
    const collection = at('c_scope_txn', [['url']]);
    await engine.ensure([collection]);
    await engine.put(collection, one('g'), { replace: true, scope: { tenant: 'globex' } });
    const trx = await engine.begin(collection);
    const acme = { tenant: 'acme' };
    await trx.engine.put(collection, one('a'), { replace: true, scope: acme });
    expect((await trx.engine.put(collection, one('g'), { replace: true, scope: acme })).conflict).toBe(true);
    expect((await trx.engine.get(collection, 'g', acme)).record).toBeUndefined();
    expect((await trx.engine.find(collection, { scope: acme })).map(record => record.id)).toEqual(['a']);
    expect(await trx.engine.count(collection, undefined, acme)).toBe(1);
    expect((await trx.engine.patch(collection, 'g', { hits: 9 }, { scope: acme })).record).toBeUndefined();
    expect((await trx.engine.remove(collection, 'g', acme)).removed).toBe(false);
    await trx.commit();
    expect((await engine.get(collection, 'g', { tenant: 'globex' })).record).toEqual(one('g'));
  });

  it('a scope added for a transaction is made on the pool, and stays when the transaction rolls back', async () => {
    const collection = at('c_scope_txn_first');
    await engine.ensure([collection]);
    const trx = await engine.begin(collection);
    const written = await Promise.all(
      ['1', '2', '3'].map(id => trx.engine.put(collection, one(id), { replace: true, scope: { tenant: 'acme' } })),
    );
    expect(written.every(answer => answer.violated === undefined && !answer.conflict)).toBe(true);
    await trx.rollback();
    expect((await catalogOf('c_scope_txn_first')).types.tenant).toBe('varchar(768) NO');
    expect(await engine.count(collection, undefined, undefined)).toBe(0);
    await engine.put(collection, one('4'), { replace: true, scope: { tenant: 'acme' } });
    expect(await engine.count(collection, undefined, { tenant: 'acme' })).toBe(1);
  });

  it('a transaction that read the table before its first scope is answered after a bounded wait', async () => {
    const collection = at('c_scope_held');
    await engine.ensure([collection]);
    const trx = await engine.begin(collection);
    await trx.engine.find(collection, {});
    // the scope is added on the pool, and this transaction holds the table it would change
    await expect(trx.engine.put(collection, one('1'), { replace: true, scope: { tenant: 'acme' } })).rejects.toThrow(
      /scope: waited 10s to add a scope to c_scope_held, which a transaction holds/,
    );
    await trx.rollback();
    await engine.put(collection, one('1'), { replace: true, scope: { tenant: 'acme' } });
    expect(await engine.count(collection, undefined, { tenant: 'acme' })).toBe(1);
  }, 30_000);

  it('a transaction that read before a scope was added to another table is told to retry its reads of it', async () => {
    const before = at('c_scope_viewed');
    const collection = at('c_scope_rebuilt', [['url']]);
    await engine.ensure([before, collection]);
    const trx = await engine.begin(collection);
    await trx.engine.find(before, {});
    // the write lands; the ALTER rebuilt the table after this transaction's snapshot, which MySQL refuses to read
    expect((await trx.engine.put(collection, one('1'), { replace: true, scope: { tenant: 'acme' } })).conflict).toBe(
      false,
    );
    await expect(trx.engine.find(collection, { scope: { tenant: 'acme' } })).rejects.toThrow(
      /Table definition has changed, please retry transaction/,
    );
    await trx.rollback();
    const again = await engine.begin(collection);
    await again.engine.find(before, {});
    await again.engine.put(collection, one('1'), { replace: true, scope: { tenant: 'acme' } });
    expect(await again.engine.count(collection, undefined, { tenant: 'acme' })).toBe(1);
    await again.commit();
  });

  it('a second load of the tree reads the scope off the table: ensure is content and the rows stay apart', async () => {
    const collection = at('c_scope_reload', [['url', 'method']]);
    await engine.ensure([collection]);
    await engine.put(collection, one('1'), { replace: true, scope: { tenant: 'acme' } });
    const again = makeMysqlEngine({ settings: {} });
    try {
      expect(await again.engine.ensure([collection])).toEqual({ collections: 0, columns: 0, constraints: 0 });
      expect((await again.engine.get(collection, '1', { tenant: 'globex' })).record).toBeUndefined();
      expect((await again.engine.get(collection, '1', { tenant: 'acme' })).record?.id).toBe('1');
      const repeat = await again.engine.put(collection, one('2', 'https://one.example/1'), {
        replace: false,
        scope: { tenant: 'acme' },
      });
      expect(repeat).toEqual({ conflict: false, violated: 'unique [url, method]' });
    } finally {
      await again.close();
    }
  });
});
