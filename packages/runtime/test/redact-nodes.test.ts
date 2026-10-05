/**
 * The reports no operation's own types redact: the guard a field invariant lowers, where a node makes the value
 * and where a graph takes it, whose switch and whose answer read the value it judges; the call a startup step's
 * `holds` operation compiles to; and a port whose `returns` drops a mark the graph that meets it carries. Each
 * shows the passwords, and the vault's key, as the marker.
 */
import { rmSync } from 'node:fs';
import { checkTree, runGraph } from '@wilanis/compiler';
import { type LoadResult, loadTree } from '@wilanis/core';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS, embedderFor } from '../src/index.js';
import {
  ADA,
  BOB,
  clearIn,
  fake,
  fired,
  LOGIN,
  nodeNamed,
  putter,
  REDACTED,
  SECRET,
  vaultTree,
  withVault,
} from './redact-tree.js';

const JUDGE = '@features/vault/domain/judge.port.json';
const SWITCH = '@wilanis/node/switch.schema.json';
const RUN = '@wilanis/node/run.schema.json';
const MAKE = '@std/object.port.json#make';

/** A node answering one fixed word: where a switch over what the graph takes routes. */
const word = (id: string) => ({ type: RUN, id, run: MAKE, in: { value: id, type: 'string' } });

/** A data graph taking `input` and reading it in one switch, `size`, which routes to `yes` or `no`. */
const taking = (input: string, reads: Record<string, string>, when: string) => ({
  in: input,
  out: { type: 'string', from: ['yes', 'no'] },
  nodes: [{ type: SWITCH, id: 'size', in: reads, rules: [{ when, to: 'yes' }], else: 'no' }, word('yes'), word('no')],
});

/**
 * The vault, with a port whose operations take a login and a list of them, each met by a data graph that takes
 * what it is handed: a taken site of the shape, guarded since nothing proves the rule of what a caller hands. Each
 * graph reads the password in a switch, so a report that drops the guard's marks shows it there.
 */
function takenTree(): string {
  const dir = vaultTree();
  const put = putter(dir);
  put('features/vault/domain/judge.port.json', {
    operations: {
      one: { description: 'd', accepts: LOGIN, returns: 'string' },
      all: { description: 'd', accepts: { logins: { type: `${LOGIN}[]` } }, returns: 'string' },
    },
  });
  put('features/vault/data/judge.binding.json', {
    port: JUDGE,
    operations: {
      one: { graph: '@features/vault/data/judge-one.graph.json' },
      all: { graph: '@features/vault/data/judge-all.graph.json' },
    },
  });
  const one = taking(LOGIN, { pw: '{{in.password}}', who: '{{in.name}}' }, 'len(pw) > 3 && len(who) > 0');
  put('features/vault/data/judge-one.graph.json', one);
  put('features/vault/data/judge-all.graph.json', taking(`${LOGIN}[]`, { all: '{{in}}' }, 'len(all) > 1'));
  return dir;
}

/** The vault with its taken sites, loaded and checked, handed to `use`; the tree does not outlive it. */
async function withTaken<T>(use: (load: LoadResult) => Promise<T>): Promise<T> {
  const dir = takenTree();
  try {
    const load = loadTree(dir, { ...BUILTIN_PLUGINS, '@fake': fake });
    expect(checkTree(load).items).toEqual([]);
    return await use(load);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * One run of an operation of the port through its binding, as a startup step or a plugin fires one: the call of
 * the graph shows what it hands as the port marks it, and the graph's own nodes read it from there.
 */
const judged = (op: string, input: Record<string, unknown>) =>
  withTaken(load => {
    const emb = embedderFor(load, { env: {} });
    return runGraph(emb.operation(`${JUDGE}#${op}`), { initial: { in: input }, env: emb.env });
  });

describe('a guard, in the report of a run', () => {
  it('shows the value it judges as the marker, in its switch, its answer and the node moved aside', async () => {
    const { report, answer } = await fired('login');
    expect(report.status).toBe('done');
    expect(answer).toEqual(ADA);
    const shown = { name: 'ada', password: SECRET };
    expect(nodeNamed(report, 'login:made')?.in).toEqual({ value: shown, type: LOGIN, trim: true });
    expect(nodeNamed(report, 'login:check')?.in).toEqual({ name: 'ada', password: SECRET });
    expect(nodeNamed(report, 'login')?.in).toEqual({ value: shown });
    expect(nodeNamed(report, 'login')?.out).toEqual(shown);
    expect(clearIn(report, ['p-ada'])).toEqual([]);
  });

  it('shows a list it judges as the marker, in the map and in each element it runs through the guard', async () => {
    const { report, answer } = await fired('logins');
    expect(report.status).toBe('done');
    expect(answer).toEqual([ADA, BOB]);
    const guard = nodeNamed(report, 'logins');
    expect(guard?.in).toEqual({ over: REDACTED });
    expect(guard?.items?.map(item => item.in)).toEqual(REDACTED.map(one => ({ in: one })));
    expect(guard?.items?.[0].sub?.nodes['in:check'].in).toEqual({ name: 'ada', password: SECRET });
    expect(guard?.items?.[0].sub?.nodes['in:ok'].out).toEqual(REDACTED[0]);
    expect(clearIn(report, ['p-ada', 'p-bob'])).toEqual([]);
  });

  it('shows a value the graph takes as the marker, in its answer and in the switch that reads it', async () => {
    const report = await judged('one', { ...ADA });
    expect(report.status).toBe('done');
    expect(report.output).toBe('yes');
    const shown = { name: 'ada', password: SECRET };
    expect(nodeNamed(report, 'in:check')?.in).toEqual(shown);
    expect(nodeNamed(report, 'in:ok')?.in).toEqual({ value: shown });
    expect(nodeNamed(report, 'in:ok')?.out).toEqual(shown);
    // the switch's authored {{in.password}} reads the judged value, at in:ok
    expect(nodeNamed(report, 'size')?.in).toEqual({ pw: SECRET, who: 'ada' });
    expect(clearIn(report, ['p-ada'])).toEqual([]);
  });

  it('shows a list the graph takes as the marker, in the map and in the switch that reads it', async () => {
    const report = await judged('all', { logins: [{ ...ADA }, { ...BOB }] });
    expect(report.status).toBe('done');
    expect(report.output).toBe('yes');
    const guard = nodeNamed(report, 'in:ok');
    expect(guard?.in).toEqual({ over: REDACTED });
    expect(guard?.out).toEqual(REDACTED);
    expect(nodeNamed(report, 'size')?.in).toEqual({ all: REDACTED });
    expect(clearIn(report, ['p-ada', 'p-bob'])).toEqual([]);
  });

  it('shows a list the graph takes as the marker where the map is seeded, and none of its elements runs', async () => {
    const report = await withTaken(async load => {
      const emb = embedderFor(load, { env: {} });
      const compiled = emb.graph('@features/vault/data/judge-all.graph.json');
      // a replay: the guard's map answers what it is given, and `in` is shown as the binding's call shows it
      const initial = { in: [ADA, BOB], 'in:ok': [ADA, BOB] };
      return runGraph(compiled, { initial, shown: { in: REDACTED }, env: emb.env });
    });
    expect(report.status).toBe('done');
    expect(report.nodes['in:ok'].out).toEqual(REDACTED);
    expect(report.nodes.size.in).toEqual({ all: REDACTED });
    expect(clearIn(report, ['p-ada', 'p-bob'])).toEqual([]);
  });
});

describe('a startup step naming a holds operation', () => {
  it('shows the secret it is handed as the marker', async () => {
    const report = await withVault(async load => {
      const emb = embedderFor(load, { env: { VAULT_KEY: 'v-1' } });
      const step = load.registry.project?.doc.startup?.[0];
      if (!step) throw new Error('the vault opens at startup');
      return emb.startup(step, { at: 0 });
    });
    expect(report.status).toBe('done');
    expect(report.nodes.op.in).toEqual({ key: SECRET });
  });
});

describe('a returns that drops a mark another declaration on the way carries', () => {
  it("shows the field the graph's answer marks as the marker in the call of the graph and the run hung on it", async () => {
    const { report, answer } = await fired('peek');
    expect(answer).toEqual(ADA);
    expect(nodeNamed(report, 'fetched')?.out).toEqual({ name: 'ada', password: SECRET });
    expect(report.nodes.op.out).toEqual({ name: 'ada', password: SECRET });
    expect(report.nodes.op.sub?.output).toEqual({ name: 'ada', password: SECRET });
    expect(clearIn(report, ['p-ada'])).toEqual([]);
  });

  it('shows the field the port marks as the marker where the binding delegates to an operation that does not', async () => {
    const { report, answer } = await fired('glance');
    expect(answer).toEqual(ADA);
    expect(report.nodes.op.handler).toBe('@fake/vault.port.json#plain');
    expect(report.nodes.op.out).toEqual({ name: 'ada', password: SECRET });
  });
});
