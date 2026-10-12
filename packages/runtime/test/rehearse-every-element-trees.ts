/**
 * The small trees `rehearse-every-element.test.ts` rehearses (#1003): a list of customers whose every element a rule on
 * `Customer` judges, the list held by a node or handed in by the trigger. A switch on the trigger's `mode` is what is
 * rehearsed; the guard on the list is one of the other decisions `answering` steers so the run gets there. Every tree
 * passes the checker, since a case about the walk must stand on a tree that does.
 */
import { edge, graph, HERE, MAKE, map, run, STRING, shape, treeOf, trigger } from './rehearse-stubs-trees.js';

/** What a customer holds, and what a row the trigger hands holds: the same fields under another shape. */
const FIELDS = { name: STRING, email: STRING };

/**
 * Where the list a rule judges element by element comes from: a node of the graph, which makes it a list of `Customer`
 * (a made site of arity list, guarded by a map over `customers:made`); or the trigger's input, which a map hands one
 * row at a time to a data graph that takes a `Customer` (a taken site, guarded at `in:check` for each element).
 */
export type Held = 'node' | 'input';

/**
 * `list` decides on the trigger's `mode`, and answers the customers either way. `rule` is the invariant on `Customer`:
 * by default every email holds an `@`, which a generated email never does, so an element the rehearsal did not steer
 * breaks it.
 */
export function everyElementTree(held: Held, rule = "email contains '@'"): string {
  const port = `${HERE}/domain/customers.port.json`;
  const customers = `${shape('Customer')}[]`;
  const asked = { mode: STRING, list: { type: `${shape('Row')}[]` } };
  const answer = held === 'node' ? '{{customers}}' : '{{kept}}';
  const listed =
    held === 'node'
      ? run('customers', MAKE, { value: '{{in.list}}', type: customers })
      : map('kept', `${port}#keep`, { over: '{{in.list}}', bind: { name: 'name', email: 'email' }, in: {} });
  return treeOf({
    'domain/Customer.shape.json': { layer: 'core', fields: FIELDS },
    'domain/Row.shape.json': { layer: 'core', fields: FIELDS },
    'domain/Ask.shape.json': { layer: 'core', fields: asked },
    'domain/a-customer-is-reachable.invariant.json': {
      label: 'A customer is reachable',
      holds: { on: shape('Customer'), when: rule },
    },
    'edge/RowIn.shape.json': { layer: 'edge', fields: FIELDS },
    'edge/AskIn.shape.json': {
      layer: 'edge',
      fields: { mode: STRING, list: { type: `${edge('RowIn')}[]`, maxItems: 10 } },
    },
    'edge/Out.shape.json': { layer: 'edge', fields: FIELDS },
    'domain/customers.port.json': {
      operations: {
        list: { description: 'd', accepts: asked, returns: customers },
        keep: { description: 'd', accepts: FIELDS, returns: shape('Customer') },
      },
    },
    'data/customers.binding.json': {
      port,
      operations: {
        list: { graph: `${HERE}/domain/list.graph.json` },
        keep: { graph: `${HERE}/data/keep.graph.json` },
      },
    },
    'domain/list.graph.json': graph('List', shape('Ask'), { type: customers, from: ['loudly', 'quietly'] }, [
      listed,
      {
        type: '@wilanis/node/switch.schema.json',
        id: 'loud',
        in: { mode: '{{in.mode}}' },
        rules: [{ when: "mode == 'loud'", to: 'loudly' }],
        else: 'quietly',
      },
      run('loudly', MAKE, { value: answer, type: customers }),
      run('quietly', MAKE, { value: answer, type: customers }),
    ]),
    'data/keep.graph.json': graph('Keep', shape('Customer'), { type: shape('Customer'), from: 'kept' }, [
      run('kept', MAKE, { value: { name: '{{in.name}}', email: '{{in.email}}' }, type: shape('Customer') }),
    ]),
    'edge/list.trigger.json': trigger('list', { in: edge('AskIn'), out: `${edge('Out')}[]` }, `${port}#list`),
  });
}
