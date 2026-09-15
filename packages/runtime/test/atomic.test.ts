/**
 * What an atomic graph's run does to the effects below it, driven the way the runtime drives one. The scope's
 * own promises are a unit test in the compiler; this is the other half: that the compiler opens one around a
 * graph whose document says `atomic`, hands it to the handlers through `env`, and settles it on every ending
 * a run has -- answered, refused, and broken.
 *
 * The participant is a fake rather than a database: what is under test is the wiring, and a real transaction
 * is what the postgres engine's own tests prove.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTree, runGraph } from '@wilanis/compiler';
import { type Atomic, loadTree, type PluginModule, Scope, schemaRef, schemaUrl } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, Embedder } from '../src/index.js';
import { docsDir } from './example-harness.js';

const CONNECTION = '@connections/records.connection.json';

/** What one run's fake transaction did, in the order it happened. */
type Log = string[];

/**
 * A plugin with one transactional operation and one that is not, so a case can put either inside an atomic
 * graph. `write` joins the scope the way a storage handler does: it asks for the transaction on its
 * connection, and what it writes is remembered against that transaction rather than kept.
 */
function keeper(log: Log, opened: { count: number }): PluginModule {
  return {
    root: '@keeper',
    docs: docsDir({
      'plugin.json': {
        $schema: schemaRef('plugin'),
        description: 'a store that remembers what a transaction did, for as long as a test runs',
        grants: {
          ports: ['@keeper/keeper.port.json'],
          connectionKinds: ['@keeper/keeper.connection-kind.json'],
        },
      },
      'keeper.connection-kind.json': {
        $schema: schemaRef('connection-kind'),
        description: 'a connection to rows that live only while a test runs',
        settings: { fields: {} },
        storage: true,
      },
      'keeper.port.json': {
        $schema: schemaRef('port'),
        description: 'writing a row, and sending something that cannot be rolled back',
        operations: {
          write: {
            description: 'Write one row inside whatever transaction the run carries.',
            transactional: true,
            accepts: {
              connection: { type: 'string', static: true },
              row: { type: 'string' },
            },
            returns: 'string',
          },
          send: {
            description: 'Send something away, which no transaction can take back.',
            accepts: { what: { type: 'string' } },
            returns: 'string',
          },
          fail: {
            description: 'Break, so a run ends without an answer.',
            accepts: { after: { type: 'string' } },
            returns: 'string',
          },
        },
      },
    }),
    handlers: {
      '@keeper/keeper.port.json#write': async ({ in: input, ctx }: any) => {
        const scope = ctx.env.atomic as Atomic | undefined;
        if (!scope) {
          log.push(`wrote ${input.row} outside a transaction`);
          return input.row;
        }
        await scope.join(input.connection, async () => {
          opened.count += 1;
          log.push('begin');
          return {
            commit: async () => {
              log.push('commit');
            },
            rollback: async () => {
              log.push('rollback');
            },
          };
        });
        log.push(`wrote ${input.row}`);
        return input.row;
      },
      '@keeper/keeper.port.json#send': async ({ in: input }: any) => {
        log.push(`sent ${input.what}`);
        return input.what;
      },
      '@keeper/keeper.port.json#fail': async () => {
        throw new Error('the fifth draft is not a draft');
      },
    },
  };
}

/** A tree whose one domain operation is met by the graph a case hands in. */
function treeRunning(graph: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-atomic-'));
  mkdirSync(join(dir, 'features/keep/domain'), { recursive: true });
  mkdirSync(join(dir, 'features/keep/data'), { recursive: true });
  mkdirSync(join(dir, 'connections'), { recursive: true });
  const put = (rel: string, doc: unknown) => writeFileSync(join(dir, rel), JSON.stringify(doc));

  put('project.json', {
    $schema: schemaUrl('project'),
    name: 'keeper',
    description: 'a tree whose one operation runs the graph a case is about',
    plugins: [{ use: '@std' }, { use: '@keeper' }],
  });
  put('connections/records.connection.json', {
    $schema: schemaRef('connection'),
    description: 'where the rows live',
    kind: '@keeper/keeper.connection-kind.json',
    settings: {},
  });
  put('features/keep/feature.json', {
    $schema: schemaRef('feature'),
    description: 'what the tree keeps',
    effects: ['@keeper/keeper.port.json#write', '@keeper/keeper.port.json#send', '@keeper/keeper.port.json#fail'],
  });
  put('features/keep/domain/Row.shape.json', {
    $schema: schemaRef('shape'),
    description: 'what a caller hands in',
    layer: 'core',
    fields: { row: { type: 'string' } },
  });
  put('features/keep/domain/keeping.port.json', {
    $schema: schemaRef('port'),
    description: 'what a caller asks of this tree',
    operations: {
      record: {
        description: 'Record what was given.',
        accepts: { row: { type: 'string' } },
        returns: 'string',
      },
    },
  });
  put('features/keep/data/record.graph.json', graph);
  put('features/keep/data/keeping.binding.json', {
    $schema: schemaRef('binding'),
    description: 'recording runs the graph',
    port: '@features/keep/domain/keeping.port.json',
    operations: { record: { graph: '@features/keep/data/record.graph.json' } },
  });
  return dir;
}

/** Run the tree's one operation and answer what the fake transaction saw. */
async function running(graph: Record<string, unknown>) {
  const log: Log = [];
  const opened = { count: 0 };
  const dir = treeRunning(graph);
  const plugins = { ...BUILTIN_PLUGINS, '@keeper': keeper(log, opened) };
  const loaded = loadTree(dir, plugins);
  const refused = checkTree(loaded).format();
  if (refused) throw new Error(`the tree a case runs must itself pass:\n${refused}`);
  const scope = new Scope(loaded.registry, loaded.resolve);
  const embedder = new Embedder(scope, loaded.plugins, { env: {}, root: dir });
  const compiled = embedder.operation('@features/keep/domain/keeping.port.json#record');
  const report = await runGraph(compiled, { initial: { in: { row: 'one' } }, env: embedder.env });
  rmSync(dir, { recursive: true, force: true });
  return { log, opened, report };
}

/** One write node, by id and row. */
const writes = (id: string, row: string) => ({
  type: schemaRef('node/run'),
  id,
  run: '@keeper/keeper.port.json#write',
  in: { connection: CONNECTION, row: `${row}-{{in.row}}` },
});

describe('a graph that says atomic', () => {
  it('opens one transaction for two writes the engine starts together, and commits when it answered', async () => {
    const { log, opened, report } = await running({
      $schema: schemaRef('graph'),
      description: 'two rows that move together',
      atomic: true,
      in: '@features/keep/domain/Row.shape.json',
      out: { type: 'string', from: 'both' },
      nodes: [
        writes('first', 'one'),
        writes('second', 'two'),
        {
          type: schemaRef('node/run'),
          id: 'both',
          run: '@std/text.port.json#join',
          in: { parts: ['{{first}}', '{{second}}'], separator: ',' },
        },
      ],
    });

    expect(report.status).toBe('done');
    expect(opened.count).toBe(1);
    expect(log[0]).toBe('begin');
    expect(log.at(-1)).toBe('commit');
    expect(log).toContain('wrote one-one');
    expect(log).toContain('wrote two-one');
  });

  it('rolls back what was written when a later node breaks', async () => {
    const { log, opened, report } = await running({
      $schema: schemaRef('graph'),
      description: 'a row written before something breaks',
      atomic: true,
      in: '@features/keep/domain/Row.shape.json',
      out: { type: 'string', from: 'failed' },
      nodes: [
        writes('first', 'one'),
        {
          type: schemaRef('node/run'),
          id: 'broke',
          run: '@keeper/keeper.port.json#send',
          in: { what: '{{first}}' },
        },
        {
          type: schemaRef('node/run'),
          id: 'failed',
          run: '@keeper/keeper.port.json#fail',
          in: { after: '{{broke}}' },
        },
      ],
    });

    expect(report.status).not.toBe('done');
    expect(opened.count).toBe(1);
    expect(log).toContain('wrote one-one');
    expect(log.at(-1)).toBe('rollback');
    expect(log).not.toContain('commit');
  });

  it('opens nothing at all when the graph reaches no transactional effect', async () => {
    const { log, opened } = await running({
      $schema: schemaRef('graph'),
      description: 'nothing here takes part',
      in: '@features/keep/domain/Row.shape.json',
      out: { type: 'string', from: 'sent' },
      nodes: [
        {
          type: schemaRef('node/run'),
          id: 'sent',
          run: '@keeper/keeper.port.json#send',
          in: { what: '{{in.row}}' },
        },
      ],
    });

    expect(opened.count).toBe(0);
    expect(log).toEqual(['sent one']);
  });

  it('leaves a graph that is not atomic exactly as it was', async () => {
    const { log, opened, report } = await running({
      $schema: schemaRef('graph'),
      description: 'one row, in no transaction at all',
      in: '@features/keep/domain/Row.shape.json',
      out: { type: 'string', from: 'first' },
      nodes: [writes('first', 'one')],
    });

    expect(report.status).toBe('done');
    expect(opened.count).toBe(0);
    expect(log).toEqual(['wrote one-one outside a transaction']);
  });
});
