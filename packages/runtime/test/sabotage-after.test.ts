/**
 * Sabotage: a node that waits for another without reading it (RFC 0041). A run or a map may name nodes under
 * `after`; it starts only once each has answered, and its operation is not given them. Each entry names another
 * node of the graph that is not a switch (G029), and not one the node already reads (G030). Everything the checker
 * asks about who waits for whom reads `after` too: a cycle through it is a cycle (G007), a node waited for is used
 * (G008), a node that waits for a routed node is routed and one that waits for an effect counts as its reader
 * (G015), and a node that waits for a caught node runs behind the catching switch (G022) and never where its fault
 * goes (G023).
 */
import { describe, expect, it } from 'vitest';
import { sabotage, sabotageHinting, sabotagePointing, sabotageSaying } from './example-harness.js';

const KEPT_GET = 'features/customers/data/kept-get.graph.json';
const KEPT_LIST = 'features/customers/data/kept-list.graph.json';
const PUBLISH = 'features/customers/data/publish-removal.graph.json';
const GET_ROW = 'features/customers/data/get-row.graph.json';
const CUSTOMER = '@customers/domain/Customer.shape.json';
const CUSTOMERS = '@customers/data/customers.store.json';

const run = (id: string, op: string, input: Record<string, unknown>) => ({
  type: '@wilanis/node/run.schema.json',
  id,
  run: op,
  in: input,
});
/** Every tier's latest registration: an effect, since it reads the store, that needs nothing of the customer. */
const everyLatest = run('everyLatest', '@storage/store.port.json#find', { store: CUSTOMERS, collection: 'latest' });
/** The customer with the latest rows beside it: the one reader of `everyLatest`, behind `isKept` through `customer`. */
const card = run('card', '@std/object.port.json#merge', {
  base: '{{customer}}',
  over: { latest: '{{everyLatest}}' },
  type: CUSTOMER,
});

/** The node of a graph document by id. */
const nodeOf = (doc: any, id: string) => doc.nodes.find((node: any) => node.id === id);
/** Have the node `id` wait for `after`. */
const waiting = (id: string, after: string[]) => (doc: any) => {
  nodeOf(doc, id).after = after;
};
/** kept-get answering the card: the customer and every tier's latest, read only where the customer is kept. */
const withCard = (after?: string[]) => (doc: any) => {
  doc.nodes.push(after ? { ...everyLatest, after } : everyLatest, card);
  doc.out.from = ['card', 'noCustomer'];
};

const AT = `@${KEPT_GET}#nodes`;
const AT_ROW = `@${GET_ROW}#nodes`;

describe('G029: after names another node of the graph, and not a switch', () => {
  it('refuses an unknown node, at the entry', () => {
    const edit = waiting('customer', ['nowhere']);
    expect(sabotagePointing(KEPT_GET, edit)).toEqual([`G029 ${AT}/customer/after/0`]);
    expect(sabotageSaying(KEPT_GET, edit)).toEqual(["G029 after names unknown node 'nowhere'"]);
    expect(sabotageHinting(KEPT_GET, edit)).toEqual([
      "G029 name a node of this graph that must answer before 'customer' starts",
    ]);
  });

  it('refuses the node itself, and only once: a wait on itself is no cycle of its own', () => {
    const edit = waiting('customer', ['customer']);
    expect(sabotage(KEPT_GET, edit)).toEqual(['G029']);
    expect(sabotageSaying(KEPT_GET, edit)).toEqual(["G029 'customer' waits for itself"]);
    expect(sabotageHinting(KEPT_GET, edit)).toEqual(["G029 drop 'customer' from its own after"]);
  });

  it('refuses a switch, which answers on every branch', () => {
    const edit = waiting('customer', ['isKept']);
    expect(sabotagePointing(KEPT_GET, edit)).toEqual([`G029 ${AT}/customer/after/0`]);
    expect(sabotageSaying(KEPT_GET, edit)).toEqual(["G029 after names switch 'isKept', which answers on every branch"]);
    // `customer` is the switch's own target, so it waits for the switch already
    expect(sabotageHinting(KEPT_GET, edit)).toEqual([
      "G029 drop 'isKept' from after: 'customer' already runs only where 'isKept' routes to it",
    ]);
  });

  it('names the node the rule routes to, where the waiter is not routed by the switch', () => {
    // and the wait holds nothing back, so the effect still runs on every branch: G015 says the same fix
    expect(sabotageHinting(KEPT_GET, withCard(['isKept']))).toEqual([
      'G029 wait for the node its rule routes to: "after": ["customer"]',
      `G015 route the effect under the branch that reads it: make 'everyLatest' the 'to' of the switch rule that leads to 'card', let it wait for the node that rule routes to ("after": ["customer"]), or read its answer from every branch`,
    ]);
  });
});

describe('G030: after names no node the node already reads', () => {
  it('refuses a node read in in, and says the read', () => {
    const edit = waiting('customer', ['stored']);
    expect(sabotage(KEPT_GET, edit)).toEqual(['G030']);
    expect(sabotagePointing(KEPT_GET, edit)).toEqual([`G030 ${AT}/customer/after/0`]);
    expect(sabotageSaying(KEPT_GET, edit)).toEqual([
      "G030 'customer' already waits for 'stored': it reads {{stored.record}}",
    ]);
    expect(sabotageHinting(KEPT_GET, edit)).toEqual([
      "G030 drop 'stored' from after; a node waits for whatever it reads",
    ]);
  });

  it('does not refuse a node read only through another node', () => {
    // card reads customer, which reads stored: the wait says one edge twice, and the edge is still true
    const edit = (doc: any) => {
      withCard(['customer'])(doc);
      nodeOf(doc, 'card').after = ['stored'];
    };
    expect(sabotage(KEPT_GET, edit)).toEqual([]);
  });
});

describe('G015: an effect that waits for a routed node is routed', () => {
  it('refuses the effect beside the switch, and offers the wait on the node the rule routes to', () => {
    expect(sabotagePointing(KEPT_GET, withCard())).toEqual([`G015 ${AT}/everyLatest`]);
    expect(sabotageHinting(KEPT_GET, withCard())).toEqual([
      `G015 route the effect under the branch that reads it: make 'everyLatest' the 'to' of the switch rule that leads to 'card', let it wait for the node that rule routes to ("after": ["customer"]), or read its answer from every branch`,
    ]);
  });

  it('is silent once the effect waits for that node', () => {
    expect(sabotage(KEPT_GET, withCard(['customer']))).toEqual([]);
  });

  it('counts a node that waits for an effect as its reader', () => {
    // nothing reads everyLatest's answer: customer only waits for it, under one branch
    const edit = (doc: any) => {
      doc.nodes.push(everyLatest);
      nodeOf(doc, 'customer').after = ['everyLatest'];
    };
    expect(sabotageSaying(KEPT_GET, edit)).toEqual([
      "G015 effect 'everyLatest' runs on every branch, but its answer is read only under 'customer'",
    ]);
  });
});

describe('what a routing proves reaches a node that waits for the routed node', () => {
  /** The record made a second time beside the switch, answered in place of `customer`. */
  const copied = (after?: string[]) => (doc: any) => {
    const copy = run('copy', '@std/object.port.json#make', { value: '{{stored.record}}', type: CUSTOMER });
    doc.nodes.push(after ? { ...copy, after } : copy);
    doc.out.from = ['copy', 'noCustomer'];
  };
  it('reads a path the rule proved present as required, once it waits for the node the rule routes to', () => {
    expect(sabotage(KEPT_GET, copied(['customer']))).toEqual([]);
  });
  it('reads it as optional beside the switch, where nothing proved it', () => {
    expect(sabotage(KEPT_GET, copied())).toEqual(['G004', 'G010', 'G008']);
  });
});

describe('G007: a cycle through after is a cycle', () => {
  it('refuses two nodes that wait for each other, and names both', () => {
    const edit = (doc: any) => {
      nodeOf(doc, 'customer').after = ['noCustomer'];
      nodeOf(doc, 'noCustomer').after = ['customer'];
    };
    expect(sabotageSaying(KEPT_GET, edit)).toEqual(['G007 cycle: customer → noCustomer → customer']);
    expect(sabotageHinting(KEPT_GET, edit)).toEqual([
      'G007 break the cycle: a graph is a dataflow, so one of these edges must read or wait for something earlier',
    ]);
  });
});

describe('G008: a node another waits for is used', () => {
  const noted = run('noted', '@std/object.port.json#make', { value: '{{in.id}}', type: 'string' });
  it('refuses a node nothing reads', () => {
    expect(sabotage(PUBLISH, doc => doc.nodes.push(noted))).toEqual(['G008']);
  });
  it('is silent once a node names it under after', () => {
    const edit = (doc: any) => {
      doc.nodes.push(noted);
      nodeOf(doc, 'queued').after = ['noted'];
    };
    expect(sabotage(PUBLISH, edit)).toEqual([]);
  });
  it('lets a map that only keeps wait, and counts what it waits for as used', () => {
    const edit = (doc: any) => {
      doc.nodes.push(
        { ...everyLatest, id: 'latestRows' },
        {
          type: '@wilanis/node/map.schema.json',
          id: 'named',
          over: '{{customers}}',
          where: 'len(item.name) > 0',
          after: ['latestRows'],
        },
      );
      doc.out.from = ['named'];
    };
    expect(sabotage(KEPT_LIST, edit)).toEqual([]);
  });
});

describe('G022 and G023: a node that waits for a caught node', () => {
  it('G022 refuses a waiter beside the catching switch, at its after', () => {
    const edit = (doc: any) => {
      doc.nodes.push({
        ...run('logged', '@std/object.port.json#make', { value: '{{in.id}}', type: 'string' }),
        after: ['fetched'],
      });
      nodeOf(doc, 'noCustomer').in.message = 'no customer {{logged}}';
    };
    expect(sabotagePointing(GET_ROW, edit)).toEqual([`G022 ${AT_ROW}/logged/after`]);
    expect(sabotageSaying(GET_ROW, edit)).toEqual([
      "G022 waits for 'fetched', whose fault 'outcome' catches, but does not run behind 'outcome'",
    ]);
  });
  it('G023 refuses the target of the caught fault waiting for the node that broke, at its after', () => {
    const edit = waiting('unreachable', ['fetched']);
    expect(sabotagePointing(GET_ROW, edit)).toEqual([`G023 ${AT_ROW}/unreachable/after`]);
    expect(sabotageHinting(GET_ROW, edit)).toEqual(["G023 drop 'fetched' from after"]);
  });
});
