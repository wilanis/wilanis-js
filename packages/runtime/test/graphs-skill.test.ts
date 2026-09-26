/**
 * The graphs skill `wilanis init` writes teaches by example, so every graph it writes out is held to `check`. Each
 * `wilanis new graph` command in SKILL.md is run in a copy of the example, in place of any graph the example keeps
 * under that name, and the JSON block that follows it is written over what the command scaffolded: the copy checks
 * clean, and each block keeps every node its command wrote. The graph the skill taught before RFC 0035, which
 * flipped a customer's tier with two `#patch` nodes and said it checked clean, is the case that proves this bites:
 * planted the same way, it is I007 twice.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schemaUrl } from '@wilanis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { scaffold } from '../src/index.js';
import { copyOfExample, refusalsAt } from './example-harness.js';

const SKILL = readFileSync(
  fileURLToPath(new URL('../templates/dot-claude/skills/wilanis-graphs/SKILL.md', import.meta.url)),
  'utf8',
);

/** A graph as far as these cases read it: its nodes, each by id and the operation it runs (none for a switch). */
interface Graph {
  nodes: { id: string; run?: string }[];
}

/** One graph the skill writes out: the command that scaffolds it, and the block it shows. */
interface Example {
  target: string;
  opts: Record<string, string>;
  graph: Graph;
}

/** One word of a command line: bare, or quoted in part or whole. */
const WORD = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;

/** A word with its quotes taken off, as a shell hands it on. */
const unquoted = (word: string) => word.replace(/"([^"]*)"|'([^']*)'/g, '$1$2');

/** A `wilanis new graph <target> --flag value ...` line, as the target and the flags the scaffold takes. */
function commandOf(line: string): Omit<Example, 'graph'> {
  const [, , , target = '', ...flags] = (line.match(WORD) ?? []).map(unquoted);
  const opts: Record<string, string> = {};
  for (let at = 0; at + 1 < flags.length; at += 2) opts[(flags[at] ?? '').replace(/^--/, '')] = flags[at + 1] ?? '';
  return { target, opts };
}

/** Each `wilanis new graph` command of a text, paired in order with the JSON block it stands for. */
function examplesOf(text: string): Example[] {
  const commands = text.match(/^wilanis new graph .+$/gm) ?? [];
  const blocks = [...text.matchAll(/^```json\n([\s\S]*?)^```$/gm)].map(block => JSON.parse(block[1] ?? ''));
  expect(blocks, 'one JSON block per command').toHaveLength(commands.length);
  return commands.map((line, at) => ({ ...commandOf(line), graph: blocks[at] }));
}

/** The copy a case plants into, removed after it; none for a case that only reads the skill. */
let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

/** The nodes a scaffold wrote that a block does not keep under the same id and operation. */
const dropped = (written: Graph, shown: Graph) =>
  written.nodes.filter(node => !shown.nodes.some(one => one.id === node.id && one.run === node.run)).map(one => one.id);

/**
 * Run each command in a fresh copy of the example, where it replaces the graph the example keeps under that name,
 * write the block over what it scaffolded, and answer the refusals, and the nodes each block dropped.
 */
function planted(examples: Example[]): { refusals: string[]; dropped: string[] } {
  dir = copyOfExample();
  const lost: string[] = [];
  for (const { target, opts, graph } of examples) {
    for (const layer of ['domain', 'data'])
      rmSync(join(dir, dirname(target), layer, `${basename(target)}.graph.json`), { force: true });
    const [file = ''] = scaffold(dir, 'graph', target, opts);
    lost.push(...dropped(JSON.parse(readFileSync(join(dir, file), 'utf8')), graph).map(id => `${file}#${id}`));
    writeFileSync(join(dir, file), JSON.stringify(graph));
  }
  return { refusals: refusalsAt(dir), dropped: lost };
}

const STORE = '@storage/store.port.json';
const CUSTOMERS = { store: '@customers/data/customers.store.json', collection: 'customers' };
const CUSTOMER = '@customers/domain/Customer.shape.json';

const run = (id: string, op: string, input: Record<string, unknown>) => ({
  type: '@wilanis/node/run.schema.json',
  id,
  run: op,
  in: input,
});
const route = (id: string, input: Record<string, unknown>, rule: { when: string; to: string }, otherwise: string) => ({
  type: '@wilanis/node/switch.schema.json',
  id,
  in: input,
  rules: [rule],
  else: otherwise,
});
const missing = (id: string, message: string) =>
  run(id, '@std/outcome.port.json#refuse', { reason: 'missing', message, type: CUSTOMER });

/** One branch of the old tier flip: patch the tier, then answer the record or refuse where it had gone. */
const flipTo = (tier: string, Tier: string, patched: string) => [
  run(patched, `${STORE}#patch`, { ...CUSTOMERS, key: '{{in.id}}', changes: { tier } }),
  route(
    `stillThereAfter${Tier}`,
    { record: `{{${patched}.record}}` },
    { when: 'has(record)', to: `${tier}Customer` },
    `goneBefore${Tier}`,
  ),
  run(`${tier}Customer`, '@std/object.port.json#make', { value: `{{${patched}.record}}`, type: CUSTOMER }),
  missing(`goneBefore${Tier}`, 'customer {{in.id}} vanished before the write'),
];

/** The graph the skill wrote out before RFC 0035: read a customer, and patch its tier to silver or to bronze. */
const TIER_FLIP = {
  $schema: schemaUrl('graph'),
  description:
    "Flip one customer's tier between bronze and silver: read it, decide on what was read, write on one branch.",
  in: '@customers/domain/CustomerRef.shape.json',
  out: {
    type: CUSTOMER,
    from: ['silverCustomer', 'bronzeCustomer', 'noCustomer', 'goneBeforeSilver', 'goneBeforeBronze'],
  },
  nodes: [
    run('current', `${STORE}#get`, { ...CUSTOMERS, key: '{{in.id}}' }),
    route('isKept', { record: '{{current.record}}' }, { when: 'has(record)', to: 'isBronze' }, 'noCustomer'),
    route('isBronze', { tier: '{{current.record.tier}}' }, { when: "tier == 'bronze'", to: 'silvered' }, 'bronzed'),
    ...flipTo('silver', 'Silver', 'silvered'),
    ...flipTo('bronze', 'Bronze', 'bronzed'),
    missing('noCustomer', 'no customer {{in.id}}'),
  ],
};

describe('the graphs skill: every graph it writes out checks', () => {
  it('writes out the load-make-keep pair and a read-decide-write graph, each after the command that scaffolds it', () => {
    expect(examplesOf(SKILL).map(one => [one.target, Object.keys(one.opts)])).toEqual([
      ['features/customers/update-customer', ['port']],
      ['features/customers/keep-customer', ['store', 'collection']],
      ['features/customers/remove-closed', ['store', 'collection', 'type', 'read-then', 'branch']],
    ]);
  });

  it('checks clean in the example, the pair in place of its own, and keeps every node the scaffold wrote', () => {
    expect(planted(examplesOf(SKILL))).toEqual({ refusals: [], dropped: [] });
  });

  it('writes no patch: a change to a record is made in the domain graph and put whole', () => {
    const ops = examplesOf(SKILL).flatMap(one => one.graph.nodes.map(node => node.run));
    expect(ops).not.toContain(`${STORE}#patch`);
    expect(ops).toContain('@std/object.port.json#merge');
    expect(ops).toContain(`${STORE}#put`);
  });

  it('bites: the tier flip it taught before, planted the same way, is I007 at each patch', () => {
    const text = [
      `wilanis new graph features/customers/flip-tier --store ${CUSTOMERS.store} --collection customers`,
      '```json',
      JSON.stringify(TIER_FLIP, null, 2),
      '```',
    ].join('\n');
    expect(planted(examplesOf(text)).refusals).toEqual([
      'I007 @features/customers/data/flip-tier.graph.json#nodes/silvered/in/changes',
      'I007 @features/customers/data/flip-tier.graph.json#nodes/bronzed/in/changes',
    ]);
  });
});
