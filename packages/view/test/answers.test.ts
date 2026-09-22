/**
 * How a refusal is answered, as the viewer shows it: every reason a trigger can reach with the node that
 * refuses with it and the answer its kind maps, and, read the other way, every trigger that reaches one
 * refusing node. It is one question asked from both ends, which is why it is one file.
 *
 * A guard the compiler lowers is among the reasons (RFC 0007): no node of the document writes `invariant`
 * down, and the viewer names the site the guard stands at exactly as it names a refusal an author wrote.
 */
import { fileURLToPath } from 'node:url';
import { loadProject } from '@wilanis/runtime';
import { describe, expect, it } from 'vitest';
import { type DocView, viewOf } from '../src/index.js';

const EXAMPLE = fileURLToPath(new URL('../../../example', import.meta.url));
const GET_ROW = '@features/customers/data/get-row.graph.json';

const view = async (path: string): Promise<DocView> => {
  const seen = viewOf(await loadProject(EXAMPLE), path);
  if (!seen) throw new Error(`no view for ${path}`);
  return seen;
};

describe('how the viewer says a refusal is answered', () => {
  it('says how a trigger answers each refusal it can reach, and which node refuses with it', async () => {
    const seen = await view('@features/customers/edge/get-customer.trigger.json');
    expect(seen.answers).toEqual([
      // one reason, refused in every binding's graphs: the viewer names each, since which one runs is the
      // profile's choice and a reader of the route wants to see every place the answer can come from
      {
        reason: 'missing',
        answer: 404,
        from: [
          { graph: GET_ROW, graphLabel: 'Get a row', node: 'missing', nodeLabel: 'No such customer' },
          {
            graph: '@features/customers/data/kept-get.graph.json',
            graphLabel: 'Get what is kept',
            node: 'missing',
            nodeLabel: 'No such customer',
          },
          {
            graph: '@features/customers/data/kept-get-postgres.graph.json',
            graphLabel: 'Get what is kept',
            node: 'missing',
            nodeLabel: 'No such customer',
          },
        ],
      },
      {
        reason: 'upstream',
        answer: 502,
        from: [{ graph: GET_ROW, graphLabel: 'Get a row', node: 'failed', nodeLabel: 'Unexpected answer' }],
      },
      // no node writes this one down: it is the guard the compiler lowers where the field invariant could not
      // be proved of the customer `row` makes, and the viewer names the site it stands at like any other refusal
      {
        reason: 'invariant',
        answer: 500,
        from: [
          {
            graph: '@features/customers/data/kept-get.graph.json',
            graphLabel: 'Get what is kept',
            node: 'row',
            nodeLabel: 'The record',
          },
          {
            graph: '@features/customers/data/kept-get-postgres.graph.json',
            graphLabel: 'Get what is kept',
            node: 'row',
            nodeLabel: 'The record',
          },
        ],
      },
    ]);
    // reached through a domain graph and a map: the batch delete refuses where delete-row does
    const batch = await view('@features/customers/edge/delete-customers.trigger.json');
    expect(batch.answers!.find(answer => answer.reason === 'missing')).toMatchObject({
      answer: 404,
      from: [
        { graph: '@features/customers/data/delete-row.graph.json', node: 'missing' },
        { graph: '@features/customers/data/kept-remove.graph.json', node: 'missing' },
        { graph: '@features/customers/data/kept-remove-postgres.graph.json', node: 'missing' },
      ],
    });
    // a kind that maps no refusals has nothing to say here
    expect((await view('@features/customers/edge/digest.trigger.json')).answers).toBeUndefined();
  });
  it('tells a refusing node which triggers reach it and how each answers its reason', async () => {
    const missing = (await view(GET_ROW)).graph!.nodes.find(node => node.id === 'missing')!;
    expect(missing.target?.refuses).toBe(true);
    expect(missing.answeredBy).toEqual([
      {
        trigger: '@features/customers/edge/get-customer.trigger.json',
        triggerLabel: 'GET /customers/{id}',
        maps: true,
        answer: 404,
      },
    ]);
    // list-rows is reached by the http listing, which maps the reason, and by the cli digest, whose kind answers every refusal alike
    const failed = (await view('@features/customers/data/list-rows.graph.json')).graph!.nodes.find(
      node => node.id === 'failed',
    )!;
    expect(failed.answeredBy).toEqual(
      expect.arrayContaining([
        {
          trigger: '@features/customers/edge/list-customers.trigger.json',
          triggerLabel: 'GET /customers',
          maps: true,
          answer: 502,
        },
        { trigger: '@features/customers/edge/digest.trigger.json', triggerLabel: 'digest', maps: false },
      ]),
    );
    // a node that answers has no such list
    expect((await view(GET_ROW)).graph!.nodes.find(node => node.id === 'row')?.answeredBy).toBeUndefined();
  });
});
