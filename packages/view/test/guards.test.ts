/**
 * What the canvas says about a field invariant (RFC 0007, step 8). A rule is stated once, somewhere else, and
 * lands on every graph that makes or takes a value of its shape: the graph's author wrote no switch, and the
 * invariant's author named no graph. So the one thing a reader with both documents open still cannot see is
 * which node the compiler put the rule in front of, and which node proved it and costs the tree nothing.
 *
 * The viewer judges neither. `guardsOf` says which sites the compiler guarded and `heldAt` how each conjunct of
 * a rule was established at a site -- the same answers the checker (I005), the lowering and the rehearsal read
 * -- so a badge and the guard in the spec cannot say different things. These cases hold the mapping honest, and
 * the example's own `a-customer-is-reachable` is what a guarded node is read against.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LoadResult, PluginModule, ResolvedInclude } from '@wilanis/core';
import { loadTree } from '@wilanis/core';
import auth from '@wilanis/plugin-auth';
import blob from '@wilanis/plugin-blob';
import http from '@wilanis/plugin-http';
import otel from '@wilanis/plugin-otel';
import reload from '@wilanis/plugin-reload';
import schedule from '@wilanis/plugin-schedule';
import storage from '@wilanis/plugin-storage';
import memory from '@wilanis/plugin-storage-memory';
import postgres from '@wilanis/plugin-storage-postgres';
import { BUILTIN_PLUGINS, loadProject } from '@wilanis/runtime';
import { describe, expect, it } from 'vitest';
import type { VHoldsInvariant, VNode } from '../src/index.js';
import { viewOf } from '../src/index.js';

const EXAMPLE = fileURLToPath(new URL('../../../example', import.meta.url));
const PAGE = fileURLToPath(new URL('../client/index.html', import.meta.url));
const CUSTOMER = '@customers/domain/Customer.shape.json';
const REACHABLE = '@features/customers/domain/a-customer-is-reachable.invariant.json';
const KEPT_GET = '@features/customers/data/kept-get.graph.json';
const WRITE_CSV = '@features/customers/data/write-csv.graph.json';
const PLANTED = '@features/customers/data/proving.graph.json';

/** The plugins the example names, handed in: a copy of the tree has no node_modules and resolves none of them. */
const PLUGINS: Record<string, PluginModule> = {
  ...BUILTIN_PLUGINS,
  '@http': http,
  '@blob': blob,
  '@reload': reload,
  '@auth': auth,
  '@schedule': schedule,
  '@storage': storage,
  '@storage-memory': memory,
  '@storage-postgres': postgres,
  '@otel': otel,
};
/** The tree the example includes, as the runtime would resolve it from the example's node_modules. */
const INCLUDES: ResolvedInclude[] = [
  {
    from: '@wilanis/access',
    dir: fileURLToPath(new URL('../../../libraries/access', import.meta.url)),
    features: ['access'],
  },
];

/** The node of a graph of the example, as the view drew it. */
const nodeOf = async (graph: string, id: string): Promise<VNode> => {
  const seen = viewOf(await loadProject(EXAMPLE), graph);
  const node = seen?.graph?.nodes.find(one => one.id === id);
  if (!node) throw new Error(`no node '${id}' in ${graph}`);
  return node;
};

/** A copy of the example with documents written into it, and what a case asks of the tree it becomes. */
function planted<T>(docs: Record<string, unknown>, ask: (load: LoadResult) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'wilanis-guards-'));
  try {
    cpSync(EXAMPLE, dir, { recursive: true, filter: path => !path.includes('node_modules') });
    for (const [file, doc] of Object.entries(docs)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), JSON.stringify(doc, null, 2));
    }
    return ask(loadTree(dir, PLUGINS, INCLUDES));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A data graph of the example, written around whatever nodes a case needs, as `invariant-proof.test.ts` writes them. */
const graph = (nodes: unknown[], rest: Record<string, unknown> = {}) => ({
  $schema: 'https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/graph.schema.json',
  label: 'Proving',
  description: 'A graph planted to see what the canvas says about the sites in it.',
  ...rest,
  nodes,
});
/** A node that makes a customer out of `value`, the shape of a made site. */
const makes = (id: string, value: unknown) => ({
  type: '@wilanis/node/run.schema.json',
  id,
  label: id,
  run: '@std/object.port.json#make',
  in: { value, type: CUSTOMER },
});
/** A node that reads a row from the store, so a site has something to be routed on. */
const reads = (id: string) => ({
  type: '@wilanis/node/run.schema.json',
  id,
  label: id,
  run: '@storage/store.port.json#get',
  in: { store: '@customers/data/customers.store.json', collection: 'customers', key: 'k' },
});
/** A refusal for a switch's else branch to land on, so every node is reachable. */
const refuses = (id: string) => ({
  type: '@wilanis/node/run.schema.json',
  id,
  label: id,
  run: '@std/outcome.port.json#refuse',
  in: { reason: 'missing', message: 'no row', type: CUSTOMER },
});

/** The nodes of the planted graph, as the view marked them: what each carries about the invariant over Customer. */
const markedIn = (nodes: unknown[], rest: Record<string, unknown>): Map<string, VNode> => {
  const file = 'features/customers/data/proving.graph.json';
  return planted({ [file]: graph(nodes, rest) }, load => {
    const seen = viewOf(load, PLANTED);
    if (!seen?.graph) throw new Error('no view of the planted graph');
    return new Map(seen.graph.nodes.map(one => [one.id, one]));
  });
};

describe('the canvas marks a node the compiler guarded', () => {
  it('names the invariant, so the badge says which rule the node is held to', async () => {
    const node = await nodeOf(KEPT_GET, 'row');
    expect(node.guarded?.by).toEqual([{ path: REACHABLE, label: 'A customer is reachable' }]);
    // the node's own document says nothing about any of this: the guard is the compiler's, not the author's
    expect(JSON.stringify(node.op)).toBe('"@std/object.port.json#make"');
  });

  it('carries the rule as the guard tests it, which is what the switch the compiler wrote asks', () => {
    // one guard per site, not one per invariant: the rule is every unproved rule bracketed and conjoined, so a
    // reader who opens the badge sees the condition the graph actually runs and not a rule reassembled here
    const marked = markedIn([makes('row', '{{in}}')], { in: CUSTOMER, out: { type: CUSTOMER, from: 'row' } });
    expect(marked.get('in')?.guarded?.when).toBe("(len(name) > 0 && len(email) > 0 && (tier != 'gold' || has(note)))");
  });

  it('marks the graph that takes a value, at `in`, and says a list is judged element by element', async () => {
    // write-csv takes `Customer[]`: the value is the caller's, so nothing in the graph establishes it and the
    // guard stands at `in`, running once per element of the list
    const node = await nodeOf(WRITE_CSV, 'in');
    expect(node.guarded?.arity).toBe('list');
    expect(node.guarded?.by.map(one => one.label)).toEqual(['A customer is reachable']);
  });

  it('marks nothing on a node that is no site of the shape at all', async () => {
    const node = await nodeOf(KEPT_GET, 'asked');
    expect(node.guarded).toBeUndefined();
    expect(node.proved).toBeUndefined();
  });
});

describe('the canvas marks a node whose rule is proved', () => {
  it('says the value was written out in literals, and guards it nowhere', () => {
    const nodes = [makes('row', { id: 'a', name: 'Ada', email: 'ada@x.test', tier: 'bronze' })];
    const marked = markedIn(nodes, { out: { type: CUSTOMER, from: 'row' } });
    expect(marked.get('row')?.guarded).toBeUndefined();
    expect(marked.get('row')?.proved?.by).toEqual([
      {
        path: REACHABLE,
        label: 'A customer is reachable',
        when: "len(name) > 0 && len(email) > 0 && (tier != 'gold' || has(note))",
        held: [{ by: 'literal' }, { by: 'literal' }, { by: 'literal' }],
      },
    ]);
  });

  it('names the switch where a rule was narrowed by the routing that reached the node', () => {
    const nodes = [
      reads('asked'),
      {
        type: '@wilanis/node/switch.schema.json',
        id: 'route',
        label: 'route',
        in: { row: '{{asked.record}}' },
        rules: [
          { when: "len(row.name) > 0 && len(row.email) > 0 && (row.tier != 'gold' || has(row.note))", to: 'row' },
        ],
        else: 'gone',
      },
      makes('row', '{{asked.record}}'),
      refuses('gone'),
    ];
    const marked = markedIn(nodes, { out: { type: CUSTOMER, from: ['row', 'gone'] } });
    expect(marked.get('row')?.proved?.by[0].held).toEqual([
      { by: 'narrowed', switch: 'route' },
      { by: 'narrowed', switch: 'route' },
      { by: 'narrowed', switch: 'route' },
    ]);
  });

  it('names the node a value was read whole from, since the rule was judged where that value was made', () => {
    const nodes = [reads('asked'), makes('first', '{{asked.record}}'), makes('row', '{{first}}')];
    const marked = markedIn(nodes, { out: { type: CUSTOMER, from: 'row' } });
    // `first` is itself a site and is guarded; `row` reads it whole, so the rule held or was guarded there
    expect(marked.get('first')?.guarded?.by.map(one => one.label)).toEqual(['A customer is reachable']);
    expect(marked.get('row')?.proved?.by[0].held).toEqual([
      { by: 'through', node: 'first' },
      { by: 'through', node: 'first' },
      { by: 'through', node: 'first' },
    ]);
  });

  it('marks a node as one or the other and never both, since a guard stands for every rule unproved there', () => {
    // `in` is guarded, since nothing in the graph establishes the caller's value; `row` reads it whole, so the
    // rule was judged where that value came into being and this site proves through it
    const marked = markedIn([makes('row', '{{in}}')], { in: CUSTOMER, out: { type: CUSTOMER, from: 'row' } });
    expect(marked.get('in')?.guarded).toBeDefined();
    expect(marked.get('row')?.proved?.by[0].held).toEqual([
      { by: 'through', node: 'in' },
      { by: 'through', node: 'in' },
      { by: 'through', node: 'in' },
    ]);
    for (const node of marked.values()) expect(Boolean(node.guarded) && Boolean(node.proved)).toBe(false);
  });
});

describe('the invariant page tables every site', () => {
  it('says how each site of the shape stands, in the order the compiler walks them', () => {
    const marked = planted({}, load => {
      const seen = viewOf(load, REACHABLE)?.invariant;
      if (seen?.form !== 'holds') throw new Error('the example invariant is not a field invariant');
      return seen as VHoldsInvariant;
    });
    expect(marked.sites.length).toBe(14);
    // the whole return on stating the rule once: thirteen places, each named, and what each costs the tree
    expect(marked.sites.filter(one => one.held).length).toBe(0);
    expect(marked.sites[0]).toEqual({
      graph: '@features/customers/data/kept-get-postgres.graph.json',
      graphLabel: 'Get what is kept',
      node: 'row',
      kind: 'made',
      arity: 'one',
    });
  });

  it('carries how a proved site was proved, so the table can say it without working it out again', () => {
    const file = 'features/customers/data/proving.graph.json';
    const nodes = [makes('row', { id: 'a', name: 'Ada', email: 'ada@x.test', tier: 'bronze' })];
    const seen = planted({ [file]: graph(nodes, { out: { type: CUSTOMER, from: 'row' } }) }, load => {
      const found = viewOf(load, REACHABLE)?.invariant;
      if (found?.form !== 'holds') throw new Error('the example invariant is not a field invariant');
      return found as VHoldsInvariant;
    });
    const site = seen.sites.find(one => one.graph === PLANTED);
    expect(site).toMatchObject({
      node: 'row',
      kind: 'made',
      held: [{ by: 'literal' }, { by: 'literal' }, { by: 'literal' }],
    });
    expect(seen.sites.length).toBe(15);
  });
});

// the page is one static file with no build step, so what it draws is read from its own source
describe('the graph canvas', () => {
  it('draws a badge on a guarded node and a lighter one on a proved node', async () => {
    const page = await readFile(PAGE, 'utf8');
    expect(page).toContain('function badgeEl(n, b)');
    expect(page).toContain("'guarded: ' + names.join('; ')");
    expect(page).toContain("'proved: ' + ways");
    // lighter is the whole difference RFC 0007 asks for: a guard is named in the warning colour, a proof is dim
    expect(page).toMatch(/\.node \.inv\.guard .*fill: var\(--warn\)/);
    expect(page).toMatch(/\.node \.inv\.held .*fill: var\(--dim\)/);
  });

  it('opens the invariant on a double-click of the badge, and not the node the badge sits on', async () => {
    const page = await readFile(PAGE, 'utf8');
    expect(page).toMatch(
      /badgeEl[\s\S]*?addEventListener\('dblclick', ev => \{ ev\.stopPropagation\(\); go\(canon\(said\.open\)\)/,
    );
    expect(page).toContain('open: n.guarded.by[0].path');
    expect(page).toContain('open: by[0].path');
  });

  it('gives the badge room in a node box, so it never sits over a port', async () => {
    const page = await readFile(PAGE, 'utf8');
    expect(page).toContain('const badgeOf = (n) => (n.guarded || n.proved) ? BADGE : 0;');
    expect(page).toContain('headOf(n) + rowsOf(n) * ROW + PAD + badgeOf(n)');
  });

  it('says in a node details panel which invariants guard it and which it proves', async () => {
    const page = await readFile(PAGE, 'utf8');
    expect(page).toContain('if (n.guarded) guardedEl(box, n.guarded);');
    expect(page).toContain('if (n.proved) provedEl(box, n.proved);');
    expect(page).toContain("'guarded by (' + guarded.by.length + ')'");
    expect(page).toContain("'proved here (' + proved.by.length + ')'");
  });
});
