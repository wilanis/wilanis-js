/**
 * `publish` inside an atomic graph. Where the connection's kind is marked `storage` the handler hands the broker
 * the run's transaction, and a broker that honours it -- the fake does, as a table in the store would -- keeps
 * the message exactly when the graph's writes commit. Where the kind is not, the handler refuses before the
 * broker keeps anything, since a message kept outside the transaction would outlive its rollback; X405 says
 * so statically for the graph that carries the node, and this is the run that reaches one through a call.
 *
 * The first block drives the handler with the scope the compiler opens, so commit and rollback are the test's
 * to call; the second runs a tree through the runtime, where the atomic graph's own ending settles it.
 */
import { rmSync } from 'node:fs';
import { AtomicScope } from '@wilanis/compiler';
import { loadTree } from '@wilanis/core';
import type { RunContext } from '@wilanis/engine';
import { runTrigger } from '@wilanis/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { brokers } from '../src/brokers.js';
import { publish } from '../src/publish.js';
import { FakeBroker } from './fake-broker.js';
import { AT_LEAST_ONCE, editing, IN_STORE, JOBS, PUBLISHING, pluginsWith, refusals, TABLE, written } from './tree.js';

/** What a handler is handed: the two connections, their kinds as the tree reads them, and a transaction where the case gives one. */
function envWith(broker: FakeBroker, atomic?: AtomicScope): Record<string, unknown> {
  const kinds: Record<string, unknown> = { [IN_STORE]: { storage: true }, [AT_LEAST_ONCE]: {} };
  const env: Record<string, unknown> = {
    connections: { [TABLE]: { kind: IN_STORE, settings: {} }, [JOBS]: { kind: AT_LEAST_ONCE, settings: {} } },
    canon: (ref: string) => ref,
    resolving: { document: (ref: string) => kinds[ref], type: () => ({ kind: 'any' }) },
  };
  if (atomic) env.atomic = atomic;
  brokers(env).register(IN_STORE, broker);
  brokers(env).register(AT_LEAST_ONCE, broker);
  return env;
}

/** Run the publish handler once, on a connection, as a node of a graph would. */
const published = (env: Record<string, unknown>, connection: string) =>
  publish({
    in: { connection, queue: 'removals', type: 'IdRequest', message: { id: 'golf' } },
    ctx: { env } as unknown as RunContext,
  } as Parameters<typeof publish>[0]);

describe('publish, handed a transaction', () => {
  it('outside an atomic graph: no transaction, and the message is kept at once', async () => {
    const broker = new FakeBroker();
    await published(envWith(broker), TABLE);
    expect(broker.transactions).toEqual([undefined]);
    expect(broker.waiting(TABLE, 'removals')).toHaveLength(1);
  });

  it('on a broker in the store: the transaction is handed over, and the message is kept on commit', async () => {
    const broker = new FakeBroker();
    const scope = new AtomicScope();
    const { id } = (await published(envWith(broker, scope), TABLE)) as { id: string };
    expect(broker.transactions).toEqual([scope]);
    expect(broker.waiting(TABLE, 'removals')).toEqual([]);
    await scope.settle(true);
    expect(broker.waiting(TABLE, 'removals').map(one => one.id)).toEqual([id]);
  });

  it('on a broker in the store: nothing is left published after a rollback', async () => {
    const broker = new FakeBroker();
    const scope = new AtomicScope();
    await published(envWith(broker, scope), TABLE);
    await scope.settle(false);
    expect(broker.waiting(TABLE, 'removals')).toEqual([]);
  });

  it('on a broker outside the store: refused before the broker keeps anything', async () => {
    const broker = new FakeBroker();
    await expect(published(envWith(broker, new AtomicScope()), JOBS)).rejects.toThrow(
      `'${JOBS}' cannot take part in a transaction: publish after the atomic graph`,
    );
    expect(broker.transactions).toEqual([]);
    expect(broker.waiting(JOBS, 'removals')).toEqual([]);
  });
});

const ENQUEUE = '@features/customers/edge/enqueue.trigger.json';

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** The publishing graph made atomic on the broker in the store, refusing `undone` after it published when the id is "undo". */
function atomicTree() {
  return editing(PUBLISHING, doc => {
    doc.atomic = true;
    doc.nodes[0].in.connection = TABLE;
    doc.out.from = ['queued', 'undone'];
    doc.nodes.push(
      {
        id: 'which',
        type: '@wilanis/node/switch.schema.json',
        in: { id: '{{in.id}}', published: '{{published.id}}' },
        rules: [{ when: "id == 'undo'", to: 'undone' }],
        else: 'queued',
      },
      {
        id: 'undone',
        type: '@wilanis/node/run.schema.json',
        run: '@std/outcome.port.json#refuse',
        in: {
          reason: 'undone',
          message: 'undone after publishing {{published.id}}',
          type: '@features/customers/domain/Queued.shape.json',
        },
      },
    );
  });
}

describe('an atomic graph publishing to a broker in the store, through the runtime', () => {
  it('the tree stands: the transaction takes the publish in, so neither X405 nor L009 refuses it', () => {
    expect(refusals(atomicTree())).toEqual([]);
  });

  it('keeps the message when the graph answers, and leaves none when it refuses after publishing', async () => {
    dir = written(atomicTree());
    const broker = new FakeBroker();
    const plugins = pluginsWith(broker);
    const kept = await runTrigger(loadTree(dir, plugins), ENQUEUE, { flags: { id: 'golf' } }, { log: () => {} });
    expect(kept.report.status).toBe('done');
    expect(broker.waiting(TABLE, 'removals').map(one => one.body)).toEqual([{ id: 'golf' }]);

    const undone = await runTrigger(loadTree(dir, plugins), ENQUEUE, { flags: { id: 'undo' } }, { log: () => {} });
    expect(undone.report.status).toBe('failed');
    expect(broker.transactions).toHaveLength(2);
    expect(broker.transactions.every(one => one !== undefined)).toBe(true);
    expect(broker.waiting(TABLE, 'removals').map(one => one.body)).toEqual([{ id: 'golf' }]);
  });
});
