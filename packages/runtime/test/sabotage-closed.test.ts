/**
 * Sabotage: a closed shape takes only a value of its own fields (#787). The run refuses a key a closed type does not
 * declare, so the checker refuses a value that may carry one wherever a closed type is declared: a node's input
 * (G004), a binding's graph (B005), a graph's answer (G010, in sabotage.test.ts) and a policy's decision (A001, in the
 * access tree's own tests). The one narrowing is `make` reading its value whole; an object written out in the node
 * is the author's own keys, and a misspelt one is refused rather than dropped.
 */
import { rmSync } from 'node:fs';
import { Compiler, runGraph } from '@wilanis/compiler';
import { loadTree, type PluginModule, Scope } from '@wilanis/core';
import type { Report } from '@wilanis/engine';
import { describe, expect, it } from 'vitest';
import { embedderFor } from '../src/index.js';
import { EXAMPLE, INCLUDES, loadedEditing, PLUGINS, sabotageSaying } from './example-harness.js';

const CUSTOMER = '@features/customers/domain/Customer.shape.json';
const ROW = '@features/customers/edge/CustomerRow.shape.json';
const byId = (graph: any, id: string) => graph.nodes.find((node: { id: string }) => node.id === id);

describe('sabotage: a closed shape handed what it does not declare', () => {
  it('G004 a make written out with a misspelt field, which the run would otherwise drop or refuse', () => {
    const said = sabotageSaying('features/customers/domain/register-customer.graph.json', graph => {
      const value = byId(graph, 'customer').in.value;
      value.registar = value.registrar;
      delete value.registrar;
    });
    expect(said).toEqual([`G004 'value': field 'registar' is not declared in ${CUSTOMER}`]);
  });

  it("G004 make's trim written by hand: the compiler sets it where make reads its value whole", () => {
    const said = sabotageSaying('features/customers/domain/register-customer.graph.json', graph => {
      byId(graph, 'customer').in.trim = true;
    });
    expect(said).toEqual(["G004 'trim' is set by the compiler, where make reads its value whole, and never written"]);
  });

  it('G004 an open row handed whole to a store write that keeps Customers', () => {
    // keep takes a Customer, which CustomerRow (open) takes as well, so the binding fits and only the put does not
    const said = sabotageSaying('features/customers/data/keep-customer.graph.json', graph => {
      graph.in = '@customers/edge/CustomerRow.shape.json';
    });
    expect(said.filter(line => line.startsWith('G004'))).toEqual([
      `G004 'record': ${ROW} is open and may carry fields ${CUSTOMER} does not declare`,
    ]);
  });

  it("B005 a graph that takes less than the operation it meets hands it: register's Customer into a CustomerRecord", () => {
    const said = sabotageSaying('features/customers/data/create-row.graph.json', graph => {
      graph.in = '@customers/domain/CustomerRecord.shape.json';
      graph.nodes = graph.nodes.filter((node: { id: string }) => node.id !== 'record');
      byId(graph, 'posted').in.body = '{{in}}';
    });
    expect(said).toEqual([
      "B005 'register' accepts → graph in: field 'id' is not declared in @features/customers/domain/CustomerRecord.shape.json",
    ]);
  });
});

/** One graph of a copy of the example run as the live profile compiles it, whether or not the copy checks. */
async function ran(
  file: string,
  edit: (doc: any) => void,
  input: unknown,
  stubs: Record<string, unknown>,
): Promise<Report> {
  const { load, dir } = loadedEditing(file, edit);
  try {
    const emb = embedderFor(load, { profile: 'live' });
    return await runGraph(emb.graph(`@${file}`), { initial: { in: input }, stubs, env: emb.envFor(undefined) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the run agrees: make narrows only a value it reads whole', () => {
  it("keeps a row's fields Customer declares and drops the rest, where get-row's make reads the body whole", async () => {
    const body = { id: 'golf', name: 'Ada', email: 'ada@example.com', tier: 'bronze', createdAt: '2026', extra8: [1] };
    const report = await ran(
      'features/customers/data/get-row.graph.json',
      () => {},
      { id: 'golf' },
      {
        fetched: { status: 200, body },
      },
    );
    expect(report.status).toBe('done');
    expect(report.output).toEqual({ id: 'golf', name: 'Ada', email: 'ada@example.com', tier: 'bronze' });
  });

  it('refuses a misspelt field written out in the node, rather than drop it, even in a tree no check has passed', async () => {
    const misspelt = (graph: any) => {
      const value = byId(graph, 'customer').in.value;
      value.registar = value.registrar;
      delete value.registrar;
    };
    const report = await ran(
      'features/customers/domain/register-customer.graph.json',
      misspelt,
      {
        name: 'Ada',
        email: 'ada@example.com',
        tier: 'bronze',
      },
      { id: 'k1' },
    );
    expect(report.status).toBe('failed');
    expect(report.nodes['customer:made']?.error).toContain('$.registar: not a declared field');
  });
});

describe('the lowering says where make narrows, in the spec', () => {
  const modules = Object.values(PLUGINS) as PluginModule[];
  const load = loadTree(EXAMPLE, PLUGINS, INCLUDES);
  const lowered = (graph: string) =>
    new Compiler(new Scope(load.registry, load.resolve), modules, { profile: 'live' }).graph(graph).spec;

  it("sets trim on a make that reads its value whole: get-row's row, moved aside as customer:made by its guard", () => {
    expect(lowered('@features/customers/data/get-row.graph.json').nodes['customer:made']).toMatchObject({
      kind: 'call',
      handler: '@std/object.port.json#make',
      in: { value: { ref: 'fetched', path: ['body'] }, trim: { value: true } },
    });
  });

  it("sets none on a make written out in the node: register-customer's customer", () => {
    const made = lowered('@features/customers/domain/register-customer.graph.json').nodes['customer:made'];
    expect(made).toMatchObject({ kind: 'call', handler: '@std/object.port.json#make' });
    expect(made && 'in' in made ? made.in : {}).not.toHaveProperty('trim');
  });
});
