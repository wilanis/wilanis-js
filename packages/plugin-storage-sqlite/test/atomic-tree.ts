/**
 * The tree `atomic.test.ts` drives: entries kept in one SQLite file, no two of them under one url, and the
 * graphs RFC 0004's end-to-end cases are written over.
 *
 * `pair` writes two entries, the second only once the first is in -- a `switch` routes to it on the first's
 * record -- so there is a moment between the two writes when the transaction holds one entry and not the
 * other. A url another entry holds is refused as `conflict`. `pairNoted` is the same graph with its second
 * write aimed at `notes`, a collection the store declares and the test never makes, so that write faults on a
 * missing table. `keepAll` is a domain graph mapping `keep` over a list, the batch RFC 0004's Motivation opens
 * with. `keep` alone, run outside any atomic graph, is a write outside every transaction.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const KIND = '@storage-sqlite/sqlite.connection-kind.json';
const STORE = '@features/entries/data/entries.store.json';
const ENTRY = '@features/entries/domain/Entry.shape.json';
const PAIR = '@features/entries/domain/Pair.shape.json';

/** The port the test fires, by its path in the tree. */
export const PORT = '@features/entries/domain/entries.port.json';

/** The file the tree keeps its entries in, relative to the tree's root. */
export const FILE = '.wilanis/entries.sqlite';

/**
 * How long a writer waits for the file here: far longer than any case holds it, so a case that proves an order
 * of events never depends on how fast the machine runs. The bound itself is proved apart, with a short one.
 */
export const BUSY_TIMEOUT_MS = 30_000;

/** One run node, the three fields every one of them here has. */
const node = (id: string, run: string, into: Record<string, unknown>) => ({
  type: '@wilanis/node/run.schema.json',
  id,
  run,
  in: into,
});

/** One write of a whole entry into a collection of the store. */
const put = (id: string, collection: string, record: string) =>
  node(id, '@storage/store.port.json#put', { store: STORE, collection, record });

/** A refusal, as the graph's answer when a write did not land. */
const refuse = (id: string, reason: string, message: string) =>
  node(id, '@std/outcome.port.json#refuse', { reason, message, type: ENTRY });

/**
 * Where a write's answer routes: a constraint refused it, it landed, or the store answered neither. A node has
 * one router, so the two refusals of each write are its own: `<write>Repeated` and `<write>Missing`.
 */
const routed = (id: string, write: string, landed: string) => [
  {
    type: '@wilanis/node/switch.schema.json',
    id,
    in: { record: `{{${write}.record}}`, violated: `{{${write}.violated}}` },
    rules: [
      { when: 'has(violated)', to: `${write}Repeated` },
      { when: 'has(record)', to: landed },
    ],
    else: `${write}Missing`,
  },
  refuse(`${write}Repeated`, 'conflict', 'another entry holds that url'),
  refuse(`${write}Missing`, 'upstream', 'the store answered no record'),
];

/** The atomic graph that writes the pair's first entry, then its second into `second` once the first is in. */
function pairGraph(second: string) {
  return {
    $schema: '@wilanis/graph.schema.json',
    description: `write the first entry, then the second into ${second} once the first is in`,
    atomic: true,
    in: PAIR,
    out: { type: ENTRY, from: ['kept', 'firstRepeated', 'firstMissing', 'secondRepeated', 'secondMissing'] },
    nodes: [
      put('first', 'entries', '{{in.first}}'),
      ...routed('afterFirst', 'first', 'second'),
      put('second', second, '{{in.second}}'),
      ...routed('afterSecond', 'second', 'kept'),
      node('kept', '@std/object.port.json#make', { value: '{{second.record}}', type: ENTRY }),
    ],
  };
}

/** The data graph behind `keep`: one write, refused as `conflict` where another entry holds the url. */
const keepGraph = {
  $schema: '@wilanis/graph.schema.json',
  description: 'write one entry whole, under its own key',
  in: ENTRY,
  out: { type: ENTRY, from: ['kept', 'storedRepeated', 'storedMissing'] },
  nodes: [
    put('stored', 'entries', '{{in}}'),
    ...routed('outcome', 'stored', 'kept'),
    node('kept', '@std/object.port.json#make', { value: '{{stored.record}}', type: ENTRY }),
  ],
};

/** The domain graph behind `keepAll`: every entry kept, or none. */
const keepAllGraph = {
  $schema: '@wilanis/graph.schema.json',
  description: 'keep every entry of the list, or none of them',
  atomic: true,
  in: `${ENTRY}[]`,
  out: { type: `${ENTRY}[]`, from: 'kept' },
  nodes: [
    {
      type: '@wilanis/node/map.schema.json',
      id: 'kept',
      run: `${PORT}#keep`,
      over: '{{in}}',
      bind: { id: 'id', url: 'url' },
    },
  ],
};

/** The domain half: the shapes and the port, which say nothing of how the entries are kept. */
function domain(write: (relative: string, doc: unknown) => void): void {
  write('features/entries/domain/Entry.shape.json', {
    $schema: '@wilanis/shape.schema.json',
    description: 'one entry',
    layer: 'core',
    fields: { id: { type: 'string' }, url: { type: 'string' } },
  });
  write('features/entries/domain/Pair.shape.json', {
    $schema: '@wilanis/shape.schema.json',
    description: 'two entries to be written together',
    layer: 'core',
    fields: { first: { type: ENTRY }, second: { type: ENTRY } },
  });
  write('features/entries/domain/keep-all.graph.json', keepAllGraph);
  write('features/entries/domain/entries.port.json', {
    $schema: '@wilanis/port.schema.json',
    description: 'what the domain needs of entry storage',
    operations: {
      keep: { description: 'Keep one entry.', accepts: ENTRY, returns: ENTRY },
      pair: { description: 'Keep two entries, both or neither.', accepts: PAIR, returns: ENTRY },
      pairNoted: { description: 'Keep an entry and a note of it, both or neither.', accepts: PAIR, returns: ENTRY },
      keepAll: {
        description: 'Keep every entry of a list, or none.',
        accepts: { entries: { type: `${ENTRY}[]` } },
        returns: `${ENTRY}[]`,
      },
      all: { description: 'Every entry kept.', returns: `${ENTRY}[]` },
    },
  });
}

/** The data half: the store, the binding, and the graphs behind the port. */
function data(write: (relative: string, doc: unknown) => void): void {
  write('features/entries/data/entries.store.json', {
    $schema: '@wilanis/store.schema.json',
    description: 'the entries, and the notes of them',
    connection: '@connections/entries.connection.json',
    collections: {
      entries: { of: ENTRY, key: 'id', unique: [['url']] },
      notes: { of: ENTRY, key: 'id' },
    },
  });
  const graph = (name: string) => ({ graph: `@features/entries/data/${name}.graph.json` });
  write('features/entries/data/entries-sqlite.binding.json', {
    $schema: '@wilanis/binding.schema.json',
    description: 'the port over an @storage store in a SQLite file',
    port: PORT,
    operations: {
      keep: graph('keep-entry'),
      pair: graph('write-pair'),
      pairNoted: graph('write-noted'),
      keepAll: { graph: '@features/entries/domain/keep-all.graph.json' },
      all: graph('list-entries'),
    },
  });
  write('features/entries/data/keep-entry.graph.json', keepGraph);
  write('features/entries/data/write-pair.graph.json', pairGraph('entries'));
  write('features/entries/data/write-noted.graph.json', pairGraph('notes'));
  write('features/entries/data/list-entries.graph.json', {
    $schema: '@wilanis/graph.schema.json',
    description: 'every entry the store keeps',
    out: { type: `${ENTRY}[]`, from: ['found'] },
    nodes: [node('found', '@storage/store.port.json#find', { store: STORE, collection: 'entries' })],
  });
}

/** A tree keeping its entries in `FILE` under a fresh temporary directory; the caller removes it. */
export function treeKeeping(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-sqlite-atomic-'));
  const write = (relative: string, doc: unknown) => {
    const path = join(dir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(doc));
  };
  write('project.json', {
    $schema: '@wilanis/project.schema.json',
    description: 'a tree that writes entries together into one SQLite file',
    name: 'atomic-sqlite',
    plugins: [
      { use: '@std' },
      { use: '@storage' },
      { use: '@storage-sqlite', settings: { busyTimeoutMs: BUSY_TIMEOUT_MS } },
    ],
  });
  write('connections/entries.connection.json', {
    $schema: '@wilanis/connection.schema.json',
    description: 'the entries, kept in one file under .wilanis, created on first use',
    kind: KIND,
    settings: { file: FILE },
  });
  write('features/entries/feature.json', {
    $schema: '@wilanis/feature.schema.json',
    description: 'what the store keeps',
    exports: [PORT, ENTRY, PAIR],
    effects: ['@storage/store.port.json#put', '@storage/store.port.json#find'],
  });
  domain(write);
  data(write);
  return dir;
}
