/**
 * What `describe` and `map` say about a queue (RFC 0009, step 6), over the example's: `jobs.connection.json`, the
 * in-process broker; `remove-queued.trigger.json`, receiving the removals queue on it; and
 * `publish-removal.graph.json`, whose `published` node sends to that queue. Neither end of the queue names the
 * other, so what is claimed is that each is told where the other is -- read off the kind's `connection`, the
 * connection kind's `delivery` and the static inputs of the call, never off a word only @queue knows.
 */
import { rmSync } from 'node:fs';
import { loadTree } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { describe as describeDoc, map } from '../src/index.js';
import { EXAMPLE, INCLUDES, loadedEditing, PLUGINS } from './example-harness.js';

const JOBS = '@connections/jobs.connection.json';
const QUEUED = '@features/customers/edge/remove-queued.trigger.json';
const PUBLISHED = '@features/customers/data/publish-removal.graph.json#published';
const load = loadTree(EXAMPLE, PLUGINS, INCLUDES);
const said = (ref: string) => describeDoc(load, ref).split('\n');

describe('describe: a connection that delivers messages', () => {
  it('says what its kind delivers under the kind, and what that means to what a trigger fires', () => {
    const lines = said(JOBS);
    const at = lines.indexOf('kind  @queue-memory/memory.connection-kind.json');
    expect(at).toBeGreaterThan(-1);
    expect(lines[at + 1]).toBe(
      'delivery  at-least-once -- a message not acknowledged is delivered again, so what it fires may run twice',
    );
  });

  it('lists the triggers receiving from it and the calls sending to it, each paired with its receiver', () => {
    expect(said(JOBS).slice(-4)).toEqual([
      'received by:',
      `    ${QUEUED}  queue "removals", maxAttempts 5, backoffMs 1000`,
      'sent to by (where on it → who receives it):',
      `    ${PUBLISHED}  queue "removals" → ${QUEUED}`,
    ]);
  });

  it('says nothing of delivery on a connection whose kind delivers nothing', () => {
    const lines = said('@connections/customers-api.connection.json');
    expect(lines.some(line => /delivery|received by|sent to by/.test(line))).toBe(false);
  });

  it("says the kind's delivery on the connection kind itself", () => {
    expect(said('@queue-memory/memory.connection-kind.json')).toContain(
      'delivery: at-least-once -- a message not acknowledged is delivered again, so what it fires may run twice',
    );
  });

  it('prints who grants the worker and that its consume holds until stopped', () => {
    const lines = said('@queue/worker.port.json');
    expect(lines).toContain('granted by  @queue  (@wilanis/plugin-queue)');
    expect(lines.some(line => line.startsWith('#consume  (holds until stopped)'))).toBe(true);
  });
});

describe('describe: a queue trigger', () => {
  const lines = said(QUEUED);

  it('prints the connection, the queue, the message type and the outcomes as it prints any settings', () => {
    expect(lines).toContain(`    connection: "${JOBS}"`);
    expect(lines).toContain('    queue: "removals"');
    expect(lines).toContain('    message: "@customers/edge/IdRequest.shape.json"');
    expect(lines).toContain('    outcomes:');
    expect(lines).toContain('        missing: "ack"');
    expect(lines).toContain('        upstream: "retry"');
  });

  it('says what it receives from, what that delivers, and the call whose messages it receives', () => {
    const at = lines.indexOf(`receives from  ${JOBS}, which delivers at-least-once`);
    expect(at).toBeGreaterThan(-1);
    expect(lines[at + 1]).toBe(`sent by  ${PUBLISHED}`);
  });

  it('says nothing of receiving on a trigger whose kind receives from no connection', () => {
    const route = said('@features/customers/edge/enqueue-removal.trigger.json');
    expect(route.some(line => /receives from|sent by/.test(line))).toBe(false);
  });
});

describe('map: a queue', () => {
  const lines = map(load);

  it('names the queue trigger with its connection and queue, and the call whose messages it receives under it', () => {
    const at = lines.findIndex(line => line.startsWith(`${QUEUED}  (@queue/queue.trigger-kind.json)`));
    expect(lines[at]).toBe(
      `${QUEUED}  (@queue/queue.trigger-kind.json)  connection "${JOBS}", queue "removals", maxAttempts 5, backoffMs 1000`,
    );
    expect(lines[at + 1]).toBe(`  sent by ${PUBLISHED}`);
  });

  it('ends the publishing node at the queue and the trigger receiving it, wherever the graph is drawn', () => {
    const sent = `      published @queue/queue.port.json#publish  (effect) → ${JOBS} queue "removals" → ${QUEUED}`;
    // the graph meets enqueueRemoval under every binding of the port, and the map draws it under each
    expect(lines.filter(line => line === sent)).toHaveLength(3);
  });

  it('draws no pairing on a node whose call delivers nothing', () => {
    const deleted = lines.filter(line => line.includes('deleted @http/http.port.json#request'));
    expect(deleted.length).toBeGreaterThan(0);
    expect(deleted.every(line => !line.includes('queue'))).toBe(true);
  });
});

describe('a queue one end of which is in another tree', () => {
  // the graph publishes to a queue no trigger of this tree receives: X403 says nothing, since another tree may
  const { load: elsewhere, dir } = loadedEditing('features/customers/data/publish-removal.graph.json', doc => {
    doc.nodes[0].in.queue = 'audit';
  });
  const lines = (ref: string) => describeDoc(elsewhere, ref).split('\n');

  it('says the call and that no trigger here receives it, on the connection and in the map', () => {
    expect(lines(JOBS)).toContain(
      `    ${PUBLISHED}  queue "audit" → no trigger of this tree -- another tree may receive it`,
    );
    expect(map(elsewhere)).toContain(
      `      published @queue/queue.port.json#publish  (effect) → ${JOBS} queue "audit" → no trigger of this tree -- another tree may receive it`,
    );
  });

  it('says on the trigger that nothing here sends to it, and draws no sender under it in the map', () => {
    expect(lines(QUEUED)).toContain('sent by  nothing in this tree -- another tree may send it');
    expect(map(elsewhere).some(line => line.startsWith('  sent by'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
