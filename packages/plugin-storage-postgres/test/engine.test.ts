/**
 * This engine, judged by the same cases the memory one is. The behaviour is not restated here: it is
 * @storage's shared suite, which is what makes "this is an engine" one executable meaning rather than a
 * promise in a README. If a filter answers different records here than in memory, one of these cases fails.
 *
 * It needs a database, so it is skipped without `WILANIS_TEST_POSTGRES_URL` -- a suite that silently passes
 * without one would be worse than no suite. To run it:
 *
 *   docker run -d --rm --name wilanis-pg -e POSTGRES_PASSWORD=wilanis -e POSTGRES_DB=wilanis \
 *     -p 55432:5432 postgres:16-alpine
 *   WILANIS_TEST_POSTGRES_URL=postgres://postgres:wilanis@127.0.0.1:55432/wilanis npm test
 *
 * Every case keeps its records in a collection of its own and prepares it with `ensure` itself, so the whole
 * suite runs against one database without the cases reaching each other.
 */
import { parseWhere } from '@wilanis/plugin-storage';
import { cases, SHAPE, scopeCases } from '@wilanis/plugin-storage/suite';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgresEngine } from '../src/engine.js';
import { closePools } from '../src/pool.js';

const url = process.env.WILANIS_TEST_POSTGRES_URL;
const KIND = '@storage-postgres/postgres.connection-kind.json';
const CONNECTION = '@connections/records.connection.json';

const subject = {
  engine: new PostgresEngine({}),
  connection: { connection: CONNECTION, kind: KIND, settings: { url } },
};

afterAll(async () => {
  if (url) await closePools();
});

describe.skipIf(!url)('what every engine answers alike', () => {
  for (const one of cases) it(one.name, () => one.run(subject));
});

/**
 * The scope cases, which this engine answers as the memory one does: the column beside the record, the
 * predicate on every statement, and a `unique` that holds within a scope rather than across every one. They
 * are the same list both engines run, which is what makes "two tenants never see each other's rows" one
 * promise and not two.
 */
describe.skipIf(!url)('what an engine that keeps scopes answers', () => {
  for (const one of scopeCases) it(one.name, () => one.run(subject));
});

/**
 * The one thing about a scope that is this engine's alone: a statement carries the filter and the predicate
 * together. The shared suite asks for a filter without a scope and a scope without a filter, since that is
 * what an engine keeping records in a Map can get wrong; here the two are compiled into one `where`, and a
 * count that answered the filter and forgot the predicate would pass every case above.
 */
describe.skipIf(!url)('a statement carries the filter and the scope at once', () => {
  const at = {
    ...subject.connection,
    name: 'both_narrow',
    shape: SHAPE,
    key: 'id',
    unique: [],
    refs: [],
    referenced: [],
    defaults: {},
  };
  const one = (id: string, method: string) => ({ id, url: `https://x/${id}`, method, hits: 1, ok: true });

  it('count and find narrow by the where and by the scope together', async () => {
    await subject.engine.ensure([at]);
    for (const record of await subject.engine.find(at, {})) await subject.engine.remove(at, record.id);
    await subject.engine.put(at, one('a', 'GET'), { replace: true, scope: { tenant: 'acme' } });
    await subject.engine.put(at, one('b', 'POST'), { replace: true, scope: { tenant: 'acme' } });
    await subject.engine.put(at, one('c', 'GET'), { replace: true, scope: { tenant: 'globex' } });

    const get = parseWhere({ method: 'GET' }, SHAPE);
    expect(await subject.engine.count(at, get, { tenant: 'acme' })).toBe(1);
    expect(await subject.engine.count(at, get, undefined)).toBe(2);
    expect(await subject.engine.count(at, undefined, { tenant: 'acme' })).toBe(2);
    const found = await subject.engine.find(at, { where: get, scope: { tenant: 'acme' } });
    expect(found.map(record => record.id)).toEqual(['a']);
  });
});
