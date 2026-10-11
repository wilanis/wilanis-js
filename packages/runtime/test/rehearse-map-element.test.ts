/**
 * How the rehearsal steers a switch inside a map through the map's first element (#904). Both trees map `#judge`, a
 * port operation bound to a graph, over the findings a scan answers; the scan is a call into a graph, so the rehearsal
 * stubs its answer to make the list hold an element.
 *
 * - The first element stands for all, so the stubbed list holds that one alone: a second element would run from values
 *   nothing steered, and where one of them breaks a guard the whole run of every case ends at the refusal, which is
 *   what a recorded scenario of the branch would then expect.
 * - The switch in the bound graph reads `in`, and stands behind the binding's wrapper `op`, which hands the element on
 *   as it got it: the element is what steers it, read back through the map's `bind` -- field for field, or whole
 *   under one name.
 */
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { checkTree } from '@wilanis/compiler';
import { loadTree } from '@wilanis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, type Rehearsal, rehearse } from '../src/index.js';
import {
  decide,
  edge,
  graph,
  HERE,
  ITEM,
  make,
  map,
  run,
  STRING,
  shape,
  treeOf,
  trigger,
} from './rehearse-stubs-trees.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PORT = `${HERE}/domain/triage.port.json`;
const VERDICTS = `${shape('Verdict')}[]`;

/** How `#judge` is handed each finding: field for field as `score` and `name`, or whole as `finding`. */
const HANDED = {
  fields: { accepts: ITEM, in: shape('Item'), bind: { score: 'score', name: 'name' } },
  whole: { accepts: { finding: { type: shape('Item') } }, in: shape('Judged'), bind: { finding: '' } },
};

/**
 * A tree whose `all` scans a target and maps `#judge` over the findings, with the nodes of `judge`'s graph, how each
 * finding is handed to it, and any documents a case adds.
 */
function triageOf(judge: object[], more: { docs?: Record<string, object>; handed?: keyof typeof HANDED } = {}): string {
  const asked = { target: STRING, list: { type: `${shape('Item')}[]` } };
  const handed = HANDED[more.handed ?? 'fields'];
  return treeOf({
    'domain/Item.shape.json': { layer: 'core', fields: ITEM },
    'domain/Judged.shape.json': { layer: 'core', fields: { finding: { type: shape('Item') } } },
    'domain/Scan.shape.json': { layer: 'core', fields: { run: STRING, findings: { type: `${shape('Item')}[]` } } },
    'domain/Verdict.shape.json': { layer: 'core', fields: { name: STRING, level: STRING } },
    'domain/Ask.shape.json': { layer: 'core', fields: asked },
    'edge/ItemIn.shape.json': { layer: 'edge', fields: ITEM },
    'edge/AskIn.shape.json': {
      layer: 'edge',
      fields: { target: STRING, list: { type: `${edge('ItemIn')}[]`, maxItems: 10 } },
    },
    'edge/Out.shape.json': { layer: 'edge', fields: { name: STRING, level: STRING } },
    'domain/triage.port.json': {
      operations: {
        all: { description: 'd', accepts: asked, returns: VERDICTS },
        scan: { description: 'd', accepts: asked, returns: shape('Scan') },
        judge: { description: 'd', accepts: handed.accepts, returns: shape('Verdict') },
      },
    },
    'data/triage.binding.json': {
      port: PORT,
      operations: {
        all: { graph: `${HERE}/domain/all.graph.json` },
        scan: { graph: `${HERE}/data/scan.graph.json` },
        judge: { graph: `${HERE}/domain/judge.graph.json` },
      },
    },
    'data/scan.graph.json': graph('Scan', shape('Ask'), { type: shape('Scan'), from: 's' }, [
      make('s', { run: '{{in.target}}', findings: '{{in.list}}' }, shape('Scan')),
    ]),
    'domain/all.graph.json': graph('All', shape('Ask'), { type: VERDICTS, from: 'judged' }, [
      run('scanned', `${PORT}#scan`, { target: '{{in.target}}', list: '{{in.list}}' }),
      map('judged', `${PORT}#judge`, { over: '{{scanned.findings}}', bind: handed.bind, in: {} }),
    ]),
    'domain/judge.graph.json': graph('Judge', handed.in, { type: shape('Verdict'), from: ['high', 'low'] }, judge),
    'edge/triage.trigger.json': trigger('triage', { in: edge('AskIn'), out: `${edge('Out')}[]` }, `${PORT}#all`),
    ...more.docs,
  });
}

/** The two verdicts `judge` makes, one per branch of its switch, each naming the element it judged, read at `name`. */
const verdicts = (name = '{{in.name}}') => [
  make('high', { name, level: 'high' }, shape('Verdict')),
  make('low', { name, level: 'low' }, shape('Verdict')),
];

/**
 * `judge` decides on a fact it made of the element, and every verdict is held to a rule no generated name meets: only
 * the element the rehearsal steers through each verdict's guard can pass it.
 */
function guardedTree(): string {
  return triageOf(
    [
      make('facts', { score: '{{in.score}}', name: '{{in.name}}' }, shape('Item')),
      decide('decide', { score: '{{facts.score}}' }, [{ when: 'score > 5', to: 'high' }], 'low'),
      ...verdicts(),
    ],
    {
      docs: {
        'domain/a-verdict-is-fine.invariant.json': {
          label: 'A verdict is fine',
          holds: { on: shape('Verdict'), when: "name == 'fine'" },
        },
      },
    },
  );
}

/** `judge` decides on the score it is handed, `in.score`, which is the element's own. */
function onInTree(): string {
  return triageOf([
    decide('decide', { score: '{{in.score}}' }, [{ when: 'score > 5', to: 'high' }], 'low'),
    ...verdicts(),
  ]);
}

/** `judge` is handed each finding whole, bound to `finding`, and decides on `in.finding.score`: the element's score. */
function wholeTree(): string {
  return triageOf(
    [
      decide('decide', { score: '{{in.finding.score}}' }, [{ when: 'score > 5', to: 'high' }], 'low'),
      ...verdicts('{{in.finding.name}}'),
    ],
    { handed: 'whole' },
  );
}

/** The tree rehearsed, once the checker has let it through: a case about the walk must stand on a tree that passes. */
async function rehearsed(dir: string, opts: { seed?: number; record?: string }): Promise<Rehearsal> {
  const load = loadTree(dir, BUILTIN_PLUGINS);
  const refused = checkTree(load).format();
  if (refused) throw new Error(`the tree a case rehearses must itself pass:\n${refused}`);
  return rehearse(load, opts);
}

/** Each branch of one decision as where it went and how it settled: its declared reason, or why it never ran. */
function branchesOf(run: Rehearsal, graph: string, node: string) {
  const decision = run.decisions.find(one => one.graph.endsWith(graph) && one.node === node);
  if (!decision) throw new Error(`no decision ${graph} '${node}' in:\n${run.lines.join('\n')}`);
  return decision.branches.map(one => [
    one.to,
    one.uncovered ??
      one.settled?.error ??
      one.settled?.declared?.reason ??
      (one.settled?.misrouted ? `misrouted to ${one.settled.misrouted}` : one.settled?.status),
  ]);
}

/**
 * What each recorded run of a decision's branches came to, under `rehearse --record` and so under seed 1: the branch's
 * target, and how the whole run ended -- the reason it refused with, or its status.
 */
function recordedRuns(dir: string, node: string): [string, unknown][] {
  const recorded = join(dir, 'scenarios/rehearsed/rv.triage');
  const files = readdirSync(recorded).filter(name => name.startsWith(`rv.judge.${node}.`));
  return files.sort().map(name => {
    const scenario = JSON.parse(readFileSync(join(recorded, name), 'utf8'));
    return [scenario.branch.to, scenario.expect.reason ?? scenario.expect.status];
  });
}

describe('a switch inside a map over a stubbed list', () => {
  it('runs for the one element it steers, so no generated element breaks a guard and ends the whole run', {
    timeout: 60_000,
  }, async () => {
    const dir = guardedTree();
    dirs.push(dir);
    // under seed 1 the scan's generated answer holds three findings; those after the first would run from generated
    // names, which the rule refuses, and every recorded run of `decide` would end refused as `invariant`
    const done = await rehearsed(dir, { record: 'scenarios/rehearsed' });
    expect(branchesOf(done, 'domain/judge.graph.json', 'decide')).toEqual([
      ['high:made', 'done'],
      ['low:made', 'done'],
    ]);
    expect(recordedRuns(dir, 'decide')).toEqual([
      ['high', 'done'],
      ['low', 'done'],
    ]);
    expect(done.ok, done.lines.join('\n')).toBe(true);
  });
});

/** Seeds 1 to 8, so the switch is steered whatever the scan's generated answer holds. */
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

/** Rehearse a tree under every seed, and expect `judge`'s switch steered to both its branches under each. */
async function steeredUnderEverySeed(dir: string): Promise<void> {
  dirs.push(dir);
  for (const seed of SEEDS) {
    const done = await rehearsed(dir, { seed });
    expect(branchesOf(done, 'domain/judge.graph.json', 'decide'), `seed ${seed}`).toEqual([
      ['high', 'done'],
      ['low', 'done'],
    ]);
    expect(done.ok, `seed ${seed}:\n${done.lines.join('\n')}`).toBe(true);
  }
}

describe('a switch on in, in a graph a map reaches through a binding', () => {
  it("is steered through the map's element, which the binding's wrapper hands on as it got it", {
    timeout: 60_000,
  }, async () => {
    await steeredUnderEverySeed(onInTree());
  });

  it("is steered through the element read back through the map's bind, where the element is bound whole", {
    timeout: 60_000,
  }, async () => {
    await steeredUnderEverySeed(wholeTree());
  });
});
