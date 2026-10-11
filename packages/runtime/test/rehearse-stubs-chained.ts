/**
 * The trees of #869, which `rehearse-stubs.test.ts` rehearses: a map runs over the answer of another map, which the
 * kernel answers element by element, at `made.<index>`, never at `made`. A stub at `made` is one the kernel never
 * reads, so `judge`'s switch is reached only when the list `made` runs over, the trigger's items, holds an element.
 */
import {
  decide,
  edge,
  graph,
  HERE,
  ITEM,
  MAKE,
  make,
  map,
  run,
  STRING,
  shape,
  treeOf,
  trigger,
} from './rehearse-stubs-trees.js';

const PORT = `${HERE}/domain/triage.port.json`;
const VERDICTS = `${shape('Verdict')}[]`;
const MADE = map('made', MAKE, { over: '{{in.items}}', bind: { value: '' }, in: { type: shape('Item') } });
const JUDGED = { over: '', bind: { score: 'score', name: 'name' }, in: {} };

/** What both trees hold: the shapes, `all` and `judge` with the graph of each, the trigger, and what a tree adds. */
function triageOf(all: object[], more: { operations?: object; bindings?: object; docs?: object } = {}): string {
  return treeOf({
    'domain/Item.shape.json': { layer: 'core', fields: ITEM },
    'domain/Verdict.shape.json': { layer: 'core', fields: { name: STRING, level: STRING } },
    'domain/Batch.shape.json': { layer: 'core', fields: { items: { type: `${shape('Item')}[]` } } },
    'edge/ItemIn.shape.json': { layer: 'edge', fields: ITEM },
    'edge/BatchIn.shape.json': { layer: 'edge', fields: { items: { type: `${edge('ItemIn')}[]`, maxItems: 10 } } },
    'edge/Out.shape.json': { layer: 'edge', fields: { name: STRING, level: STRING } },
    'domain/triage.port.json': {
      operations: {
        all: { description: 'd', accepts: { items: { type: `${shape('Item')}[]` } }, returns: VERDICTS },
        judge: { description: 'd', accepts: ITEM, returns: shape('Verdict') },
        ...more.operations,
      },
    },
    'data/triage.binding.json': {
      port: PORT,
      operations: {
        all: { graph: `${HERE}/domain/all.graph.json` },
        judge: { graph: `${HERE}/domain/judge.graph.json` },
        ...more.bindings,
      },
    },
    'domain/all.graph.json': graph('All', shape('Batch'), { type: VERDICTS, from: 'judged' }, all),
    'domain/judge.graph.json': graph('Judge', shape('Item'), { type: shape('Verdict'), from: ['high', 'low'] }, [
      make('facts', { score: '{{in.score}}', name: '{{in.name}}' }, shape('Item')),
      decide('decide', { score: '{{facts.score}}' }, [{ when: 'score > 5', to: 'high' }], 'low'),
      make('high', { name: '{{in.name}}', level: 'high' }, shape('Verdict')),
      make('low', { name: '{{in.name}}', level: 'low' }, shape('Verdict')),
    ]),
    'edge/triage.trigger.json': trigger('triage', { in: edge('BatchIn'), out: `${edge('Out')}[]` }, `${PORT}#all`),
    ...more.docs,
  });
}

/**
 * `all` makes an `Item` of each of the trigger's items with a `map` of `#make`, and judges each made item with a second
 * `map` beside it, so the list the second map runs over is its sibling's answer.
 */
export function chainedTree(): string {
  return triageOf([MADE, map('judged', `${PORT}#judge`, { ...JUDGED, over: '{{made}}' })]);
}

/**
 * The same, one call further out: `all` hands what `made` made to `judgeAll` as `{ list: '{{made}}' }`, and the second
 * `map` runs over `in.list` in that graph. The node holding its list stands in the caller's frame, not in the map's.
 */
export function calledTree(): string {
  const list = { list: { type: `${shape('Item')}[]` } };
  return triageOf([MADE, run('judged', `${PORT}#judgeAll`, { list: '{{made}}' })], {
    operations: { judgeAll: { description: 'd', accepts: list, returns: VERDICTS } },
    bindings: { judgeAll: { graph: `${HERE}/domain/judge-all.graph.json` } },
    docs: {
      'domain/List.shape.json': { layer: 'core', fields: list },
      'domain/judge-all.graph.json': graph('JudgeAll', shape('List'), { type: VERDICTS, from: 'judged' }, [
        map('judged', `${PORT}#judge`, { ...JUDGED, over: '{{in.list}}' }),
      ]),
    },
  });
}
