/**
 * What `wilanis ls`, `wilanis describe` and `wilanis map` say about a store, the port it is reached through,
 * and a shape a store keeps. A store is where a feature writes down what it persists and what it holds those
 * records to; none of what makes it reachable -- which engine keeps the records, what type a key is, which
 * graphs run against it -- is in the document, so a reader who cannot see it has to walk the tree by hand,
 * which is the one thing the viewer and `describe` exist to avoid.
 *
 * The marks are exercised against a planted store, which declares more of them than the example needs; the
 * engine, the key's type, the calls and the map line are exercised against the example's own.
 */
import { rmSync } from 'node:fs';
import { loadTree, schemaUrl } from '@wilanis/core';
import { afterAll, describe, expect, it } from 'vitest';
import { describe as describeDoc, ls, map } from '../src/index.js';
import { EXAMPLE, INCLUDES, loadedWith, PLUGINS } from './example-harness.js';

const shape = (label: string, fields: Record<string, unknown>) => ({
  $schema: schemaUrl('shape'),
  label,
  layer: 'core',
  description: `A ${label} as the domain knows it.`,
  fields,
});

const STORE = '@features/monitor/data/entries.store.json';
const { load, dir } = loadedWith({
  'features/monitor/domain/Note.shape.json': shape('Note', {
    id: { type: 'string' },
    entryId: { type: 'string' },
    text: { type: 'string' },
  }),
  'features/monitor/data/entries.store.json': {
    $schema: schemaUrl('store'),
    label: 'Entries',
    description: 'The entries recorded so far, and the notes hung off them.',
    connection: '@connections/customers.connection.json',
    collections: {
      entries: {
        of: '@monitor/domain/Entry.shape.json',
        key: 'id',
        unique: [['url', 'method'], ['ua']],
        defaults: { ua: 'unknown' },
        renamed: { agent: 'ua', note: 'comment' },
        was: 'entry',
        description: 'one row per observed call',
      },
      notes: {
        of: '@monitor/domain/Note.shape.json',
        key: 'id',
        refs: { entryId: { collection: 'entries', onRemove: 'refuse' } },
      },
    },
  },
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('describe: a store', () => {
  const said = () => describeDoc(load, STORE);

  it('says the connection its records live behind, and every collection with the shape it holds', () => {
    expect(said()).toContain('connection  @connections/customers.connection.json');
    expect(said()).toContain('  collection entries: @monitor/domain/Entry.shape.json');
    expect(said()).toContain('  collection notes: @monitor/domain/Note.shape.json');
  });

  it('gives each mark family one line, with its constraints in the order they were declared', () => {
    expect(said()).toContain('    key         id');
    expect(said()).toContain('    unique      [url, method], [ua]');
    expect(said()).toContain('    default     ua = "unknown"');
    expect(said()).toContain('    refs        entryId → entries.id (refuse on remove)');
    expect(said()).toContain('    holds       one row per observed call');
  });

  it('prints no line for a family with nothing to say, so a collection that declares nothing reads as one', () => {
    const notes = said().slice(said().indexOf('  collection notes:'));
    expect(notes).toContain('    refs');
    expect(notes).not.toContain('    unique');
    expect(notes).not.toContain('    default');
    expect(notes).not.toContain('    renamed');
    expect(notes).not.toContain('    was ');
    expect(notes).not.toContain('    holds');
  });

  it('gives the renames their own lines, and says under each that the database is not there yet', () => {
    expect(said()).toContain('    renamed     agent ← ua, note ← comment');
    expect(said()).toContain('    was         entry');
    // one note under each, so a reader of either knows the tree is ahead of every database
    const under = said()
      .split('\n')
      .filter(line => line.includes('until wilanis migrate has applied it everywhere'));
    expect(under).toHaveLength(2);
    // the note sits where a mark's own words sit, under the family it belongs to
    for (const line of under) expect(line).toBe(`${' '.repeat(16)}until wilanis migrate has applied it everywhere`);
  });

  it('opens no connection to say them: what the database holds is migrate --history to say', () => {
    // every line is the tree's own words -- no engine is reached, so the page says nothing about a database
    expect(said()).not.toContain('in the database');
    expect(said()).not.toContain('migration ');
    expect(said()).not.toContain('applied at');
  });
});

describe('describe: a shape a store keeps', () => {
  it('says which collection holds it, beside who writes it', () => {
    expect(describeDoc(load, '@monitor/domain/Entry.shape.json')).toContain(`held by  ${STORE}#entries`);
    expect(describeDoc(load, '@monitor/domain/Note.shape.json')).toContain(`held by  ${STORE}#notes`);
  });

  it('says nothing of the sort about a shape no store keeps', () => {
    expect(describeDoc(load, '@monitor/domain/Digest.shape.json')).not.toContain('held by');
  });
});

// ---- the example's own store, the one a reader meets -------------------------------------------------

const example = loadTree(EXAMPLE, PLUGINS, INCLUDES);
const KEPT = '@features/monitor/data/entries.store.json';

describe('ls: the stores of a tree', () => {
  it('lists a store under its kind, as every other kind is listed', () => {
    // two, since the example keeps its entries in memory under one profile and in PostgreSQL under another,
    // and a profile swaps bindings rather than connections
    expect(ls(example, 'store')).toEqual([
      'store            @features/monitor/data/entries-postgres.store.json',
      `store            ${KEPT}`,
    ]);
  });

  it('lists it among everything else too, so a reader who asks for no kind still finds it', () => {
    expect(ls(example).some(line => line.includes(KEPT))).toBe(true);
  });
});

describe('describe: the engine behind a store', () => {
  const said = () => describeDoc(example, KEPT);

  it('says which connection kind keeps the records, and the plugin and package that grant it', () => {
    expect(said()).toContain('connection  @connections/entries.connection.json');
    expect(said()).toContain(
      'engine      @storage-memory/memory.connection-kind.json  granted by @storage-memory (@wilanis/plugin-storage-memory)',
    );
  });

  it("says the type of a collection's key, read from the shape rather than repeated by the store", () => {
    expect(said()).toContain('    key         id: string');
  });

  it('names every graph that runs an operation against it, with the operation and the collection', () => {
    expect(said()).toContain('run against by (the operation each runs):');
    expect(said()).toContain('    @features/monitor/data/kept-get.graph.json#asked  get (entries)');
    expect(said()).toContain('    @features/monitor/data/store-and-latest.graph.json#key  newKey (entries)');
    expect(said()).toContain('    @features/monitor/data/store-and-latest.graph.json#stored  put (entries)');
    expect(said()).toContain('    @features/monitor/data/store-and-latest.graph.json#latest  put (latest)');
  });
});

describe('describe: the port a store is reached through', () => {
  const said = () => describeDoc(example, '@storage/store.port.json');

  it('says which plugin grants it, as every native port does', () => {
    expect(said()).toContain('granted by  @storage  (@wilanis/plugin-storage)');
  });

  it('lays out every operation with what it accepts and answers', () => {
    for (const op of ['#get', '#find', '#count', '#put', '#patch', '#remove', '#newKey']) expect(said()).toContain(op);
    expect(said()).toContain('    returns {record?: $T}');
  });

  it('says where the record type and the key type come from, rather than asking a caller to repeat them', () => {
    expect(said()).toContain('binds $T from collections[collection].of');
    expect(said()).toContain('binds $K from collections[collection].of{key}.type');
  });

  it('lays the where grammar out where find and count accept it, so a reader never guesses a filter', () => {
    const where = said()
      .split('\n')
      .filter(line => line.trimStart().startsWith('in  where?:'));
    expect(where).toHaveLength(2);
    for (const line of where) {
      expect(line).toContain('one or more of eq, ne, lt, lte, gt, gte');
      expect(line).toContain('all, any');
      expect(line).toContain('not');
    }
  });
});

describe('map: where a node lands', () => {
  const lines = () => map(example);

  it('ends a store call at the records, naming the store, the collection and the operation', () => {
    expect(lines()).toContain(`      asked @storage/store.port.json#get  (effect) → store ${KEPT} entries (get)`);
    expect(lines()).toContain(`      asked @storage/store.port.json#remove  (effect) → store ${KEPT} entries (remove)`);
  });

  it('leaves a call that is not a store call as it was', () => {
    expect(lines().some(line => line.includes('@std/object.port.json#make') && line.includes('store'))).toBe(false);
  });
});
