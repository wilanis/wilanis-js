/**
 * This engine, judged by the same cases the memory, postgres and sqlite ones are. The behaviour is not restated
 * here: it is @storage's shared suite, which is what makes "this is an engine" one executable meaning rather
 * than a promise in a README. If a filter answers different records here than in memory, one of these cases
 * fails.
 *
 * It needs a database, so it is skipped without `WILANIS_TEST_MYSQL_URL` -- a suite that silently passed without
 * one would be worse than no suite. CI starts no database, so it runs by hand, against the floor version:
 *
 *   docker run -d --rm --name wilanis-mysql --platform linux/amd64 -e MYSQL_ROOT_PASSWORD=wilanis \
 *     -e MYSQL_DATABASE=wilanis -p 53306:3306 mysql:8.0.16
 *   WILANIS_TEST_MYSQL_URL=mysql://root:wilanis@127.0.0.1:53306/wilanis \
 *     npx vitest run packages/plugin-storage-mysql
 *
 * Every case keeps its records in a collection of its own and prepares it with `ensure` itself, so the whole
 * suite runs against one database without the cases reaching each other, and runs again over what it left.
 */
import { cases } from '@wilanis/plugin-storage/suite';
import { afterAll, describe, it } from 'vitest';
import { makeMysqlEngine } from '../src/index.js';

const url = process.env.WILANIS_TEST_MYSQL_URL;
const KIND = '@storage-mysql/mysql.connection-kind.json';
const CONNECTION = '@connections/records.connection.json';

describe.skipIf(!url)('what every engine answers alike', () => {
  const made = makeMysqlEngine({ settings: {} });
  const subject = { engine: made.engine, connection: { connection: CONNECTION, kind: KIND, settings: { url } } };
  afterAll(() => made.close());
  for (const one of cases) it(one.name, () => one.run(subject));
});
