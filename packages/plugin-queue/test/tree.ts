/**
 * A tree small enough to break one way at a time: one feature whose `remove` refuses `missing` for the id
 * "missing" and `upstream` for "broken", a queue trigger consuming removals, a data graph publishing them behind
 * `enqueue`, a command-line trigger to fire that by hand, and a startup step working the queues. Every case
 * copies it, edits one document, and answers the refusal codes, as `packages/plugin-schedule/test` does.
 *
 * The broker is the fake of `fake-broker.ts`, granted by a plugin of this file under two connection kinds --
 * one delivering at least once and one at most once -- and registered from its `postLoad` exactly as a broker
 * package registers itself.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree, type PluginModule, schemaRef } from '@wilanis/core';
import { BUILTIN_PLUGINS } from '@wilanis/runtime';
import { brokers } from '../src/brokers.js';
import queue from '../src/index.js';
import { FakeBroker } from './fake-broker.js';

export const FAKE = '@fake-broker';
export const AT_LEAST_ONCE = `${FAKE}/fake.connection-kind.json`;
export const AT_MOST_ONCE = `${FAKE}/once.connection-kind.json`;
export const JOBS = '@connections/jobs.connection.json';
export const ONCE = '@connections/once.connection.json';
export const TRIGGER = 'features/customers/edge/removals.trigger.json';
export const PUBLISHING = 'features/customers/data/publish-removal.graph.json';
export const ID_REQUEST = '@features/customers/edge/IdRequest.shape.json';

/** A directory of documents, written as a plugin's docs. */
function docsDir(docs: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-queue-docs-'));
  for (const [name, doc] of Object.entries(docs)) writeFileSync(join(dir, name), JSON.stringify(doc));
  return dir;
}

const BROKER_DOCS = docsDir({
  'plugin.json': {
    $schema: schemaRef('plugin'),
    description: 'A broker for tests: two kinds of connection, one redelivering and one not, kept in a Map.',
    grants: { connectionKinds: [AT_LEAST_ONCE, AT_MOST_ONCE] },
  },
  'fake.connection-kind.json': {
    $schema: schemaRef('connection-kind'),
    description: 'A broker that delivers a message again when it was not acknowledged.',
    delivery: 'at-least-once',
    settings: { fields: {} },
  },
  'once.connection-kind.json': {
    $schema: schemaRef('connection-kind'),
    description: 'A broker that hands a message once and never again.',
    delivery: 'at-most-once',
    settings: { fields: {} },
  },
});

/** The broker plugin, registering `broker` for both its kinds every time the tree is loaded; `none` registers nothing. */
export function brokerPlugin(broker: FakeBroker | 'none' = new FakeBroker()): PluginModule {
  return {
    root: FAKE,
    docs: BROKER_DOCS,
    handlers: {},
    async postLoad({ env }) {
      if (broker === 'none') return;
      brokers(env).register(AT_LEAST_ONCE, broker);
      brokers(env).register(AT_MOST_ONCE, broker);
    },
  };
}

/** The plugins a tree here loads with: the built-in ones, @queue, and the fake broker. */
export const pluginsWith = (broker: FakeBroker | 'none' = new FakeBroker()): Record<string, PluginModule> => ({
  ...BUILTIN_PLUGINS,
  '@queue': queue,
  [FAKE]: brokerPlugin(broker),
});

/** One document of the tree, by the path it sits at. */
export type Docs = Record<string, unknown>;

const shape = (description: string, layer: string, fields: Record<string, unknown>) => ({
  $schema: schemaRef('shape'),
  description,
  layer,
  fields,
});

const connection = (description: string, kind: string) => ({
  $schema: schemaRef('connection'),
  description,
  kind,
  settings: {},
});

/** The project, its connections and the shapes of the feature. */
function base(): Docs {
  return {
    'project.json': {
      $schema: schemaRef('project'),
      description: 'a tree with work to do off the request',
      name: 'jobs',
      plugins: [{ use: '@std' }, { use: '@cli' }, { use: '@queue' }, { use: FAKE }],
      startup: [{ label: 'Work the queues', run: '@queue/worker.port.json#consume' }],
    },
    'connections/jobs.connection.json': connection('the broker removals go through', AT_LEAST_ONCE),
    'connections/once.connection.json': connection('a broker that never redelivers', AT_MOST_ONCE),
    'features/customers/feature.json': {
      $schema: schemaRef('feature'),
      description: 'who the registry keeps',
      effects: ['@queue/queue.port.json#publish'],
    },
    'features/customers/domain/Customer.shape.json': shape('a customer', 'core', { id: { type: 'string' } }),
    'features/customers/domain/Queued.shape.json': shape('a removal that was queued', 'core', {
      id: { type: 'string' },
    }),
    'features/customers/edge/IdRequest.shape.json': shape('one customer, by id', 'edge', { id: { type: 'string' } }),
    'features/customers/edge/CustomerView.shape.json': shape('a customer as the edge says it', 'edge', {
      id: { type: 'string' },
    }),
    'features/customers/edge/QueuedView.shape.json': shape('a queued removal as the edge says it', 'edge', {
      id: { type: 'string' },
    }),
    'features/customers/edge/Upload.shape.json': shape('a file, which no message may carry', 'edge', {
      rows: { type: { fields: { file: { type: 'blob' } } } },
    }),
  };
}

/** The port, its binding, and the two data graphs behind it. */
function domain(): Docs {
  return {
    'features/customers/domain/customer.port.json': {
      $schema: schemaRef('port'),
      description: 'what the registry can be asked for',
      operations: {
        remove: {
          description: 'remove one customer: missing when there is none, upstream when the registry broke',
          idempotent: true,
          accepts: { id: { type: 'string' } },
          returns: '@features/customers/domain/Customer.shape.json',
        },
        enqueue: {
          description: 'queue the removal of one customer',
          accepts: { id: { type: 'string' } },
          returns: '@features/customers/domain/Queued.shape.json',
        },
      },
    },
    'features/customers/data/customers.binding.json': {
      $schema: schemaRef('binding'),
      description: 'how the registry is met',
      port: '@features/customers/domain/customer.port.json',
      operations: {
        remove: { graph: '@features/customers/data/remove.graph.json' },
        enqueue: { graph: '@features/customers/data/publish-removal.graph.json' },
      },
    },
    'features/customers/data/remove.graph.json': removeGraph(),
    [PUBLISHING]: {
      $schema: schemaRef('graph'),
      description: 'one message on the removals queue',
      in: '@features/customers/domain/Customer.shape.json',
      out: { type: '@features/customers/domain/Queued.shape.json', from: 'queued' },
      nodes: [
        {
          id: 'published',
          type: '@wilanis/node/run.schema.json',
          run: '@queue/queue.port.json#publish',
          in: {
            connection: JOBS,
            queue: 'removals',
            type: ID_REQUEST,
            message: { id: '{{in.id}}' },
            headers: { origin: 'enqueue' },
          },
        },
        {
          id: 'queued',
          type: '@wilanis/node/run.schema.json',
          run: '@std/object.port.json#make',
          in: { value: { id: '{{published.id}}' }, type: '@features/customers/domain/Queued.shape.json' },
        },
      ],
    },
  };
}

/** A refusal node of the remove graph. */
const refusing = (id: string, reason: string) => ({
  id,
  type: '@wilanis/node/run.schema.json',
  run: '@std/outcome.port.json#refuse',
  in: { reason, message: `${reason}: {{in.id}}`, type: '@features/customers/domain/Customer.shape.json' },
});

/** The graph behind remove: the id decides whether it answers, is missing, or finds the registry broken. */
function removeGraph() {
  return {
    $schema: schemaRef('graph'),
    description: 'remove one customer, as far as a test needs: the id says what happens',
    in: '@features/customers/domain/Customer.shape.json',
    out: { type: '@features/customers/domain/Customer.shape.json', from: ['removed', 'missing', 'broken'] },
    nodes: [
      {
        id: 'which',
        type: '@wilanis/node/switch.schema.json',
        in: { id: '{{in.id}}' },
        rules: [
          { when: "id == 'missing'", to: 'missing' },
          { when: "id == 'broken'", to: 'broken' },
        ],
        else: 'removed',
      },
      {
        id: 'removed',
        type: '@wilanis/node/run.schema.json',
        run: '@std/object.port.json#make',
        in: { value: { id: '{{in.id}}' }, type: '@features/customers/domain/Customer.shape.json' },
      },
      refusing('missing', 'missing'),
      refusing('broken', 'upstream'),
    ],
  };
}

/** The two triggers: the queue trigger consuming removals, and the command line that enqueues one. */
function edge(): Docs {
  return {
    [TRIGGER]: {
      $schema: schemaRef('trigger'),
      description: 'one message per customer to remove',
      kind: '@queue/queue.trigger-kind.json',
      settings: {
        connection: JOBS,
        queue: 'removals',
        message: ID_REQUEST,
        maxAttempts: 3,
        backoffMs: 10,
        outcomes: { missing: 'ack', upstream: 'retry' },
      },
      in: ID_REQUEST,
      out: '@features/customers/edge/CustomerView.shape.json',
      fire: { run: '@features/customers/domain/customer.port.json#remove', in: { id: '{{request.message.id}}' } },
    },
    'features/customers/edge/enqueue.trigger.json': {
      $schema: schemaRef('trigger'),
      description: 'wilanis run enqueue --id=<id> queues one removal',
      kind: '@cli/cli.trigger-kind.json',
      settings: { command: 'enqueue' },
      in: ID_REQUEST,
      out: '@features/customers/edge/QueuedView.shape.json',
      fire: { run: '@features/customers/domain/customer.port.json#enqueue', in: { id: '{{request.flags.id}}' } },
    },
  };
}

/** The tree as it stands when nothing is broken. */
export function tree(): Docs {
  return { ...base(), ...domain(), ...edge() };
}

/** Write a tree into a directory of its own; the caller removes it. */
export function written(docs: Docs): string {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-queue-'));
  for (const [relative, doc] of Object.entries(docs)) {
    const path = join(dir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(doc));
  }
  return dir;
}

/** The refusals a tree answers with, as code and where each points. */
export function refusals(docs: Docs): { code: string; at: string; file: string; message: string; hint: string }[] {
  const dir = written(docs);
  const found = checkTree(loadTree(dir, pluginsWith())).items;
  rmSync(dir, { recursive: true, force: true });
  return found.map(one => ({ code: one.code, at: one.at ?? '', file: one.file, message: one.message, hint: one.hint }));
}

/** The refusal codes a tree answers with. */
export const codes = (docs: Docs) => refusals(docs).map(one => one.code);

/** The tree with one document replaced by the result of editing it. */
export function editing(file: string, edit: (doc: any) => void): Docs {
  const docs = tree();
  edit(docs[file]);
  return docs;
}
