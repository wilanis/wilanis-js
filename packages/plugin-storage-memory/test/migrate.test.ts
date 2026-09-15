/**
 * What this engine answers about migrations, which is nothing at all (RFC 0017). It keeps records for exactly
 * as long as the process runs, so there is nothing to record, nothing in a catalog to inspect, no row standing
 * in any step's way, no plan worth applying and no history of one.
 *
 * The claim worth pinning is that the five answers are the *honest* ones and not stubs that happen to work:
 * `wilanis migrate` reads them and says "nothing kept between processes, nothing to migrate" for this
 * connection rather than planning against a record that cannot exist.
 */
import type { FieldType, On, Step } from '@wilanis/plugin-storage';
import { classed } from '@wilanis/plugin-storage';
import { describe, expect, it } from 'vitest';
import { MemoryEngine } from '../src/engine.js';

const on: On = {
  connection: '@connections/entries.connection.json',
  kind: '@storage-memory/memory.connection-kind.json',
  settings: {},
};

describe('an engine that keeps nothing between processes has nothing to migrate', () => {
  it('nothing was ever recorded, whatever the collection', async () => {
    expect(await new MemoryEngine().recorded(on, 'entries')).toBeUndefined();
  });

  it('there is no catalog to inspect, so no table is ever adopted from one', async () => {
    expect(await new MemoryEngine().inspect(on, 'entries')).toBeUndefined();
  });

  it('no row stands in any step way, whatever the step', async () => {
    const engine = new MemoryEngine();
    const steps: Step[] = [
      { do: 'drop', target: 'notes', says: 'drop collection notes' },
      { do: 'unique', target: 'entries', at: 'url', over: ['url'], says: 'unique   [url]' },
      { do: 'require', target: 'entries', at: 'ua', says: 'require ua' },
    ];
    for (const step of steps) expect(await engine.rows(on, step)).toBe(0);
  });

  it('applying a plan does nothing and records nothing', async () => {
    const engine = new MemoryEngine();
    const applied = await engine.apply(
      on,
      [{ do: 'drop', target: 'notes', says: 'drop collection notes' }],
      {},
      {
        by: 'rfontes@build-1',
        tree: 'monitor',
      },
    );
    expect(applied).toBeUndefined();
  });

  it('no plan ever applied, so there is no history of one', async () => {
    expect(await new MemoryEngine().history(on)).toEqual([]);
  });

  it('no cast is attempted, whatever the pair, because no step of this engine ever writes one', async () => {
    const engine = new MemoryEngine();
    const pairs: [FieldType, FieldType][] = [
      ['number', 'string'],
      ['string', 'number'],
      ['json', 'number'],
      ['string', 'string'],
    ];
    for (const [was, becomes] of pairs) expect(engine.attempts(was, becomes)).toBe(false);
    // and that answer is of no consequence, which is what makes it the honest one rather than a stub: a plan of
    // this engine's is never classed, since `apply` does nothing. Read by `classed` it would refuse every cast
    const step: Step = {
      do: 'retype',
      target: 'entries',
      at: 'ua',
      was: 'number',
      becomes: 'string',
      says: 'retype ua',
    };
    const judged = classed(step, 0, { attempts: (was, becomes) => engine.attempts(was, becomes) });
    expect(judged.class).toBe('refused');
  });
});
