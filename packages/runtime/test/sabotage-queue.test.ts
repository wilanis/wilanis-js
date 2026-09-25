/**
 * The example's queue (RFC 0009), broken one way at a time. `enqueue-removal.trigger.json` publishes through
 * `publish-removal.graph.json` onto the removals queue of `jobs.connection.json`, and `remove-queued.trigger.json`
 * consumes it, firing `customer.port.json#remove` under the same policies as DELETE /customers/{id}. Each case
 * says the tree is judged where it stands: @queue's own band against the example, and the rules a queue trigger
 * and a publishing graph share with a route and an effect, which the compiler already had. The plugin's own unit
 * cases live in `packages/plugin-queue/test/rules.test.ts`; these say the example proves them too.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codes, EXAMPLE, planted, relocate, sabotage, sabotagePointing } from './example-harness.js';

const QUEUED = 'features/customers/edge/remove-queued.trigger.json';
const PUBLISH = 'features/customers/data/publish-removal.graph.json';
const PUBLISHING = '@queue/queue.port.json#publish';
const CONSUME = '@queue/worker.port.json#consume';
const queued = JSON.parse(readFileSync(join(EXAMPLE, QUEUED), 'utf8'));

describe('sabotage: the example queue (RFC 0009)', () => {
  it('checks clean as written', () => {
    expect(codes(EXAMPLE)).toEqual([]);
  });

  it('X401 an outcome that is not ack, retry or dead, and a maxAttempts below one', () => {
    expect(
      sabotage(QUEUED, trigger => {
        trigger.settings.outcomes.upstream = 'later';
      }),
    ).toEqual(['X401']);
    expect(
      sabotage(QUEUED, trigger => {
        trigger.settings.maxAttempts = 0;
      }),
    ).toEqual(['X401']);
  });

  it('X403 a publish of a shape the consuming trigger does not accept', () => {
    expect(
      sabotagePointing(PUBLISH, graph => {
        graph.nodes[0].in.type = '@customers/edge/DeleteRequest.shape.json';
        graph.nodes[0].in.message = { ids: ['{{in.id}}'] };
      }),
    ).toEqual([`X403 @${PUBLISH}#nodes/published/in/type`]);
  });

  it('X404 a message that carries a blob', () => {
    expect(
      sabotage(QUEUED, trigger => {
        trigger.settings.message = '@customers/edge/CsvUpload.shape.json';
      }),
    ).toContain('X404');
  });

  it('X406 a second trigger receiving from the removals queue', () => {
    expect(planted('features/customers/edge/remove-queued-again.trigger.json', queued)).toContain('X406');
  });

  it('T005 a reason the run can reach that the outcomes do not map', () => {
    expect(
      sabotage(QUEUED, trigger => {
        delete trigger.settings.outcomes.missing;
      }),
    ).toEqual(['T005']);
  });

  it('L003 publishing from a feature that does not list it under effects', () => {
    expect(
      sabotage('features/customers/feature.json', feature => {
        feature.effects = feature.effects.filter((one: string) => one !== PUBLISHING);
      }),
    ).toEqual(['L003']);
  });

  it('L008 a graph that runs the worker', () => {
    expect(
      sabotage(PUBLISH, graph => {
        graph.nodes[0].run = CONSUME;
        graph.nodes[0].in = {};
      }),
    ).toContain('L008');
  });

  it('B006 a startup step naming publish, which holds nothing', () => {
    expect(
      sabotage('project.json', project => {
        project.startup.find((step: { run: string }) => step.run === CONSUME).run = PUBLISHING;
      }),
    ).toContain('B006');
  });

  it('D008 the queue trigger outside edge/', () => {
    expect(relocate(QUEUED, 'features/customers/domain/remove-queued.trigger.json')).toContain('D008');
  });
});
