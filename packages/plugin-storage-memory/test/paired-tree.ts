/**
 * The tree `rollback-on-cancel.test.ts` drives: a store of entries, a domain port that writes two of them
 * one after the other, and one that lists what is kept. The second write waits on the first -- a `switch`
 * routes to it only once the first answered a record -- so there is a moment, between the two, when one
 * entry is written and the other is not, and a run cancelled there has something to undo.
 *
 * The graph is atomic unless the tree is asked for without it, so the one test file can show both what the
 * transaction undoes and what a cancelled run leaves behind where there is none.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const KIND = '@storage-memory/memory.connection-kind.json';
const STORE = '@features/entries/data/entries.store.json';
const ENTRY = '@features/entries/domain/Entry.shape.json';
const PAIR = '@features/entries/domain/Pair.shape.json';
const WRITTEN = '@features/entries/domain/Written.shape.json';

/** The port the test fires, by its path in the tree. */
export const PORT = '@features/entries/domain/entries.port.json';

/** One run node, the three fields every one of them here has. */
const node = (id: string, run: string, into: Record<string, unknown>) => ({
  type: '@wilanis/node/run.schema.json',
  id,
  run,
  in: into,
});

/** One write of an entry under the key the pair names for it. */
const put = (id: string, key: string) =>
  node(id, '@storage/store.port.json#put', { store: STORE, collection: 'entries', record: { id: key } });

/** The graph that writes the pair: the first entry, then, once it is in, the second. */
function pairGraph(atomic: boolean) {
  return {
    $schema: '@wilanis/graph.schema.json',
    description: 'write the first entry, then the second once the first is in',
    atomic,
    in: PAIR,
    out: { type: WRITTEN, from: ['kept', 'none'] },
    nodes: [
      put('first', '{{in.first}}'),
      {
        type: '@wilanis/node/switch.schema.json',
        id: 'wrote',
        in: { record: '{{first.record}}' },
        rules: [{ when: 'has(record)', to: 'second' }],
        else: 'none',
      },
      put('second', '{{in.second}}'),
      node('kept', '@std/object.port.json#make', { value: { record: '{{second.record}}' }, type: WRITTEN }),
      node('none', '@std/object.port.json#make', { value: {}, type: WRITTEN }),
    ],
  };
}

/** The domain half: the shapes and the port, which say nothing of how the entries are kept. */
function domain(write: (relative: string, doc: unknown) => void): void {
  write('features/entries/domain/Entry.shape.json', {
    $schema: '@wilanis/shape.schema.json',
    description: 'one entry',
    layer: 'core',
    fields: { id: { type: 'string' } },
  });
  write('features/entries/domain/Pair.shape.json', {
    $schema: '@wilanis/shape.schema.json',
    description: 'the keys of two entries to be written together',
    layer: 'core',
    fields: { first: { type: 'string' }, second: { type: 'string' } },
  });
  write('features/entries/domain/Written.shape.json', {
    $schema: '@wilanis/shape.schema.json',
    description: 'what writing the pair answers: the second entry, absent where the first was not written',
    layer: 'core',
    fields: { record: { type: ENTRY, required: false } },
  });
  write('features/entries/domain/entries.port.json', {
    $schema: '@wilanis/port.schema.json',
    description: 'what the domain needs of entry storage',
    operations: {
      pair: {
        description: 'Keep two entries, both or neither.',
        accepts: { first: { type: 'string' }, second: { type: 'string' } },
        returns: WRITTEN,
      },
      all: { description: 'Every entry kept.', returns: `${ENTRY}[]` },
    },
  });
}

/** The data half: the store, the binding, and the two graphs behind the port. */
function data(write: (relative: string, doc: unknown) => void, atomic: boolean): void {
  write('features/entries/data/entries.store.json', {
    $schema: '@wilanis/store.schema.json',
    description: 'the entries',
    connection: '@connections/records.connection.json',
    collections: { entries: { of: ENTRY, key: 'id' } },
  });
  write('features/entries/data/entries-memory.binding.json', {
    $schema: '@wilanis/binding.schema.json',
    description: 'the port over an @storage store',
    port: PORT,
    operations: {
      pair: { graph: '@features/entries/data/write-pair.graph.json' },
      all: { graph: '@features/entries/data/list-entries.graph.json' },
    },
  });
  write('features/entries/data/write-pair.graph.json', pairGraph(atomic));
  write('features/entries/data/list-entries.graph.json', {
    $schema: '@wilanis/graph.schema.json',
    description: 'every entry the store keeps',
    out: { type: `${ENTRY}[]`, from: ['found'] },
    nodes: [node('found', '@storage/store.port.json#find', { store: STORE, collection: 'entries' })],
  });
}

/** A tree whose pair of writes is atomic unless `atomic` is false. */
export function treePairing(atomic = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-storage-cancel-'));
  const write = (relative: string, doc: unknown) => {
    const path = join(dir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(doc));
  };

  write('project.json', {
    $schema: '@wilanis/project.schema.json',
    description: 'a tree that writes two entries together',
    name: 'paired',
    plugins: [{ use: '@std' }, { use: '@storage' }, { use: '@storage-memory' }],
  });
  write('connections/records.connection.json', {
    $schema: '@wilanis/connection.schema.json',
    description: 'the records, kept for as long as this process runs',
    kind: KIND,
    settings: {},
  });
  write('features/entries/feature.json', {
    $schema: '@wilanis/feature.schema.json',
    description: 'what the store keeps',
    exports: [PORT, ENTRY, PAIR, WRITTEN],
    effects: ['@storage/store.port.json#put', '@storage/store.port.json#find'],
  });
  domain(write);
  data(write, atomic);
  return dir;
}
