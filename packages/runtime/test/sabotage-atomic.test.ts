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
 * atomic declaration suits, `kept-list` only reads and is the consistent snapshot the RFC decided to allow,
 * and `import-entries` reads a file before it writes, which is the shape the RFC says to split. The two that
 * need a document the example has no use for -- a second connection to fall on, and a port declaring itself
 * transactional while saying nowhere it goes -- plant it.
 *
 * Two cases are about the refusals themselves rather than about a graph: that one fault answers one refusal
 * naming every profile that reached it, and that a fault only one profile's binding reaches names only that
 * profile. The walk is per profile, since a profile chooses the binding; the refusal is per fault.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree, type PluginModule, schemaRef, schemaUrl } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS } from '../src/index.js';
import { docsDir, plantedEditingAllSaying, plantedEditingSaying, sabotage, sabotageSaying } from './example-harness.js';

const KEPT = 'features/monitor/data/kept-record.graph.json';
const IMPORT = 'features/monitor/domain/import-entries.graph.json';
const RECORD = 'features/monitor/domain/record-entry.graph.json';

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

  it('is accepted where everything it reaches is a store read -- L011', () => {
    // kept-list only finds records, and a find takes part in the transaction: an atomic read-only graph
    // is the consistent snapshot RFC 0004 decided to allow, not a graph with nothing to roll back
    expect(atomic('features/monitor/data/kept-list.graph.json')).toEqual([]);
  });

  it('is refused where it reaches an effect that cannot take part -- L009', () => {
    // import-entries reads the CSV through @blob before it records a row, and a file is not rolled back
    expect(atomic(IMPORT)).toContain('L009');
  });

  it('answers one refusal for one fault, naming every profile that reached it -- L009', () => {
    // parse-drafts is a data graph, so every profile's walk reaches the same @blob node: one fault, one
    // refusal, and the message says the three profiles rather than the refusal being repeated three times
    const said = sabotageSaying(IMPORT, doc => {
      doc.atomic = true;
    }).filter(one => one.startsWith('L009') && one.includes('@blob/csv.port.json#parse'));
    expect(said).toEqual([
      "L009 atomic graph '@features/monitor/domain/import-entries.graph.json' reaches '@blob/csv.port.json#parse', which cannot take part in a transaction (profiles 'live', 'local', 'production')",
    ]);
  });

  it('names only the profile whose binding reaches an effect that cannot take part -- L009', () => {
    // create-row is reached through monitor-rest.binding.json, which only the live profile chooses: the
    // refusal for its @http node says 'live' and no other, where the @blob one says all three
    const said = sabotageSaying(IMPORT, doc => {
      doc.atomic = true;
    }).filter(one => one.startsWith('L009') && one.includes('@http/http.port.json#request'));
    expect(said).toEqual([
      "L009 atomic graph '@features/monitor/domain/import-entries.graph.json' reaches '@http/http.port.json#request', which cannot take part in a transaction (profile 'live')",
    ]);
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

/** Write the note beside whatever the graph already wrote, so its effects fall on two connections. */
const NOTED = {
  type: '@wilanis/node/run.schema.json',
  id: 'noted',
  label: 'Note it elsewhere',
  run: '@storage/store.port.json#put',
  in: { store: '@monitor/data/notes.store.json', collection: 'notes', record: '{{recorded}}' },
};

describe('an atomic graph over more than one connection', () => {
  it('is refused, since one transaction is one connection -- L010', () => {
    const broken = plantedEditingSaying(ELSEWHERE, KEPT, doc => {
      doc.atomic = true;
      doc.nodes.push({ ...NOTED, in: { ...NOTED.in, record: '{{saved.record}}' } });
    });
    expect(broken.filter(one => one.startsWith('L010'))).toHaveLength(1);
  });

  it('names the profiles whose bindings put the effects on two connections -- L010', () => {
    // record-entry fires monitor.record, which the local profile meets in memory and the production
    // profile in PostgreSQL: two connections, each different from the notes one, so both profiles refuse.
    // The live profile meets it over HTTP, which is L009 and not a second connection at all.
    const broken = plantedEditingSaying(ELSEWHERE, RECORD, doc => {
      doc.atomic = true;
      doc.nodes.push(NOTED);
    });
    expect(broken.filter(one => one.startsWith('L010'))).toEqual([
      "L010 atomic graph reaches effects on 2 connections (@connections/entries.connection.json, @connections/notes.connection.json) (profile 'local')",
      "L010 atomic graph reaches effects on 2 connections (@connections/entries-postgres.connection.json, @connections/notes.connection.json) (profile 'production')",
    ]);
    // the live profile meets the port over HTTP, which is no second connection but an effect that cannot
    // take part at all
    expect(broken.filter(one => one.startsWith('L009'))).toHaveLength(1);
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

/**
 * The batch graph the example's `import` wants: one map over `monitor.submit`, declaring that the rows it
 * records move together. What it reaches depends entirely on which binding meets `submit`, so it is the graph
 * the profile filter is about.
 */
const BATCH = {
  'features/monitor/domain/record-batch.graph.json': {
    $schema: schemaUrl('graph'),
    label: 'Record a batch',
    atomic: true,
    description: 'Every draft of a batch recorded, or none.',
    in: '@monitor/domain/EntryDraft.shape.json[]',
    out: { type: '@monitor/domain/Entry.shape.json[]', from: 'recorded' },
    nodes: [
      {
        type: schemaRef('node/map'),
        id: 'recorded',
        label: 'Record each draft',
        run: '@monitor/domain/monitor.port.json#submit',
        over: '{{in}}',
        bind: { url: 'url', method: 'method' },
      },
    ],
  },
};

/** Meet `removeMany` with the batch graph in one binding, so the profiles choosing it reach the graph. */
const meetsBatch = (doc: any) => {
  doc.operations.removeMany = { graph: '@monitor/domain/record-batch.graph.json' };
};

const STORE_BINDING = 'features/monitor/data/monitor-store.binding.json';
const REST_BINDING = 'features/monitor/data/monitor-rest.binding.json';

/**
 * Which profiles an atomic graph is judged under. L009 and L010 ask what one run of the graph would do, and a
 * profile that never runs it has no such run: the example's `submit` reaches a store under `local` and an
 * HTTP call under `live`, so the same graph is a transaction under one profile and impossible under the
 * other, and which refusals it earns has to follow the bindings that name it.
 *
 * The case is written over `removeMany` because every profile of the example binds every operation of
 * `monitor.port.json`: pointing one profile's binding at the graph and not another's is what makes one
 * profile reach it. The type it answers is the same either way, so nothing else in the tree moves.
 */
describe('an atomic graph the profiles do not all reach', () => {
  it('is judged under the profile that names it, and not under one that does not', () => {
    // only the store binding meets removeMany with the batch graph, so only local and production reach it:
    // both keep the entries in a store, and neither has anything to refuse
    const said = plantedEditingAllSaying(BATCH, { [STORE_BINDING]: meetsBatch });
    expect(said.filter(one => one.includes('record-batch'))).toEqual([]);
  });

  it('is refused again as soon as a profile that cannot run it names it -- L009', () => {
    // the live binding meets removeMany with the same graph, and live meets submit over HTTP: one profile
    // now reaches a transaction it cannot hold, and the refusal names that profile and no other
    const said = plantedEditingAllSaying(BATCH, { [STORE_BINDING]: meetsBatch, [REST_BINDING]: meetsBatch });
    expect(said.filter(one => one.startsWith('L009') && one.includes('record-batch'))).toEqual([
      "L009 atomic graph '@features/monitor/domain/record-batch.graph.json' reaches '@http/http.port.json#request', which cannot take part in a transaction (profile 'live')",
    ]);
  });

  it('is refused for what it reaches nowhere, whatever the profiles name -- L011', () => {
    // a graph no profile reaches still earns the refusal its own contents earn: L011 is judged over every
    // profile, so an unreached graph answers what it is rather than an empty union and silence
    const said = plantedEditingAllSaying(
      {
        'features/monitor/domain/record-batch.graph.json': {
          ...BATCH['features/monitor/domain/record-batch.graph.json'],
          in: 'blob',
          out: { type: '@monitor/domain/EntryDraft.shape.json[]', from: 'recorded' },
          nodes: [
            {
              type: schemaRef('node/run'),
              id: 'recorded',
              label: 'Read the file',
              run: '@blob/csv.port.json#parse',
              in: { file: '{{in}}', type: '@monitor/domain/EntryDraft.shape.json' },
            },
          ],
        },
      },
      {},
    );
    // the message names the rule, not the file: what matters is that a graph nothing reaches is still judged
    expect(said.filter(one => one.startsWith('L011'))).toEqual([
      'L011 atomic graph reaches no effect that can take part in a transaction',
    ]);
  });
});
