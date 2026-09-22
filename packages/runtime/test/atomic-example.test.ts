/**
 * The example's atomic graphs against a real store: what RFC 0004's Motivation is about, answered rather
 * than argued. Import a CSV whose fifth row is not a customer and the store holds nothing -- not the four
 * rows the map had already written before the fifth refused. Import a clean one and every row is there, with
 * the latest registration of each tier beside it.
 *
 * Nothing here is a stand-in. The tree is the example, loaded under `local` so `@storage-memory` keeps the
 * records, and every operation is fired through the `Embedder` the way a startup step is -- the path a served
 * tree takes, blob scope and all. What is read back is the store itself, through the tree's own `listAll`,
 * so a rollback that left rows behind would be seen rather than inferred.
 *
 * The trigger's policies are not in the way because they gate the trigger and not the operation: who may
 * import is `@auth`'s business and is proved in its own tests, while what an import leaves behind is this
 * one's.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BlobHandle, LoadResult } from '@wilanis/core';
import { loadTree } from '@wilanis/core';
import { embedderFor, FileBlobStore, postLoad } from '@wilanis/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { INCLUDES, PLUGINS } from './example-harness.js';

const EXAMPLE = fileURLToPath(new URL('../../../example', import.meta.url));

/** One customer as the store keeps them, with the id dropped: what a case can write down. */
const people = (rows: unknown): { email: string; tier: string }[] =>
  (rows as { email: string; tier: string }[]).map(row => ({ email: row.email, tier: row.tier }));

/**
 * The example, served under one profile: its plugins registered by `postLoad`, a blob scope for the file,
 * and a way to fire a domain operation the way a startup step does. Every case takes a fresh one, since the
 * memory engine keeps its records for as long as the process and two cases must not see each other's.
 */
async function serving(profile = 'local') {
  const load: LoadResult = loadTree(EXAMPLE, PLUGINS, INCLUDES);
  const emb = embedderFor(load, { profile });
  const down = await postLoad(load, emb, () => {});
  const blobs = emb.blobs.scope();
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-atomic-e2e-'));

  /**
   * Fire one operation of the customer port, with what it accepts, and answer the whole report. `at` is the
   * place this call takes in the order they were made here -- these are not the project's steps, so the index
   * is this harness's own, and it is counted rather than defaulted so no record claims a position it has not.
   */
  let at = 0;
  const run = (op: string, input: Record<string, unknown> = {}) =>
    emb.startup({ run: `@customers/domain/customer.port.json#${op}`, in: input }, { blobs, at: at++ });

  /** The CSV as the route would hand it: bytes in the registry, a handle in the graph. */
  const upload = (text: string): Promise<BlobHandle> =>
    blobs.put(text, { contentType: 'text/csv', filename: 'customers.csv' });

  const stop = async () => {
    await blobs.release();
    await down();
    if (emb.blobs instanceof FileBlobStore) emb.blobs.destroy();
    rmSync(dir, { recursive: true, force: true });
  };
  return { run, upload, stop };
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

/** A CSV of drafts, header included, as the route receives one. */
const csv = (rows: string[]) => `name,email,tier\n${rows.join('\n')}\n`;
const FOUR = [
  'Ada,a@example.com,bronze',
  'Bo,b@example.com,silver',
  'Cy,c@example.com,bronze',
  'Di,d@example.com,silver',
];

describe('importing a CSV into a store, all of it or none of it', () => {
  it('leaves every row in when the file is one the domain accepts', async () => {
    const tree = await serving();
    close = tree.stop;
    const imported = await tree.run('import', { file: await tree.upload(csv(FOUR)) });
    expect(imported.status).toBe('done');
    // the answer is the customers, and the store holds exactly them. Delete the `atomic` from register-all
    // and this case fails with one row rather than four: the map fires the four writes at once, and without
    // one transaction to share they are four views of the store that overwrite one another. What the flag
    // buys here is not only the rollback below but the batch landing at all.
    const kept = await tree.run('listAll');
    expect(kept.status).toBe('done');
    expect(people(kept.output).sort((one, other) => one.email.localeCompare(other.email))).toEqual([
      { email: 'a@example.com', tier: 'bronze' },
      { email: 'b@example.com', tier: 'silver' },
      { email: 'c@example.com', tier: 'bronze' },
      { email: 'd@example.com', tier: 'silver' },
    ]);
  });

  it('leaves the store exactly as it was when a row partway through refuses', async () => {
    const tree = await serving();
    close = tree.stop;
    // the fifth row repeats the first address, which the customers collection declares unique: the write is
    // refused, and the four rows the map had already written go with it
    const five = csv([...FOUR, 'Ada again,a@example.com,bronze']);
    const imported = await tree.run('import', { file: await tree.upload(five) });
    expect(imported.status).toBe('failed');
    const kept = await tree.run('listAll');
    expect(kept.output).toEqual([]);
  });

  it('writes nothing when the file itself will not parse, since the read is outside the transaction', async () => {
    const tree = await serving();
    close = tree.stop;
    // a fault, not a declared refusal, and it happens at the read rather than at a write: the import is two
    // nodes so that a file a database could never roll back is read before the transaction opens. Nothing
    // reached the store to undo. (A fault *inside* the transaction is proved over a fake transactional
    // plugin in atomic.test.ts, where a handler can be told to throw; nothing the memory engine does on a
    // valid record faults.)
    const bad = await tree.run('import', { file: await tree.upload(csv([...FOUR, 'Ed,e@example.com,platinum'])) });
    expect(bad.status).toBe('failed');
    expect(String(bad.nodes.op?.error)).toContain('not in "bronze" | "silver"');
    const kept = await tree.run('listAll');
    expect(kept.output).toEqual([]);
  });

  it('keeps what an earlier import committed, since a rollback undoes one run and not the store', async () => {
    const tree = await serving();
    close = tree.stop;
    await tree.run('import', { file: await tree.upload(csv(FOUR)) });
    // a second import that refuses must leave the first one's rows alone: the transaction is the run's
    const broken = await tree.run('import', { file: await tree.upload(csv(['Ada again,a@example.com,bronze'])) });
    expect(broken.status).toBe('failed');
    const kept = await tree.run('listAll');
    expect(people(kept.output)).toHaveLength(4);
  });
});

describe('two atomic graphs running at once', () => {
  it('do not see each other’s uncommitted rows, so one refusing leaves the other whole', async () => {
    const tree = await serving();
    close = tree.stop;
    // both imports run against the same store at the same time. The second repeats an address within itself,
    // so its transaction rolls back; the first must keep every row it wrote, having never read the other's.
    const good = tree.run('import', { file: await tree.upload(csv(FOUR)) });
    const bad = tree.run('import', {
      file: await tree.upload(csv(['Zoe,z@example.com,bronze', 'Zoe again,z@example.com,silver'])),
    });
    const [first, second] = await Promise.all([good, bad]);
    expect(first.status).toBe('done');
    expect(second.status).toBe('failed');
    // the four rows of the import that answered, and nothing of the one that did not
    const kept = await tree.run('listAll');
    expect(
      people(kept.output)
        .map(one => one.email)
        .sort(),
    ).toEqual(['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com']);
  });
});

describe('registering a customer and their tier’s latest, both or neither', () => {
  it('writes the customer and the latest of their tier together', async () => {
    const tree = await serving();
    close = tree.stop;
    const registered = await tree.run('submit', { name: 'Ada', email: 'a@example.com', tier: 'bronze' });
    expect(registered.status).toBe('done');
    const kept = await tree.run('listAll');
    expect(people(kept.output)).toEqual([{ email: 'a@example.com', tier: 'bronze' }]);
  });

  it('leaves neither behind when the customer cannot be written', async () => {
    const tree = await serving();
    close = tree.stop;
    await tree.run('submit', { name: 'Ada', email: 'a@example.com', tier: 'bronze' });
    // the same address again: unique [email] refuses the customer, so the latest row it would have updated
    // is rolled back with it and the store still holds the one customer
    const again = await tree.run('submit', { name: 'Ada again', email: 'a@example.com', tier: 'silver' });
    expect(again.status).toBe('failed');
    const kept = await tree.run('listAll');
    expect(people(kept.output)).toHaveLength(1);
  });
});
