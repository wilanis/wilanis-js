/**
 * Sabotage: what a switch's `catch` may say (RFC 0014). The example's `get-row` is given the guide's catch -- the
 * API answering nothing at all routes to a refusal of `upstream`, which the trigger already maps -- and checks
 * clean; each case then breaks one thing about it. A caught node is one the switch reads and caught by it alone,
 * routed to another node of the graph (G021); it is an effect, since nothing else breaks but a bug (G024); whatever
 * else reads it runs behind the switch (G022); and nothing behind where its fault goes reads it (G023). Only a data
 * graph catches (L013), and no catch names a node a guard the compiler lowers moves aside (G025). The lowering
 * carries the catch to the kernel's switch as written.
 */
import { rmSync } from 'node:fs';
import { Compiler } from '@wilanis/compiler';
import { type PluginModule, Scope } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { loadedEditing, PLUGINS, sabotage, sabotageHinting, sabotagePointing } from './example-harness.js';

const GET_ROW = 'features/customers/data/get-row.graph.json';
const LIST = 'features/customers/domain/list-customers.graph.json';
const CUSTOMER = '@customers/domain/Customer.shape.json';

const run = (id: string, op: string, input: Record<string, unknown>) => ({
  type: '@wilanis/node/run.schema.json',
  id,
  run: op,
  in: input,
});
const refuse = (id: string, message: string) =>
  run(id, '@std/outcome.port.json#refuse', { reason: 'upstream', message, type: CUSTOMER });
const make = (id: string, value: unknown, type: string) => run(id, '@std/object.port.json#make', { value, type });

/** The node of a graph document by id. */
const nodeOf = (doc: any, id: string) => doc.nodes.find((node: any) => node.id === id);

/** The guide's catch on get-row: `fetched` breaking routes to `unreachable`, which refuses upstream. */
function caught(doc: any, catches: Record<string, string> = { fetched: 'unreachable' }): void {
  doc.nodes.push(refuse('unreachable', 'the customer API could not be reached'));
  doc.out.from.push('unreachable');
  nodeOf(doc, 'outcome').catch = catches;
}

describe('a switch that catches a fault', () => {
  it('checks clean as the guide writes it: the target refuses a reason the trigger maps, and joins out.from', () => {
    expect(sabotage(GET_ROW, doc => caught(doc))).toEqual([]);
  });
  it('lowers onto the kernel switch as written', () => {
    const { load, dir } = loadedEditing(GET_ROW, doc => caught(doc));
    const modules = Object.values(PLUGINS) as PluginModule[];
    const spec = new Compiler(new Scope(load.registry, load.resolve), modules).graph(`@${GET_ROW}`).spec;
    rmSync(dir, { recursive: true, force: true });
    expect(spec.nodes.outcome).toMatchObject({ kind: 'switch', catch: { fetched: 'unreachable' } });
    expect(spec.nodes.fetched).not.toHaveProperty('catch');
  });
});

describe('G021: a catch names a node the switch reads, and routes it to another node of the graph', () => {
  const at = '@features/customers/data/get-row.graph.json#nodes/outcome/catch';
  it('refuses a caught node that is not a node, is the switch, or is not read by it', () => {
    expect(sabotagePointing(GET_ROW, doc => caught(doc, { nope: 'unreachable' }))).toEqual([`G021 ${at}/nope`]);
    expect(sabotagePointing(GET_ROW, doc => caught(doc, { outcome: 'unreachable' }))).toEqual([`G021 ${at}/outcome`]);
    // `customer` is a node of the graph, routed by the switch, and read by none of its in
    expect(sabotagePointing(GET_ROW, doc => caught(doc, { customer: 'unreachable' }))).toEqual([`G021 ${at}/customer`]);
  });
  it('refuses a fault routed to no node, to the node that broke, or to the switch', () => {
    // `unreachable` is then routed by nothing, so out.from is refused for naming it (G010)
    expect(sabotage(GET_ROW, doc => caught(doc, { fetched: 'nope' }))).toEqual(['G021', 'G010']);
    expect(sabotage(GET_ROW, doc => caught(doc, { fetched: 'fetched' }))).toEqual(['G021', 'G010']);
    expect(sabotage(GET_ROW, doc => caught(doc, { fetched: 'outcome' }))).toEqual(['G021', 'G010']);
  });
  it('refuses a node caught by two switches', () => {
    const twice = (doc: any) => {
      caught(doc);
      doc.nodes.push(refuse('gone', 'the customer API is gone'), {
        type: '@wilanis/node/switch.schema.json',
        id: 'later',
        in: { status: '{{fetched.status}}' },
        rules: [{ when: 'status == 1', to: 'gone' }],
        else: 'gone',
        catch: { fetched: 'gone' },
      });
      doc.out.from.push('gone');
    };
    // the second catch is the one refused; the switch it sits in is not also refused as a reader beside the first
    expect(sabotagePointing(GET_ROW, twice)).toEqual([`G021 @${GET_ROW}#nodes/later/catch/fetched`]);
    expect(sabotageHinting(GET_ROW, twice)).toEqual([
      'G021 catch names a node this switch reads and routes its fault to a node of this graph, e.g. "catch": { "asked": "unreachable" }',
    ]);
  });
});

describe('G024: only an effect is caught', () => {
  const hint = 'nothing here breaks but a bug, which rehearse reports as BROKE; delete catch';
  it('refuses catching a pure operation', () => {
    const pure = (doc: any) => {
      doc.nodes.push(make('status', '{{fetched.status}}', 'number'));
      nodeOf(doc, 'outcome').in.status = '{{status}}';
      caught(doc, { status: 'unreachable' });
    };
    expect(sabotageHinting(GET_ROW, pure)).toEqual([`G024 ${hint}`]);
  });
  it('refuses catching a node that refuses on purpose: a refusal is never caught', () => {
    const refusing = (doc: any) => {
      doc.nodes.push(refuse('early', 'no'));
      nodeOf(doc, 'outcome').in.early = '{{early}}';
      caught(doc, { early: 'unreachable' });
    };
    expect(sabotage(GET_ROW, refusing)).toEqual(['G024']);
  });
});

describe('G022: whatever else reads a caught node runs behind the switch', () => {
  it('refuses a reader beside the switch, which would wait on a node that broke', () => {
    const beside = (doc: any) => {
      caught(doc);
      doc.nodes.push(make('logged', '{{fetched.status}}', 'number'));
      nodeOf(doc, 'upstreamFailed').in.message = 'the customer API answered {{logged}}';
    };
    expect(sabotage(GET_ROW, beside)).toEqual(['G022']);
    expect(sabotagePointing(GET_ROW, beside)).toEqual([`G022 @${GET_ROW}#nodes/logged/in`]);
  });
});

describe('G023: nothing behind where a fault goes reads the node that broke', () => {
  it('refuses the target reading it, at the value that does', () => {
    const reads = (doc: any) => {
      caught(doc);
      nodeOf(doc, 'unreachable').in.message = 'the API said {{fetched.status}}';
    };
    expect(sabotage(GET_ROW, reads)).toEqual(['G023']);
    expect(sabotagePointing(GET_ROW, reads)).toEqual([`G023 @${GET_ROW}#nodes/unreachable/in/message`]);
    expect(sabotageHinting(GET_ROW, reads)).toEqual([
      'G023 say it without the value; the report and the trace carry what fetched threw',
    ]);
  });
  it('refuses a node behind the target reading it', () => {
    const behind = (doc: any) => {
      caught(doc, { fetched: 'why' });
      doc.nodes.push(make('why', 'down', 'string'));
      nodeOf(doc, 'unreachable').in.message = '{{why}}: {{fetched.status}}';
    };
    expect(sabotagePointing(GET_ROW, behind)).toEqual([`G023 @${GET_ROW}#nodes/unreachable/in/message`]);
  });
});

describe('L013: only a data graph catches', () => {
  it("refuses a domain graph's switch that declares catch, and judges nothing more of it", () => {
    const domain = (doc: any) => {
      nodeOf(doc, 'tierGiven').catch = { byTier: 'all' };
    };
    expect(sabotage(LIST, domain)).toEqual(['L013']);
    expect(sabotagePointing(LIST, domain)).toEqual([`L013 @${LIST}#nodes/tierGiven/catch`]);
  });
});

describe('G025: a catch of a node a guard moves aside', () => {
  const Kept = 'features/customers/data/kept-list.graph.json';
  /** kept-list's `customers` caught: it is a made site of the customer invariant, so the compiler guards it. */
  const guarded = (doc: any) => {
    doc.nodes.push(
      {
        type: '@wilanis/node/switch.schema.json',
        id: 'anyKept',
        in: { list: '{{customers}}' },
        rules: [{ when: 'len(list) >= 0', to: 'kept' }],
        else: 'kept',
        catch: { customers: 'unreachable' },
      },
      make('kept', '{{customers}}', `${CUSTOMER}[]`),
      run('unreachable', '@std/outcome.port.json#refuse', {
        reason: 'upstream',
        message: 'the store could not be read',
        type: `${CUSTOMER}[]`,
      }),
    );
    doc.out.from = ['kept', 'unreachable'];
  };
  it('refuses it, where the catch names the node', () => {
    expect(sabotage(Kept, guarded)).toEqual(['G025']);
    expect(sabotagePointing(Kept, guarded)).toEqual([`G025 @${Kept}#nodes/anyKept/catch/customers`]);
    expect(sabotageHinting(Kept, guarded)).toEqual([
      "G025 catch a node the invariant is not checked at, or prove the rule where 'customers' is made, so no guard is lowered there",
    ]);
  });
  it('because the lowering moves the effect aside, where the catch no longer reaches it', () => {
    const { load, dir } = loadedEditing(Kept, guarded);
    const modules = Object.values(PLUGINS) as PluginModule[];
    const spec = new Compiler(new Scope(load.registry, load.resolve), modules).graph(`@${Kept}`).spec;
    rmSync(dir, { recursive: true, force: true });
    expect(spec.nodes['customers:made']).toMatchObject({ kind: 'call' });
    expect(spec.nodes.anyKept).toMatchObject({ catch: { customers: 'unreachable' } });
  });
  it('sends a fault routed to a node the lowering moves aside where it went: <id>:made', () => {
    /** A fresh key caught and routed to `customers`, the guarded site, which is legal: only its catch is G025. */
    const routedToGuarded = (doc: any) => {
      doc.nodes.push(
        run('counted', '@storage/store.port.json#newKey', {
          store: '@customers/data/customers.store.json',
          collection: 'customers',
        }),
        {
          type: '@wilanis/node/switch.schema.json',
          id: 'anyKept',
          in: { n: '{{counted}}' },
          rules: [{ when: 'has(n)', to: 'none' }],
          else: 'none',
          catch: { counted: 'customers' },
        },
        run('none', '@std/outcome.port.json#refuse', {
          reason: 'upstream',
          message: 'no key was made',
          type: `${CUSTOMER}[]`,
        }),
      );
      doc.out.from = ['customers', 'none'];
    };
    expect(sabotage(Kept, routedToGuarded)).toEqual([]);
    const { load, dir } = loadedEditing(Kept, routedToGuarded);
    const modules = Object.values(PLUGINS) as PluginModule[];
    const spec = new Compiler(new Scope(load.registry, load.resolve), modules).graph(`@${Kept}`).spec;
    rmSync(dir, { recursive: true, force: true });
    expect(spec.nodes['customers:made']).toMatchObject({ kind: 'call' });
    expect(spec.nodes.anyKept).toMatchObject({ catch: { counted: 'customers:made' } });
  });
});
