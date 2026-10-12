/**
 * What the viewer draws of a map that only keeps (RFC 0039, step 2). The example's digest keeps the active
 * customers with a map that says `where` and runs nothing: its node names no operation, answers the type of the
 * list it keeps, and the count that reads it is wired to it as to any node. How the page marks a keep is step 4's.
 */
import { fileURLToPath } from 'node:url';
import { loadProject } from '@wilanis/runtime';
import { describe, expect, it } from 'vitest';
import { viewOf } from '../src/index.js';

const EXAMPLE = fileURLToPath(new URL('../../../example', import.meta.url));
const DIGEST = '@features/customers/domain/digest.graph.json';

describe('a map that only keeps', () => {
  it('names no operation and answers the type of its over', async () => {
    const graph = viewOf(await loadProject(EXAMPLE), DIGEST)?.graph;
    const active = graph?.nodes.find(node => node.id === 'active');
    expect(active).toMatchObject({
      kind: 'map',
      outputs: [{ type: '@features/customers/domain/Customer.shape.json[]' }],
    });
    expect(active?.op).toBeUndefined();
    expect(active?.target).toBeUndefined();
    const read = graph?.edges.find(edge => edge.from === 'active' && edge.to === 'activeCount');
    expect(read).toMatchObject({ kind: 'data', toPort: 'list' });
  });
});
