/**
 * The solver on a consumer's tree (#845): an else case of a switch over an enum field is steered with a member the
 * rules do not name, never with a value outside the enum, and a rule comparing two fields is solved by making them
 * equal rather than called a contradiction. Every seed must settle every branch: the seed decides what the else case
 * replaces and which branch the later switches stand behind, never whether a branch can be reached.
 */
import { rmSync } from 'node:fs';
import { checkTree } from '@wilanis/compiler';
import { loadTree } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, rehearse } from '../src/index.js';
import {
  decide,
  edge,
  graph,
  HERE,
  make,
  NUMBER,
  refuse,
  run,
  STRING,
  shape,
  treeOf,
  trigger,
} from './rehearse-stubs-trees.js';

/**
 * `check` reads a scan and decides on it three times: `status` names two of its three enum members and sends the third,
 * by its else, to `ok`, which makes a `Result` whose status is the same enum; `agree` reads a boolean; and `moved`
 * compares two fields of the same answer, `has(previous) && previous == commit`.
 */
function scanTree(): string {
  const port = `${HERE}/domain/scan.port.json`;
  const result = shape('Result');
  const status = { type: 'string', enum: ['clean', 'findings', 'broke'] };
  const read = {
    status,
    agrees: { type: 'boolean' },
    count: NUMBER,
    commit: STRING,
    previous: { ...STRING, required: false },
  };
  const rules = [
    { when: "status == 'clean'", to: 'ok' },
    { when: "status == 'findings'", to: 'broke' },
  ];
  return treeOf({
    'domain/Read.shape.json': { layer: 'core', fields: read },
    'domain/Result.shape.json': { layer: 'core', fields: { status, count: NUMBER } },
    'domain/Ask.shape.json': { layer: 'core', fields: { target: STRING } },
    'edge/AskIn.shape.json': { layer: 'edge', fields: { target: STRING } },
    'edge/Out.shape.json': { layer: 'edge', fields: { status: STRING, count: NUMBER } },
    'domain/scan.port.json': {
      operations: {
        check: { description: 'd', accepts: { target: STRING }, returns: result, refuses: true },
        read: { description: 'd', accepts: { target: STRING }, returns: shape('Read') },
      },
    },
    'data/scan.binding.json': {
      port,
      operations: {
        check: { graph: `${HERE}/domain/check.graph.json` },
        read: { graph: `${HERE}/data/read.graph.json` },
      },
    },
    'data/read.graph.json': graph('Read', shape('Ask'), { type: shape('Read'), from: 'r' }, [
      make('r', { status: 'broke', agrees: false, count: 0, commit: '{{in.target}}' }, shape('Read')),
    ]),
    'domain/check.graph.json': graph(
      'Check',
      shape('Ask'),
      { type: result, from: ['good', 'same', 'broke', 'disagree'] },
      [
        run('got', `${port}#read`, { target: '{{in.target}}' }),
        decide('status', { status: '{{got.status}}' }, rules, 'ok'),
        refuse('broke', 'broke', result),
        make('ok', { status: '{{got.status}}', count: '{{got.count}}' }, result),
        decide('agree', { agrees: '{{got.agrees}}', n: '{{ok.count}}' }, [{ when: 'agrees', to: 'moved' }], 'disagree'),
        refuse('disagree', 'disagree', result),
        decide(
          'moved',
          { previous: '{{got.previous}}', commit: '{{got.commit}}' },
          [{ when: 'has(previous) && previous == commit', to: 'same' }],
          'good',
        ),
        refuse('same', 'same', result),
        make('good', { status: '{{ok.status}}', count: '{{ok.count}}' }, result),
      ],
    ),
    'edge/check.trigger.json': trigger('check', { in: edge('AskIn'), out: edge('Out') }, `${port}#check`),
  });
}

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

describe('rehearsing a tree whose switches read an enum and compare two fields', () => {
  it('settles every branch under every seed', { timeout: 60_000 }, async () => {
    const dir = scanTree();
    const load = loadTree(dir, BUILTIN_PLUGINS);
    expect(checkTree(load).format()).toBe('');
    const runs = [];
    for (const seed of SEEDS) runs.push({ seed, run: await rehearse(load, { seed }) });
    rmSync(dir, { recursive: true, force: true });
    for (const { seed, run: one } of runs) {
      const said = `seed ${seed}\n${one.lines.join('\n')}`;
      // the else of `status` is `broke`, the member neither rule names, and `ok` makes a Result of it
      expect(said).toMatch(/ok {2}anything else +answered from 'ok'/);
      // `has(previous) && previous == commit` is met by a previous equal to the commit
      expect(said).toMatch(/ok {2}when has\(previous\) && previous == commit +refused on purpose at 'same' as same/);
      expect(said).not.toMatch(/contradicts itself|BROKE|NEVER RUN/);
      expect(one.ok, said).toBe(true);
    }
  });
});

/**
 * `sort` reads a scan and routes on its `status`, whose rules name every member of its enum, so only an absent status
 * reaches the else: a required one never does, and an optional one does when it is left out (#861).
 */
function exhaustedTree(required: boolean): string {
  const port = `${HERE}/domain/scan.port.json`;
  const result = shape('Result');
  const status = { type: 'string', enum: ['clean', 'findings', 'broke'], required };
  // an optional field is read under has(), which the checker asks for (G011)
  const guard = required ? '' : 'has(status) && ';
  const rules = ['clean', 'findings', 'broke'].map(member => ({ when: `${guard}status == '${member}'`, to: 'known' }));
  return treeOf({
    'domain/Read.shape.json': { layer: 'core', fields: { status, commit: STRING } },
    'domain/Result.shape.json': { layer: 'core', fields: { label: STRING } },
    'domain/Ask.shape.json': { layer: 'core', fields: { target: STRING } },
    'edge/AskIn.shape.json': { layer: 'edge', fields: { target: STRING } },
    'edge/Out.shape.json': { layer: 'edge', fields: { label: STRING } },
    'domain/scan.port.json': {
      operations: {
        sort: { description: 'd', accepts: { target: STRING }, returns: result },
        read: { description: 'd', accepts: { target: STRING }, returns: shape('Read') },
      },
    },
    'data/scan.binding.json': {
      port,
      operations: {
        sort: { graph: `${HERE}/domain/sort.graph.json` },
        read: { graph: `${HERE}/data/read.graph.json` },
      },
    },
    'data/read.graph.json': graph('Read', shape('Ask'), { type: shape('Read'), from: 'r' }, [
      make('r', { status: 'broke', commit: '{{in.target}}' }, shape('Read')),
    ]),
    'domain/sort.graph.json': graph('Sort', shape('Ask'), { type: result, from: ['known', 'unknown'] }, [
      run('got', `${port}#read`, { target: '{{in.target}}' }),
      decide('status', { status: '{{got.status}}' }, rules, 'unknown'),
      make('known', { label: '{{got.commit}}' }, result),
      make('unknown', { label: 'unknown' }, result),
    ]),
    'edge/sort.trigger.json': trigger('sort', { in: edge('AskIn'), out: edge('Out') }, `${port}#sort`),
  });
}

/** The rehearsal's lines for an `exhaustedTree` under every seed, and whether each rehearsal was ok. */
async function rehearsedUnder(required: boolean): Promise<{ said: string; ok: boolean }[]> {
  const dir = exhaustedTree(required);
  const load = loadTree(dir, BUILTIN_PLUGINS);
  expect(checkTree(load).format()).toBe('');
  const runs = [];
  for (const seed of SEEDS) {
    const one = await rehearse(load, { seed });
    runs.push({ said: `seed ${seed}\n${one.lines.join('\n')}`, ok: one.ok });
  }
  rmSync(dir, { recursive: true, force: true });
  return runs;
}

describe('rehearsing a switch whose rules name every member of an enum (#861)', () => {
  it('reports the else unreachable when the field is required, and says why', { timeout: 60_000 }, async () => {
    for (const { said, ok } of await rehearsedUnder(true)) {
      expect(said).toMatch(/anything else +NEVER RUN -- every member of status's enum is named by a rule before it$/m);
      expect(said).not.toMatch(/BROKE|cannot vary it/);
      expect(ok, said).toBe(false);
    }
  });
  it('reaches the else by leaving the field out when it is optional', { timeout: 60_000 }, async () => {
    for (const { said, ok } of await rehearsedUnder(false)) {
      expect(said).toMatch(/ok {2}anything else +answered from 'unknown'/);
      expect(said).not.toMatch(/BROKE|NEVER RUN/);
      expect(ok, said).toBe(true);
    }
  });
});
