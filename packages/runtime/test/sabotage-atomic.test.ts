/**
 * What a graph may declare atomic, and what the compiler will not let one be. A graph that says `atomic`
 * promises that the effects below it commit or roll back together, and four rules hold it to that: every
 * effect it reaches can take part in a transaction (L009), they fall on one connection (L010), there is at
 * least one to roll back (L011), and no map among them collects a failure that has already ended the
 * transaction (G014). A transactional operation must also say where it goes, statically (C009), since the
 * connection is resolved before anything runs.
 *
 * The cases mark the example's own graphs atomic rather than planting new ones, so what is proved is the
 * rule against the tree a reader learns from: `kept-record` writes twice to one store and is the graph an
 * atomic declaration suits, and `import-entries` reads a file before it writes, which is the shape the RFC
 * says to split. The two that need a document the example has no use for -- a second connection to fall on,
 * and a port declaring itself transactional while saying nowhere it goes -- plant it.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree, type PluginModule, schemaRef, schemaUrl } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS } from '../src/index.js';
import { docsDir, plantedEditing, sabotage } from './example-harness.js';

const KEPT = 'features/monitor/data/kept-record.graph.json';
const IMPORT = 'features/monitor/domain/import-entries.graph.json';

/** Mark one graph of the example atomic, and answer what the tree then refuses with. */
const atomic = (file: string, also: (doc: any) => void = () => {}) =>
  sabotage(file, doc => {
    doc.atomic = true;
    also(doc);
  });

describe('a graph that says it is atomic', () => {
  it('is accepted where every effect it reaches is one transaction on one connection', () => {
    // kept-record asks for a key and writes the record, both through @storage on the entries connection:
    // the case that must pass, so the three that follow are refusing something real
    expect(atomic(KEPT)).toEqual([]);
  });

  it('is refused where it reaches an effect that cannot take part -- L009', () => {
    // import-entries reads the CSV through @blob before it records a row, and a file is not rolled back
    expect(atomic(IMPORT)).toContain('L009');
  });

  it('is refused where nothing it reaches could roll back -- L011', () => {
    // parse-drafts only reads a file: there is no transaction for "atomic" to be about
    expect(atomic('features/monitor/data/parse-drafts.graph.json')).toContain('L011');
  });

  it('is refused where a map below it collects the failures -- G014', () => {
    // a collected failure leaves the run done, so the transaction would commit what the element did not write
    const broken = atomic(KEPT, doc => {
      doc.nodes.push({
        type: '@wilanis/node/map.schema.json',
        id: 'each',
        label: 'Write each again',
        run: '@storage/store.port.json#put',
        over: '{{in.tags}}',
        onItemFailure: 'collect',
        in: { store: '@monitor/data/entries.store.json', collection: 'entries', record: '{{saved.record}}' },
      });
    });
    expect(broken).toContain('G014');
  });
});

/** A second store, on a connection of its own, so an atomic graph has two to fall on. */
const ELSEWHERE = {
  'connections/notes.connection.json': {
    $schema: schemaUrl('connection'),
    label: 'Notes',
    description: 'A second place records are kept, so one transaction can be asked to span two.',
    kind: '@storage-memory/memory.connection-kind.json',
    settings: {},
  },
  'features/monitor/data/notes.store.json': {
    $schema: schemaUrl('store'),
    label: 'Notes',
    description: 'Notes kept beside the entries, and deliberately not with them.',
    connection: '@connections/notes.connection.json',
    collections: {
      notes: { description: 'one note per entry', of: '@monitor/domain/Entry.shape.json', key: 'id' },
    },
  },
};

describe('an atomic graph over more than one connection', () => {
  it('is refused, since one transaction is one connection -- L010', () => {
    const broken = plantedEditing(ELSEWHERE, KEPT, doc => {
      doc.atomic = true;
      doc.nodes.push({
        type: '@wilanis/node/run.schema.json',
        id: 'noted',
        label: 'Note it elsewhere',
        run: '@storage/store.port.json#put',
        in: { store: '@monitor/data/notes.store.json', collection: 'notes', record: '{{saved.record}}' },
      });
    });
    // once per profile: which binding meets an operation is the profile's choice, so the walk is made per
    // profile and the refusal says which one found it
    expect(broken).toContain('L010');
    expect(broken.filter(code => code === 'L010').length).toBeGreaterThan(1);
  });
});

describe('an operation that says it is transactional', () => {
  /** A tree of nothing but the plugins it names, so a planted port is judged and nothing else is. */
  const treeOf = (plugins: unknown[]): string => {
    const dir = mkdtempSync(join(tmpdir(), 'wilanis-atomic-'));
    writeFileSync(
      join(dir, 'project.json'),
      JSON.stringify({ $schema: schemaUrl('project'), name: 'atomic', description: 'a tree with a port', plugins }),
    );
    return dir;
  };

  /** The codes a tree answers with when one plugin ships a port whose one operation is as given. */
  const shipping = (write: Record<string, unknown>): string[] => {
    const fake: PluginModule = {
      root: '@fake',
      docs: docsDir({
        'plugin.json': {
          $schema: schemaRef('plugin'),
          description: 'a plugin granting one transactional operation',
          grants: {},
        },
        'fake.port.json': {
          $schema: schemaRef('port'),
          description: 'A port whose operation takes part in a transaction.',
          operations: { write },
        },
      }),
      handlers: {},
    };
    const dir = treeOf([{ use: '@std' }, { use: '@fake' }]);
    const out = checkTree(loadTree(dir, { ...BUILTIN_PLUGINS, '@fake': fake })).items.map(refusal => refusal.code);
    rmSync(dir, { recursive: true, force: true });
    return out;
  };

  it('is refused where it says nowhere static to resolve a connection from -- C009', () => {
    const wandering = {
      description: 'Write something, somewhere nobody said.',
      transactional: true,
      accepts: { what: { type: 'string', description: 'the thing written' } },
    };
    expect(shipping(wandering)).toContain('C009');
  });

  it('is accepted where it accepts a static store to resolve one from', () => {
    const saying = {
      description: 'Write something, where the store says.',
      transactional: true,
      accepts: {
        store: { type: 'string', static: true, description: 'the store written to' },
        what: { type: 'string', description: 'the thing written' },
      },
    };
    expect(shipping(saying)).not.toContain('C009');
  });
});
