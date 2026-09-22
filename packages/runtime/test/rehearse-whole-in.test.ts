/**
 * A rehearsed branch runs the whole of the graph that owns the decision, not only the part the decision reads
 * (#359). The example's `store-and-latest` is reached from two triggers under the local profile: POST /customers,
 * whose draft is the trigger's own input, and the CSV import, which maps `submit` over the drafts a data graph read
 * from the file. Its switch reads only what the store answered. Planting the form the issue shows, a pure node
 * composing the record from the whole of `in` before the write, must leave every branch settling: `in` is a
 * `CustomerRecord`, whose fields are all required, and the same graph answers when it runs for real.
 *
 * What broke was the import's path. To reach the switch at all the walk stubs the list the map runs over with one
 * element, and the node holding that list is a call into a graph, which no stub records a type for; the element
 * was built from nothing, so `in` arrived without a name, and the pure node judged its result wrong.
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTree } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { rehearse } from '../src/index.js';
import { copyOfExample, INCLUDES, PLUGINS } from './example-harness.js';

const GRAPH = 'features/customers/data/store-and-latest.graph.json';

/** The data graph with the record composed by a pure node from `in`, and the write handed that node's answer. */
function composeBeforeTheWrite(dir: string) {
  const path = join(dir, GRAPH);
  const graph = JSON.parse(readFileSync(path, 'utf8'));
  const at = graph.nodes.findIndex((node: { id: string }) => node.id === 'stored');
  graph.nodes.splice(at, 0, {
    type: '@wilanis/node/run.schema.json',
    id: 'made',
    run: '@std/object.port.json#make',
    in: {
      value: {
        id: '{{key}}',
        name: '{{in.name}}',
        email: '{{in.email}}',
        tier: '{{in.tier}}',
        registrar: '{{in.registrar}}',
      },
      type: '@customers/domain/Customer.shape.json',
    },
  });
  graph.nodes[at + 1].in.record = '{{made}}';
  writeFileSync(path, JSON.stringify(graph));
}

describe('a rehearsed data graph', () => {
  it('runs a pure node that reads more of in than its decision does', { timeout: 30_000 }, async () => {
    const dir = copyOfExample();
    composeBeforeTheWrite(dir);
    const run = await rehearse(loadTree(dir, PLUGINS, INCLUDES), { seed: 1, profile: 'local' });
    rmSync(dir, { recursive: true, force: true });
    const head = "features/customers/data/store-and-latest  (atomic)  switch 'bothWritten'  3/3 branches";
    const at = run.lines.indexOf(head);
    expect(at, run.lines.join('\n')).toBeGreaterThanOrEqual(0);
    // every branch settles where its rule points, the node that composes the record from `in` among them
    expect(run.lines.slice(at + 1, at + 4)).toEqual([
      expect.stringMatching(/^ {2}ok {2}when has\(violated\) +refused on purpose at 'repeated' as conflict/),
      expect.stringMatching(/^ {2}ok {2}when has\(record\) && has\(mark\) +answered from 'customer:made'$/),
      expect.stringMatching(/^ {2}ok {2}anything else +refused on purpose at 'nothingWritten' as upstream/),
    ]);
    expect(run.ok).toBe(true);
  });
});
