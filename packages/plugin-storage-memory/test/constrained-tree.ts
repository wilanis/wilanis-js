/**
 * The tree `constraints.test.ts` drives: a store whose entries may not repeat a url and a method together, and
 * notes that each point at an entry. Every graph that writes routes on what the store answered, so the claims
 * beside it are about which branch ran rather than about which error was thrown.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { edge } from './constrained-edge.js';

const KIND = '@storage-memory/memory.connection-kind.json';
const STORE = '@features/monitor/data/entries.store.json';
const ENTRY = '@features/monitor/domain/Entry.shape.json';
const NOTE = '@features/monitor/domain/Note.shape.json';

/** One run node, the three fields every one of them here has. */
const node = (id: string, run: string, into: Record<string, unknown>) => ({
  type: '@wilanis/node/run.schema.json',
  id,
  run,
  in: into,
});

/** A graph that writes through one @storage operation and routes on what the store answered. */
function routing(what: {
  description: string;
  in: string;
  out: string;
  from: string[];
  write: { id: string; run: string; in: Record<string, unknown> };
  reads: string[];
  rules: { when: string; to: string }[];
  else: string;
  answers: Record<string, Record<string, unknown>>;
}) {
  return {
    $schema: '@wilanis/graph.schema.json',
    description: what.description,
    in: what.in,
    out: { type: what.out, from: what.from },
    nodes: [
      node(what.write.id, what.write.run, what.write.in),
      {
        type: '@wilanis/node/switch.schema.json',
        id: 'route',
        in: Object.fromEntries(what.reads.map(field => [field, `{{${what.write.id}.${field}}}`])),
        rules: what.rules,
        else: what.else,
      },
      ...Object.entries(what.answers).map(([id, into]) => node(id, '@std/object.port.json#make', into)),
    ],
  };
}

/** A tree that keeps entries under a unique, and notes that reference them. */
export function treeServing(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-storage-constraints-'));
  const write = (relative: string, doc: unknown) => {
    const path = join(dir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(doc));
  };

  write('project.json', {
    $schema: '@wilanis/project.schema.json',
    description: 'a tree whose store declares what no two records may repeat, and what points at what',
    name: 'constrained',
    plugins: [{ use: '@std' }, { use: '@cli' }, { use: '@storage' }, { use: '@storage-memory' }],
  });
  write('connections/records.connection.json', {
    $schema: '@wilanis/connection.schema.json',
    description: 'the records, kept for as long as this process runs',
    kind: KIND,
    settings: {},
  });
  write('features/monitor/feature.json', {
    $schema: '@wilanis/feature.schema.json',
    description: 'what the monitor keeps',
    exports: ['@features/monitor/domain/entries.port.json', ENTRY],
    effects: ['@storage/store.port.json#put', '@storage/store.port.json#remove'],
  });
  write('features/monitor/domain/Entry.shape.json', {
    $schema: '@wilanis/shape.schema.json',
    description: 'one observed call',
    layer: 'core',
    fields: { id: { type: 'string' }, url: { type: 'string' }, method: { type: 'string' } },
  });
  write('features/monitor/domain/Note.shape.json', {
    $schema: '@wilanis/shape.schema.json',
    description: 'something written about one entry',
    layer: 'core',
    fields: { id: { type: 'string' }, entryId: { type: 'string' }, text: { type: 'string' } },
  });
  write('features/monitor/data/entries.store.json', {
    $schema: '@wilanis/store.schema.json',
    description: 'the entries, and the notes that point at them',
    connection: '@connections/records.connection.json',
    collections: {
      entries: { of: ENTRY, key: 'id', unique: [['url', 'method']] },
      notes: { of: NOTE, key: 'id', refs: { entryId: { collection: 'entries' } } },
    },
  });
  write('features/monitor/domain/Written.shape.json', {
    $schema: '@wilanis/shape.schema.json',
    description: 'what a write answers: the record, or the constraint that stopped it',
    layer: 'core',
    fields: {
      record: { type: ENTRY, required: false },
      violated: { type: 'string', required: false },
    },
  });
  write('features/monitor/domain/Noted.shape.json', {
    $schema: '@wilanis/shape.schema.json',
    description: 'what writing a note answers: the note, or the reference that stopped it',
    layer: 'core',
    fields: { record: { type: NOTE, required: false }, violated: { type: 'string', required: false } },
  });
  write('features/monitor/domain/Gone.shape.json', {
    $schema: '@wilanis/shape.schema.json',
    description: 'what a removal answers: whether it went, and what kept it where it did not',
    layer: 'core',
    fields: { removed: { type: 'boolean' }, referencedBy: { type: 'string', required: false } },
  });
  write('features/monitor/domain/entries.port.json', {
    $schema: '@wilanis/port.schema.json',
    description: 'what the domain needs of entry storage',
    operations: {
      record: {
        description: 'Keep one entry, or say which constraint stopped it.',
        accepts: { id: { type: 'string' }, url: { type: 'string' }, method: { type: 'string' } },
        returns: '@features/monitor/domain/Written.shape.json',
      },
      note: {
        description: 'Keep one note about an entry, or say which constraint stopped it.',
        accepts: { id: { type: 'string' }, entryId: { type: 'string' }, text: { type: 'string' } },
        returns: '@features/monitor/domain/Noted.shape.json',
      },
      forget: {
        description: 'Remove one entry, or say what still references it.',
        accepts: { id: { type: 'string' } },
        returns: '@features/monitor/domain/Gone.shape.json',
      },
    },
  });
  write('features/monitor/data/entries-memory.binding.json', {
    $schema: '@wilanis/binding.schema.json',
    description: 'the port over an @storage store',
    port: '@features/monitor/domain/entries.port.json',
    operations: {
      record: { graph: '@features/monitor/data/record-entry.graph.json' },
      note: { graph: '@features/monitor/data/record-note.graph.json' },
      forget: { graph: '@features/monitor/data/forget-entry.graph.json' },
    },
  });

  const kept = {
    kept: { value: { record: '{{saved.record}}' }, type: '@features/monitor/domain/Written.shape.json' },
    broke: { value: { violated: '{{saved.violated}}' }, type: '@features/monitor/domain/Written.shape.json' },
  };
  const noted = {
    noted: { value: { record: '{{saved.record}}' }, type: '@features/monitor/domain/Noted.shape.json' },
    broke: { value: { violated: '{{saved.violated}}' }, type: '@features/monitor/domain/Noted.shape.json' },
  };
  write(
    'features/monitor/data/record-entry.graph.json',
    routing({
      description: 'write the entry, and say which unique stopped it where one did',
      in: ENTRY,
      out: '@features/monitor/domain/Written.shape.json',
      from: ['kept', 'broke'],
      write: {
        id: 'saved',
        run: '@storage/store.port.json#put',
        in: {
          store: STORE,
          collection: 'entries',
          record: { id: '{{in.id}}', url: '{{in.url}}', method: '{{in.method}}' },
        },
      },
      reads: ['violated'],
      rules: [{ when: 'has(violated)', to: 'broke' }],
      else: 'kept',
      answers: kept,
    }),
  );
  write(
    'features/monitor/data/record-note.graph.json',
    routing({
      description: 'write the note, and say which reference stopped it where one did',
      in: NOTE,
      out: '@features/monitor/domain/Noted.shape.json',
      from: ['noted', 'broke'],
      write: {
        id: 'saved',
        run: '@storage/store.port.json#put',
        in: {
          store: STORE,
          collection: 'notes',
          record: { id: '{{in.id}}', entryId: '{{in.entryId}}', text: '{{in.text}}' },
        },
      },
      reads: ['violated'],
      rules: [{ when: 'has(violated)', to: 'broke' }],
      else: 'noted',
      answers: noted,
    }),
  );
  write(
    'features/monitor/data/forget-entry.graph.json',
    routing({
      description: 'remove the entry, and say what still references it where something does',
      in: '@features/monitor/edge/IdRequest.shape.json',
      out: '@features/monitor/domain/Gone.shape.json',
      from: ['gone', 'held'],
      write: {
        id: 'saved',
        run: '@storage/store.port.json#remove',
        in: { store: STORE, collection: 'entries', key: '{{in.id}}' },
      },
      reads: ['referencedBy'],
      rules: [{ when: 'has(referencedBy)', to: 'held' }],
      else: 'gone',
      answers: {
        gone: { value: { removed: '{{saved.removed}}' }, type: '@features/monitor/domain/Gone.shape.json' },
        held: {
          value: { removed: '{{saved.removed}}', referencedBy: '{{saved.referencedBy}}' },
          type: '@features/monitor/domain/Gone.shape.json',
        },
      },
    }),
  );

  edge(write);

  return dir;
}
