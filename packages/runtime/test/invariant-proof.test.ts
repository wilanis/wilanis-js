/**
 * The three proof rules behind a field invariant, over graphs planted in a copy of the example. A wrongly-proved
 * invariant silently removes the guard the compiler would otherwise lower, so what each rule proves -- and, just
 * as much, what it refuses to prove -- is held here rather than left to the guard that will lean on it.
 *
 * Each case plants one data graph, asks `sitesOf` for the sites of `Entry` in it, and reads back how `heldAt`
 * established each conjunct: `literal`, `narrowed` by a switch, `through` a sibling site, or `guarded`.
 */

import { rmSync } from 'node:fs';
import { heldAt, type Proof, sitesOf } from '@wilanis/compiler';
import { Scope } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { loadedWith } from './example-harness.js';

const ENTRY = '@customers/domain/Customer.shape.json';
const GRAPH = 'features/customers/data/proving.graph.json';
const PLANTED = '@features/customers/data/proving.graph.json';

/** A data graph of the example, written around whatever nodes a case needs. */
const graph = (nodes: unknown[], rest: Record<string, unknown> = {}) => ({
  $schema: 'https://raw.githubusercontent.com/wilanis/wilanis-js/main/packages/core/schemas/graph.schema.json',
  label: 'Proving',
  description: 'A graph planted to ask what the proof rules establish at its sites.',
  ...rest,
  nodes,
});

/** A node that makes an entry out of `value`, the shape of a made site. */
const makes = (id: string, value: unknown) => ({
  type: '@wilanis/node/run.schema.json',
  id,
  label: id,
  run: '@std/object.port.json#make',
  in: { value, type: ENTRY },
});

/** A node that reads a row from the store, so a site has something to be routed on. */
const reads = (id: string) => ({
  type: '@wilanis/node/run.schema.json',
  id,
  label: id,
  run: '@storage/store.port.json#get',
  in: { store: '@customers/data/customers.store.json', collection: 'entries', key: 'k' },
});

/** A switch routing to `to` when `when` holds of what `reads` answers. */
const routes = (id: string, when: string, to: string, otherwise: string) => ({
  type: '@wilanis/node/switch.schema.json',
  id,
  label: id,
  in: { row: '{{asked.record}}' },
  rules: [{ when, to }],
  else: otherwise,
});

/** A switch of several rules over what `reads` answers, each routing where the case says. */
const routesAll = (id: string, rules: { when: string; to: string }[], otherwise: string) => ({
  type: '@wilanis/node/switch.schema.json',
  id,
  label: id,
  in: { row: '{{asked.record}}' },
  rules,
  else: otherwise,
});

/** A refusal for a switch's else branch to land on, so every node is reachable. */
const refuses = (id: string) => ({
  type: '@wilanis/node/run.schema.json',
  id,
  label: id,
  run: '@std/outcome.port.json#refuse',
  in: { reason: 'missing', message: 'no row', type: ENTRY },
});

/**
 * How each conjunct of `when` is established at the node `id` of the planted graph: one word per conjunct, in
 * the order the rule writes them. The tree is loaded whole, so the sites the pass-through rule leans on are the
 * real ones of the example plus whatever the case planted.
 */
function provenAt(nodes: unknown[], rest: Record<string, unknown>, id: string, when: string): string[] {
  const { load, dir } = loadedWith({ [GRAPH]: graph(nodes, rest) });
  try {
    const scope = new Scope(load.registry, load.resolve);
    const sites = sitesOf(scope, ENTRY);
    const site = sites.find(one => one.graph.path === PLANTED && (one.node?.id ?? 'in') === id);
    if (!site) throw new Error(`no site '${id}' in the planted graph`);
    return [...heldAt(scope, sites, site, when).values()].map(said);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One proof as a word, with what established it where that is the claim. */
const said = (proof: Proof): string => {
  if (proof.by === 'narrowed') return `narrowed by ${proof.switch}`;
  return proof.by === 'through' ? `through ${proof.node}` : proof.by;
};

/** The nodes of a graph whose made site is routed to by a switch over the row it reads. */
const narrowing = (when: string) => [
  reads('asked'),
  routes('route', when, 'row', 'gone'),
  makes('row', '{{asked.record}}'),
  refuses('gone'),
];
const ANSWERS = { out: { type: ENTRY, from: ['row', 'gone'] } };

describe('the proof rules of a field invariant', () => {
  it('proves a site whose every read is a literal, and guards nothing about it', () => {
    const nodes = [makes('row', { id: 'a', url: 'https://x', method: 'GET' })];
    const answers = { out: { type: ENTRY, from: 'row' } };
    expect(provenAt(nodes, answers, 'row', "len(url) > 0 && method != 'DELETE'")).toEqual(['literal', 'literal']);
  });

  it('proves a site the switch that routed to it already established the rule for', () => {
    expect(provenAt(narrowing("len(row.url) > 0 && row.method != 'DELETE'"), ANSWERS, 'row', 'len(url) > 0')).toEqual([
      'narrowed by route',
    ]);
    // both conjuncts, each matched against the conjunct of the routing rule that says the same thing
    expect(
      provenAt(
        narrowing("len(row.url) > 0 && row.method != 'DELETE'"),
        ANSWERS,
        'row',
        "len(url) > 0 && method != 'DELETE'",
      ),
    ).toEqual(['narrowed by route', 'narrowed by route']);
  });

  it('proves through the implication table: an ordering proves a weaker one on the same literal', () => {
    expect(provenAt(narrowing('len(row.url) > 0'), ANSWERS, 'row', 'len(url) >= 0')).toEqual(['narrowed by route']);
    expect(provenAt(narrowing('len(row.url) > 0'), ANSWERS, 'row', 'len(url) != 0')).toEqual(['narrowed by route']);
    expect(provenAt(narrowing("row.method == 'GET'"), ANSWERS, 'row', "method != 'DELETE'")).toEqual([
      'narrowed by route',
    ]);
  });

  it('guards what the table must not prove: no arithmetic on the literals, and no reversed comparison', () => {
    // x > 1 does not prove x > 0 here: it is true, and not worth being wrong about, so the site is guarded
    expect(provenAt(narrowing('len(row.url) > 1'), ANSWERS, 'row', 'len(url) > 0')).toEqual(['guarded']);
    // 0 < len(url) says what len(url) > 0 says, and is not the same term; the site is guarded
    expect(provenAt(narrowing('0 < len(row.url)'), ANSWERS, 'row', 'len(url) > 0')).toEqual(['guarded']);
    // == 'GET' proves != 'DELETE', but never == of another literal
    expect(provenAt(narrowing("row.method == 'GET'"), ANSWERS, 'row', "method == 'POST'")).toEqual(['guarded']);
    // len(url) > 0 is not has(url): presence is a different claim from length, and only has() proves it
    expect(provenAt(narrowing('len(row.url) > 0'), ANSWERS, 'row', 'has(url)')).toEqual(['guarded']);
    // a rule about another field than the one routed on is established by nothing
    expect(provenAt(narrowing('len(row.url) > 0'), ANSWERS, 'row', "method != 'DELETE'")).toEqual(['guarded']);
  });

  it('guards a node the same switch reaches by a rule and by else: it runs whether the rule held or not', () => {
    // the rule proves len(url) > 0 of the runs it routed, and `else` sends the rest of them to the very same
    // node. Arriving at `row` says nothing about which way brought the run there, so nothing is established.
    const bothWays = [
      reads('asked'),
      routes('route', 'len(row.url) > 0', 'row', 'row'),
      makes('row', '{{asked.record}}'),
    ];
    expect(provenAt(bothWays, { out: { type: ENTRY, from: 'row' } }, 'row', 'len(url) > 0')).toEqual(['guarded']);
  });

  it('guards a node two rules of one switch both route to: only one of the two was true of the run', () => {
    // two cases answered the same way is a fair thing for a graph to say, and it establishes neither rule:
    // unioning them would prove len(url) > 0 of a run that arrived because the method was GET
    const twice = [
      reads('asked'),
      routesAll(
        'route',
        [
          { when: 'len(row.url) > 0', to: 'row' },
          { when: "row.method == 'GET'", to: 'row' },
        ],
        'gone',
      ),
      makes('row', '{{asked.record}}'),
      refuses('gone'),
    ];
    expect(provenAt(twice, ANSWERS, 'row', 'len(url) > 0')).toEqual(['guarded']);
    expect(provenAt(twice, ANSWERS, 'row', "method == 'GET'")).toEqual(['guarded']);
    // and the switch's other targets are unaffected: only the one reached twice loses what it established
    const one = [
      reads('asked'),
      routesAll(
        'route',
        [
          { when: 'len(row.url) > 0', to: 'row' },
          { when: "row.method == 'GET'", to: 'other' },
        ],
        'gone',
      ),
      makes('row', '{{asked.record}}'),
      makes('other', '{{asked.record}}'),
      refuses('gone'),
    ];
    expect(provenAt(one, { out: { type: ENTRY, from: ['row', 'other', 'gone'] } }, 'row', 'len(url) > 0')).toEqual([
      'narrowed by route',
    ]);
  });

  it('proves a site that reads a sibling site of the same shape whole, and guards one that reads anything else', () => {
    const through = [reads('asked'), makes('first', '{{asked.record}}'), makes('row', '{{first}}')];
    const answers = { out: { type: ENTRY, from: 'row' } };
    expect(provenAt(through, answers, 'row', "len(url) > 0 && method != 'DELETE'")).toEqual([
      'through first',
      'through first',
    ]);
    // reading one whole node that is NOT a site of this shape: `latest` makes a TierLatest, and a rule about
    // an entry was never judged of it, so the read proves nothing and the site is guarded
    const elsewhere = [
      reads('asked'),
      {
        type: '@wilanis/node/run.schema.json',
        id: 'latest',
        label: 'latest',
        run: '@std/object.port.json#make',
        in: { value: '{{asked.record}}', type: '@customers/domain/TierLatest.shape.json' },
      },
      makes('row', '{{latest}}'),
    ];
    expect(provenAt(elsewhere, { out: { type: ENTRY, from: 'row' } }, 'row', 'len(url) > 0')).toEqual(['guarded']);
    // and reading a field of another value, rather than the value whole, is not that value either
    const partial = [reads('asked'), makes('row', '{{asked.record}}')];
    expect(provenAt(partial, { out: { type: ENTRY, from: 'row' } }, 'row', 'len(url) > 0')).toEqual(['guarded']);
  });

  it('guards a taken site: nothing in the graph establishes the value its caller handed it', () => {
    const nodes = [makes('row', '{{in}}')];
    const answers = { in: ENTRY, out: { type: ENTRY, from: 'row' } };
    expect(provenAt(nodes, answers, 'in', 'len(url) > 0')).toEqual(['guarded']);
  });

  it('finds every site of the example, and proves none of them, so the compiler guards each', () => {
    const { load, dir } = loadedWith({});
    try {
      const scope = new Scope(load.registry, load.resolve);
      const sites = sitesOf(scope, ENTRY);
      const when = "len(url) > 0 && (method != 'DELETE' || has(agent))";
      const guarded = sites.filter(site =>
        [...heldAt(scope, sites, site, when).values()].some(proof => proof.by === 'guarded'),
      );
      expect([sites.length, guarded.length]).toEqual([13, 13]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
