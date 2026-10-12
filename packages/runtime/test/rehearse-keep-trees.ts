/**
 * The small tree the keep tests rehearse (#1026, #1027): a list read through a port, a keep over it, and a switch on
 * what the keep answers. Built with `rehearse-stubs-trees.ts`'s helpers, and passing the checker.
 */
import { decide, edge, graph, HERE, ITEM, make, NUMBER, run, shape, treeOf, trigger } from './rehearse-stubs-trees.js';
import { SOURCE } from './source-plugin.js';

/**
 * `page` reads a list of items through a port, keeps those with a positive score, and counts them when it kept any.
 * The switch reads the keep's answer, which the rehearsal steers through the list the keep runs over (#1027). The
 * list comes from the trigger's input, through a data graph that copies it; with `source`, that data graph reads it
 * through `@source` instead, one effect under a `make`, as a tree reads from the world.
 */
export function keptTree(opts: { source?: boolean } = {}): string {
  const port = `${HERE}/domain/items.port.json`;
  const items = `${shape('Item')}[]`;
  return treeOf(
    {
      'domain/Item.shape.json': { layer: 'core', fields: ITEM },
      'domain/Ask.shape.json': { layer: 'core', fields: { list: { type: items } } },
      'domain/Count.shape.json': { layer: 'core', fields: { count: NUMBER } },
      'edge/ItemIn.shape.json': { layer: 'edge', fields: ITEM },
      'edge/AskIn.shape.json': { layer: 'edge', fields: { list: { type: `${edge('ItemIn')}[]`, maxItems: 10 } } },
      'edge/Out.shape.json': { layer: 'edge', fields: { count: NUMBER } },
      'domain/items.port.json': {
        operations: {
          page: {
            description: 'd',
            ...(opts.source ? {} : { accepts: { list: { type: items } } }),
            returns: shape('Count'),
            refuses: true,
          },
          read: { description: 'd', ...(opts.source ? {} : { accepts: { list: { type: items } } }), returns: items },
        },
      },
      'data/items.binding.json': {
        port,
        operations: {
          page: { graph: `${HERE}/domain/page.graph.json` },
          read: { graph: `${HERE}/data/read.graph.json` },
        },
      },
      'data/read.graph.json': graph('Read', opts.source ? undefined : shape('Ask'), { type: items, from: 'r' }, [
        ...(opts.source ? [run('fetched', SOURCE, { type: items })] : []),
        make('r', opts.source ? '{{fetched}}' : '{{in.list}}', items),
      ]),
      'domain/page.graph.json': graph(
        'Page',
        opts.source ? undefined : shape('Ask'),
        { type: shape('Count'), from: ['counted', 'none'] },
        [
          run('got', `${port}#read`, opts.source ? {} : { list: '{{in.list}}' }),
          { type: '@wilanis/node/map.schema.json', id: 'kept', over: '{{got}}', where: 'item.score > 0' },
          decide('any', { kept: '{{kept}}' }, [{ when: 'len(kept) > 0', to: 'n' }], 'none'),
          run('n', '@std/list.port.json#count', { list: '{{kept}}' }),
          make('counted', { count: '{{n}}' }, shape('Count')),
          run('none', '@std/outcome.port.json#refuse', { reason: 'empty', message: 'empty', type: shape('Count') }),
        ],
      ),
      'edge/page.trigger.json': trigger(
        'page',
        { in: opts.source ? undefined : edge('AskIn'), out: edge('Out') },
        `${port}#page`,
      ),
    },
    opts,
  );
}
