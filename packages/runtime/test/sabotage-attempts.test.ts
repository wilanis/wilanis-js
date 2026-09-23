/**
 * What a retry is written over (RFC 0011). A port operation's words about repeating it fit the operation (C015);
 * a domain graph never says how often or how long (L012); and a data graph's node or a binding's operation that
 * retries is held to what it repeats: never a pure call or a graph with no effect (G017), never a call that is
 * not idempotent where it is made (G018), and a `when` that reads the answer as a boolean (G019). Below an
 * atomic graph nothing retries at all (G020): the retry that works is on the binding operation that runs the
 * graph, whose every try is a transaction of its own. The cases break the example's own documents, since the
 * guide's retry is written over get-row's GET and store-and-latest and register-all already say atomic.
 */
import http from '@wilanis/plugin-http';
import { describe, expect, it } from 'vitest';
import { sabotage, sabotagePointing, sabotageSaying, withBrokenPluginDoc } from './example-harness.js';

describe('sabotage: what a retry is written over (RFC 0011)', () => {
  const getRow = 'features/customers/data/get-row.graph.json';
  const rest = 'features/customers/data/customers-rest.binding.json';
  /** An edit that writes `words` onto node `id` of a graph. */
  const onNode = (id: string, words: object) => (graph: any) => {
    Object.assign(
      graph.nodes.find((node: any) => node.id === id),
      words,
    );
  };
  /** An edit that writes `words` onto operation `op` of a binding. */
  const onOperation = (op: string, words: object) => (binding: any) => {
    Object.assign(binding.operations[op], words);
  };
  const once = { retry: { times: 1 } };

  it('C015 a native operation whose key is not a field, that says idempotent and key, or whose idempotent is not boolean', () => {
    const broken = (edit: (op: any) => void) =>
      withBrokenPluginDoc(http, 'http.port.json', doc => edit(doc.operations.request)).at.filter(at =>
        at.includes('@http/http.port.json'),
      );
    const keyed = broken(op => {
      delete op.idempotent;
      op.key = 'nope';
    });
    expect(keyed).toEqual(['C015 @http/http.port.json#operations/request/key']);
    const both = broken(op => {
      op.idempotent = true;
      op.key = 'method';
    });
    expect(both).toEqual(['C015 @http/http.port.json#operations/request']);
    const number = broken(op => {
      op.idempotent = 'method';
    });
    expect(number).toEqual(['C015 @http/http.port.json#operations/request/idempotent']);
  });
  it('C015 a domain operation that names a key, or promises idempotent only under an expression', () => {
    const port = 'features/customers/domain/customer.port.json';
    const keyed = sabotagePointing(port, doc => {
      doc.operations.get.key = 'id';
    });
    expect(keyed).toEqual([`C015 @${port}#operations/get/key`]);
    const when = sabotage(port, doc => {
      doc.operations.get.idempotent = "id != ''";
    });
    expect(when).toEqual(['C015']);
  });
  it('L012 a domain graph that retries a call or bounds one', () => {
    const register = 'features/customers/domain/register-customer.graph.json';
    expect(sabotagePointing(register, onNode('registered', once))).toEqual([
      `L012 @${register}#nodes/registered/retry`,
    ]);
    const imports = 'features/customers/domain/import-customers.graph.json';
    expect(sabotagePointing(imports, onNode('drafts', { timeoutMs: 100 }))).toEqual([
      `L012 @${imports}#nodes/drafts/timeoutMs`,
    ]);
    expect(sabotage(imports, onNode('drafts', { timeoutMs: 100, ...once }))).toEqual(['L012', 'L012']);
  });
  it('G017 a retry over a pure operation, or over a binding whose graph reaches no effect', () => {
    expect(sabotagePointing(getRow, onNode('customer', once))).toEqual([`G017 @${getRow}#nodes/customer/retry`]);
    // the greeting is filled and made by pure nodes alone: nothing in it can fail transiently
    expect(sabotage('features/hello/data/greeting.binding.json', onOperation('hello', once))).toEqual(['G017']);
  });
  it('G018 a retry over a POST, over a method read rather than written, and over a binding whose graph POSTs', () => {
    const request = `'@http/http.port.json#request', which is not idempotent here`;
    expect(sabotageSaying('features/customers/data/create-row.graph.json', onNode('posted', once))).toEqual([
      `G018 retry over ${request}: method is "POST"`,
    ]);
    const read = sabotageSaying('features/customers/data/update-row.graph.json', graph => {
      onNode('updated', once)(graph);
      graph.nodes.find((node: any) => node.id === 'updated').in.method = '{{in.tier}}';
    });
    // method is static, so P001 refuses the read as well; G018 says why the retry cannot be judged
    expect(read).toContain(`G018 retry over ${request}: method is read from {{in.tier}}; write it as a literal`);
    expect(read.map(line => line.slice(0, 4)).sort()).toEqual(['G018', 'P001']);
    const createRow = '@features/customers/data/create-row.graph.json';
    expect(sabotageSaying(rest, onOperation('register', once))).toEqual([
      `G018 retry over '${createRow}', whose 'posted' runs ${request}: method is "POST"`,
    ]);
    // a domain graph reaches its effects through the profile's bindings, so the refusal names the node's
    // graph and the profile
    expect(sabotageSaying(rest, onOperation('submit', once))).toEqual([
      `G018 retry over '@features/customers/domain/register-customer.graph.json', whose 'posted' in ${createRow} runs ${request}: method is "POST" (profile 'live')`,
    ]);
  });
  it('G019 a retry whose when is not boolean over the answer, or whose answer is not an object', () => {
    expect(sabotagePointing(getRow, onNode('fetched', { retry: { times: 1, when: 'status' } }))).toEqual([
      `G019 @${getRow}#nodes/fetched/retry/when`,
    ]);
    // write-csv answers a blob; its write puts a new handle in the registry each time, so G018 refuses it too
    const csv = { retry: { times: 1, when: 'has(x)' } };
    expect(sabotagePointing(rest, onOperation('toCsv', csv))).toContain(`G019 @${rest}#operations/toCsv/retry/when`);
    expect(sabotage(rest, onOperation('toCsv', csv))).toEqual(['G018', 'G019']);
  });
  describe('G020 a retry below an atomic graph', () => {
    const kept = 'features/customers/data/store-and-latest.graph.json';
    const store = 'features/customers/data/customers-store.binding.json';
    const recordAll = '@features/customers/domain/register-all.graph.json';
    const inside = (graph: string) => `retries inside the transaction of atomic graph '${graph}'`;
    const g020 = (said: string[]) => said.filter(line => line.startsWith('G020'));

    it('refuses a node of the atomic graph itself, and says so for each atomic graph that reaches it', () => {
      // store-and-latest is atomic, and register-all reaches it under local through submit and register
      const broken = sabotageSaying(kept, onNode('stored', once));
      expect(g020(broken)).toEqual([
        `G020 node 'stored' ${inside(`@${kept}`)}`,
        `G020 node 'stored' ${inside(recordAll)} (profile 'local')`,
      ]);
      expect(g020(sabotagePointing(kept, onNode('stored', once)))).toEqual([
        `G020 @${kept}#nodes/stored/retry`,
        `G020 @${kept}#nodes/stored/retry`,
      ]);
    });
    it('refuses a node of a graph an atomic graph reaches, though that graph is not atomic itself', () => {
      const broken = sabotageSaying(kept, graph => {
        delete graph.atomic;
        onNode('stored', once)(graph);
      });
      expect(g020(broken)).toEqual([`G020 node 'stored' ${inside(recordAll)} (profile 'local')`]);
    });
    it('refuses a binding operation reached inside the transaction, which would join it', () => {
      // register runs store-and-latest, which is right on its own, and wrong once register-all is the caller
      expect(sabotagePointing(store, onOperation('register', once))).toEqual([
        `G020 @${store}#operations/register/retry`,
      ]);
      expect(g020(sabotageSaying(store, onOperation('submit', once)))).toEqual([
        `G020 operation 'submit' ${inside(recordAll)} (profile 'local')`,
      ]);
    });
    it('accepts the retry the hint names: on the binding operation that runs the atomic graph', () => {
      // each try is a transaction of its own and a failed one rolled back, so what it repeats is not G018's
      expect(sabotage(store, onOperation('registerAll', once))).toEqual([]);
    });
  });
  it("accepts the guide's retry over a GET, and a binding operation whose graph only GETs", () => {
    const guide = { timeoutMs: 5000, retry: { times: 2, backoffMs: 200, when: 'status >= 500' } };
    expect(sabotage(getRow, onNode('fetched', guide))).toEqual([]);
    expect(sabotage(rest, onOperation('listAll', { retry: { times: 1 }, timeoutMs: 8000 }))).toEqual([]);
  });
});
